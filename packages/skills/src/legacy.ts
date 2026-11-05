import type { Kysely } from 'kysely';
import type { SkillDetail, SkillStatus, SkillVersion } from '@mohassan/contracts';

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const STATUS: Record<string, SkillStatus> = { candidate: 'quarantined', sandbox_tested: 'tested', benchmarked: 'benchmarked', active: 'active', revoked: 'revoked' };
const slugOf = (id: string) => `checklist-${id.slice(0, 8)}`;

function toVersion(row: any, activeId: string | null): SkillVersion {
  return {
    id: row.id, familyId: row.family_id, slug: slugOf(row.id), name: row.name, description: row.description, category: 'reasoning',
    version: `${row.version}.0.0`, revision: row.revision, level: 'instruction', origin: 'custom', status: STATUS[row.status] ?? 'quarantined', statusReason: null,
    contentHash: row.manifest_hash, active: activeId === row.id, readOnly: true, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
const description = (value: string) => (value.trim().length >= 10 ? value : `${value} (قائمة فحص)`);

/**
 * checklist-router skills stay owned by packages/memory and its routes. This only reads them so the
 * registry is one list; they are proposals, so they are reported at the instruction level.
 */
export async function legacySkills(db: Kysely<any>, ownerId: string): Promise<SkillVersion[]> {
  const rows = await db.selectFrom('memory_skill_versions as v').innerJoin('memory_skill_families as f', 'f.id', 'v.family_id')
    .select(['v.id', 'v.family_id', 'f.active_skill_id', 'v.version', 'v.revision', 'v.name', 'v.description', 'v.manifest_hash', 'v.status', 'v.created_at', 'v.updated_at'])
    .where('v.owner_id', '=', ownerId).orderBy('v.created_at', 'desc').limit(100).execute();
  return rows.map((row) => toVersion(row, row.active_skill_id));
}

export async function legacyDetail(db: Kysely<any>, ownerId: string, id: string): Promise<SkillDetail | null> {
  const row = await db.selectFrom('memory_skill_versions as v').innerJoin('memory_skill_families as f', 'f.id', 'v.family_id')
    .select(['v.id', 'v.family_id', 'f.active_skill_id', 'v.version', 'v.revision', 'v.name', 'v.description', 'v.manifest_hash', 'v.status', 'v.created_at', 'v.updated_at'])
    .where('v.owner_id', '=', ownerId).where('v.id', '=', id).executeTakeFirst();
  if (!row) return null;
  const skill = toVersion(row, row.active_skill_id);
  return {
    skill, contract: { slug: skill.slug, name: skill.name, description: description(skill.description), version: skill.version, category: skill.category, level: 'instruction', inputs: [], outputs: [], steps: [], requires: { tools: [], scopes: [], paths: [] }, sideEffects: 'none', retry: { maxAttempts: 1 }, idempotent: false, rollback: { mode: 'none' }, conflicts: [], dependsOn: [] },
    source: { kind: 'memory', locator: `memory:${id}`, observedAt: skill.createdAt, fileCount: 0, totalBytes: 0 }, files: [], versions: [skill], audit: [], inspection: null, grants: [],
  };
}
