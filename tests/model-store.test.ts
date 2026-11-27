import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, statfs, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getModelEntry, type ModelArtifact, type ModelEntry } from '../packages/model-relations/src/registry.js';
import { checkBundle, packStore } from '../scripts/models/pack-store.js';
import { inspectStore, planStore } from '../scripts/models/store.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const entry = (id: string, ...artifacts: ModelArtifact[]): ModelEntry => ({ ...getModelEntry('refusal')!, id, artifacts });
const artifact = (path: string, sha256: string | null = null, role = 'weights'): ModelArtifact => ({ role, path, sha256 });
const command = fileURLToPath(new URL('../scripts/models/pack-store.mjs', import.meta.url));

describe('model store tooling', () => {
  let temp: string;
  let root: string;
  let out: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'model-store-'));
    root = join(temp, 'owner checkout');
    out = join(temp, 'new bundle');
    await mkdir(root);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  async function put(path: string, data: Buffer | string) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  it('plans and packs exact registered files, cross-file pins and partial model sets', async () => {
    const bytes = randomBytes(55);
    const path = `artifacts/${'long-name-'.repeat(10)}/${'another directory '.repeat(9)}run/weights.bin`;
    const pinReference = 'artifacts/training/receipt.json';
    const registry = [entry('pinned', { ...artifact(path), pin: { reference: pinReference, keys: ['sha256'] } }),
      entry('partial', artifact(path), artifact('artifacts/missing', null, 'tokenizer')), entry('no-registered-output')];
    const metadata = JSON.stringify({ sha256: sha(bytes) });
    await put(path, bytes);
    await put(pinReference, metadata);
    await put('artifacts/unregistered.bin', randomBytes(32));

    const dry = await packStore({ root }, out, false, registry);
    expect(dry.manifestSha256).toBeUndefined();
    await expect(readFile(join(out, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(dry.requiredBytes).toBeGreaterThan(dry.manifest.totalBytes);

    const result = await packStore({ root }, out, true, registry);
    const receipt = await readFile(join(out, 'manifest.json'));
    expect(sha(receipt)).toBe(result.manifestSha256);
    expect(JSON.parse(receipt.toString()).totalBytes).toBe(bytes.length + Buffer.byteLength(metadata));
    expect(result.manifest.files).toEqual([
      { area: 'models', path, sizeBytes: bytes.length, sha256: sha(bytes), artifacts: [
        { modelId: 'pinned', version: registry[0].version, role: 'weights', required: true, expectedSha256: sha(bytes), pinStatus: 'match' },
        { modelId: 'partial', version: registry[1].version, role: 'weights', required: true, expectedSha256: null, pinStatus: 'no pin' },
      ] },
      { area: 'models', path: pinReference, sizeBytes: Buffer.byteLength(metadata), sha256: sha(Buffer.from(metadata)), artifacts: [
        { modelId: 'pinned', version: registry[0].version, role: 'pin-reference', required: false, expectedSha256: null, pinStatus: 'no pin' },
      ] },
    ]);
    const staged = join(out, 'files', 'models');
    expect(await readFile(join(staged, path))).toEqual(bytes);
    await expect(readFile(join(staged, 'artifacts/unregistered.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.manifest.models.map(model => model.status)).toEqual(['present', 'absent', 'absent']);
    expect(result.manifest.models[2].reason).toMatch(/No trained artifact declared/u);
    await expect(checkBundle(result.manifest, { root: staged }, registry)).resolves.toBeUndefined();
    const forged = structuredClone(result.manifest);
    forged.files[0].artifacts[0].pinStatus = 'no pin';
    await expect(checkBundle(forged, { root: staged }, registry)).rejects.toThrow(/registry entry/u);
    forged.files[0].path = 'artifacts/unregistered.bin';
    await expect(checkBundle(forged, { root }, registry)).rejects.toThrow(/unregistered path/u);
  });

  it.each(['../outside.bin', 'artifacts/../outside.bin', 'D:\\outside.bin', '/outside.bin', 'artifacts/COM¹.bin', 'artifacts/weights.bin\n'])('rejects unsafe registry paths (%s)', async path => {
    await expect(packStore({ root }, out, true, [entry('outside', artifact(path))])).rejects.toThrow(/Unsafe registry artifact path/u);
    await expect(readFile(join(out, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('refuses artifacts behind a symlinked directory or file', async () => {
    const elsewhere = join(temp, 'outside');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'weights.pt'), randomBytes(32));
    await symlink(elsewhere, join(root, 'linked'));
    await symlink(join(elsewhere, 'weights.pt'), join(root, 'linked.pt'));
    for (const name of ['linked/weights.pt', 'linked.pt']) {
      await expect(packStore({ root }, out, true, [entry('link', artifact(name))])).rejects.toThrow(/no symlink components/u);
    }
  });

  it.skipIf(process.platform !== 'linux')('checks capacity before hashing or creating the bundle', async () => {
    const path = 'artifacts/oversized.bin';
    await put(path, Buffer.alloc(0));
    const { bsize, bavail } = await statfs(temp);
    // A sparse file lets the test exceed the available payload space without filling the filesystem.
    await truncate(join(root, path), (bavail + 1) * bsize);
    await expect(packStore({ root }, out, true, [entry('too-large', artifact(path))])).rejects.toThrow(/Output filesystem needs/u);
    await expect(readFile(join(out, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-rooted GoalTagger config keeps its checkpoint pin and refuses paths outside the source', async () => {
    const goal = getModelEntry('google-ads-pointer')!;
    const checkpoint = randomBytes(9);
    const path = 'artifacts/my worker export/weights.pt';
    const workerConfig = join(root, 'config', 'approved.json');
    const config = { model: { checkpoint: { path: join(root, path), sha256: sha(checkpoint), format: 'goal-tagger' } } };
    await put(path, checkpoint);
    await put('config/approved.json', JSON.stringify(config));
    const bundle = await packStore({ root, workerConfig }, out, true, [goal]);
    const staged = join(out, 'files', 'models');
    expect(JSON.parse(await readFile(join(staged, '.data', 'model-worker.json'), 'utf8')).model.checkpoint.path)
      .toBe('model-worker-files/checkpoint/weights.pt');
    await expect(checkBundle(bundle.manifest, { root: staged }, [goal])).resolves.toBeUndefined();
    config.model.checkpoint.path = join(temp, 'outside.pt');
    await writeFile(config.model.checkpoint.path, checkpoint);
    await put('config/approved.json', JSON.stringify(config));
    await expect(packStore({ root, workerConfig }, join(temp, 'outside bundle'), true, [goal])).rejects.toThrow(/outside its source root/u);
  });

  it('reports present, absent, unpinned and mismatched artifacts and resolves OCR independently', async () => {
    const ocr = getModelEntry('ocr')!;
    const bytes = randomBytes(16);
    const ocrDir = join(temp, 'ocr');
    await mkdir(ocrDir);
    await writeFile(join(ocrDir, 'weights.bin'), bytes);
    await writeFile(join(ocrDir, 'manifest.json'), JSON.stringify({ weights: { sha256: sha(bytes) } }));
    await put('valid.pt', bytes);
    await put('wrong.pt', randomBytes(16));
    const registry = [entry('valid', artifact('valid.pt', sha(bytes))), entry('absent', artifact('missing.pt')),
      entry('unpinned', artifact('valid.pt')), entry('wrong', artifact('wrong.pt', sha(bytes))), ocr];
    const manifest = await inspectStore(await planStore({ root, ocrDir }, registry));
    expect(manifest.models.map(model => model.status)).toEqual(['present', 'absent', 'unpinned', 'hash mismatch', 'unpinned']);
    expect(manifest.files.find(file => file.path === 'weights.bin')).toMatchObject({ area: 'ocr', sha256: sha(bytes) });
    const result = await packStore({ root, ocrDir }, out, true, registry);
    expect(result.manifestSha256).toBeUndefined();
    await expect(readFile(join(out, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(join(ocrDir, 'manifest.json'), '{}');
    const unresolvable = await inspectStore(await planStore({ root, ocrDir }, [ocr]));
    expect(unresolvable.models[0].artifacts.find(item => item.role === 'weights')).toMatchObject({ status: 'hash mismatch', reason: /metadata/u });
  });

  it('verifies the requested store without falling back to trained checkout models', () => {
    const invoke = (...flags: string[]) => spawnSync(process.execPath, [command, '--verify-store', '--json', ...flags], {
      env: { ...process.env, MOHASSAN_MODELS_ROOT: root, MOHASSAN_OCR_MODEL_DIR: join(temp, 'empty OCR') }, encoding: 'utf8',
    });
    const report = invoke();
    expect(report.status, report.stderr).toBe(0);
    const parsed = JSON.parse(report.stdout);
    expect(parsed.root).toBe(root);
    expect(parsed.models.find((model: { id: string }) => model.id === 'scratch-route').status).toBe('absent');
    expect(invoke('--strict').status).toBe(1);
    expect(invoke('--store', join(temp, 'missing store')).status).toBe(1);
  });

  it('defaults the pack CLI to a dry run', async () => {
    const path = getModelEntry('refusal')!.artifacts[0].path;
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    await put(path, bytes);
    const result = spawnSync(process.execPath, [command, '--root', root, '--out', out], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Dry run/u);
    await expect(readFile(join(out, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
