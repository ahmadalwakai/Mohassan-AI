import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openKnowledgeBase } from '../packages/knowledge-base/src/query.ts';
import { openBuild } from '../packages/knowledge-base/src/store.ts';
import type { BuildInput, StoredEntity } from '../packages/knowledge-base/src/types.ts';
import { importWikidata } from '../packages/knowledge-base/src/wikidata.ts';

const input: BuildInput = {
  source: 'https://example.test/wikidata.json', dumpDate: '2026-11-16',
  fingerprint: 'fixture-fingerprint', categories: ['cities', 'countries', 'people'],
};

function entity(id: string, labels: StoredEntity['labels'], fields: Partial<StoredEntity> = {}): StoredEntity {
  return {
    id, labels, revision: null, categories: ['cities'], aliases: {}, descriptions: {}, claims: [], ...fields,
  };
}

describe('offline Wikidata entity linking', () => {
  let directory: string;
  let databasePath: string;
  let kb: ReturnType<typeof openKnowledgeBase> | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mohassan-kb-linking-'));
    databasePath = join(directory, 'wikidata.sqlite');
  });

  afterEach(() => {
    kb?.close();
    kb = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  function build(entities: StoredEntity[]) {
    const writer = openBuild(databasePath, input);
    try {
      writer.commit({ phase: 'entities', offset: 0 }, () => {});
      writer.writeEntities(entities, { phase: 'entities', offset: entities.length });
      writer.finish();
    } finally {
      writer.close();
    }
  }

  function open() {
    kb = openKnowledgeBase(databasePath);
    return kb;
  }

  it('uses normalized Arabic aliases and returns the original alias and source', () => {
    build([entity('Q31', { ar: 'بلجيكا', en: 'Belgium' }, {
      revision: 2569315931,
      categories: ['countries'],
      aliases: { ar: ['مَمْلَكَةُ بَلْجِيكَا'] },
      descriptions: { ar: 'دولة في أوروبا' },
      sitelinkCount: 4,
    })]);
    const knowledge = open();
    expect(knowledge.linkEntity('مملكه بلجـيكا', { language: 'ar' })).toMatchObject({
      status: 'linked',
      candidate: {
        entityId: 'Q31', matchMethod: 'name', sitelinkCount: 4,
        labels: { ar: 'بلجيكا', en: 'Belgium' }, descriptions: { ar: 'دولة في أوروبا' },
        match: { kind: 'alias', language: 'ar', text: 'مَمْلَكَةُ بَلْجِيكَا' },
        source: { dumpDate: input.dumpDate, url: 'https://www.wikidata.org/wiki/Special:PermanentLink/2569315931' },
      },
    });
    expect(knowledge.linkEntity('  q31  ', { category: 'countries' })).toMatchObject({
      status: 'linked', candidate: { entityId: 'Q31', matchMethod: 'id', match: { kind: 'id' } },
    });
    expect(knowledge.linkEntity('Q31', { category: 'people' })).toEqual({ status: 'missing' });
    expect(knowledge.linkEntity('Unindexed locality')).toEqual({ status: 'missing' });
  });

  it('matches names across scripts when an exact label or alias is absent', () => {
    build([
      entity('Q1530', { en: 'Baghdad' }),
      entity('Q90', { ar: 'باريس' }),
    ]);
    const knowledge = open();
    expect(knowledge.linkEntity('بَغْـدَاد', { language: 'ar' })).toMatchObject({
      status: 'linked', candidate: {
        entityId: 'Q1530', matchMethod: 'transliteration', match: { kind: 'label', language: 'en', text: 'Baghdad' },
      },
    });
    expect(knowledge.linkEntity('Paris', { language: 'en' })).toMatchObject({
      status: 'linked', candidate: {
        entityId: 'Q90', matchMethod: 'transliteration', match: { kind: 'label', language: 'ar', text: 'باريس' },
      },
    });
    expect(knowledge.linkEntity('Bagdahd', { language: 'en' })).toEqual({ status: 'missing' });
  });

  it('asks for a choice when transliteration matches more than one entity', () => {
    build([
      entity('Q90', { ar: 'باريس' }, { sitelinkCount: 200 }),
      entity('Q900001', { ar: 'باريس' }, { sitelinkCount: 1 }),
    ]);
    expect(open().linkEntity('Paris')).toMatchObject({
      status: 'ambiguous', candidates: [
        { entityId: 'Q90', matchMethod: 'transliteration' },
        { entityId: 'Q900001', matchMethod: 'transliteration' },
      ],
    });
  });

  it('prefers a stored name to transliteration regardless of popularity', () => {
    build([
      entity('Q1530', { en: 'Baghdad' }, { sitelinkCount: 100 }),
      entity('Q900001', { ar: 'بغداد' }, { sitelinkCount: 1 }),
    ]);
    expect(open().linkEntity('بغداد', { language: 'ar' })).toMatchObject({
      status: 'linked', candidate: { entityId: 'Q900001', matchMethod: 'name' },
    });
  });

  it('orders ambiguous name choices by popularity and returns at most four distinct candidates', () => {
    build([
      entity('Q900001', { en: 'Springfield' }, { sitelinkCount: 1 }),
      entity('Q900002', { en: 'Springfield' }, { sitelinkCount: 20 }),
      entity('Q900003', { en: 'Springfield' }, { sitelinkCount: 100, aliases: { en: ['Springfield'] } }),
      entity('Q900004', { en: 'Springfield' }, { sitelinkCount: 30 }),
      entity('Q900005', { en: 'Springfield' }, { sitelinkCount: 50 }),
      entity('Q900006', { en: 'Springfield' }, { categories: ['people'], sitelinkCount: 200 }),
    ]);
    const knowledge = open();
    expect(knowledge.linkEntity('Springfield', { language: 'en', category: 'cities' })).toMatchObject({
      status: 'ambiguous', candidates: [
        { entityId: 'Q900003', sitelinkCount: 100 },
        { entityId: 'Q900005', sitelinkCount: 50 },
        { entityId: 'Q900004', sitelinkCount: 30 },
        { entityId: 'Q900002', sitelinkCount: 20 },
      ],
    });
    expect(knowledge.linkEntity('Springfield', { language: 'en', category: 'people' })).toMatchObject({
      status: 'linked', candidate: { entityId: 'Q900006' },
    });
  });

  it.each(['completed', 'in-progress'])('serves exact matches and reverse transliteration from an original %s store', state => {
    const entities = [
      entity('Q900001', { en: 'Springfield' }, { sitelinkCount: 1 }),
      entity('Q900002', { en: 'Springfield' }, { sitelinkCount: 100 }),
      entity('Q90', { ar: 'باريس' }),
    ];
    if (state === 'completed') build(entities);
    else openBuild(databasePath, input).close();
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('DROP TABLE entity_link_names; DROP TABLE entity_link_popularity;');
    } finally {
      db.close();
    }
    if (state === 'in-progress') build(entities);
    const knowledge = open();
    expect(knowledge.linkEntity('Springfield')).toMatchObject({
      status: 'ambiguous', candidates: [
        { entityId: 'Q900001', matchMethod: 'name', sitelinkCount: null },
        { entityId: 'Q900002', matchMethod: 'name', sitelinkCount: null },
      ],
    });
    expect(knowledge.lookupEntity('Springfield')).toHaveLength(2);
    expect(knowledge.linkEntity('Paris')).toMatchObject({
      status: 'linked', candidate: { entityId: 'Q90', matchMethod: 'transliteration', sitelinkCount: null },
    });
  });

  it('imports a popularity prior from the source sitelinks', async () => {
    const inputPath = join(directory, 'fixture.json');
    const item = {
      type: 'item', id: 'Q31', labels: { en: { language: 'en', value: 'Belgium' } },
      sitelinks: {
        arwiki: { site: 'arwiki', title: 'بلجيكا' }, enwiki: { site: 'enwiki', title: 'Belgium' },
      },
      claims: {
        P31: [{ rank: 'normal', mainsnak: {
          snaktype: 'value', property: 'P31', datatype: 'wikibase-item',
          datavalue: { type: 'wikibase-entityid', value: { id: 'Q6256' } },
        } }],
      },
    };
    writeFileSync(inputPath, `[\n${JSON.stringify(item)}\n]\n`);
    await importWikidata({ inputPath, databasePath, source: input.source, dumpDate: input.dumpDate });
    expect(open().linkEntity('Belgium')).toMatchObject({
      status: 'linked', candidate: { entityId: 'Q31', sitelinkCount: 2 },
    });
  });
});
