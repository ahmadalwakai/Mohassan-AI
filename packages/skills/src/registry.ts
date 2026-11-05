import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  SkillContractSchema, SkillDetailSchema, SkillRegistryQuerySchema, SkillRegistryResultSchema,
  type SkillContract, type SkillDetail, type SkillRegistryResult, type SkillVersion,
} from '@mohassan/contracts';
import { builtinSkills } from './builtin/index.ts';
import { legacyDetail, legacySkills } from './legacy.ts';

export class SkillError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'SkillError'; }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

/** The hash covers the contract and every file, so any change is a different version. */
export function skillContentHash(contract: SkillContract, files: readonly { path: string; content: string }[]): string {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(({ path, content }) => ({ path, hash: sha256(content) }));
  return sha256(JSON.stringify({ contract, files: ordered }));
}

function versionDto(row: any, activeVersionId: string | null): SkillVersion {
  return {
    id: row.id, familyId: row.family_id, slug: row.slug, name: row.name, description: row.description, category: row.category,
    version: row.version, revision: row.revision, level: row.level, origin: row.origin, status: row.status, statusReason: row.status_reason ?? null,
    contentHash: row.content_hash, active: activeVersionId === row.id, readOnly: false, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export function createSkillRegistry(db: Kysely<any>) {
  async function audit(connection: Kysely<any>, ownerId: string, targetId: string, event: string, detail: Record<string, unknown> = {}) {
    await connection.insertInto('skill_audit').values({ id: randomUUID(), owner_id: ownerId, target_id: targetId, event, detail: JSON.stringify(detail) }).execute();
  }

  /** Safe to repeat and to race: the unique slug decides, and a seeded skill still needs inspection and approval. */
  async function seedBuiltins(ownerId: string): Promise<void> {
    const seeded = new Set((await db.selectFrom('skill_families').select('slug').where('owner_id', '=', ownerId).execute()).map((row) => row.slug));
    for (const { contract, instructions } of builtinSkills) {
      if (seeded.has(contract.slug)) continue;
      const files = [{ path: 'SKILL.md', content: instructions }];
      const contentHash = skillContentHash(contract, files);
      await db.transaction().execute(async (tx) => {
        const familyId = randomUUID();
        const family = await tx.insertInto('skill_families').values({ id: familyId, owner_id: ownerId, slug: contract.slug }).onConflict((conflict) => conflict.columns(['owner_id', 'slug']).doNothing()).returning('id').executeTakeFirst();
        if (!family) return;
        const id = randomUUID();
        await tx.insertInto('skill_versions').values({
          id, family_id: familyId, owner_id: ownerId, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category,
          level: contract.level, origin: 'custom', status: 'quarantined', status_reason: 'بانتظار الفحص والموافقة.', contract: JSON.stringify(contract), content_hash: contentHash,
        }).execute();
        await tx.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content: instructions, content_hash: sha256(instructions), size_bytes: Buffer.byteLength(instructions, 'utf8') }).execute();
        await tx.insertInto('skill_sources').values({ version_id: id, kind: 'builtin', locator: `builtin:${contract.slug}`, file_count: 1, total_bytes: Buffer.byteLength(instructions, 'utf8') }).execute();
        await audit(tx, ownerId, id, 'skill.seeded', { slug: contract.slug, contentHash });
      });
    }
  }

  async function list(ownerId: string, input: unknown): Promise<SkillRegistryResult> {
    const query = SkillRegistryQuerySchema.parse(input ?? {});
    await seedBuiltins(ownerId);
    const rows = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
      .select(['v.id', 'v.family_id', 'f.slug', 'f.active_version_id', 'v.name', 'v.description', 'v.category', 'v.version', 'v.revision', 'v.level', 'v.origin', 'v.status', 'v.status_reason', 'v.content_hash', 'v.created_at', 'v.updated_at'])
      .where('v.owner_id', '=', ownerId).orderBy('v.updated_at', 'desc').orderBy('v.id').limit(500).execute();
    const merged: SkillVersion[] = [...rows.map((row) => versionDto(row, row.active_version_id)), ...await legacySkills(db, ownerId)];
    const needle = query.q.toLocaleLowerCase('ar');
    const matches = merged.filter((skill) =>
      (!needle || [skill.name, skill.description, skill.slug].some((text) => text.toLocaleLowerCase('ar').includes(needle)))
      && (!query.category || skill.category === query.category) && (!query.level || skill.level === query.level)
      && (!query.status || skill.status === query.status) && (!query.origin || skill.origin === query.origin));
    const tally = (key: 'category' | 'level') => matches.reduce<Record<string, number>>((counts, skill) => ({ ...counts, [skill[key]]: (counts[skill[key]] ?? 0) + 1 }), {});
    return SkillRegistryResultSchema.parse({ items: matches.slice(query.offset, query.offset + query.limit), total: matches.length, counts: { category: tally('category'), level: tally('level') } });
  }

  async function detail(ownerId: string, id: string): Promise<SkillDetail> {
    const row = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').select(['v.id', 'v.family_id', 'f.slug', 'f.active_version_id', 'v.name', 'v.description', 'v.category', 'v.version', 'v.revision', 'v.level', 'v.origin', 'v.status', 'v.status_reason', 'v.content_hash', 'v.created_at', 'v.updated_at', 'v.contract']).where('v.owner_id', '=', ownerId).where('v.id', '=', id).executeTakeFirst();
    if (!row) {
      const legacy = await legacyDetail(db, ownerId, id);
      if (legacy) return SkillDetailSchema.parse(legacy);
      throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
    }
    const [files, source, siblings, events] = await Promise.all([
      db.selectFrom('skill_files').select(['path', 'kind', 'content_hash', 'size_bytes']).where('version_id', '=', id).orderBy('path').execute(),
      db.selectFrom('skill_sources').selectAll().where('version_id', '=', id).executeTakeFirst(),
      db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').select(['v.id', 'v.family_id', 'f.slug', 'f.active_version_id', 'v.name', 'v.description', 'v.category', 'v.version', 'v.revision', 'v.level', 'v.origin', 'v.status', 'v.status_reason', 'v.content_hash', 'v.created_at', 'v.updated_at']).where('v.owner_id', '=', ownerId).where('v.family_id', '=', row.family_id).orderBy('v.sequence', 'desc').limit(50).execute(),
      db.selectFrom('skill_audit').selectAll().where('owner_id', '=', ownerId).where('target_id', '=', id).orderBy('created_at', 'desc').limit(50).execute(),
    ]);
    return SkillDetailSchema.parse({
      skill: versionDto(row, row.active_version_id), contract: SkillContractSchema.parse(json(row.contract)),
      source: source ? { kind: source.kind, locator: source.locator, observedAt: iso(source.observed_at), fileCount: source.file_count, totalBytes: source.total_bytes } : null,
      files: files.map((file) => ({ path: file.path, kind: file.kind, contentHash: file.content_hash, sizeBytes: file.size_bytes })),
      versions: siblings.map((sibling) => versionDto(sibling, sibling.active_version_id)),
      audit: events.map((event) => ({ id: event.id, targetId: event.target_id, event: event.event, detail: json(event.detail), createdAt: iso(event.created_at) })),
    });
  }

  return { list, detail, seedBuiltins, audit };
}
