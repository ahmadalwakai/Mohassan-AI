import { appliesInYear, formatAmount, orderAmounts, orderedStatementDate, quantityInUnit, unitId, validateYear } from './query-values.ts';
import { prepareEntityLinker } from './entity-linking.ts';
import { normalizeLookupKey, openKnowledgeStore } from './store.ts';
import { ENTITY_CATEGORIES, type DataCard, type EntityCategory, type Language, type StoredClaim, type StoredEntity } from './types.ts';

export interface WikidataSource {
  dataset: DataCard['dataset'];
  dumpSource: string;
  dumpDate: string;
  fingerprint: string;
  license: DataCard['license'];
  revision: number | null;
  url: string;
}

type EntityMatch = { kind: 'id' } | { kind: 'label' | 'alias'; language: Language; text: string };

export interface EntityCandidate extends Pick<StoredEntity, 'labels' | 'aliases' | 'descriptions' | 'categories'> {
  entityId: string;
  match: EntityMatch;
  source: WikidataSource;
}

export interface Fact {
  entityId: string;
  property: string;
  statement: StoredClaim;
  source: WikidataSource;
}

export interface EntityLookupOptions {
  language?: Language;
  category?: EntityCategory;
  limit?: number;
}

export interface FactLookupOptions {
  /** Gregorian calendar year. Undated statements cannot substantiate a dated answer. */
  year?: number;
  /** Keep the earliest or latest dated values, observations or interval starts. */
  order?: 'earliest' | 'latest';
  /** Require an explicit point-in-time qualifier (P585) observed by the dump date. */
  pointInTimeOnly?: boolean;
  /** Keep normal as well as preferred statements. Deprecated statements are always excluded. */
  allRanks?: boolean;
}

interface QuantityQuery extends FactLookupOptions {
  property: string;
  /** A Wikidata unit QID or entity URL. Use '1' for unitless quantities. */
  unit: string;
}

export interface SuperlativeQuery extends QuantityQuery {
  category: EntityCategory;
  direction?: 'max' | 'min';
  /** Maximum number of tied entities to return. Defaults to 25. */
  limit?: number;
}

export interface SuperlativeResult {
  status: 'ranked' | 'partial' | 'unavailable';
  unit: string;
  /** Exact decimal representation of the extreme nominal amount, in the requested unit. */
  amount?: string;
  facts: Fact[];
  categoryEntities: number;
  comparableEntities: number;
  tieCount: number;
}

export interface ComparisonQuery extends QuantityQuery {
  entityIds: readonly string[];
}

export interface ComparisonRow {
  entityId: string;
  facts: Fact[];
  amount?: string;
}

export interface ComparisonResult {
  status: 'ordered' | 'incomplete';
  unit: string;
  /** Comparable rows are ordered by decreasing nominal amount, with unresolved rows last. */
  rows: ComparisonRow[];
}

interface EntityRow {
  id: string;
  revision: number | null;
  labels: string;
  descriptions: string;
  aliases: string;
}

interface NameRow extends EntityRow {
  kind: 'label' | 'alias';
  language: Language;
  name: string;
}

interface ClaimRow {
  entity_id: string;
  revision: number | null;
  property: string;
  statement_id: string | null;
  rank: StoredClaim['rank'];
  snak: string;
  qualifiers: string;
  refs: string;
}

const CLAIM_COLUMNS = 'c.entity_id, e.revision, c.property, c.statement_id, c.rank, c.snak, c.qualifiers, c.refs';

function sourceFor(card: DataCard, entityId: string, revision: number | null): WikidataSource {
  return {
    dataset: card.dataset, dumpSource: card.source, dumpDate: card.dumpDate,
    fingerprint: card.fingerprint, license: card.license, revision,
    url: revision === null ? `https://www.wikidata.org/wiki/${entityId}` :
      `https://www.wikidata.org/wiki/Special:PermanentLink/${revision}`,
  };
}

type DatedFact = { fact: Fact; earliest: number; latest: number };

