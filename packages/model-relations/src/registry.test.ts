import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getModelEntry, modelRegistry, resolveModel } from './registry.js';

const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

let root: string;

async function write(path: string, content: string): Promise<string> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

describe('model registry', () => {
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mohassan-model-registry-')); });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  it('lists every tracked deployable model with matching SHA-256 and compatible dependency IDs', async () => {
    expect(new Set(modelRegistry.map(entry => entry.id)).size).toBe(modelRegistry.length);
    for (const entry of modelRegistry) {
      expect(new Set(entry.artifacts.map(item => item.role)).size).toBe(entry.artifacts.length);
      await expect(readFile(join(checkout, entry.owner))).resolves.toBeInstanceOf(Buffer);
      await expect(readFile(join(checkout, entry.dataCard))).resolves.toBeInstanceOf(Buffer);
      for (const dependency of entry.dependencies) expect(getModelEntry(dependency.id)?.version).toBe(dependency.version);
    }
    for (const id of ['scratch-route', 'scratch-speech-act', 'scratch-refusal', 'scratch-follow-up', 'refusal', 'arithmetic']) {
      const entry = getModelEntry(id)!;
      const model = await resolveModel(entry, checkout, {});
      expect(model.state).toBe(entry.state);
      expect(model.artifacts.every(item => item.present && item.matchesPin && item.sha256 === item.expectedSha256)).toBe(true);
    }
  });

  it('returns absent when required files are missing even with an activation flag', async () => {
    const refusal = getModelEntry('refusal')!;
    const env = { MOHASSAN_REFUSAL_POLICY: '1' };
    expect((await resolveModel(refusal, root, env)).state).toBe('absent');
    await write(refusal.artifacts[0].path, 'modified weights');
    const resolved = await resolveModel(refusal, root, env);
    expect(resolved.state).toBe('active');
    expect(resolved.artifacts[0]).toMatchObject({ present: true, required: true, matchesPin: false, sha256: sha('modified weights') });
  });

  it('resolves the configured OCR directory and checks the manifest-provided weight pin', async () => {
    const ocr = getModelEntry('ocr')!;
    const weights = await write('approved-export/weights.bin', 'image test weights');
    const env = { MOHASSAN_OCR_MODEL_DIR: 'approved-export' };
    expect((await resolveModel(ocr, root, env)).state).toBe('absent');
    await write('approved-export/manifest.json', JSON.stringify({ weights: { sha256: sha('image test weights') } }));
    expect((await resolveModel(ocr, root, env, false)).artifacts[1]).toMatchObject({ path: weights, sha256: sha('image test weights'), matchesPin: null });
    expect((await resolveModel(ocr, root, env)).artifacts[1]).toMatchObject({ path: weights, present: true, matchesPin: true });
  });

  it('requires an actual GoalTagger config with a pinned local checkpoint', async () => {
    const model = getModelEntry('google-ads-pointer')!;
    const config = 'worker/approved.json';
    const env = { MOHASSAN_MODEL_WORKER_CONFIG: config };
    const checkpoint = await write('worker/best.pt', 'pointer test weights');
    const sha256 = sha('pointer test weights');
    const writeConfig = (format: string) => write(config, JSON.stringify({ model: { checkpoint: { path: 'best.pt', sha256, format } } }));
    await writeConfig('training');
    expect((await resolveModel(model, root, env)).state).toBe('absent');
    await writeConfig('goal-tagger');
    const resolved = await resolveModel(model, root, env);
    expect(resolved.state).toBe('experimental');
    expect(resolved.artifacts.find(item => item.role === 'checkpoint')).toMatchObject({ path: checkpoint, sha256, matchesPin: true });
    expect(resolved.artifacts.find(item => item.role === 'tokenizer')).toMatchObject({ required: false, present: false });
  });
});
