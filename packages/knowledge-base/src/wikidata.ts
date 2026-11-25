import { stat } from 'node:fs/promises';
import { dumpFingerprint, dumpRecords } from './dump.ts';
import { openBuild, type Build } from './store.ts';
import {
  ENTITY_CATEGORIES,
  type DataCard,
  type EntityCategory,
  type Language,
  type StoredClaim,
  type StoredEntity,
  type WikidataReference,
  type WikidataSnak,
} from './types.ts';

const COUNTRY_CLASSES = ['Q6256', 'Q3624078'];
const CITY_CLASSES = ['Q515', 'Q1549591'];
export const WIKIDATA_CATEGORY_ROOTS: Readonly<Record<EntityCategory, readonly string[]>> = {
  people: ['Q5'],
  places: ['Q17334923', 'Q2221906', 'Q27096213', 'Q486972', 'Q82794', ...COUNTRY_CLASSES, ...CITY_CLASSES],
  countries: COUNTRY_CLASSES,
  cities: CITY_CLASSES,
  organizations: ['Q43229', 'Q4830453', 'Q3918'],
  events: ['Q1190554', 'Q1656682', 'Q198'],
  works: ['Q386724', 'Q17537576', 'Q7725634', 'Q571', 'Q11424', 'Q5398426', 'Q3305213', 'Q13442814', 'Q7366', 'Q482994', 'Q7889'],
  units: ['Q47574'],
};

const ITEM_ID = /^Q[1-9]\d*$/;
const LANGUAGES = ['ar', 'en'] as const;
const MAX_BATCH_CHARACTERS = 8 * 1024 * 1024;
const MAX_BATCH_EDGES = 5000;

interface DumpTerm {
  value: string;
}

interface DumpStatement {
  id?: string;
  rank: StoredClaim['rank'];
  mainsnak: WikidataSnak;
  qualifiers?: Record<string, WikidataSnak[]>;
  references?: WikidataReference[];
}

interface DumpItem {
  type: 'item';
  id: string;
  lastrevid?: number;
  labels?: Partial<Record<Language, DumpTerm>>;
  descriptions?: Partial<Record<Language, DumpTerm>>;
  aliases?: Partial<Record<Language, DumpTerm[]>>;
  claims?: Record<string, DumpStatement[]>;
}

export interface WikidataImportOptions {
  inputPath: string;
  databasePath: string;
  source: string;
  dumpDate: string;
  categories?: readonly EntityCategory[];
  batchSize?: number;
  signal?: AbortSignal;
}

function parseItem(record: string, offset: number): DumpItem | undefined {
  let entry: DumpItem;
  try {
    entry = JSON.parse(record) as DumpItem;
  } catch (error) {
    throw new Error(`Invalid Wikimedia JSON dump record ${offset}`, { cause: error });
  }
  if (entry.type !== 'item') return undefined;
  if (typeof entry.id !== 'string' || !ITEM_ID.test(entry.id)) {
    throw new Error(`Invalid Wikidata item ID in dump record ${offset}`);
  }
  return entry;
}

function itemTargets(statements: readonly DumpStatement[] | undefined): string[] {
  const targets: string[] = [];
  for (const statement of statements ?? []) {
    if (statement.rank === 'deprecated' || statement.mainsnak?.snaktype !== 'value') continue;
    const data = statement.mainsnak.datavalue;
    if (data?.type !== 'wikibase-entityid' || typeof data.value !== 'object' || data.value === null) continue;
    const { id, 'entity-type': entityType, 'numeric-id': numericId } = data.value as {
      id?: string;
      'entity-type'?: string;
      'numeric-id'?: number;
    };
    const target = id ?? (entityType === 'item' && Number.isSafeInteger(numericId) ? `Q${numericId}` : '');
    if (ITEM_ID.test(target)) targets.push(target);
  }
  return targets;
}

function projectItem(item: DumpItem, categories: EntityCategory[]): StoredEntity {
  const entity: StoredEntity = {
    id: item.id,
    revision: Number.isSafeInteger(item.lastrevid) ? item.lastrevid as number : null,
    categories,
    labels: {},
    descriptions: {},
    aliases: {},
    claims: [],
  };
  for (const language of LANGUAGES) {
    const label = item.labels?.[language]?.value;
    const description = item.descriptions?.[language]?.value;
    const aliases = item.aliases?.[language]?.map(term => term.value);
    if (label) entity.labels[language] = label;
    if (description) entity.descriptions[language] = description;
    if (aliases?.length) entity.aliases[language] = aliases;
  }
  for (const [property, statements] of Object.entries(item.claims ?? {})) {
    for (const statement of statements) {
      entity.claims.push({
        property,
        id: statement.id ?? null,
        rank: statement.rank,
        snak: statement.mainsnak,
        qualifiers: statement.qualifiers ?? {},
        references: statement.references ?? [],
      });
    }
  }
  return entity;
}

