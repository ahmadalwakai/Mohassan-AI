import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapabilityCorpus } from '../corpus.js';
import { importClinc, importMassive } from './intent.js';
import { importGsm8k, importMbpp } from './math-code.js';
import { quotas } from './policy.js';
import { importCanard, importMintaka, importTyDiQA } from './qa.js';
import { availableStrata, buildSealedSet } from './sample.js';
import { downloadSource, massiveLocale, sourcePins, sourceText } from './sources.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const usage = 'Use --cache PATH and either --inventory true or --seed PATH --out NEW_DIRECTORY.';

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1];
    if (!['--cache', '--inventory', '--seed', '--out'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) {
      throw new Error(usage);
    }
    values.set(flag, value);
  }
  const cache = values.get('--cache'), seed = values.get('--seed'), out = values.get('--out');
  const inventory = values.get('--inventory');
  if (!cache || (inventory !== undefined ? inventory !== 'true' || seed || out : !seed || !out)) throw new Error(usage);
  return { cache, seed, out };
}

function outsideCheckout(path: string): string {
  const fromRoot = relative(root, path);
  if (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Custodian files must be outside the checkout.');
  }
  return path;
}

async function privateLocation(input: string, mustExist: boolean): Promise<string> {
  const full = outsideCheckout(resolve(input));
  try {
    return outsideCheckout(await realpath(full));
  } catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return outsideCheckout(join(await realpath(dirname(full)), relative(dirname(full), full)));
  }
}

async function main() {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(process.argv.slice(2)); }
  catch { console.error(usage); return 1; }
  let step = 'prepare private directories and seed';
  try {
    const cache = await privateLocation(args.cache, false);
    const out = args.out && await privateLocation(args.out, false);
    const seedPath = args.seed && await privateLocation(args.seed, true);
    const seedInfo = seedPath && await lstat(seedPath);
    if (seedInfo && (!seedInfo.isFile() || (seedInfo.mode & 0o077) !== 0 || seedInfo.size !== 32)) {
      throw new Error('Expected a private 32-byte custodian seed file.');
    }
    const seed = seedPath ? await readFile(seedPath) : undefined;
    await mkdir(cache, { recursive: true, mode: 0o700 });
    if (((await lstat(cache)).mode & 0o077) !== 0) throw new Error('Expected a private source cache.');
    step = 'download and verify the pinned source artifacts';
    // Keep the download order fixed and avoid retaining duplicate archive copies.
    const artifacts = new Map<keyof typeof sourcePins, Buffer>();
    for (const name of Object.keys(sourcePins) as (keyof typeof sourcePins)[]) {
      artifacts.set(name, await downloadSource(cache, name));
    }
    const raw = (name: keyof typeof sourcePins) => sourceText(artifacts.get(name)!);
    const massive = artifacts.get('massive-1.1.tar.gz')!;
    step = 'map rows from the public datasets';
    const results = [
      importClinc(raw('clinc150.json')),
      importMassive(massiveLocale(massive, 'en-US'), massiveLocale(massive, 'ar-SA')),
      importMintaka(raw('mintaka.json')),
      importTyDiQA(raw('tydiqa-ar.jsonl'), raw('tydiqa-en.jsonl')),
      importCanard(raw('canard.json')),
      importGsm8k(raw('gsm8k.jsonl')),
      importMbpp(raw('mbpp.json')),
    ];
    if (!seed || !out) {
      console.log(JSON.stringify({ available: availableStrata(results), sources: results.map(
        ({ dataset, seen, candidates, dropped }) => ({ dataset, seen, admitted: candidates.length, dropped }),
      ) }, null, 2));
      return 0;
    }
    step = 'sample and validate the sealed corpus';
    const v1 = join(root, 'tests/fixtures/agent-capability-bench');
    const previous = await loadCapabilityCorpus({ manifest: join(v1, 'manifest.json'),
      development: join(v1, 'development.json'), sealed: join(v1, 'holdout/sealed.json') });
    const built = buildSealedSet(results, quotas, seed, [...previous.development, ...previous.sealed!]);
    step = 'write a fresh private release directory';
    await mkdir(out, { mode: 0o700 });
    for (const name of ['payload', 'manifest', 'accounting'] as const) {
      await writeFile(join(out, `${name}.json`), built[name], { mode: 0o600, flag: 'wx' });
    }
    console.log(built.manifest.trimEnd());
    return 0;
  } catch (error) {
    // Filesystem, parse and tool errors can include source text or private paths.
    const fixed = error instanceof Error && /^(?:SHA-256 mismatch for |Could not download |Could fill only |No distinct unselected candidate remains in |Invalid mapped case in )/u.test(error.message);
    console.error(fixed ? error.message : `Could not ${step}.`);
    return 1;
  }
}

process.exitCode = await main();
