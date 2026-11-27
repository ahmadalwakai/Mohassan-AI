import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { openKnowledgeBase } from '../packages/knowledge-base/src/index.ts';

const run = promisify(execFile);
const command = fileURLToPath(new URL('../scripts/knowledge-base/build.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/knowledge-base/wikidata-20261116-projected.json', import.meta.url));
// The fixture's Wikidata source range and statements were reconfirmed on 2026-11-27.
const source = 'https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

it('builds a local snapshot from the CLI and queries a sourced statement from it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-kb-cli-'));
  const database = join(directory, 'output', 'countries.sqlite');
  try {
    const { stdout } = await run(process.execPath, [
      command, 'wikidata', '--input', fixture, '--output', database,
      '--source', source, '--dump-date', '2026-11-16', '--category', 'countries',
    ]);
    const result = JSON.parse(stdout);
    expect(result.storeBytes).toBe((await stat(database)).size);
    expect(JSON.parse(await readFile(`${database}.data-card.json`, 'utf8'))).toEqual(result.card);
    const input = await readFile(fixture);
    const store = await readFile(database);
    expect(JSON.parse(await readFile(`${database}.manifest.json`, 'utf8'))).toEqual(result.manifest);
    expect(result.manifest).toEqual({
      dataset: 'wikidata',
      builtAt: expect.any(String),
      inputs: [{
        source, dumpDate: '2026-11-16', file: 'wikidata-20261116-projected.json',
        bytes: input.length, sha256: sha256(input),
      }],
      store: { file: 'countries.sqlite', bytes: store.length, sha256: sha256(store) },
    });

    const kb = openKnowledgeBase(database);
    try {
      const [country] = kb.lookupEntity('بَلْجِيكا', { language: 'ar', category: 'countries' });
      expect(country.entityId).toBe('Q31');
      expect(kb.lookupFacts(country.entityId, 'P1082', { year: 2020 })).toEqual([
        expect.objectContaining({
          statement: expect.objectContaining({
            snak: expect.objectContaining({
              datavalue: { type: 'quantity', value: { amount: '+11492641', unit: '1' } },
            }),
          }),
          source: expect.objectContaining({ dumpSource: source, dumpDate: '2026-11-16', license: 'CC0-1.0' }),
        }),
      ]);
    } finally {
      kb.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('records the bytes of a compressed Wikipedia dump separately from the XML data card', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-kb-cli-'));
  try {
    const fixture = new URL('./fixtures/knowledge-base/wikipedia-en.fixture.xml', import.meta.url);
    const input = gzipSync(await readFile(fixture));
    const inputPath = join(directory, 'en.xml.gz');
    const database = join(directory, 'wikipedia.sqlite');
    const source = 'fixture:hand-built-wikipedia-en';
    await writeFile(inputPath, input);
    const { stdout } = await run(process.execPath, [
      command, 'wikipedia', '--output', database,
      '--en-input', inputPath, '--en-source', source, '--en-dump-date', '2025-01-01',
    ]);

    const { card, manifest } = JSON.parse(stdout);
    expect(manifest.inputs).toEqual([{
      source, dumpDate: '2025-01-01', language: 'en', file: 'en.xml.gz',
      bytes: input.length, sha256: sha256(input),
    }]);
    expect(card.sources[0].fingerprint).not.toBe(`sha256:${sha256(input)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
