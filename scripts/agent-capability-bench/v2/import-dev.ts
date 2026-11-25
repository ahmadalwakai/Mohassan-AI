import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isWithin } from '../corpus.js';
import { collectCapabilityNotices, downloadCapabilitySources, mapCapabilitySources } from './import-sources.js';
import { quotas } from './policy.js';
import { buildDevelopmentSet } from './sample-dev.js';
import { loadSealedCapabilityCorpus } from './sealed.js';
import { sha256 } from './sources.js';
import { wikiAttribution } from './wiki-attribution.js';

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/agent-capability-bench/v2/', import.meta.url));
const sealedDirectory = join(fixtures, 'sealed');
const devDirectory = join(fixtures, 'dev');
const sealedManifest = fileURLToPath(new URL('./manifest.json', import.meta.url));
const seedName = 'sampling-v2-dev.seed';
const usage = 'Use --cache PATH --out NEW_DIRECTORY.';

async function resolveFromExistingParent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(await resolveFromExistingParent(parent), basename(path));
  }
}

async function developmentLocation(input: string): Promise<string> {
  const path = resolve(input);
  const canonical = await resolveFromExistingParent(path);
  for (const [label, directory] of [['sealed release', sealedDirectory], ['committed development', devDirectory]] as const) {
    if (isWithin(directory, path) || isWithin(await realpath(directory), canonical)) {
      throw new Error(`Development cache and output paths must be outside the ${label} directory.`);
    }
  }
  return canonical;
}

async function main() {
  let cache: string;
  let out: string;
  try {
    const { values } = parseArgs({ options: { cache: { type: 'string' }, out: { type: 'string' } } });
    if (!values.cache || !values.out) throw new Error(usage);
    cache = values.cache;
    out = values.out;
  } catch {
    console.error(usage);
    return 1;
  }
  let step = 'prepare the development cache and output paths';
  try {
    cache = await developmentLocation(cache);
    out = await developmentLocation(out);
    step = 'read the development seed and verify the sealed release';
    const seed = await readFile(join(devDirectory, seedName));
    const sealed = await loadSealedCapabilityCorpus({
      manifest: sealedManifest, sealed: join(sealedDirectory, 'payload.json'),
    });
    step = 'download and verify the pinned source artifacts';
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const artifacts = await downloadCapabilitySources(cache);
    step = 'map and sample the development corpus';
    const targets = quotas.map(quota => ({ ...quota, count: quota.count * 2 }));
    const built = buildDevelopmentSet(mapCapabilitySources(artifacts), targets, seed, sealed.cases);
    step = 'assemble and verify the development attribution';
    const entries = new Map<string, Buffer | string>([
      [seedName, seed],
      ['payload.json', built.payload],
      ['accounting.json', built.accounting],
      ['attribution/ATTRIBUTION.md', await readFile(join(devDirectory, 'attribution/ATTRIBUTION.md'))],
      ['attribution/wikipedia-articles.json', wikiAttribution(built.payload)],
    ]);
    for (const [name, bytes] of Object.entries(await collectCapabilityNotices(cache, artifacts))) {
      entries.set(`attribution/${name}`, bytes);
    }
    const files = Object.fromEntries([...entries.keys()].sort().map(name => [name, sha256(entries.get(name)!)]));
    const manifest = JSON.stringify({ ...JSON.parse(built.manifest), files }) + '\n';
    step = 'write a fresh development directory';
    await mkdir(out);
    await mkdir(join(out, 'attribution'));
    for (const [name, bytes] of entries) {
      await writeFile(join(out, name), bytes, { flag: 'wx' });
    }
    await writeFile(join(out, 'manifest.json'), manifest, { flag: 'wx' });
    console.log(manifest.trimEnd());
    return 0;
  } catch (error) {
    // Filesystem, parse and tool errors can include source text or private paths.
    const fixed = error instanceof Error && /^(?:Development cache and output |SHA-256 mismatch for |Could not download |Could not fill the development |Invalid mapped case in )/u.test(error.message);
    console.error(fixed ? error.message : `Could not ${step}.`);
    return 1;
  }
}

process.exitCode = await main();
