import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listModels } from '../../../apps/server/src/models-routes.js';
import { getModelEntry, modelRegistry, modelRoots, resolveModel } from './registry.js';
import { ModelRuntime } from './runtime.js';

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

  it('lists and loads checked-in models from a temporary working directory and an empty model store', async () => {
    const originalCwd = process.cwd();
    const store = join(root, 'empty-store');
    await mkdir(store);
    process.chdir(root);
    const env = { MOHASSAN_MODELS_ROOT: store };
    let runtime: ModelRuntime | undefined;
    try {
      const roots = modelRoots(process.cwd(), env);
      expect(roots).toEqual([store, process.cwd(), resolve(checkout)]);
      expect(modelRoots(checkout, { MOHASSAN_MODELS_ROOT: checkout })).toEqual([resolve(checkout)]);
      const models = await listModels({ roots, imageReaderLive: false, v5Live: false, councilLive: true });
      runtime = new ModelRuntime({ artifactRoots: roots, env });
      for (const id of ['scratch-route', 'refusal', 'arithmetic']) {
        expect(models.find(model => model.id === id)).toMatchObject({ present: true });
        expect(await runtime.health(id)).toMatchObject({ ok: true });
      }
    } finally {
      process.chdir(originalCwd);
      await runtime?.close();
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
    const config = '.data/goal-tagger-worker.json';
    const checkpoint = await write('.data/best.pt', 'pointer test weights');
    const sha256 = sha('pointer test weights');
    const writeConfig = (format: string) => write(config, JSON.stringify({ model: { checkpoint: { path: 'best.pt', sha256, format } } }));
    await writeConfig('training');
    expect((await resolveModel(model, root, {})).state).toBe('absent');
    await writeConfig('goal-tagger');
    const resolved = await resolveModel(model, root, {});
    expect(resolved.state).toBe('experimental');
    expect(resolved.artifacts.find(item => item.role === 'checkpoint')).toMatchObject({ path: checkpoint, sha256, matchesPin: true });
    expect(resolved.artifacts.find(item => item.role === 'tokenizer')).toMatchObject({ required: false, present: false });
  });

  it('resolves chat-v5 and GoalTagger from their own worker configurations', async () => {
    const chat = getModelEntry('chat-v5')!;
    const tagger = getModelEntry('google-ads-pointer')!;
    const checkpoint = chat.artifacts.find(item => item.role === 'checkpoint')!;
    const tokenizer = chat.artifacts.find(item => item.role === 'tokenizer')!;
    const report = chat.artifacts.find(item => item.role === 'tokenizer-report')!;
    const checkpointSha = sha('chat fixture checkpoint');
    const tokenizerSha = sha('chat fixture tokenizer');
    const goalTaggerSha = sha('tagger fixture checkpoint');
    const chatCheckpoint = await write(checkpoint.path, 'chat fixture checkpoint');
    await write(checkpoint.pin!.reference, JSON.stringify({ files: { [basename(checkpoint.path)]: checkpointSha } }));
    await write(tokenizer.path, 'chat fixture tokenizer');
    await write(report.path, 'chat fixture tokenizer report');
    await write(tokenizer.pin!.reference, JSON.stringify({ tokenizer_sha256: {
      [basename(tokenizer.path)]: tokenizerSha, [basename(report.path)]: sha('chat fixture tokenizer report'),
    } }));

    const v5Config = await write('v5/worker.json', JSON.stringify({ model: {
      checkpoint: { path: chatCheckpoint, sha256: checkpointSha, format: 'training' },
    } }));
    const v5Env = { MOHASSAN_MODEL_WORKER_CONFIG: v5Config };
    expect((await resolveModel(tagger, root, v5Env)).state).toBe('absent');

    const taggerCheckpoint = await write('tagger/tagger.pt', 'tagger fixture checkpoint');
    const taggerConfig = await write('tagger/worker.json', JSON.stringify({ model: {
      checkpoint: { path: 'tagger.pt', sha256: goalTaggerSha, format: 'goal-tagger' },
    } }));
    const env = { ...v5Env, MOHASSAN_GOAL_TAGGER_CONFIG: 'tagger/worker.json' };
    const [resolvedChat, resolvedTagger] = await Promise.all([resolveModel(chat, root, env), resolveModel(tagger, root, env)]);
    expect(resolvedChat).toMatchObject({ state: 'experimental', artifacts: expect.arrayContaining([
      expect.objectContaining({ role: 'worker-config', path: v5Config, present: true }),
      expect.objectContaining({ role: 'checkpoint', path: chatCheckpoint, matchesPin: true }),
    ]) });
    expect(resolvedTagger).toMatchObject({ state: 'experimental', artifacts: expect.arrayContaining([
      expect.objectContaining({ role: 'worker-config', path: taggerConfig, present: true }),
      expect.objectContaining({ role: 'checkpoint', path: taggerCheckpoint, matchesPin: true }),
    ]) });
  });
});
