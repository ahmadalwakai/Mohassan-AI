import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBudgetReceipt, budgetMachine, defaultSamplesPerLanguage, deriveBudget, installedBudgetReceiptPath,
  summarizeBudgetTimings, type BudgetReceipt, type LanguageMeasurement } from './budget-receipt.js';
import { getModelEntry, modelRegistry, resolveModel, unmeasuredModelRegistry } from './registry.js';

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

  it('labels defaults and applies only complete, matching measured budgets with provenance', async () => {
    expect(unmeasuredModelRegistry.every(entry => entry.resources.provenance === 'unmeasured')).toBe(true);
    const refusal = unmeasuredModelRegistry.find(entry => entry.id === 'refusal')!;
    const runtime = refusal.runtime;
    const modelId = refusal.id;
    const version = refusal.version;
    const artifacts = [{ role: 'weights', sha256: refusal.artifacts[0]!.sha256! }];
    const ascendingMs = Array.from({ length: defaultSamplesPerLanguage }, (_, index) => index + 1);
    const coldStartMs = summarizeBudgetTimings(ascendingMs);
    expect(coldStartMs.p50).toBe((ascendingMs[9]! + ascendingMs[10]!) / 2);
    expect(coldStartMs.p95).toBe(ascendingMs[18]);
    const fixture = 'tests/fixtures/refusal-development.ts';
    const sourceSha256 = createHash('sha256').update(await readFile(join(checkout, fixture))).digest('hex');
    const measurement: LanguageMeasurement = {
      source: fixture, sourceSha256, inputSha256: sourceSha256,
      coldStartMs, warmCallMs: summarizeBudgetTimings(ascendingMs.map(value => value / 2)),
      peakRssKiB: 80 * 1024, peakNodeRssKiB: 80 * 1024, residentReservationBasisKiB: 80 * 1024,
    };
    const languages = { ar: measurement, en: measurement };
    const recommendedBudget = deriveBudget(languages);
    const machine = budgetMachine();
    const commit = '29448aea3fa10d226ef82ec5bf0a65e723d6ec39';
    const receipt: BudgetReceipt = {
      schemaVersion: 1, commit, dirty: false, createdAt: new Date().toISOString(),
      machine, samplesPerLanguage: defaultSamplesPerLanguage,
      models: [{ status: 'measured', modelId, version, runtime, artifacts, languages, recommendedBudget }],
    };
    const serialized = JSON.stringify(receipt);
    const path = await write(installedBudgetReceiptPath, serialized);
    expect(applyBudgetReceipt([refusal], path, machine)[0]?.resources).toMatchObject({
      startupMs: Math.ceil(2 * coldStartMs.p95 + 20),
      latencyMs: Math.ceil(2 * measurement.warmCallMs.p95 + 20),
      memoryMb: Math.ceil(1.25 * measurement.residentReservationBasisKiB / 1024),
      provenance: { receipt: installedBudgetReceiptPath, sha256: sha(serialized), commit },
    });
    expect(applyBudgetReceipt([refusal], path, { ...machine, arch: machine.arch === 'arm64' ? 'x64' : 'arm64' })).toEqual([refusal]);
    await writeFile(path, JSON.stringify({ ...receipt, dirty: true }));
    expect(applyBudgetReceipt([refusal], path, machine)).toEqual([refusal]);
    await writeFile(path, JSON.stringify({ ...receipt, samplesPerLanguage: 1 }));
    expect(applyBudgetReceipt([refusal], path, machine)).toEqual([refusal]);
    artifacts[0]!.sha256 = sha('');
    await writeFile(path, JSON.stringify(receipt));
    expect(applyBudgetReceipt([refusal], path, machine)).toEqual([refusal]);
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
