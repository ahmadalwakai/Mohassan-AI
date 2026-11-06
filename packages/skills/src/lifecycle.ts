import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { SkillActivateSchema, SkillContractSchema, SkillInspectRequestSchema, SkillRevokeSchema, SkillRollbackSchema, type SkillStatus } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { skillContentMatches } from './hash.ts';
import { INSPECTOR_VERSION, inspectSkill, type SkillFileKind } from './inspector.ts';
import { acquireSkillLifecycleLock } from './lifecycle-lock.ts';
import { assertForgePromotion } from './forge-promotion.ts';

const ACTIVATABLE: readonly SkillStatus[] = ['inspected', 'tested', 'benchmarked'];
const REINSPECTABLE: readonly SkillStatus[] = [...ACTIVATABLE, 'active', 'deprecated'];
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

type Audit = (connection: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>) => Promise<void>;
export interface LifecycleOptions {
  audit: Audit;
  executableReady: () => Promise<boolean>;
  /** Metadata refresh only; must reuse this transaction and grant no authority. */
  rebuildGraph?: (tx: Kysely<any>, ownerId: string) => Promise<unknown>;
}

export function createSkillLifecycle(db: Kysely<any>, options: LifecycleOptions) {
  async function locked(tx: Kysely<any>, ownerId: string, id: string) {
    const version = await tx.selectFrom('skill_versions').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!version) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
    return version;
  }
  async function lockedWithFamily(tx: Kysely<any>, ownerId: string, id: string) {
    await acquireSkillLifecycleLock(tx, ownerId);
    const known = await tx.selectFrom('skill_versions').select('family_id').where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
    if (!known) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
    // Owner lifecycle lock precedes family/version locks, including cross-family
    // Forge baseline revocation. Never acquire the quota user row from here.
    const family = await tx.selectFrom('skill_families').selectAll().where('id', '=', known.family_id).where('owner_id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
    return { family, version: await locked(tx, ownerId, id) };
  }
  function expect(version: any, expected: number) {
    if (version.revision !== expected) throw new SkillError('SKILL_VERSION_CONFLICT', 'تغيرت المهارة؛ حدّث الصفحة وأعد المحاولة.', 409);
  }
  async function verifiedFiles(tx: Kysely<any>, version: any) {
    const files = await tx.selectFrom('skill_files').select(['path', 'kind', 'content']).where('version_id', '=', version.id).execute();
    const contract = SkillContractSchema.parse(json(version.contract));
    if (!skillContentMatches(contract, files, version.content_hash)) throw new SkillError('SKILL_INTEGRITY_FAILED', 'لا تطابق محتويات المهارة بصمتها المسجلة.', 409);
    return { contract, files: files as { path: string; kind: SkillFileKind; content: string }[] };
  }
  async function currentInspection(tx: Kysely<any>, version: any) {
    return tx.selectFrom('skill_inspections').selectAll().where('version_id', '=', version.id).where('content_hash', '=', version.content_hash).orderBy('created_at', 'desc').executeTakeFirst();
  }
  async function setStatus(tx: Kysely<any>, id: string, revision: number, status: SkillStatus, reason: string | null) {
    await tx.updateTable('skill_versions').set({ status, status_reason: reason, revision: revision + 1, updated_at: new Date() }).where('id', '=', id).execute();
  }
  async function assertRunnable(tx: Kysely<any>, version: any, acknowledged: boolean) {
    await verifiedFiles(tx, version);
    const inspection = await currentInspection(tx, version);
    if (!inspection || !['pass', 'review'].includes(inspection.verdict)) throw new SkillError('SKILL_NOT_INSPECTED', 'يلزم فحص ناجح لهذه البصمة قبل التفعيل.', 409);
    if (inspection.inspector_version !== INSPECTOR_VERSION) throw new SkillError('SKILL_INSPECTION_STALE', 'تغير فاحص الأمان؛ أعد فحص المهارة ومراجعتها قبل التفعيل.', 409);
    if (inspection.verdict === 'review' && !acknowledged) throw new SkillError('SKILL_FINDINGS_NOT_ACKNOWLEDGED', 'توجد ملاحظات فحص تحتاج إلى إقرارك قبل التفعيل.', 409);
    if (version.level === 'executable' && !await options.executableReady()) throw new SkillError('SKILL_EXECUTABLE_GATES_CLOSED', 'بوابات العزل لم تكتمل؛ لا يمكن تفعيل مهارة تنفيذية.', 409);
  }
  async function replaceActive(tx: Kysely<any>, family: any, version: any, action: 'activate' | 'rollback', reason: string | null, approval: { approve: true; evaluationId?: string }) {
    const proof = await assertForgePromotion(tx, { ownerId: version.owner_id, family, version, action, evaluationId: approval.evaluationId, approved: approval.approve });
    if (family.active_version_id && family.active_version_id !== version.id) {
      const previous = await locked(tx, version.owner_id, family.active_version_id);
      await setStatus(tx, previous.id, previous.revision, 'deprecated', `استُبدلت بالإصدار ${version.version}.`);
    }
    await setStatus(tx, version.id, version.revision, 'active', null);
    await tx.updateTable('skill_families').set({ active_version_id: version.id, revision: family.revision + 1 }).where('id', '=', family.id).execute();
    await tx.insertInto('skill_activations').values({ id: randomUUID(), family_id: family.id, version_id: version.id, owner_id: version.owner_id, action, reason }).execute();
    if (proof) await options.audit(tx, version.owner_id, version.id, 'skill.forge_promoted', { ...proof, action });
  }

  async function inspect(ownerId: string, id: string, input: unknown) {
    const request = SkillInspectRequestSchema.parse(input);
    await db.transaction().execute(async (tx) => {
      const { family, version } = await lockedWithFamily(tx, ownerId, id);
      expect(version, request.expectedRevision);
      const previous = await currentInspection(tx, version);
      const refreshing = REINSPECTABLE.includes(version.status) && previous?.inspector_version !== INSPECTOR_VERSION;
      if (version.status !== 'quarantined' && !refreshing) throw new SkillError('SKILL_NOT_QUARANTINED', 'الفحص متاح للمهارات في الحجر أو ذات فحص أمان قديم فقط.', 409);
      const { contract, files } = await verifiedFiles(tx, version);
      const { verdict, findings } = inspectSkill(contract, files);
      if (refreshing) {
        // Only this explicit owner request invalidates old approval; startup never rewrites skills.
        const reason = 'أُعيد فحص المهارة بعد تحديث فاحص الأمان؛ يلزم تفعيل ومنح جديدان.';
        if (family.active_version_id === id) {
          await tx.updateTable('skill_families').set({ active_version_id: null, revision: family.revision + 1 }).where('id', '=', family.id).execute();
          await tx.insertInto('skill_activations').values({ id: randomUUID(), family_id: family.id, version_id: id, owner_id: ownerId, action: 'revoke', reason }).execute();
        }
        await tx.updateTable('skill_grants').set({ revoked_at: new Date(), revoke_reason: reason }).where('version_id', '=', id).where('revoked_at', 'is', null).execute();
        await options.audit(tx, ownerId, id, 'skill.inspection_invalidated', { previousInspector: previous?.inspector_version ?? null, previousStatus: version.status, inspector: INSPECTOR_VERSION });
      }
      await tx.insertInto('skill_inspections').values({ id: randomUUID(), version_id: id, owner_id: ownerId, content_hash: version.content_hash, inspector_version: INSPECTOR_VERSION, verdict, findings: JSON.stringify(findings) }).execute();
      const status: SkillStatus = verdict === 'fail' ? 'rejected' : verdict === 'incompatible' ? 'incompatible' : 'inspected';
      await setStatus(tx, id, version.revision, status, verdict === 'fail' ? 'رفضها الفحص.' : verdict === 'incompatible' ? 'لا يمكن تشغيلها في العزل الحالي.' : null);
      await options.audit(tx, ownerId, id, 'skill.inspected', { verdict, findingCount: findings.length, inspector: INSPECTOR_VERSION });
      await options.rebuildGraph?.(tx, ownerId);
    });
  }

  async function activate(ownerId: string, id: string, input: unknown) {
    const request = SkillActivateSchema.parse(input);
    await db.transaction().execute(async (tx) => {
      const { family, version } = await lockedWithFamily(tx, ownerId, id);
      expect(version, request.expectedRevision);
      if (!ACTIVATABLE.includes(version.status)) throw new SkillError('SKILL_NOT_ACTIVATABLE', 'لا يمكن تفعيل المهارة في حالتها الحالية.', 409);
      await assertRunnable(tx, version, request.acknowledgeFindings);
      await replaceActive(tx, family, version, 'activate', null, request);
      await options.audit(tx, ownerId, id, 'skill.activated', { contentHash: version.content_hash, acknowledgedFindings: request.acknowledgeFindings });
      await options.rebuildGraph?.(tx, ownerId);
    });
  }

  async function revoke(ownerId: string, id: string, input: unknown) {
    const request = SkillRevokeSchema.parse(input);
    await db.transaction().execute(async (tx) => {
      const { family, version } = await lockedWithFamily(tx, ownerId, id);
      expect(version, request.expectedRevision);
      if (version.status === 'revoked') throw new SkillError('SKILL_ALREADY_REVOKED', 'المهارة ملغاة بالفعل.', 409);
      await setStatus(tx, id, version.revision, 'revoked', request.reason);
      if (family.active_version_id === id) await tx.updateTable('skill_families').set({ active_version_id: null, revision: family.revision + 1 }).where('id', '=', family.id).execute();
      await tx.updateTable('skill_grants').set({ revoked_at: new Date(), revoke_reason: 'أُلغيت المهارة.' }).where('version_id', '=', id).where('revoked_at', 'is', null).execute();
      await tx.insertInto('skill_activations').values({ id: randomUUID(), family_id: family.id, version_id: id, owner_id: ownerId, action: 'revoke', reason: request.reason }).execute();
      await options.audit(tx, ownerId, id, 'skill.revoked', { reason: request.reason });
      await options.rebuildGraph?.(tx, ownerId);
    });
  }

  /** Restores an older version that was active before; grants stay bound to their own content hash. */
  async function rollback(ownerId: string, id: string, input: unknown) {
    const request = SkillRollbackSchema.parse(input);
    await db.transaction().execute(async (tx) => {
      const { family, version } = await lockedWithFamily(tx, ownerId, id);
      expect(version, request.expectedRevision);
      if (version.status !== 'deprecated') throw new SkillError('SKILL_NOT_ROLLBACK_TARGET', 'يمكن الرجوع فقط إلى إصدار كان مفعّلاً واستُبدل.', 409);
      await assertRunnable(tx, version, true);
      await replaceActive(tx, family, version, 'rollback', request.reason, request);
      await options.audit(tx, ownerId, id, 'skill.rolled_back', { reason: request.reason, contentHash: version.content_hash });
      await options.rebuildGraph?.(tx, ownerId);
    });
  }

  return { inspect, activate, revoke, rollback };
}
