import { DatabaseSync } from 'node:sqlite';
import { normalizeLookupKey } from './normalize.ts';
import { ENTITY_CATEGORIES, type BuildInput, type DataCard, type StoredEntity } from './types.ts';

export { normalizeLookupKey };
export type { BuildInput, DataCard, StoredEntity, StoredClaim, WikidataReference, WikidataSnak } from './types.ts';

const APPLICATION_ID = 0x4d4b4257;
const FORMAT_VERSION = 1;
const SCHEMA = `
  CREATE TABLE build (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    input TEXT NOT NULL,
    phase TEXT NOT NULL,
    offset INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    card TEXT
  );
  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    revision INTEGER,
    labels TEXT NOT NULL,
    descriptions TEXT NOT NULL,
    aliases TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE names (
    key TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    language TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (key, entity_id, language, kind, name)
  ) WITHOUT ROWID;
  CREATE TABLE categories (
    category TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    PRIMARY KEY (category, entity_id)
  ) WITHOUT ROWID;
  CREATE TABLE claims (
    entity_id TEXT NOT NULL REFERENCES entities(id),
    property TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    statement_id TEXT,
    rank TEXT NOT NULL,
    snak TEXT NOT NULL,
    qualifiers TEXT NOT NULL,
    refs TEXT NOT NULL,
    PRIMARY KEY (entity_id, property, ordinal)
  ) WITHOUT ROWID;
  CREATE INDEX claims_by_property ON claims (property, entity_id);
`;

export interface Checkpoint {
  phase: 'classes' | 'entities' | 'complete';
  offset: number;
}

export interface Build {
  db: DatabaseSync;
  readonly checkpoint: Checkpoint;
  commit(checkpoint: Checkpoint, work: (db: DatabaseSync) => void): void;
  writeEntities(entities: readonly StoredEntity[], checkpoint: Checkpoint): void;
  finish(cleanup?: (db: DatabaseSync) => void): DataCard;
  close(): void;
}

interface BuildRow extends Checkpoint {
  input: string;
  generation: number;
  card: string | null;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
  return Number(db.prepare(`PRAGMA ${key}`).get()?.[key]);
}

function checkFormat(db: DatabaseSync): void {
  if (pragma(db, 'application_id') !== APPLICATION_ID || pragma(db, 'user_version') !== FORMAT_VERSION) {
    throw new Error('Unsupported Wikidata knowledge store format');
  }
}

function canonicalInput(input: BuildInput): BuildInput {
  const date = new Date(input.dumpDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dumpDate) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== input.dumpDate) {
    throw new Error('Wikidata dump date must be a valid YYYY-MM-DD date');
  }
  if (!input.source.trim() || !input.fingerprint.trim() ||
      !input.categories.length || input.categories.some(category => !ENTITY_CATEGORIES.includes(category))) {
    throw new Error('Wikidata build requires a source, fingerprint and known categories');
  }
  return {
    source: input.source,
    dumpDate: input.dumpDate,
    fingerprint: input.fingerprint,
    categories: ENTITY_CATEGORIES.filter(category => input.categories.includes(category)),
  };
}

function readBuild(db: DatabaseSync): BuildRow {
  const row = db.prepare('SELECT input, phase, offset, generation, card FROM build WHERE id = 1').get();
  if (!row) throw new Error('Wikidata build metadata missing');
  return row as unknown as BuildRow;
}

