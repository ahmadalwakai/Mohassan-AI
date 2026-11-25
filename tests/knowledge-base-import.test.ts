import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../packages/knowledge-base/src/store.ts';
import { importWikidata } from '../packages/knowledge-base/src/wikidata.ts';

const fixture = fileURLToPath(new URL('./fixtures/knowledge-base/wikidata-20261116-projected.json', import.meta.url));
const source = 'https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz';
const dumpDate = '2026-11-16';

function statement(property: string, target: string, rank = 'normal') {
  return {
    rank,
    mainsnak: {
      snaktype: 'value',
      property,
      datatype: 'wikibase-item',
      datavalue: { type: 'wikibase-entityid', value: { id: target } },
    },
  };
}

function item(id: string, claims: Record<string, object[]>) {
  return { type: 'item', id, claims };
}

function dump(entries: object[]): string {
  return `[\n${entries.map(entry => JSON.stringify(entry)).join(',\n')}\n]\n`;
}

describe('offline Wikidata import', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-wikidata-'));
    databasePath = join(directory, 'wikidata.sqlite');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('imports the labeled 240-record CC0 projection with original statements and citations', async () => {
    const card = await importWikidata({ inputPath: fixture, databasePath, source, dumpDate, batchSize: 17 });
    expect(card).toMatchObject({
      dataset: 'wikidata',
      source,
      dumpDate,
      license: 'CC0-1.0',
      fingerprint: 'sha256:4156507f1477a3c33df2ac642cdca067f8845a358b0d2f255a53b4623e7d4ff4',
      scannedEntities: 240,
    });
    expect(card.entityCount).toBeGreaterThan(50);
    expect(card.entityCount).toBeLessThan(240);
    const knowledge = store.openKnowledgeStore(databasePath);
    try {
      expect(knowledge.card).toEqual(card);
      const belgium = knowledge.db.prepare("SELECT revision, labels, aliases, descriptions FROM entities WHERE id = 'Q31'").get();
      expect(belgium?.revision).toBe(2569315931);
      expect(JSON.parse(String(belgium?.labels))).toEqual({ ar: 'بلجيكا', en: 'Belgium' });
      expect(JSON.parse(String(belgium?.aliases)).en).toContain('Kingdom of Belgium');
      expect(JSON.parse(String(belgium?.descriptions))).toHaveProperty('ar');
      expect(knowledge.db.prepare("SELECT 1 FROM entities WHERE id = 'Q8'").get()).toBeUndefined();

      const population = knowledge.db.prepare(`
        SELECT rank, snak, qualifiers, refs FROM claims
        WHERE entity_id = 'Q31' AND property = 'P1082' ORDER BY ordinal
      `).all().map(row => ({
        rank: row.rank,
        value: JSON.parse(String(row.snak)).datavalue.value,
        date: JSON.parse(String(row.qualifiers)).P585[0].datavalue.value.time,
        reference: JSON.parse(String(row.refs))[0],
      }));
      expect(population).toContainEqual({
        rank: 'normal',
        value: { amount: '+11492641', unit: '1' },
        date: '+2020-01-01T00:00:00Z',
        reference: expect.objectContaining({
          hash: '840972047f788582f0e73ac91a8cbfea89e4de80',
          snaks: expect.any(Object),
        }),
      });
      expect(population).toContainEqual(expect.objectContaining({
        rank: 'preferred',
        date: '+2025-01-01T00:00:00Z',
        value: { amount: '+11825551', unit: '1' },
      }));
      const area = knowledge.db.prepare("SELECT snak FROM claims WHERE property = 'P2046' AND entity_id = 'Q155'").get();
      expect(JSON.parse(String(area?.snak)).datavalue.value.unit).toBe('http://www.wikidata.org/entity/Q712226');
    } finally {
      knowledge.close();
    }
  });

  it('follows subclasses transitively, terminates cycles and honors the selected categories', async () => {
    const inputPath = join(directory, 'test.json');
    await writeFile(inputPath, dump([
      item('Q800001', { P31: [statement('P31', 'Q800005')] }),
      item('Q800002', { P31: [statement('P31', 'Q800006')] }),
      item('Q800003', { P31: [statement('P31', 'Q6256')] }),
      item('Q800004', { P31: [statement('P31', 'Q5')] }),
      item('Q800005', { P279: [statement('P279', 'Q800006'), statement('P279', 'Q515', 'deprecated')] }),
      item('Q800006', { P279: [statement('P279', 'Q800005'), statement('P279', 'Q515')] }),
      item('Q800007', { P31: [statement('P31', 'Q800008')] }),
      item('Q800008', { P279: [statement('P279', 'Q515', 'deprecated')] }),
    ]));
    const card = await importWikidata({ inputPath, databasePath, source, dumpDate, categories: ['cities'], batchSize: 2 });
    expect(card).toMatchObject({ scannedEntities: 8, entityCount: 2, categories: ['cities'] });
    const knowledge = store.openKnowledgeStore(databasePath);
    try {
      expect(knowledge.db.prepare('SELECT id FROM entities ORDER BY id').all()).toEqual([
        { id: 'Q800001' }, { id: 'Q800002' },
      ]);
    } finally {
      knowledge.close();
    }
  });

  it.each(['classes', 'entities'] as const)('resumes a gzip import after an interrupted %s batch', async phase => {
    const controller = new AbortController();
    const inputPath = join(directory, 'test.json.gz');
    const bytes = gzipSync(await readFile(fixture));
    await writeFile(inputPath, bytes);
    const realOpen = store.openBuild;
    vi.spyOn(store, 'openBuild').mockImplementationOnce((...args) => {
      const build = realOpen(...args);
      const commit = build.commit;
      const writeEntities = build.writeEntities;
      build.commit = (checkpoint, work) => {
        commit(checkpoint, work);
        if (checkpoint.phase === phase && checkpoint.offset > 0) controller.abort();
      };
      build.writeEntities = (entities, checkpoint) => {
        writeEntities(entities, checkpoint);
        if (checkpoint.phase === phase && checkpoint.offset > 0) controller.abort();
      };
      return build;
    });

    const options = { inputPath, databasePath, source, dumpDate, batchSize: 4 };
    await expect(importWikidata({ ...options, signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(() => store.openKnowledgeStore(databasePath)).toThrow(/incomplete/i);
    const resumed = await importWikidata(options);
    const clean = await importWikidata({ ...options, databasePath: join(directory, 'clean.sqlite') });
    expect(resumed).toEqual(clean);
    expect(resumed.fingerprint).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(await importWikidata(options)).toEqual(resumed);
    await writeFile(inputPath, gzipSync(dump([item('Q800001', { P31: [statement('P31', 'Q5')] })])));
    await expect(importWikidata(options)).rejects.toThrow(/different build input/i);
  });

  it.each([
    ['[\n{"type":"item","id":"Q5"}\n', /incomplete/i],
    ['[\n{"type":"item","id":"Q5"},\n]\n', /framing/i],
    ['[\n{"type":"item", id:"Q5"}\n]\n', /invalid Wikimedia JSON dump record/i],
    ['[\n]\n{}\n', /framing/i],
  ])('refuses to finalize a malformed JSON dump %j', async (data, error) => {
    const inputPath = join(directory, 'bad.json');
    await writeFile(inputPath, data);
    await expect(importWikidata({ inputPath, databasePath, source, dumpDate, batchSize: 1 })).rejects.toThrow(error);
    expect(() => store.openKnowledgeStore(databasePath)).toThrow(/incomplete/i);
  });

  it('reports a truncated gzip stream', async () => {
    const inputPath = join(directory, 'bad.json.gz');
    await writeFile(inputPath, gzipSync(await readFile(fixture)).subarray(0, -8));
    await expect(importWikidata({ inputPath, databasePath, source, dumpDate })).rejects.toThrow();
    expect(() => store.openKnowledgeStore(databasePath)).toThrow(/incomplete/i);
  });

  it('rejects invalid UTF-8 instead of changing source values', async () => {
    const inputPath = join(directory, 'bad-encoding.json');
    await writeFile(inputPath, Buffer.concat([
      Buffer.from('[\n{"type":"item","id":"Q5","text":"'), Buffer.from([255]), Buffer.from('"}\n]\n'),
    ]));
    await expect(importWikidata({ inputPath, databasePath, source, dumpDate })).rejects.toMatchObject({
      code: 'ERR_ENCODING_INVALID_ENCODED_DATA',
    });
    expect(() => store.openKnowledgeStore(databasePath)).toThrow(/incomplete/i);
  });
});
