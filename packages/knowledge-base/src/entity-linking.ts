import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { compatibleTransliteration, reverseTransliterationKeys, transliterationForms } from './entity-linking-keys.ts';
import { normalizeLookupKey } from './normalize.ts';
import type { EntityCandidate, EntityLookupOptions } from './query.ts';
import type { EntityCategory, Language } from './types.ts';

export interface LinkedEntityCandidate extends EntityCandidate {
  matchMethod: 'id' | 'name' | 'transliteration';
  sitelinkCount: number | null;
}

export type EntityLinkResult =
  | { status: 'linked'; candidate: LinkedEntityCandidate }
  | { status: 'ambiguous'; candidates: LinkedEntityCandidate[] }
  | { status: 'missing' };

export interface EntityLinkOptions {
  language?: Language;
  category?: EntityCategory;
}

// Auxiliary indexes are optional for existing v1 stores and never change the exact-name index.
export const ENTITY_LINK_SCHEMA = `
  CREATE TABLE entity_link_names (
    key TEXT NOT NULL,
    script TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    name TEXT NOT NULL,
    phones TEXT NOT NULL,
    PRIMARY KEY (key, script, entity_id, kind, language, name, phones)
  ) WITHOUT ROWID;
  CREATE TABLE entity_link_popularity (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id),
    sitelink_count INTEGER NOT NULL CHECK (sitelink_count >= 0)
  ) WITHOUT ROWID;
`;

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function prepareEntityLinkWriter(db: DatabaseSync) {
  const insertName = hasTable(db, 'entity_link_names') ? db.prepare(
    'INSERT INTO entity_link_names VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  ) : undefined;
  const insertPopularity = hasTable(db, 'entity_link_popularity') ? db.prepare(
    'INSERT INTO entity_link_popularity VALUES (?, ?)',
  ) : undefined;
  return {
    name(entityId: string, kind: 'label' | 'alias', language: Language, name: string) {
      if (!insertName) return;
      const transliterated = transliterationForms(name);
      if (!transliterated) return;
      for (const form of transliterated.forms) {
        insertName.run(form.key, transliterated.script, entityId, kind, language, name, form.phones);
      }
    },
    popularity(entityId: string, count: number | undefined) {
      if (count !== undefined && Number.isSafeInteger(count) && count >= 0) insertPopularity?.run(entityId, count);
    },
  };
}

interface NameMatch {
  entity_id: string;
  kind: 'label' | 'alias';
  language: Language;
  name: string;
  sitelink_count: number | null;
}

function linkResult(candidates: LinkedEntityCandidate[]): EntityLinkResult {
  if (!candidates.length) return { status: 'missing' };
  if (candidates.length === 1) return { status: 'linked', candidate: candidates[0] };
  return { status: 'ambiguous', candidates };
}

/** Prepare bounded lookups against the existing exact index and the optional cross-script index. */
export function prepareEntityLinker(db: DatabaseSync,
  lookupEntity: (text: string, options?: EntityLookupOptions) => EntityCandidate[]) {
  const hasPopularity = hasTable(db, 'entity_link_popularity');
  const prior = hasPopularity ? db.prepare('SELECT sitelink_count FROM entity_link_popularity WHERE entity_id = ?') : undefined;

  function prepareMatches(surfaceMatches: string): StatementSync {
    return db.prepare(`
      WITH surface_matches AS (${surfaceMatches}), ranked AS (
        SELECT m.*, row_number() OVER (PARTITION BY m.entity_id
          ORDER BY (m.language IS $language) DESC, m.kind = 'alias', m.language, m.name) AS precedence
        FROM surface_matches m
        WHERE $category IS NULL OR EXISTS (
          SELECT 1 FROM categories WHERE category = $category AND entity_id = m.entity_id
        )
      )
      SELECT m.entity_id, m.kind, m.language, m.name, ${hasPopularity ? 'p.sitelink_count' : 'NULL'} AS sitelink_count
      FROM ranked m ${hasPopularity ? 'LEFT JOIN entity_link_popularity p ON p.entity_id = m.entity_id' : ''}
      WHERE m.precedence = 1
      ORDER BY m.kind = 'alias', (m.language IS $language) DESC, sitelink_count DESC, length(m.entity_id), m.entity_id
      LIMIT 4
    `);
  }

  const exact = prepareMatches(`
    SELECT entity_id, kind, language, name FROM names WHERE key IN (SELECT value FROM json_each($keys))
  `);
  let crossScript: StatementSync | undefined;
  if (hasTable(db, 'entity_link_names')) {
    db.function('mohassan_link_phones', { deterministic: true }, (arabic, latin) =>
      typeof arabic === 'string' && typeof latin === 'string' && compatibleTransliteration(arabic, latin) ? 1 : 0);
    crossScript = prepareMatches(`
      SELECT n.entity_id, n.kind, n.language, n.name
      FROM json_each($forms) k JOIN entity_link_names n
        ON n.key = json_extract(k.value, '$.key') AND n.script = $targetScript
      WHERE CASE WHEN $targetScript = 'ar' THEN mohassan_link_phones(n.phones, json_extract(k.value, '$.phones'))
        ELSE mohassan_link_phones(json_extract(k.value, '$.phones'), n.phones) END
    `);
  }

  function candidates(rows: NameMatch[], matchMethod: 'name' | 'transliteration'): LinkedEntityCandidate[] {
    return rows.flatMap(row => {
      const [entity] = lookupEntity(row.entity_id);
      return entity ? [{
        ...entity, match: { kind: row.kind, language: row.language, text: row.name },
        matchMethod, sitelinkCount: row.sitelink_count,
      }] : [];
    });
  }

  return function linkEntity(mention: string, options: EntityLinkOptions = {}): EntityLinkResult {
    if (/^q[1-9]\d*$/iu.test(mention.trim())) {
      const [candidate] = lookupEntity(mention, { category: options.category });
      if (!candidate) return { status: 'missing' };
      const count = prior?.get(candidate.entityId)?.sitelink_count;
      return { status: 'linked', candidate: {
        ...candidate, matchMethod: 'id', sitelinkCount: typeof count === 'number' ? count : null,
      } };
    }
    const key = normalizeLookupKey(mention);
    if (!key) return { status: 'missing' };
    const params = { $language: options.language ?? null, $category: options.category ?? null };
    const direct = exact.all({ ...params, $keys: JSON.stringify([key]) }) as unknown as NameMatch[];
    if (direct.length) return linkResult(candidates(direct, 'name'));

    const transliterated = transliterationForms(mention);
    if (!transliterated) return { status: 'missing' };
    const rows = crossScript ? crossScript.all({
      ...params, $forms: JSON.stringify(transliterated.forms), $targetScript: transliterated.script === 'ar' ? 'en' : 'ar',
    }) : exact.all({ ...params, $keys: JSON.stringify(reverseTransliterationKeys(transliterated)) });
    return linkResult(candidates(rows as unknown as NameMatch[], 'transliteration'));
  };
}
