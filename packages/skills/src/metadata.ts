import type { Kysely } from 'kysely';
import { SkillCategorySchema } from '@mohassan/contracts';
import type { SkillContextMetadata } from './router.ts';

/** The metadata columns every instruction-selection path reads; the body is never part of it. */
export const METADATA_COLUMNS = ['v.id', 'f.slug', 'v.name', 'v.description', 'v.category', 'v.version', 'v.content_hash'] as const;
const metadata = (row: any): SkillContextMetadata => ({ id: row.id, slug: row.slug, name: row.name, description: row.description, category: row.category, version: row.version, contentHash: row.content_hash });
const bounds = { id: 100, slug: 64, name: 100, description: 1000, version: 30, content_hash: 64 } as const;

/** Rows outside the stored bounds or with an unknown category never become candidates. */
export const metadataRows = (rows: any[]): SkillContextMetadata[] => rows.filter(row => (Object.keys(bounds) as (keyof typeof bounds)[]).every(key => typeof row[key] === 'string' && row[key].length <= bounds[key]) && SkillCategorySchema.safeParse(row.category).success).map(metadata);
export const metadataOf = metadata;

/** Active instruction versions of one owner: the active pointer of the family, status active, level instruction. */
export function instructionMetadataQuery(db: Kysely<any>, ownerId: string) {
  return db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
    .select(METADATA_COLUMNS).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId)
    .where('v.status', '=', 'active').where('v.level', '=', 'instruction').whereRef('f.active_version_id', '=', 'v.id');
}
