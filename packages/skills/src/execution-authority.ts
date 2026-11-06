import type { Kysely } from 'kysely';
import { SkillContractSchema, type SkillNodeBinding } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { sha256, skillContentMatches } from './hash.ts';
import { classifySkillFile, INSPECTOR_VERSION } from './inspector.ts';

const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

/** Authorization is re-read at dispatch, not inherited from a planner snapshot.
 * Root access belongs to the exact granted tool; scopes alone grant no file root. */
export async function readSkillExecutionAuthority(db: Kysely<any>, ownerId: string, binding: SkillNodeBinding, alreadyInTransaction = false, scriptsReady = false) {
  const read = async (tx: Kysely<any>) => {
    const version = await tx.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
      .select(['v.id', 'v.contract', 'v.content_hash', 'v.status', 'f.active_version_id'])
      .where('v.id', '=', binding.versionId).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId).executeTakeFirst();
    if (!version || version.status !== 'active' || version.active_version_id !== version.id || version.content_hash !== binding.contentHash) {
      throw new SkillError('SKILL_AUTHORITY_REVOKED', 'لم تعد نسخة المهارة المصرح بها مفعّلة.', 403);
    }
    const contract = SkillContractSchema.parse(json(version.contract));
    const files = await tx.selectFrom('skill_files').selectAll().where('version_id', '=', version.id).orderBy('path').limit(201).execute();
    if (files.length > 200 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0) > 256000
      || files.some(file => sha256(file.content) !== file.content_hash || classifySkillFile(file.path) !== file.kind || Buffer.byteLength(file.content, 'utf8') !== file.size_bytes)
      || !skillContentMatches(contract, files.map(file => ({path: String(file.path), content: String(file.content)})), binding.contentHash)) throw new SkillError('SKILL_INTEGRITY_FAILED', 'تغير محتوى المهارة المثبت.', 409);
    const inspection = await tx.selectFrom('skill_inspections').select(['verdict', 'inspector_version'])
      .where('owner_id', '=', ownerId).where('version_id', '=', version.id).where('content_hash', '=', binding.contentHash)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!inspection || inspection.inspector_version !== INSPECTOR_VERSION || !['pass', 'review'].includes(inspection.verdict)) {
      throw new SkillError('SKILL_INSPECTION_STALE', 'التنفيذ يحتاج فحص أمان حاليًا ناجحًا.', 403);
    }
    if (binding.kind === 'script' && !scriptsReady) throw new SkillError('SKILL_SANDBOX_UNVERIFIED', 'المهارات التنفيذية محجوبة حتى إثبات بوابات العزل.', 409);
    if (binding.kind === 'tool' && (!binding.tool || !contract.requires.tools.includes(binding.tool))) throw new SkillError('SKILL_TOOL_UNDECLARED', 'الأداة ليست ضمن عقد المهارة.', 403);
    if (binding.kind === 'model' && !contract.requires.scopes.includes('model:generate')) throw new SkillError('SKILL_MODEL_PERMISSION_REQUIRED', 'خطوة النموذج تحتاج تصريح model:generate في العقد والمنحة.', 403);
    const grants = await tx.selectFrom('skill_grants').select(['tools', 'scopes', 'roots']).where('owner_id', '=', ownerId)
      .where('version_id', '=', version.id).where('content_hash', '=', binding.contentHash).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).execute();
    const scopes = new Set<string>(grants.flatMap(grant => json(grant.scopes)));
    if (contract.requires.scopes.some(scope => !scopes.has(scope))) throw new SkillError('SKILL_SCOPE_REVOKED', 'صلاحية مطلوبة مفقودة أو انتهت.', 403);
    const matching = binding.tool ? grants.filter(grant => json(grant.tools).includes(binding.tool)) : [];
    if (binding.kind === 'tool' && !matching.length) throw new SkillError('SKILL_TOOL_PERMISSION_REQUIRED', 'لا توجد منحة سارية للأداة المطلوبة.', 403);
    return {contract, roots: [...new Set<string>(matching.flatMap(grant => json(grant.roots)))], files: files.map(file => ({path: String(file.path), kind: String(file.kind), content: String(file.content)}))};
  };
  return alreadyInTransaction ? read(db) : db.transaction().setIsolationLevel('repeatable read').execute(read);
}
