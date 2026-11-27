import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareProbe } from './budget-inputs.js';
import type { ProbeSample } from './budget-probe.js';
import {
  budgetLanguages, budgetMachine, budgetProbeTimeoutMs, budgetReceiptSchema, defaultSamplesPerLanguage, deriveBudget,
  maxSamplesPerLanguage, summarizeBudgetTimings, type BudgetReceipt, type LanguageMeasurement,
} from './budget-receipt.js';
import { modelRoots, resolveModelInRoots, unmeasuredModelRegistry, type ModelEntry } from './registry.js';

export const defaultBudgetReceiptPath = '.data/model-runtime-budget-receipt.json';
const execute = promisify(execFile);
const probeScript = fileURLToPath(new URL(`./budget-probe${extname(import.meta.filename)}`, import.meta.url));
const isolateTimeoutMs = budgetProbeTimeoutMs * 3 + 5_000; // Three runtime phases, plus launch and cleanup.

async function runSample(root: string, modelId: string, input: unknown): Promise<ProbeSample> {
  return new Promise(done => {
    const child = execFile(process.execPath, ['--import', import.meta.resolve('tsx'), probeScript, modelId],
      { cwd: root, timeout: isolateTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (!error) {
          try { done(JSON.parse(stdout) as ProbeSample); return; } catch { /* Report the invalid sample below. */ }
        }
        done({ ok: false, phase: 'measurement', reason: error?.killed ? 'timeout' : 'probe-process-failed' });
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

async function measureModel(root: string, roots: readonly string[], scratch: string, entry: ModelEntry, samples: number): Promise<BudgetReceipt['models'][number]> {
  const identity = { modelId: entry.id, version: entry.version, runtime: entry.runtime };
  const model = await resolveModelInRoots(entry, roots, process.env, false);
  if (model.state === 'absent') {
    return { ...identity, status: 'absent', missing: model.artifacts.filter(item => item.required && !item.present).map(item => item.role) };
  }
  const languages = {} as Record<typeof budgetLanguages[number], LanguageMeasurement>;
  let artifacts: Extract<ProbeSample, { ok: true }>['artifacts'] | undefined;
  for (const language of budgetLanguages) {
    let prepared: Awaited<ReturnType<typeof prepareProbe>>;
    try { prepared = await prepareProbe(root, scratch, model, language); }
    catch { return { ...identity, status: 'failed', language, phase: 'probe', reason: 'fixture-unavailable' }; }
    const { input, ...source } = prepared;
    const timings: Extract<ProbeSample, { ok: true }>[] = [];
    for (let index = 0; index < samples; index++) {
      const result = await runSample(root, entry.id, input);
      if (!result.ok) {
        const { phase, reason } = result;
        return { ...identity, status: 'failed', language, phase, reason };
      }
      if (entry.runtime !== 'node-cpu' && !result.worker) {
        return { ...identity, status: 'failed', language, phase: 'memory', reason: 'worker-memory-unavailable' };
      }
      artifacts ??= result.artifacts;
      if (JSON.stringify(artifacts) !== JSON.stringify(result.artifacts)) {
        return { ...identity, status: 'failed', language, phase: 'measurement', reason: 'artifacts-changed' };
      }
      timings.push(result);
    }
    const workerRss = Math.max(0, ...timings.map(item => item.worker?.peakRssKiB ?? 0));
    const workerAddressSpace = Math.max(0, ...timings.map(item => item.worker?.peakAddressSpaceKiB ?? 0));
    const peakNodeRssKiB = Math.max(...timings.map(item => item.nodePeakRssKiB));
    languages[language] = {
      ...source, coldStartMs: summarizeBudgetTimings(timings.map(item => item.coldMs)),
      warmCallMs: summarizeBudgetTimings(timings.map(item => item.warmMs)),
      peakRssKiB: Math.max(workerRss, peakNodeRssKiB),
      peakNodeRssKiB,
      // The processes may peak at different times. Their sum bounds concurrent resident memory.
      residentReservationBasisKiB: Math.max(...timings.map(item => item.nodePeakRssKiB + (item.worker?.peakRssKiB ?? 0))),
      ...(workerRss ? { peakWorkerRssKiB: workerRss, peakWorkerAddressSpaceKiB: workerAddressSpace } : {}),
    };
  }
  return { ...identity, status: 'measured', artifacts: artifacts!, languages, recommendedBudget: deriveBudget(languages) };
}

async function checkoutState(root: string) {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execute('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execute('git', ['status', '--porcelain'], { cwd: root }),
  ]);
  return { commit: revision.trim(), dirty: Boolean(status.trim()) };
}

export async function measureModelBudgets({ root, outputPath = defaultBudgetReceiptPath, samples = defaultSamplesPerLanguage }:
  { root: string; outputPath?: string; samples?: number }): Promise<BudgetReceipt> {
  if (process.platform !== 'linux') throw new Error('Model budget measurement requires Linux for consistent RSS and worker address-space readings.');
  if (!Number.isInteger(samples) || samples < 1 || samples > maxSamplesPerLanguage) {
    throw new Error(`Samples per language must be an integer from 1 to ${maxSamplesPerLanguage}.`);
  }
  const path = resolve(root, outputPath);
  const { commit, dirty } = await checkoutState(root);
  const createdAt = new Date().toISOString();
  const machine = budgetMachine();
  const models: BudgetReceipt['models'] = [];
  const roots = modelRoots(root);
  const scratch = await mkdtemp(join(tmpdir(), 'mohassan-budget-probe-'));
  try {
    for (const entry of unmeasuredModelRegistry) models.push(await measureModel(root, roots, scratch, entry, samples));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const after = await checkoutState(root);
  const receipt = budgetReceiptSchema.parse({ schemaVersion: 1, createdAt, commit,
    dirty: dirty || after.dirty || commit !== after.commit, machine, samplesPerLanguage: samples, models });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return receipt;
}
