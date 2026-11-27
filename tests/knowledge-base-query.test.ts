import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openKnowledgeBase } from '../packages/knowledge-base/src/query.ts';
import { openBuild } from '../packages/knowledge-base/src/store.ts';
import type { StoredClaim, StoredEntity, WikidataSnak } from '../packages/knowledge-base/src/types.ts';

const cairo = 'Q900000001';
const cairoAlias = 'Q900000002';
const regionA = 'Q900000010';
const regionB = 'Q900000011';
const regionC = 'Q900000012';
const regionD = 'Q900000013';
const area = 'P2046';
const population = 'P1082';
const incumbent = 'P35';
const headOfGovernment = 'P6';
const inception = 'P571';
const squareKilometre = 'Q712226';
const squareMetre = 'Q25343';
const dumpDate = '2026-11-01';
const dumpSource = 'fixture:knowledge-base-query';
const fingerprint = 'sha256:3dcc0547d3d495babf91324d070f455038483b8a7fd9dad7e98eb08e099fd5096';

function entity(id: string, fields: Partial<StoredEntity>): StoredEntity {
  return { id, revision: null, labels: {}, aliases: {}, descriptions: {}, categories: [], claims: [], ...fields };
}

function time(property: string, date: string, precision = 9, calendar = 'Q1985727'): WikidataSnak {
  return {
    snaktype: 'value', property, datatype: 'time',
    datavalue: {
      type: 'time', value: {
        time: `+${date}T00:00:00Z`, precision, before: 0, after: 0, timezone: 0,
        calendarmodel: `http://www.wikidata.org/entity/${calendar}`,
      },
    },
  };
}

const at2020 = time('P585', '2020-00-00');
const at2021 = time('P585', '2021-01-01', 11);

function quantity(property: string, amount: string, unit: string, options: Partial<StoredClaim> = {}): StoredClaim {
  return {
    property, id: null, rank: 'normal', qualifiers: {}, references: [],
    snak: {
      snaktype: 'value', property, datatype: 'quantity',
      datavalue: { type: 'quantity', value: { amount, unit: unit === '1' ? unit : `http://www.wikidata.org/entity/${unit}` } },
    },
    ...options,
  };
}

function itemClaim(property: string, id: string, qualifiers: StoredClaim['qualifiers']): StoredClaim {
  return {
    property, id: null, rank: 'normal', qualifiers, references: [],
    snak: { snaktype: 'value', property, datatype: 'wikibase-item', datavalue: { type: 'wikibase-entityid', value: { id } } },
  };
}

function dateClaim(property: string, date: string, precision: number): StoredClaim {
  return { property, id: null, rank: 'normal', qualifiers: {}, references: [], snak: time(property, date, precision) };
}

const datedPopulation = quantity(population, '+100', '1', {
  id: `${cairo}$source-fixture`, qualifiers: { P585: [at2020] },
  references: [{
    hash: 'fixture-reference',
    snaks: {
      P854: [{ snaktype: 'value', property: 'P854', datatype: 'url', datavalue: { type: 'string', value: 'https://example.test/census-2020' } }],
      P813: [time('P813', '2020-05-28', 11)],
    },
    'snaks-order': ['P854', 'P813'],
  }],
});

