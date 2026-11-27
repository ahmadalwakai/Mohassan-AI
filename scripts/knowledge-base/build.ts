import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dumpFingerprint } from '../../packages/knowledge-base/src/dump.ts';
import { ENTITY_CATEGORIES, type EntityCategory } from '../../packages/knowledge-base/src/types.ts';
import { importWikidata } from '../../packages/knowledge-base/src/wikidata.ts';
import { importWikipedia, type WikipediaInput } from '../../packages/knowledge-base/src/wikipedia.ts';

const USAGE = `Usage
  npx tsx scripts/knowledge-base/build.ts wikidata --input DUMP --output STORE --source URL --dump-date YYYY-MM-DD [--category NAME ...]
  npx tsx scripts/knowledge-base/build.ts wikipedia --output STORE [--ar-input DUMP --ar-source URL --ar-dump-date YYYY-MM-DD] [--en-input DUMP --en-source URL --en-dump-date YYYY-MM-DD]
Wikidata categories: ${ENTITY_CATEGORIES.join(', ')} (default: all)
Supply at least one Wikipedia edition. Paths must refer to local dumps.
The build writes a data card and a SHA-256 manifest beside the store.`;

interface DumpInput {
  inputPath: string;
  source: string;
  dumpDate: string;
  language?: WikipediaInput['language'];
  fingerprint?: string;
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`Missing --${flag}`);
  return value;
}

function categories(values: string[] | undefined): EntityCategory[] | undefined {
  return values?.map(value => {
    const category = ENTITY_CATEGORIES.find(candidate => candidate === value);
    if (!category) throw new Error(`Unknown Wikidata category: ${value}`);
    return category;
  });
}

function requireSeparateInput(input: string, output: string): void {
  if ([output, `${output}.data-card.json`, `${output}.manifest.json`].includes(input)) {
    throw new Error('Use separate paths for the input, store, data card and manifest');
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function describeFile(path: string, signal: AbortSignal, fingerprint?: string) {
  return {
    file: basename(path),
    bytes: (await stat(path)).size,
    sha256: (fingerprint ?? await dumpFingerprint(path, signal)).slice('sha256:'.length),
  };
}

async function main(): Promise<void> {
  const [dataset, ...args] = process.argv.slice(2);
  if (dataset === '--help' || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const started = performance.now();
    let output: string;
    let dumpInputs: DumpInput[];
    let card: Awaited<ReturnType<typeof importWikidata | typeof importWikipedia>>;
    if (dataset === 'wikidata') {
      const { values } = parseArgs({
        args,
        options: {
          input: { type: 'string' }, output: { type: 'string' },
          source: { type: 'string' }, 'dump-date': { type: 'string' },
          category: { type: 'string', multiple: true },
        },
      });
      output = resolve(required(values.output, 'output'));
      const inputPath = resolve(required(values.input, 'input'));
      requireSeparateInput(inputPath, output);
      const source = required(values.source, 'source');
      const dumpDate = required(values['dump-date'], 'dump-date');
      const subset = categories(values.category);
      await mkdir(dirname(output), { recursive: true });
      card = await importWikidata({ inputPath, databasePath: output, source, dumpDate, categories: subset, signal: controller.signal });
      dumpInputs = [{ inputPath, source, dumpDate, fingerprint: card.fingerprint }];
    } else if (dataset === 'wikipedia') {
      const { values } = parseArgs({
        args,
        options: {
          output: { type: 'string' },
          'ar-input': { type: 'string' }, 'ar-source': { type: 'string' }, 'ar-dump-date': { type: 'string' },
          'en-input': { type: 'string' }, 'en-source': { type: 'string' }, 'en-dump-date': { type: 'string' },
        },
      });
      output = resolve(required(values.output, 'output'));
      const inputs: WikipediaInput[] = [];
      for (const language of ['ar', 'en'] as const) {
        const path = values[`${language}-input`];
        const source = values[`${language}-source`];
        const dumpDate = values[`${language}-dump-date`];
        if (path === undefined && source === undefined && dumpDate === undefined) continue;
        const inputPath = resolve(required(path, `${language}-input`));
        requireSeparateInput(inputPath, output);
        inputs.push({
          language,
          inputPath,
          source: required(source, `${language}-source`),
          dumpDate: required(dumpDate, `${language}-dump-date`),
        });
      }
      if (!inputs.length) throw new Error('Supply at least one Wikipedia edition');
      await mkdir(dirname(output), { recursive: true });
      card = await importWikipedia({ inputs, databasePath: output, signal: controller.signal });
      dumpInputs = inputs;
    } else {
      throw new Error(USAGE);
    }

    const inputs = [];
    for (const { inputPath, source, dumpDate, language, fingerprint } of dumpInputs) {
      inputs.push({ source, dumpDate, language, ...await describeFile(inputPath, controller.signal, fingerprint) });
    }
    const store = await describeFile(output, controller.signal);
    const manifest = { dataset, builtAt: new Date().toISOString(), inputs, store };
    controller.signal.throwIfAborted();
    await writeJson(`${output}.data-card.json`, card);
    await writeJson(`${output}.manifest.json`, manifest);
    const elapsedSeconds = (performance.now() - started) / 1_000;
    process.stdout.write(`${JSON.stringify({ card, storeBytes: store.bytes, elapsedSeconds, manifest }, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Knowledge build failed'}\n`);
  process.exitCode = 1;
});