export function openBuild(path: string, input: BuildInput): Build {
  const identity = canonicalInput(input);
  const serializedInput = JSON.stringify(identity);
  const db = new DatabaseSync(path);
  try {
    let current = transaction(db, () => {
      if (pragma(db, 'application_id') === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
        db.exec('PRAGMA auto_vacuum = INCREMENTAL');
        db.exec(SCHEMA);
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${FORMAT_VERSION}`);
        db.prepare("INSERT INTO build (id, input, phase, offset) VALUES (1, ?, 'classes', 0)").run(serializedInput);
      }
      checkFormat(db);
      const row = readBuild(db);
      if (row.input !== serializedInput) throw new Error('Wikidata store already belongs to a different build input');
      return row;
    });
    const insertEntity = db.prepare('INSERT INTO entities VALUES (?, ?, ?, ?, ?)');
    const insertName = db.prepare('INSERT INTO names VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    const insertCategory = db.prepare('INSERT INTO categories VALUES (?, ?)');
    const insertClaim = db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const advance = db.prepare('UPDATE build SET phase = ?, offset = ?, generation = generation + 1 WHERE id = 1');

    function assertCurrent(): void {
      const actual = readBuild(db);
      if (actual.generation !== current.generation) {
        throw new Error('Wikidata build checkpoint changed in another process');
      }
    }

    function commit(checkpoint: Checkpoint, work: (database: DatabaseSync) => void): void {
      const samePhase = checkpoint.phase === current.phase && checkpoint.offset >= current.offset;
      const nextPhase = current.phase === 'classes' && checkpoint.phase === 'entities' && checkpoint.offset === 0;
      if (!Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0 ||
          current.phase === 'complete' || !(samePhase || nextPhase)) {
        throw new Error('Invalid Wikidata build checkpoint');
      }
      transaction(db, () => {
        assertCurrent();
        work(db);
        advance.run(checkpoint.phase, checkpoint.offset);
      });
      current = { ...current, ...checkpoint, generation: current.generation + 1 };
    }

    return {
      db,
      get checkpoint() { return { phase: current.phase, offset: current.offset }; },
      commit,
      writeEntities(entities, checkpoint) {
        if (current.phase !== 'entities' || checkpoint.phase !== 'entities') {
          throw new Error('Wikidata entities can only be written in the entities phase');
        }
        commit(checkpoint, () => {
          for (const entity of entities) {
            insertEntity.run(entity.id, entity.revision, JSON.stringify(entity.labels), JSON.stringify(entity.descriptions), JSON.stringify(entity.aliases));
            for (const category of entity.categories) insertCategory.run(category, entity.id);
            for (const language of ['ar', 'en'] as const) {
              const label = entity.labels[language];
              const key = label && normalizeLookupKey(label);
              if (key) insertName.run(key, entity.id, language, 'label', label);
              for (const alias of entity.aliases[language] ?? []) {
                const aliasKey = normalizeLookupKey(alias);
                if (aliasKey) insertName.run(aliasKey, entity.id, language, 'alias', alias);
              }
            }
            for (const [ordinal, claim] of entity.claims.entries()) {
              insertClaim.run(entity.id, claim.property, ordinal, claim.id, claim.rank,
                JSON.stringify(claim.snak), JSON.stringify(claim.qualifiers), JSON.stringify(claim.references));
            }
          }
        });
      },
      finish(cleanup) {
        if (current.card) return JSON.parse(current.card) as DataCard;
        if (current.phase !== 'entities') throw new Error('Wikidata entities phase is incomplete');
        const card = transaction(db, () => {
          assertCurrent();
          cleanup?.(db);
          db.exec('PRAGMA incremental_vacuum');
          const result: DataCard = {
            ...identity,
            dataset: 'wikidata',
            license: 'CC0-1.0',
            scannedEntities: current.offset,
            entityCount: Number(db.prepare('SELECT count(*) AS count FROM entities').get()?.count),
            claimCount: Number(db.prepare('SELECT count(*) AS count FROM claims').get()?.count),
          };
          db.prepare("UPDATE build SET phase = 'complete', generation = generation + 1, card = ? WHERE id = 1")
            .run(JSON.stringify(result));
          return result;
        });
        current = { ...current, phase: 'complete', generation: current.generation + 1, card: JSON.stringify(card) };
        return card;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openKnowledgeStore(path: string): { db: DatabaseSync; card: DataCard; close(): void } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    checkFormat(db);
    const row = readBuild(db);
    if (row.phase !== 'complete' || !row.card) throw new Error('Wikidata build is incomplete');
    return { db, card: JSON.parse(row.card) as DataCard, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
