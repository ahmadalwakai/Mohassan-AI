import { createHash } from 'node:crypto';
import { createWriteStream, type BigIntStats } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import type { ModelEntry } from '../../packages/model-relations/src/registry.js';
import { inspectStore, openArtifact, planStore, portablePath, presentFiles, type StoreManifest, type StoreRoots } from './store.js';

async function copyArtifact(source: { source: string; content?: Buffer; identity: BigIntStats | null }, destination: string,
  expected: { sizeBytes: number; sha256: string }) {
  await mkdir(toNamespacedPath(dirname(destination)), { mode: 0o700, recursive: true });
  if (source.content) {
    await writeFile(toNamespacedPath(destination), source.content, { flag: 'wx', mode: 0o600 });
    return;
  }
  const handle = await openArtifact(source.source, source.identity);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    await pipeline(handle.createReadStream({ autoClose: false }), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    }), createWriteStream(toNamespacedPath(destination), { flags: 'wx', mode: 0o600 }));
  } finally {
    await handle.close();
  }
  if (sizeBytes !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) {
    throw new Error(`Registry artifact changed while packing: ${source.source}`);
  }
}

export async function packStore(roots: StoreRoots, out: string, write: boolean, registry?: readonly ModelEntry[]) {
  const plan = await planStore(roots, registry, true);
  const sources = presentFiles(plan);
  const parent = dirname(out);
  const disk = await statfs(toNamespacedPath(parent), { bigint: true });
  const block = disk.bsize;
  const freeBytes = disk.bavail * block;
  const allocated = (bytes: number) => ((BigInt(bytes) + block - 1n) / block) * block;
  const dirs = new Set(['', 'files']);
  let allocatedBytes = 0n;
  for (const [path, source] of sources) {
    allocatedBytes += allocated(source.size);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`files/${parts.slice(0, i).join('/')}`);
  }
  allocatedBytes += BigInt(dirs.size) * block;
  const requireSpace = (required: bigint) => {
    if (required > freeBytes) throw new Error(`Output filesystem needs at least ${required} bytes, has ${freeBytes} available`);
  };
  requireSpace(allocatedBytes);
  const manifest = await inspectStore(plan);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const requiredBytes = allocatedBytes + allocated(Buffer.byteLength(json));
  requireSpace(requiredBytes);
  for (const file of manifest.files) {
    if (sources.get(`${file.area}/${file.path}`)?.size !== file.sizeBytes) throw new Error(`Artifact size changed: ${file.path}`);
  }
  const result = { manifest, requiredBytes: Number(requiredBytes), freeBytes: Number(freeBytes), manifestSha256: undefined as string | undefined };
  if (!write || manifest.models.some(model => model.status === 'hash mismatch')) return result;
  if (!sources.size) throw new Error('No registered model files are present. No bundle was created.');
  // Reserve the destination exclusively. The manifest appears only after every artifact was copied successfully.
  await mkdir(toNamespacedPath(out), { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const source = sources.get(`${file.area}/${file.path}`)!;
      await copyArtifact(source, join(out, 'files', file.area, file.path), file);
    }
    await writeFile(toNamespacedPath(join(out, 'manifest.json')), json, { flag: 'wx', mode: 0o600 });
    result.manifestSha256 = createHash('sha256').update(json).digest('hex');
  } catch (error) {
    await rm(toNamespacedPath(out), { recursive: true, force: true });
    throw error;
  }
  return result;
}

export async function checkBundle(manifest: StoreManifest, roots: StoreRoots, registry?: readonly ModelEntry[]) {
  const staged = await inspectStore(await planStore(roots, registry));
  const allowed = new Map(staged.files.map(file => [`${file.area}/${file.path}`, file]));
  for (const file of manifest.files) {
    const path = `${file.area}/${portablePath(file.path)}`;
    const expected = allowed.get(path);
    if (!expected || !Array.isArray(file.artifacts) || !file.artifacts.length) throw new Error(`Upload contains an unregistered path: ${path}`);
    if (expected.sha256 !== file.sha256 || expected.sizeBytes !== file.sizeBytes) throw new Error(`Staged artifact differs from manifest: ${path}`);
    for (const claim of file.artifacts) {
      if (!expected.artifacts.some(artifact => artifact.modelId === claim.modelId && artifact.version === claim.version
        && artifact.role === claim.role && artifact.required === claim.required && artifact.expectedSha256 === claim.expectedSha256
        && artifact.pinStatus === claim.pinStatus)) throw new Error(`Upload does not match the registry entry for ${path}`);
    }
  }
  const failed = staged.models.filter(model => model.status === 'hash mismatch');
  if (failed.length) throw new Error(`Staged registry pin check failed for: ${failed.map(model => model.id).join(', ')}`);
}

