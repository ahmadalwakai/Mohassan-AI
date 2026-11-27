import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { z } from 'zod';
import type { ModelEntry } from './registry.js';

export const installedBudgetReceiptPath = '.data/model-runtime-budgets.json';
export const budgetLanguages = ['ar', 'en'] as const;
export const defaultSamplesPerLanguage = 20;
export const maxSamplesPerLanguage = 100;
// Match the default maximum worker request time in model_worker/runtime.py.
export const budgetProbeTimeoutMs = 120_000;
const KiBPerMiB = 1024;
// Operational margins for differences between an isolated sample and a live request.
const latencyMultiplier = 2;
const schedulingAllowanceMs = 20;
const memoryMultiplier = 1.25;
// Minimum accepted by the permanent worker's _LIMITS in model_worker/runtime.py.
const minimumWorkerMemoryMiB = 128;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const machineSchema = z.object({
  platform: z.string(), arch: z.string(), cpuModel: z.string(), availableCpus: z.number().int().positive(),
  totalMemoryBytes: z.number().int().positive(), kernelRelease: z.string(), node: z.string(),
});

export const budgetMachine = () => ({
  platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model ?? 'unknown',
  availableCpus: availableParallelism(), totalMemoryBytes: totalmem(), kernelRelease: release(), node: process.version,
});

export const hashBudgetBytes = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const samples = z.array(z.number().positive().max(budgetProbeTimeoutMs)).min(1).max(maxSamplesPerLanguage);
const timings = z.object({ p50: z.number().positive(), p95: z.number().positive(), samples });
const probe = z.object({
  source: z.string(), sourceSha256: sha256, inputSha256: sha256,
  coldStartMs: timings, warmCallMs: timings, peakRssKiB: z.number().int().positive(),
  peakNodeRssKiB: z.number().int().positive(), residentReservationBasisKiB: z.number().int().positive(),
  peakWorkerRssKiB: z.number().int().positive().optional(), peakWorkerAddressSpaceKiB: z.number().int().positive().optional(),
});
const artifacts = z.array(z.object({ role: z.string(), sha256 }));
const identity = z.object({ modelId: z.string(), version: z.string(), runtime: z.enum(['node-cpu', 'python-worker', 'gpu']) });
const limits = z.object({
  startupMs: z.number().int().positive(), latencyMs: z.number().int().positive(), memoryMb: z.number().int().positive(),
  workerMemoryMb: z.number().int().positive().optional(),
});
const receiptModel = z.discriminatedUnion('status', [
  identity.extend({ status: z.literal('measured'), artifacts, languages: z.object({ ar: probe, en: probe }), recommendedBudget: limits }),
  identity.extend({ status: z.literal('absent'), missing: z.array(z.string()) }),
  identity.extend({
    status: z.literal('failed'), language: z.enum(budgetLanguages).optional(), reason: z.string(),
    phase: z.enum(['probe', 'cold-start', 'first-call', 'warm-call', 'memory', 'measurement']),
  }),
]);
export const budgetReceiptSchema = z.object({
  schemaVersion: z.literal(1), createdAt: z.iso.datetime(), commit: z.string().regex(/^[a-f0-9]{40}$/u), dirty: z.boolean(),
  machine: machineSchema, samplesPerLanguage: z.number().int().min(1).max(maxSamplesPerLanguage),
  models: z.array(receiptModel),
});
export type BudgetReceipt = z.output<typeof budgetReceiptSchema>;
export type MeasuredModelBudget = Extract<BudgetReceipt['models'][number], { status: 'measured' }>;
export type LanguageMeasurement = MeasuredModelBudget['languages']['en'];
export type BudgetLanguage = typeof budgetLanguages[number];
export type BudgetProvenance = 'unmeasured' | { readonly receipt: string; readonly sha256: string; readonly commit: string };

export function summarizeBudgetTimings(samples: number[]): LanguageMeasurement['coldStartMs'] {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    p50: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    samples,
  };
}

export function deriveBudget(languages: MeasuredModelBudget['languages']): MeasuredModelBudget['recommendedBudget'] {
  const { ar, en } = languages;
  const cold = Math.max(ar.coldStartMs.p95, en.coldStartMs.p95);
  const warm = Math.max(ar.warmCallMs.p95, en.warmCallMs.p95);
  const rss = Math.max(ar.residentReservationBasisKiB, en.residentReservationBasisKiB);
  const worker = Math.max(ar.peakWorkerAddressSpaceKiB ?? 0, en.peakWorkerAddressSpaceKiB ?? 0);
  return {
    startupMs: Math.ceil(cold * latencyMultiplier + schedulingAllowanceMs),
    latencyMs: Math.ceil(warm * latencyMultiplier + schedulingAllowanceMs),
    memoryMb: Math.ceil(rss * memoryMultiplier / KiBPerMiB),
    ...(worker ? { workerMemoryMb: Math.max(minimumWorkerMemoryMiB, Math.ceil(worker * memoryMultiplier / KiBPerMiB)) } : {}),
  };
}

/** An operator installs a reviewed receipt for this machine. A malformed or foreign receipt leaves the defaults unmeasured. */
export function applyBudgetReceipt(entries: readonly ModelEntry[], path: string, machine = budgetMachine()): readonly ModelEntry[] {
  let bytes: Buffer;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 1024 * 1024) return entries;
      bytes = readFileSync(fd);
      if (bytes.length !== info.size) return entries;
    } finally {
      closeSync(fd);
    }
  } catch {
    return entries;
  }
  let receipt: BudgetReceipt;
  try { receipt = budgetReceiptSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { return entries; }
  if (receipt.machine.arch !== machine.arch || receipt.machine.platform !== machine.platform ||
    receipt.machine.cpuModel !== machine.cpuModel || receipt.machine.node !== machine.node ||
    receipt.machine.availableCpus !== machine.availableCpus || receipt.machine.kernelRelease !== machine.kernelRelease ||
    receipt.machine.totalMemoryBytes !== machine.totalMemoryBytes || receipt.dirty ||
    receipt.samplesPerLanguage < defaultSamplesPerLanguage) return entries;
  const measured = new Map(receipt.models.filter(row => row.status === 'measured').map(row => [row.modelId, row]));
  const provenance = { receipt: installedBudgetReceiptPath, sha256: hashBudgetBytes(bytes), commit: receipt.commit };
  return entries.map(entry => {
    const row = measured.get(entry.id);
    if (!row || row.version !== entry.version || row.runtime !== entry.runtime ||
      !entry.artifacts.every(artifact => !artifact.sha256 || row.artifacts.some(item =>
        item.role === artifact.role && item.sha256 === artifact.sha256)) ||
      !budgetLanguages.every(language => {
        const sample = row.languages[language];
        return (entry.runtime === 'node-cpu' || Boolean(sample.peakWorkerAddressSpaceKiB && sample.peakWorkerRssKiB)) &&
          [sample.coldStartMs, sample.warmCallMs].every(timing => {
            const expected = summarizeBudgetTimings(timing.samples);
            return timing.samples.length === receipt.samplesPerLanguage && expected.p50 === timing.p50 && expected.p95 === timing.p95;
          });
      })) return entry;
    return { ...entry, resources: { ...entry.resources, ...deriveBudget(row.languages), provenance } };
  });
}