describe('query a completed offline Wikidata snapshot', () => {
  let root: string;
  let kb: ReturnType<typeof openKnowledgeBase>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mohassan-knowledge-query-'));
    const path = join(root, 'fixture.sqlite');
    const build = openBuild(path, { source: dumpSource, fingerprint, dumpDate, categories: ['places', 'cities', 'countries'] });
    const entities = [
      entity(cairo, {
        revision: 123456789, labels: { ar: 'الْقَاهِرَة', en: 'Cairo' }, aliases: { ar: ['القاهرة'], en: ['Al-Qahira'] },
        descriptions: { ar: 'مدينة مصرية', en: 'City in Egypt' }, categories: ['cities', 'places'],
        claims: [
          datedPopulation,
          quantity(population, '+111', '1', { rank: 'deprecated', qualifiers: { P585: [at2020] } }),
          quantity(population, '+120', '1', { rank: 'preferred', qualifiers: { P585: [at2021] } }),
          quantity(population, '+999', '1'),
          itemClaim(incumbent, 'Q900000101', { P580: [time('P580', '2018-11-15', 11)], P582: [time('P582', '2020-06-15', 11)] }),
          itemClaim(incumbent, 'Q900000102', { P580: [time('P580', '2020-06-15', 11)] }),
          itemClaim(incumbent, 'Q900000103', { P580: [time('P580', '2020-10-00', 10)], P582: [time('P582', '2020-05-00', 10)] }),
          itemClaim(incumbent, 'Q900000104', { P585: [time('P585', '2020-01-01', 11, 'Q1985786')] }),
          itemClaim(incumbent, 'Q900000105', { P585: [time('P585', '2020-00-00', 8)] }),
          itemClaim(headOfGovernment, 'Q900000106', { P585: [at2020], P580: [time('P580', '2021-00-00')] }),
          itemClaim(headOfGovernment, 'Q900000107', { P582: [time('P582', '2024-00-00')] }),
          dateClaim(inception, '1900-05-00', 10),
          dateClaim(inception, '2000-05-00', 10),
        ],
      }),
      entity(cairoAlias, {
        labels: { ar: 'كايرو', en: 'Cairo' }, aliases: { ar: ['القاهرة'] },
        descriptions: { en: 'Other city with the same name' }, categories: ['cities'],
        claims: [
          quantity(population, '+20', '1', { rank: 'preferred', qualifiers: { P585: [at2020] } }),
          quantity(population, '+30', '1', { qualifiers: { P585: [at2021] } }),
          quantity(population, '+31', '1', { rank: 'preferred', qualifiers: { P585: [at2021] } }),
          quantity(population, '+40', '1', { qualifiers: { P585: [time('P585', '2021-00-00')] } }),
          quantity(population, '+999', '1', { qualifiers: { P585: [time('P585', '2022-00-00'), time('P585', '2023-00-00')] } }),
        ],
      }),
      entity(regionA, { categories: ['countries', 'places'], claims: [quantity(area, '+9007199254740993', squareKilometre)] }),
      entity(regionB, { categories: ['countries', 'places'], claims: [quantity(area, '+9007199254740993000000', squareMetre)] }),
      entity(regionC, {
        categories: ['countries', 'places'], claims: [
          quantity(area, '+9007199254740992', squareKilometre),
          { ...datedPopulation, rank: 'preferred' },
          quantity(population, '+120', '1', { qualifiers: { P585: [at2021] } }),
          quantity(population, '+999', '1', { qualifiers: { P585: [time('P585', '2027-01-01', 11)] } }),
          itemClaim(incumbent, 'Q900000101', { P585: [at2020] }),
          itemClaim(incumbent, 'Q900000102', { P585: [at2021] }),
          itemClaim(incumbent, 'Q900000103', { P580: [time('P580', '2022-01-01', 11)] }),
        ],
      }),
      entity(regionD, {
        categories: ['countries'], claims: [
          quantity(area, '+9007199254740994', squareKilometre), quantity(area, '+9007199254740995', squareKilometre),
        ],
      }),
    ];
    try {
      build.commit({ phase: 'entities', offset: 0 }, () => {});
      build.writeEntities(entities, { phase: 'entities', offset: entities.length });
      build.finish();
    } finally {
      build.close();
    }
    kb = openKnowledgeBase(path);
  });

  afterAll(async () => {
    kb?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('matches normalized Arabic labels and aliases, returning distinct disambiguation candidates', () => {
    const candidates = kb.lookupEntity('  القَاهِـرة ', { language: 'ar' });
    expect(candidates.map(({ entityId, match }) => [entityId, match.kind])).toEqual([[cairo, 'label'], [cairoAlias, 'alias']]);
    expect(candidates[0]).toMatchObject({
      labels: { ar: 'الْقَاهِرَة', en: 'Cairo' }, descriptions: { ar: 'مدينة مصرية' },
      categories: ['places', 'cities'], match: { text: 'الْقَاهِرَة', language: 'ar' },
      source: { dumpDate, revision: 123456789 },
    });
    expect(kb.lookupEntity('Al Qahira', { language: 'en', category: 'cities' })[0]?.entityId).toBe(cairo);
    expect(kb.lookupEntity('القاهرة', { language: 'en' })).toEqual([]);
    expect(kb.lookupEntity('القاهرة', { category: 'places', limit: 1 }).map(e => e.entityId)).toEqual([cairo]);
    expect(kb.lookupEntity(regionA.toLowerCase())[0]?.match.kind).toBe('id');
    expect(kb.lookupEntity(regionA, { category: 'cities' })).toEqual([]);
    expect(kb.lookupEntity('!')).toEqual([]);
  });

  it('selects applicable point qualifiers before applying rank and retains attribution and original references', () => {
    expect(kb.lookupFacts(cairo, population, { year: 2020 })).toEqual([{
      entityId: cairo, property: population, statement: datedPopulation,
      source: {
        dataset: 'wikidata', dumpSource, dumpDate, fingerprint, license: 'CC0-1.0', revision: 123456789,
        url: 'https://www.wikidata.org/wiki/Special:PermanentLink/123456789',
      },
    }]);
    expect(kb.lookupFacts(cairo, population, { year: 2021 })).toMatchObject([{ statement: { rank: 'preferred' } }]);
    expect(kb.lookupFacts(cairo, population, { year: 2022 })).toEqual([]);
    expect(kb.lookupFacts(cairo, population)).toHaveLength(1);
    expect(kb.lookupFacts(regionA, area)[0]?.source.url).toBe(`https://www.wikidata.org/wiki/${regionA}`);
  });

  it('retains both terms in a turnover year and rejects inconsistent, coarse or unsupported dates', () => {
    expect(kb.lookupFacts(cairo, incumbent, { year: 2020 }).map(fact => fact.statement.snak.datavalue?.value)).toEqual([
      { id: 'Q900000101' }, { id: 'Q900000102' },
    ]);
    expect(kb.lookupFacts(cairo, incumbent, { year: 2022 }).map(fact => fact.statement.snak.datavalue?.value)).toEqual([
      { id: 'Q900000102' },
    ]);
    expect(kb.lookupFacts(cairo, headOfGovernment, { year: 2020 })).toEqual([]);
    expect(kb.lookupFacts(cairo, headOfGovernment, { year: 2024 }).map(fact => fact.statement.snak.datavalue?.value)).toEqual([
      { id: 'Q900000107' },
    ]);
    expect(kb.lookupFacts(cairo, incumbent, { year: 2027 })).toEqual([]);
    expect(() => kb.lookupFacts(cairo, population, { year: 2020.5 })).toThrow(RangeError);
  });

  it('selects dates before rank, retaining temporal provenance and omitting undated values', () => {
    expect(kb.lookupFacts(cairo, population, { order: 'earliest' })).toMatchObject([{
      statement: datedPopulation,
      source: { dumpDate, revision: 123456789 },
    }]);
    expect(kb.lookupFacts(cairo, population, { order: 'latest' })).toMatchObject([{
      statement: { qualifiers: { P585: [at2021] }, snak: { datavalue: { value: { amount: '+120' } } } },
    }]);
    expect(kb.lookupFacts(cairo, population, { year: 2020, order: 'latest' })[0]?.statement).toEqual(datedPopulation);
    expect(kb.lookupFacts(regionA, area, { order: 'latest' })).toEqual([]);
  });

  it('selects the latest explicit observation available at the dump date', () => {
    const options = { order: 'latest', pointInTimeOnly: true, allRanks: true } as const;
    expect(kb.lookupFacts(regionC, population, options)).toMatchObject([{
      entityId: regionC,
      source: { dumpDate, dumpSource },
      statement: { qualifiers: { P585: [at2021] }, snak: { datavalue: { value: { amount: '+120' } } } },
    }]);
    expect(kb.lookupFacts(regionC, incumbent, options)).toMatchObject([{
      entityId: regionC,
      statement: { qualifiers: { P585: [at2021] }, snak: { datavalue: { value: { id: 'Q900000102' } } } },
    }]);
    expect(kb.lookupFacts(cairo, incumbent, options)).toEqual([]);
    expect(kb.lookupFacts(regionC, population, { ...options, year: 2027 })).toEqual([]);
  });

  it('preserves overlapping time bounds, preferring rank only for identical bounds', () => {
    function amounts(options: Parameters<typeof kb.lookupFacts>[2]) {
      return kb.lookupFacts(cairoAlias, population, options).map(fact => fact.statement.snak.datavalue?.value);
    }
    expect(amounts({ order: 'latest' })).toEqual([{ amount: '+31', unit: '1' }, { amount: '+40', unit: '1' }]);
    expect(amounts({ order: 'latest', allRanks: true })).toEqual([
      { amount: '+30', unit: '1' }, { amount: '+31', unit: '1' }, { amount: '+40', unit: '1' },
    ]);
    expect(amounts({ year: 2021, allRanks: true })).toEqual([
      { amount: '+30', unit: '1' }, { amount: '+31', unit: '1' }, { amount: '+40', unit: '1' },
    ]);
  });

  it('can order interval starts and date main values without treating end-only qualifiers as starts', () => {
    expect(kb.lookupFacts(cairo, incumbent, { order: 'latest' })[0]?.statement.snak.datavalue?.value).toEqual({ id: 'Q900000102' });
    expect(kb.lookupFacts(cairo, headOfGovernment, { order: 'earliest' })).toEqual([]);
    expect(kb.lookupFacts(cairo, inception, { order: 'earliest' })).toMatchObject([{
      statement: { snak: { datavalue: { value: { time: '+1900-05-00T00:00:00Z', precision: 10 } } } },
    }]);
  });

  it('passes temporal options through both quantity query entry points', () => {
    expect(kb.compare({ entityIds: [cairoAlias, cairo], property: population, unit: '1', order: 'earliest' })).toMatchObject({
      status: 'ordered', rows: [{ entityId: cairo, amount: '100' }, { entityId: cairoAlias, amount: '20' }],
    });
    expect(kb.superlative({ category: 'cities', property: population, unit: '1', order: 'latest' })).toMatchObject({
      status: 'partial', amount: '120', categoryEntities: 2, comparableEntities: 1,
      facts: [{ entityId: cairo }],
    });
  });

  it('ranks exact decimal amounts across compatible area units and reports ties and coverage', () => {
    const maximum = kb.superlative({ category: 'countries', property: area, unit: squareKilometre });
    expect(maximum).toMatchObject({ status: 'partial', amount: '9007199254740993', categoryEntities: 4, comparableEntities: 3, tieCount: 2 });
    expect(maximum.facts.map(fact => fact.entityId)).toEqual([regionA, regionB]);
    expect(maximum.facts.every(fact => fact.source.dumpDate === dumpDate)).toBe(true);
    expect(kb.superlative({ category: 'countries', property: area, unit: squareKilometre, limit: 1 })).toMatchObject({
      tieCount: 2, facts: [{ entityId: regionA }],
    });
    expect(kb.superlative({ category: 'countries', property: area, unit: squareKilometre, direction: 'min' })).toMatchObject({
      amount: '9007199254740992', facts: [{ entityId: regionC }],
    });
    expect(kb.superlative({ category: 'countries', property: area, unit: '1' })).toMatchObject({
      status: 'unavailable', facts: [], categoryEntities: 4, comparableEntities: 0, tieCount: 0,
    });
  });

  it('returns ordered comparisons with incomplete rows for conflicting, missing or inapplicable facts', () => {
    const comparison = kb.compare({ entityIds: [regionC, regionA, regionD, 'Q900000099'], property: area, unit: squareKilometre });
    expect(comparison.status).toBe('incomplete');
    expect(comparison.rows.map(row => [row.entityId, row.amount, row.facts.length])).toEqual([
      [regionA, '9007199254740993', 1], [regionC, '9007199254740992', 1], [regionD, undefined, 2], ['Q900000099', undefined, 0],
    ]);
    expect(kb.compare({ entityIds: [regionA, regionB], property: area, unit: `https://www.wikidata.org/entity/${squareMetre}` })).toMatchObject({
      status: 'ordered', unit: squareMetre, rows: [{ amount: '9007199254740993000000' }, { amount: '9007199254740993000000' }],
    });
    expect(kb.compare({ entityIds: [regionA, regionB], property: area, unit: squareMetre, year: 2020 })).toMatchObject({
      status: 'incomplete', rows: [{ facts: [] }, { facts: [] }],
    });
    expect(() => kb.compare({ entityIds: [regionA, regionB], property: area, unit: 'km²' })).toThrow(TypeError);
  });
});