async function collectClasses(build: Build, options: WikidataImportOptions, categories: readonly EntityCategory[],
  batchSize: number, verifyInput: () => Promise<void>): Promise<void> {
  build.commit(build.checkpoint, db => db.exec(`
    CREATE TABLE IF NOT EXISTS class_edges (
      parent TEXT NOT NULL,
      child TEXT NOT NULL,
      PRIMARY KEY (parent, child)
    ) WITHOUT ROWID;
  `));
  const insert = build.db.prepare('INSERT OR IGNORE INTO class_edges VALUES (?, ?)');
  let offset = build.checkpoint.offset;
  const edges: [string, string][] = [];
  for await (const next of dumpRecords(options.inputPath, offset, options.signal)) {
    // Property P279 is serialized as a JSON object key in the publisher's dump.
    const item = /"P279"\s*:/.test(next.record) ? parseItem(next.record, next.offset) : undefined;
    if (item) for (const parent of itemTargets(item.claims?.P279)) edges.push([parent, item.id]);
    offset = next.offset;
    if (offset - build.checkpoint.offset >= batchSize || edges.length >= MAX_BATCH_EDGES) {
      await verifyInput();
      build.commit({ phase: 'classes', offset }, () => {
        for (const edge of edges) insert.run(...edge);
      });
      edges.length = 0;
    }
  }
  options.signal?.throwIfAborted();
  await verifyInput();
  build.commit({ phase: 'entities', offset: 0 }, db => {
    for (const edge of edges) insert.run(...edge);
    db.exec(`
      CREATE TABLE class_categories (
        class TEXT NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (class, category)
      ) WITHOUT ROWID;
    `);
    const resolve = db.prepare(`
      WITH RECURSIVE classes(id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT child FROM class_edges JOIN classes ON parent = classes.id
      )
      INSERT INTO class_categories SELECT id, ? FROM classes
    `);
    for (const category of categories) resolve.run(JSON.stringify(WIKIDATA_CATEGORY_ROOTS[category]), category);
    db.exec('DROP TABLE class_edges');
  });
}

async function collectEntities(build: Build, options: WikidataImportOptions, batchSize: number,
  verifyInput: () => Promise<void>): Promise<void> {
  const lookup = build.db.prepare(`
    SELECT DISTINCT category FROM class_categories
    WHERE class IN (SELECT value FROM json_each(?)) ORDER BY category
  `);
  let offset = build.checkpoint.offset;
  let batchCharacters = 0;
  const entities: StoredEntity[] = [];
  for await (const next of dumpRecords(options.inputPath, offset, options.signal)) {
    const item = parseItem(next.record, next.offset);
    if (item) {
      const targets = itemTargets(item.claims?.P31);
      const categories = targets.length
        ? lookup.all(JSON.stringify(targets)).map(row => row.category as EntityCategory)
        : [];
      if (categories.length) {
        entities.push(projectItem(item, categories));
        batchCharacters += next.record.length;
      }
    }
    offset = next.offset;
    if (offset - build.checkpoint.offset >= batchSize || batchCharacters >= MAX_BATCH_CHARACTERS) {
      await verifyInput();
      build.writeEntities(entities, { phase: 'entities', offset });
      entities.length = 0;
      batchCharacters = 0;
    }
  }
  options.signal?.throwIfAborted();
  await verifyInput();
  if (offset !== build.checkpoint.offset) build.writeEntities(entities, { phase: 'entities', offset });
}

export async function importWikidata(options: WikidataImportOptions): Promise<DataCard> {
  const categories = options.categories ?? ENTITY_CATEGORIES;
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('Wikidata import batch size must be a positive integer');
  }

  const inputStat = await stat(options.inputPath, { bigint: true });
  if (!inputStat.isFile()) throw new Error('Wikidata dump must be a local file');
  async function verifyInput(): Promise<void> {
    const current = await stat(options.inputPath, { bigint: true });
    if (current.dev !== inputStat.dev || current.ino !== inputStat.ino || current.size !== inputStat.size ||
        current.ctimeNs !== inputStat.ctimeNs || current.mtimeNs !== inputStat.mtimeNs) {
      throw new Error('Wikidata dump file changed while being imported');
    }
  }
  const fingerprint = await dumpFingerprint(options.inputPath, options.signal);
  await verifyInput();
  options.signal?.throwIfAborted();

  const build = openBuild(options.databasePath, {
    source: options.source, dumpDate: options.dumpDate, categories, fingerprint,
  });
  try {
    if (build.checkpoint.phase === 'classes') await collectClasses(build, options, [...new Set(categories)], batchSize, verifyInput);
    if (build.checkpoint.phase === 'entities') await collectEntities(build, options, batchSize, verifyInput);
    return build.finish(db => db.exec('DROP TABLE class_categories'));
  } finally {
    build.close();
  }
}
