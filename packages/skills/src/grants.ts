import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { canonicalDirectory } from '@mohassan/coding/security';
import { SkillContractSchema, SkillGrantCreateSchema, SkillGrantRevokeSchema, type SkillGrant, type SkillStatus, type SkillToolId } from '@mohassan/contracts';
import { SkillError } from './errors.ts';

const GRANTABLE: readonly SkillStatus[] = ['inspected', 'tested', 'benchmarked', 'active'];
const FILE_TOOLS: readonly SkillToolId[] = ['file.read', 'file.write'];
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

export function grantDto(row: any): SkillGrant {
  return { id: row.id, contentHash: row.content_hash, tools: json(row.tools), scopes: json(row.scopes), roots: json(row.roots), expiresAt: iso(row.expires_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null, createdAt: iso(row.created_at) };
}

type Audit = (connection: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>) => Promise<void>;

export function createSkillGrants(db: Kysely<any>, options: { allowedRoots: readonly string[]; audit: Audit; now?: () => Date }) {
  const now = options.now ?? (() => new Date());

  /** A grant can narrow the contract and never widen it. The owner chooses the folders. */
  async function create(ownerId: string, id: string, input: unknown): Promise<SkillGrant> {
    const request = SkillGrantCreateSchema.parse(input);
    if (!request.tools.length && !request.scopes.length) throw new SkillError('SKILL_GRANT_EMPTY', 'حدد أداة أو صلاحية واحدة على الأقل.');
    const roots = await Promise.all(request.roots.map((root) => canonicalDirectory(root, options.allowedRoots)));
    return db.transaction().execute(async (tx) => {
      const version = await tx.selectFrom('skill_versions').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!version) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
      if (version.revision !== request.expectedRevision) throw new SkillError('SKILL_VERSION_CONFLICT', 'تغيرت المهارة؛ حدّث الصفحة وأعد المحاولة.', 409);
      if (!GRANTABLE.includes(version.status)) throw new SkillError('SKILL_NOT_GRANTABLE', 'لا يمكن منح صلاحيات لمهارة في هذه الحالة.', 409);
      const { requires } = SkillContractSchema.parse(json(version.contract));
      const extraTool = request.tools.find((tool) => !requires.tools.includes(tool));
      if (extraTool) throw new SkillError('SKILL_GRANT_EXCEEDS_CONTRACT', `الأداة ${extraTool} ليست في عقد المهارة.`, 403);
      const extraScope = request.scopes.find((scope) => !requires.scopes.includes(scope));
      if (extraScope) throw new SkillError('SKILL_GRANT_EXCEEDS_CONTRACT', `الصلاحية ${extraScope} ليست في عقد المهارة.`, 403);
      const needsRoots = request.tools.some((tool) => FILE_TOOLS.includes(tool));
      if (needsRoots && !roots.length) throw new SkillError('SKILL_GRANT_ROOTS_REQUIRED', 'أدوات الملفات تحتاج مجلداً محدداً.');
      if (!needsRoots && roots.length) throw new SkillError('SKILL_GRANT_ROOTS_UNUSED', 'المجلدات تخص أدوات الملفات فقط.');
      const grantId = randomUUID(), expiresAt = new Date(now().getTime() + request.durationHours * 3_600_000);
      await tx.insertInto('skill_grants').values({ id: grantId, version_id: id, owner_id: ownerId, content_hash: version.content_hash, tools: JSON.stringify(request.tools), scopes: JSON.stringify(request.scopes), roots: JSON.stringify(roots), expires_at: expiresAt }).execute();
      await options.audit(tx, ownerId, id, 'skill.granted', { grantId, tools: request.tools, scopes: request.scopes, rootCount: roots.length, expiresAt: expiresAt.toISOString() });
      return grantDto(await tx.selectFrom('skill_grants').selectAll().where('id', '=', grantId).executeTakeFirstOrThrow());
    });
  }

  async function revoke(ownerId: string, id: string, grantId: string, input: unknown): Promise<void> {
    const { reason } = SkillGrantRevokeSchema.parse(input);
    await db.transaction().execute(async (tx) => {
      const grant = await tx.updateTable('skill_grants').set({ revoked_at: now(), revoke_reason: reason }).where('id', '=', grantId).where('version_id', '=', id).where('owner_id', '=', ownerId).where('revoked_at', 'is', null).returning('id').executeTakeFirst();
      if (!grant) throw new SkillError('SKILL_GRANT_NOT_FOUND', 'لم يُعثر على منحة نشطة.', 404);
      await options.audit(tx, ownerId, id, 'skill.grant_revoked', { grantId, reason });
    });
  }

  /** What a version may do now. Expired or revoked grants, and grants for other content, count for nothing. */
  async function effective(ownerId: string, id: string): Promise<{ tools: Set<SkillToolId>; scopes: Set<string>; roots: Set<string> }> {
    const rows = await db.selectFrom('skill_grants as g').innerJoin('skill_versions as v', 'v.id', 'g.version_id').select(['g.tools', 'g.scopes', 'g.roots'])
      .where('g.owner_id', '=', ownerId).where('g.version_id', '=', id).where('g.revoked_at', 'is', null).where('g.expires_at', '>', now()).whereRef('g.content_hash', '=', 'v.content_hash').execute();
    const access = { tools: new Set<SkillToolId>(), scopes: new Set<string>(), roots: new Set<string>() };
    for (const row of rows) {
      for (const tool of json(row.tools)) access.tools.add(tool);
      for (const scope of json(row.scopes)) access.scopes.add(scope);
      for (const root of json(row.roots)) access.roots.add(root);
    }
    return access;
  }

  return { create, revoke, effective };
}
