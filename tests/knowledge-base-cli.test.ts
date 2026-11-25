import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { openKnowledgeBase } from '../packages/knowledge-base/src/index.ts';

const run = promisify(execFile);
const command = fileURLToPath(new URL('../scripts/knowledge-base/build.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/knowledge-base/wikidata-20261116-projected.json', import.meta.url));
const source = 'https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz';

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