function chronologicalFacts(facts: DatedFact[], order: NonNullable<FactLookupOptions['order']>, allRanks: boolean): Fact[] {
  const pivot = order === 'latest'
    ? facts.reduce((latestStart, date) => Math.max(latestStart, date.earliest), -Infinity)
    : facts.reduce((earliestEnd, date) => Math.min(earliestEnd, date.latest), Infinity);
  // Every interval that can still be the extreme is needed to expose uncertain order.
  const candidates = facts.filter(date => order === 'latest' ? date.latest >= pivot : date.earliest <= pivot);
  if (allRanks) return candidates.map(({ fact }) => fact);
  const interval = (date: DatedFact) => `${date.earliest}:${date.latest}`;
  const preferred = new Set(candidates.filter(({ fact }) => fact.statement.rank === 'preferred').map(interval));
  return candidates.filter(date => date.fact.statement.rank === 'preferred' || !preferred.has(interval(date)))
    .map(({ fact }) => fact);
}

function bestFacts(rows: readonly ClaimRow[], card: DataCard, options: FactLookupOptions, snapshotDay: number): Fact[] {
  const { year, order, pointInTimeOnly = false, allRanks = false } = options;
  const byRank = !allRanks && !order;
  let facts: Fact[] = [];
  const dated: DatedFact[] = [];
  for (const row of rows) {
    if (byRank && facts[0]?.statement.rank === 'preferred' && row.rank === 'normal') continue;
    const statement: StoredClaim = {
      property: row.property, id: row.statement_id, rank: row.rank, snak: JSON.parse(row.snak),
      qualifiers: JSON.parse(row.qualifiers), references: JSON.parse(row.refs),
    };
    if (year !== undefined && !appliesInYear(statement, year, snapshotDay)) continue;
    const date = (order || pointInTimeOnly) ? orderedStatementDate(statement, pointInTimeOnly) : undefined;
    if (pointInTimeOnly && (!date || date.earliest > snapshotDay)) continue;
    const fact = {
      entityId: row.entity_id, property: row.property, statement,
      source: sourceFor(card, row.entity_id, row.revision),
    };
    if (order) {
      if (date) dated.push({ fact, ...date });
    } else {
      if (byRank && facts[0]?.statement.rank === 'normal' && row.rank === 'preferred') facts = [];
      facts.push(fact);
    }
  }
  return order ? chronologicalFacts(dated, order, allRanks) : facts;
}

function uniqueAmount(facts: readonly Fact[], unit: string) {
  const first = facts[0] && quantityInUnit(facts[0].statement, unit);
  if (!first) return undefined;
  for (const fact of facts.slice(1)) {
    const next = quantityInUnit(fact.statement, unit);
    if (!next || orderAmounts(first, next) !== 0) return undefined;
  }
  return first;
}

function queryUnit(options: QuantityQuery): string {
  validateYear(options.year);
  const unit = unitId(options.unit);
  if (!unit) throw new TypeError('Expected a Wikidata unit QID, entity URL, or 1');
  return unit;
}

function resultLimit(limit: number | undefined, defaultLimit: number): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Result limit must be an integer from 1 to 100');
  }
  return limit;
}