function printModels(manifest: StoreManifest) {
  for (const model of manifest.models) {
    console.log(`${model.id} (${model.version})  ${model.status}${model.reason ? `  ${model.reason}` : ''}`);
    for (const artifact of model.artifacts) {
      if (artifact.status === 'hash mismatch' || (artifact.status === 'absent' && artifact.required)) {
        console.log(`  ${artifact.role}${artifact.path ? ` (${artifact.path})` : ''}  ${artifact.reason ?? artifact.status}`);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const model of manifest.models) counts.set(model.status, (counts.get(model.status) ?? 0) + 1);
  console.log(`${manifest.models.length} models  ${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}`);
}

const usage = `Pack (dry run unless --write):
  node scripts/models/pack-store.mjs [--root SOURCE] [--ocr-dir OCR_SOURCE] [--worker-config CONFIG] [--out NEW_DIRECTORY] [--write] [--json]
Verify:
  npm run models:verify-store -- [--store DIRECTORY] [--ocr-dir DIRECTORY] [--strict] [--json]
  --store and --ocr-dir default to MOHASSAN_MODELS_ROOT and MOHASSAN_OCR_MODEL_DIR.`;

export async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    root: { type: 'string' }, 'ocr-dir': { type: 'string' }, 'worker-config': { type: 'string' },
    out: { type: 'string' }, write: { type: 'boolean' }, 'verify-store': { type: 'boolean' }, store: { type: 'string' },
    'check-bundle': { type: 'string' }, strict: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return 0; }
  if (values['check-bundle']) {
    if (!values.root) throw new Error('--check-bundle requires a staged --root');
    const manifest = JSON.parse(await readFile(values['check-bundle'], 'utf8')) as StoreManifest;
    await checkBundle(manifest, { root: values.root, ocrDir: values['ocr-dir'] });
    return 0;
  }
  if (values['verify-store']) {
    if (values.root || values.out || values.write || values['worker-config']) throw new Error('Use --store to select the verification root');
    const root = values.store ?? process.env.MOHASSAN_MODELS_ROOT?.trim();
    if (!root) throw new Error('Set MOHASSAN_MODELS_ROOT or pass --store');
    if (!(await stat(toNamespacedPath(resolve(root))).catch(() => undefined))?.isDirectory()) {
      throw new Error(`Model store directory is missing or unreadable: ${resolve(root)}`);
    }
    const ocrDir = values['ocr-dir'] ?? process.env.MOHASSAN_OCR_MODEL_DIR?.trim();
    const manifest = await inspectStore(await planStore({ root, ocrDir }));
    if (values.json) console.log(JSON.stringify({ root: resolve(root), ocrDir: ocrDir ? resolve(ocrDir) : null, models: manifest.models }));
    else printModels(manifest);
    return Number(manifest.models.some(model => model.status === 'hash mismatch' || (values.strict && model.status === 'absent')));
  }
  if (values.store || values.strict) throw new Error('--store and --strict apply to models:verify-store');
  const root = resolve(values.root ?? process.cwd());
  const out = resolve(values.out ?? 'artifacts/model-store-bundle');
  if (values.write && await lstat(toNamespacedPath(out)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  })) throw new Error(`Choose a new bundle directory: ${out}`);
  const result = await packStore({ root, ocrDir: values['ocr-dir'], workerConfig: values['worker-config'] }, out, values.write ?? false);
  if (values.json) console.log(JSON.stringify(result));
  else {
    printModels(result.manifest);
    console.log(`${result.manifest.files.length} files, ${result.manifest.totalBytes} payload bytes. Estimated bundle allocation: ${result.requiredBytes} bytes. Free: ${result.freeBytes} bytes.`);
    if (result.manifestSha256) console.log(`Bundle: ${out}\nManifest SHA-256: ${result.manifestSha256}`);
    else console.log(values.write ? 'Pin check failed. No bundle was written.' : 'Dry run. No bundle was written.');
  }
  return Number(result.manifest.models.some(model => model.status === 'hash mismatch'));
}
