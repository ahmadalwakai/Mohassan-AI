import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { featureIndices, featureSets } from './features.ts';

export const SCRATCH_HEADS = ['refusal', 'speechAct', 'route', 'followUp'] as const;
export type ScratchHead = typeof SCRATCH_HEADS[number];

export class ScratchClassifierPinMismatch extends Error {}

export interface ScratchPrediction {
  label: string | undefined;
  abstained: boolean;
  topK: { label: string; score: number }[];
}

export interface ScratchPredictionOptions {
  previousText?: string;
  topK?: number;
}

export interface ScratchClassifiers {
  predict(head: ScratchHead, text: string, options?: ScratchPredictionOptions): ScratchPrediction;
  predictAll(text: string, options?: ScratchPredictionOptions): Record<ScratchHead, ScratchPrediction>;
}

interface Model {
  labels: string[];
  dimensions: number;
  weights: Int16Array;
  weightScale: number;
  bias: number[];
  temperature: number;
  threshold: number;
}

const MODEL_DIRECTORY = new URL('../models/', import.meta.url);
const HEAD_LIMIT_BYTES = 2_000_000;
// Calibration exports the next float above 1 when no operating point meets its target.
const ALWAYS_ABSTAIN_THRESHOLD = 1 + Number.EPSILON;

function readArtifact(file: URL, sizeLimit: number): Buffer {
  const descriptor = openSync(file, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size >= sizeLimit) {
      throw new Error(`Invalid scratch classifier artifact size: ${file.pathname}`);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== stat.size) throw new Error(`Scratch classifier artifact size changed: ${file.pathname}`);
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function loadHead(file: URL, expectedHash: unknown): Model {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw new Error(`Invalid scratch classifier SHA-256 pin: ${file.pathname}`);
  }
  const bytes = readArtifact(file, HEAD_LIMIT_BYTES);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new ScratchClassifierPinMismatch(`Scratch classifier SHA-256 mismatch: ${file.pathname}`);
  }

  const model: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(model) || model.version !== 1) throw new Error(`Invalid scratch classifier version: ${file.pathname}`);
  const { labels, dimensions, weights, weightScale, bias, temperature, threshold } = model;
  if (!Array.isArray(labels) || labels.length < 2 || labels.some(label => typeof label !== 'string' || label.length === 0)
    || new Set(labels).size !== labels.length || typeof dimensions !== 'number' || !Number.isSafeInteger(dimensions) || dimensions < 1
    || typeof weights !== 'string' || !isFiniteNumber(weightScale) || weightScale <= 0
    || !Array.isArray(bias) || bias.length !== labels.length || !bias.every(isFiniteNumber)
    || !isFiniteNumber(temperature) || temperature <= 0 || !isFiniteNumber(threshold)
    || threshold < 0 || threshold > ALWAYS_ABSTAIN_THRESHOLD) {
    throw new Error(`Invalid scratch classifier schema: ${file.pathname}`);
  }

  const elements = labels.length * dimensions;
  const rawWeights = Buffer.from(weights, 'base64');
  const maxDotProduct = dimensions * 32768 * weightScale;
  if (rawWeights.length !== elements * Int16Array.BYTES_PER_ELEMENT || rawWeights.toString('base64') !== weights
    || bias.some(value => !Number.isFinite((Math.abs(value) + maxDotProduct) / temperature))) {
    throw new Error(`Invalid scratch classifier weights: ${file.pathname}`);
  }
  const quantizedWeights = new Int16Array(elements);
  for (let index = 0; index < elements; index++) quantizedWeights[index] = rawWeights.readInt16LE(index * 2);
  return { labels, dimensions, weights: quantizedWeights, weightScale, bias, temperature, threshold };
}

function score(model: Model, indices: number[], topK: number): ScratchPrediction {
  if (indices.length === 0) return { label: undefined, abstained: true, topK: [] };
  const { dimensions, weights, weightScale, bias, temperature, labels, threshold } = model;
  const logits = labels.map((_, row) => {
    const offset = row * dimensions;
    let sum = 0;
    for (const index of indices) sum += weights[offset + index];
    return (bias[row] + sum * weightScale) / temperature;
  });
  const largest = logits.reduce((maximum, logit) => Math.max(maximum, logit), -Infinity);
  const exp = logits.map(logit => Math.exp(logit - largest));
  const total = exp.reduce((sum, value) => sum + value, 0);
  const ranked = labels.map((label, row) => ({ label, score: exp[row] / total }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const abstained = best.score < threshold;
  return { label: abstained ? undefined : best.label, abstained, topK: ranked.slice(0, topK) };
}

function topKCount(topK: number | undefined): number {
  if (topK === undefined) return 3;
  if (!Number.isSafeInteger(topK) || topK < 0) throw new RangeError('topK must be a nonnegative integer');
  return topK;
}

/** Load and verify the four packaged models once, before scoring messages. */
export function loadScratchClassifiers(directory: URL = MODEL_DIRECTORY): ScratchClassifiers {
  const manifest: unknown = JSON.parse(readArtifact(new URL('manifest.json', directory), 4096).toString('utf8'));
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.sha256)) {
    throw new Error('Invalid scratch classifier manifest');
  }
  const pins = manifest.sha256;
  const models: Record<ScratchHead, Model> = {
    refusal: loadHead(new URL('refusal.json', directory), pins.refusal),
    speechAct: loadHead(new URL('speechAct.json', directory), pins.speechAct),
    route: loadHead(new URL('route.json', directory), pins.route),
    followUp: loadHead(new URL('followUp.json', directory), pins.followUp),
  };

  return {
    predict(head, text, options) {
      const model = models[head];
      const previousText = head === 'followUp' ? options?.previousText : undefined;
      return score(model, featureIndices(text, model.dimensions, previousText), topKCount(options?.topK));
    },
    predictAll(text, options) {
      const k = topKCount(options?.topK);
      const byDimensions = new Map<number, number[]>();
      const currentFeatures = (dimensions: number) => {
        let features = byDimensions.get(dimensions);
        if (features === undefined) {
          features = featureIndices(text, dimensions);
          byDimensions.set(dimensions, features);
        }
        return features;
      };
      const followUp = featureSets(text, models.followUp.dimensions, options?.previousText);
      byDimensions.set(models.followUp.dimensions, followUp.current);
      return {
        refusal: score(models.refusal, currentFeatures(models.refusal.dimensions), k),
        speechAct: score(models.speechAct, currentFeatures(models.speechAct.dimensions), k),
        route: score(models.route, currentFeatures(models.route.dimensions), k),
        followUp: score(models.followUp, followUp.withContext, k),
      };
    },
  };
}