/** Opens a completed local Wikidata snapshot without mutating it or making network requests. */
export function openKnowledgeBase(databasePath: string) {
  const { db, card, close } = openKnowledgeStore(databasePath);
  const snapshotDay = Number(card.dumpDate.replaceAll('-', ''));
  const entityById = db.prepare('SELECT * FROM entities WHERE id = ?');
  const membership = db.prepare('SELECT 1 FROM categories WHERE category = ? AND entity_id = ?');
  const entityByName = db.prepare(`
    WITH matches AS (
      SELECT n.entity_id, n.kind, n.language, n.name,
        row_number() OVER (PARTITION BY n.entity_id ORDER BY n.kind = 'alias', n.language, n.name) AS precedence
      FROM names n
      WHERE n.key = ? AND (? IS NULL OR n.language = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM categories WHERE category = ? AND entity_id = n.entity_id))
    )
    SELECT e.*, m.kind, m.language, m.name
    FROM matches m JOIN entities e ON e.id = m.entity_id
    WHERE m.precedence = 1
    ORDER BY m.kind = 'alias', e.id
    LIMIT ?
  `);
  const factsByEntity = db.prepare(`
    SELECT ${CLAIM_COLUMNS} FROM claims c JOIN entities e ON e.id = c.entity_id
    WHERE c.entity_id = ? AND c.property = ? AND c.rank <> 'deprecated'
    ORDER BY c.ordinal
  `);
  const factsByCategory = db.prepare(`
    SELECT ${CLAIM_COLUMNS} FROM claims c
    JOIN categories m ON m.entity_id = c.entity_id AND m.category = ?
    JOIN entities e ON e.id = c.entity_id
    WHERE c.property = ? AND c.rank <> 'deprecated'
    ORDER BY c.entity_id, c.ordinal
  `);
  const countCategory = db.prepare('SELECT count(*) AS count FROM categories WHERE category = ?');

  function entityCandidate(row: EntityRow, match: EntityMatch): EntityCandidate {
    return {
      entityId: row.id, labels: JSON.parse(row.labels), descriptions: JSON.parse(row.descriptions),
      aliases: JSON.parse(row.aliases), match,
      categories: ENTITY_CATEGORIES.filter(category => membership.get(category, row.id) !== undefined),
      source: sourceFor(card, row.id, row.revision),
    };
  }

  function lookupEntity(text: string, options: EntityLookupOptions = {}): EntityCandidate[] {
    const limit = resultLimit(options.limit, 10);
    const { language = null, category = null } = options;
    const id = text.trim().toUpperCase();
    if (/^Q[1-9]\d*$/u.test(id)) {
      const row = entityById.get(id) as unknown as EntityRow | undefined;
      return row && (!category || membership.get(category, row.id)) ? [entityCandidate(row, { kind: 'id' })] : [];
    }
    const key = normalizeLookupKey(text);
    if (!key) return [];
    const matches = entityByName.all(key, language, language, category, category, limit) as unknown as NameRow[];
    return matches.map(row => entityCandidate(row, { kind: row.kind, language: row.language, text: row.name }));
  }

  function lookupFacts(entityId: string, property: string, options: FactLookupOptions = {}): Fact[] {
    validateYear(options.year);
    return bestFacts(factsByEntity.all(entityId, property) as unknown as ClaimRow[], card, options, snapshotDay);
  }

  function superlative(options: SuperlativeQuery): SuperlativeResult {
    const unit = queryUnit(options);
    const limit = resultLimit(options.limit, 25);
    const categoryEntities = Number(countCategory.get(options.category)?.count);
    const rows = factsByCategory.iterate(options.category, options.property) as unknown as Iterable<ClaimRow>;
    let group: ClaimRow[] = [];
    let best: ReturnType<typeof uniqueAmount>;
    let facts: Fact[] = [];
    let comparableEntities = 0;
    let tieCount = 0;

    function consider(rows: ClaimRow[]) {
      if (!rows.length) return;
      const candidates = bestFacts(rows, card, options, snapshotDay);
      const amount = uniqueAmount(candidates, unit);
      if (!amount) return;
      comparableEntities++;
      const order = best && orderAmounts(amount, best);
      if (order === undefined || order === (options.direction === 'min' ? -1 : 1)) {
        best = amount;
        facts = candidates;
        tieCount = 1;
      } else if (order === 0) {
        if (tieCount < limit) for (const candidate of candidates) facts.push(candidate);
        tieCount++;
      }
    }

    for (const row of rows) {
      if (group.length && group[0].entity_id !== row.entity_id) {
        consider(group);
        group = [];
      }
      group.push(row);
    }
    consider(group);
    return {
      status: best === undefined ? 'unavailable' : comparableEntities < categoryEntities ? 'partial' : 'ranked',
      unit, ...(best === undefined ? {} : { amount: formatAmount(best) }),
      facts, categoryEntities, comparableEntities, tieCount,
    };
  }

  function compare(options: ComparisonQuery): ComparisonResult {
    const unit = queryUnit(options);
    const entities = new Set(options.entityIds);
    if (entities.size < 2) throw new RangeError('Comparison requires two or more distinct entity IDs');
    const comparable = [];
    const unresolved: ComparisonRow[] = [];
    for (const entityId of entities) {
      const facts = lookupFacts(entityId, options.property, options);
      const amount = uniqueAmount(facts, unit);
      if (amount) comparable.push({ entityId, facts, amount });
      else unresolved.push({ entityId, facts });
    }
    comparable.sort((a, b) => orderAmounts(b.amount, a.amount));
    return {
      status: unresolved.length ? 'incomplete' : 'ordered', unit,
      rows: [...comparable.map(row => ({ ...row, amount: formatAmount(row.amount) })), ...unresolved],
    };
  }

  const linkEntity = prepareEntityLinker(db, lookupEntity);
  return { card, lookupEntity, linkEntity, lookupFacts, superlative, compare, close };
}
