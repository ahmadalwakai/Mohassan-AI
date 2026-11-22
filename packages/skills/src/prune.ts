import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { acquireSkillLifecycleLock } from './lifecycle-lock.ts';

/** The retention rule recorded in every tombstone and audit event, so a later change of rule stays visible in history. */
export const SKILL_RETENTION_POLICY = 'github-retention-v1';
const MAX_PRUNED_PER_CALL = 1000, CHUNK = 200;

export interface SkillRetentionRow {
  id: string; family_id: string; slug: string; active_version_id: string | null; version: string; sequence: number;
  status: string; level: string; origin: string; content_hash: string; updated_at: string | Date; source_kind: string | null;
}
const time = (value: string | Date) => new Date(value).getTime();

/**
 * Pure: which versions of families that a GitHub source created may be deleted. Every family keeps its active version,
 * its newest version (so numbering and the GitHub ownership of the slug survive), the version replaced most recently
 * (the rollback target) and every revoked version (revocation must stay final). Only GitHub instruction imports qualify.
 */
export function retentionCandidates(rows: readonly SkillRetentionRow[]): SkillRetentionRow[] {
  const families = new Map<string, SkillRetentionRow[]>();
  for (const row of rows) {
    const versions = families.get(row.family_id) ?? [];
    versions.push(row);
    families.set(row.family_id, versions);
  }
  const deletable: SkillRetentionRow[] = [];
  for (const versions of families.values()) {
    versions.sort((a, b) => a.sequence - b.sequence);
    if (versions[0].source_kind !== 'github') continue;
    const newest = versions[versions.length - 1].id;
    const rollback = versions.filter((version) => version.status === 'deprecated')
      .sort((a, b) => time(b.updated_at) - time(a.updated_at) || b.sequence - a.sequence)[0]?.id ?? null;
    for (const version of versions) {
      if (version.id === newest || version.id === rollback || version.id === version.active_version_id) continue;
      if (version.status === 'active' || version.status === 'revoked') continue;
      if (version.source_kind !== 'github' || version.origin !== 'local_import' || version.level !== 'instruction') continue;
      deletable.push(version);
    }
  }
  return deletable.sort((a, b) => time(a.updated_at) - time(b.updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every column that names a skill version without cascading; a version named in any of them is never deleted. */
const REFERENCES: readonly (readonly [table: string, column: string])[] = [
  ['skill_grants', 'version_id'], ['skill_run_nodes', 'version_id'], ['skill_evidence', 'version_id'], ['skill_circuit_state', 'version_id'],
  ['skill_benchmark_runs', 'baseline_id'], ['skill_benchmark_runs', 'candidate_id'], ['skill_forge_generations', 'baseline_id'], ['skill_forge_generations', 'candidate_id'],
];

/**
 * Deletes what retention allows for one owner, inside one transaction under the owner lifecycle lock, so no activation,
 * rollback or import of that owner runs at the same time. Each deleted version leaves a tombstone that keeps its number
 * bound to its content, and a `skill.pruned` audit event. Files, sources, inspections and activation rows go with it.
 */
export async function pruneGithubSkillVersions(db: Kysely<any>, ownerId: string): Promise<{ pruned: number }> {
  return db.transaction().execute(async (tx) => {
    await acquireSkillLifecycleLock(tx, ownerId);
    const rows = await tx.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').leftJoin('skill_sources as s', 's.version_id', 'v.id')
      .select(['v.id', 'v.family_id', 'f.slug', 'f.active_version_id', 'v.version', 'v.sequence', 'v.status', 'v.level', 'v.origin', 'v.content_hash', 'v.updated_at', 's.kind as source_kind'])
      .where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId).execute() as SkillRetentionRow[];
    const candidates = retentionCandidates(rows).slice(0, MAX_PRUNED_PER_CALL);
    if (!candidates.length) return { pruned: 0 };
    const referenced = new Set<string>();
    // A run that has not finished may still read a version it pinned, even an instruction one.
    const open = await tx.selectFrom('skill_runs').select('pinned_versions').where('owner_id', '=', ownerId).where('status', 'in', ['running', 'waiting_children']).execute();
    for (const run of open) {
      const pins: unknown = typeof run.pinned_versions === 'string' ? JSON.parse(run.pinned_versions) : run.pinned_versions;
      if (Array.isArray(pins)) for (const pin of pins) if (typeof pin?.versionId === 'string') referenced.add(pin.versionId);
    }
    for (let index = 0; index < candidates.length; index += CHUNK) {
      const ids = candidates.slice(index, index + CHUNK).map((row) => row.id);
      for (const [table, column] of REFERENCES) {
        const found = await tx.selectFrom(table).select(sql.ref<string>(column).as('id')).where(sql.ref(column), 'in', ids).execute();
        for (const row of found) referenced.add(row.id as string);
      }
    }
    const deletable = candidates.filter((row) => !referenced.has(row.id));
    for (let index = 0; index < deletable.length; index += CHUNK) {
      const batch = deletable.slice(index, index + CHUNK);
      await tx.insertInto('skill_version_tombstones').values(batch.map((row) => ({
        family_id: row.family_id, owner_id: ownerId, version: row.version, content_hash: row.content_hash, sequence: row.sequence, status: row.status, policy: SKILL_RETENTION_POLICY,
      }))).onConflict((conflict) => conflict.columns(['family_id', 'version']).doNothing()).execute();
      await tx.deleteFrom('skill_versions').where('owner_id', '=', ownerId).where('id', 'in', batch.map((row) => row.id)).execute();
      await tx.insertInto('skill_audit').values(batch.map((row) => ({
        id: randomUUID(), owner_id: ownerId, target_id: row.id, event: 'skill.pruned',
        detail: JSON.stringify({ policy: SKILL_RETENTION_POLICY, slug: row.slug, version: row.version, status: row.status, contentHash: row.content_hash }),
      }))).execute();
    }
    return { pruned: deletable.length };
  });
}
