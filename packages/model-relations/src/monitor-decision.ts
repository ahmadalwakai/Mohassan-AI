import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ArbiterBrain, type ArbiterInput } from './arbiter.js';

export const monitorDecisionModelId = 'monitor-context-head';
export const monitorDecisionType = 'monitor-context';
export const monitorReasonerComponent = 'context-reasoner';
export const monitorHeadComponent = 'monitor-context-head';

export const monitorDecisionLabels = ['none', 'offer', 'propose', 'manage', 'reminder'] as const;
export type MonitorDecisionLabel = typeof monitorDecisionLabels[number];

export interface MonitorDecisionHeadInput {
  frameFeatures: Readonly<Record<string, number>>;
  textFeatureIds: readonly number[];
}

export interface MonitorDecisionClaim {
  label: MonitorDecisionLabel;
  score: number;
}

export interface MonitorDecisionPrediction {
  label: MonitorDecisionLabel | null;
  score: number;
}

export interface MonitorDecisionContext {
  language: 'ar' | 'en';
  length: number;
  conversationState: 'initial' | 'follow-up' | 'pending';
}

export function makeMonitorArbiterInput(context: MonitorDecisionContext, baseline: MonitorDecisionClaim,
  learned?: MonitorDecisionClaim): ArbiterInput {
  return {
    type: monitorDecisionType,
    precedence: monitorReasonerComponent,
    claimants: [{ component: monitorReasonerComponent, ...baseline },
      ...(learned ? [{ component: monitorHeadComponent, ...learned, modelState: 'shadow' as const }] : [])],
    language: context.language,
    length: context.length,
    conversationState: context.conversationState,
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
export const isMonitorDecisionLabel = (value: unknown): value is MonitorDecisionLabel =>
  monitorDecisionLabels.includes(value as MonitorDecisionLabel);
export const isMonitorDecisionClaim = (value: unknown): value is MonitorDecisionClaim =>
  isRecord(value) && isMonitorDecisionLabel(value.label) && isFiniteNumber(value.score) && value.score >= 0 && value.score <= 1;

// All operations that create or change schedules keep their existing authority.
// The only eligible override is declining to show an otherwise admissible offer.
export function monitorHeadMayOverride(baseline: MonitorDecisionLabel, learned: MonitorDecisionLabel, protectedTurn = false): boolean {
  return !protectedTurn && baseline === 'offer' && learned === 'none';
}

const featureName = /^[a-z][a-zA-Z0-9_-]{0,63}$/u;
const maxFrameValue = 8_000;
const maxArtifactBytes = 1_000_000;
const alwaysAbstain = 1 + Number.EPSILON;

export const monitorArtifactSha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function readMonitorArtifact(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxArtifactBytes) throw new Error('Invalid monitor artifact size');
    const content = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('Monitor artifact size changed');
    return content.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** The owner installs this artifact after the monitor-specific dual gate passes. */
export class MonitorDecisionPromotion {
  private constructor(readonly brain: ArbiterBrain, readonly weightsSha256: string) {}

  static fromArtifact(artifact: unknown, weightsSha256: string): MonitorDecisionPromotion | undefined {
    if (!isRecord(artifact) || artifact.schemaVersion !== 1 || artifact.trainingSource !== 'human'
      || !isSha256(weightsSha256) || artifact.weightsSha256 !== weightsSha256
      || !isSha256(artifact.replaySha256) || !isSha256(artifact.developmentBeforeSha256) || !isSha256(artifact.developmentAfterSha256)
      || !isRecord(artifact.gates) || artifact.gates.timeHeldOut !== true || artifact.gates.development !== true
      || !isRecord(artifact.arbiter) || artifact.arbiter.schemaVersion !== 1 || !isRecord(artifact.arbiter.decisions)
      || Object.keys(artifact.arbiter.decisions).length !== 1) return undefined;
    const model = artifact.arbiter.decisions[monitorDecisionType];
    if (!isRecord(model) || !isFiniteNumber(model.threshold) || model.threshold <= 0 || model.threshold > 1
      || !Array.isArray(model.components) || model.components.length !== 2 || !model.components.includes(monitorReasonerComponent)
      || !model.components.includes(monitorHeadComponent)) return undefined;
    const brain = new ArbiterBrain(artifact.arbiter);
    const probe = makeMonitorArbiterInput({ language: 'en', length: 0, conversationState: 'initial' },
      { label: 'offer', score: 1 }, { label: 'none', score: 1 });
    if (brain.choose(probe).confidence === null) return undefined;
    return new MonitorDecisionPromotion(brain, weightsSha256);
  }
}

export function loadMonitorDecisionHead(artifact: unknown, options: { pipelineCheck?: boolean } = {}) {
  if (!isRecord(artifact) || artifact.schemaVersion !== 1 || artifact.featureSchemaVersion !== 1
    || (artifact.trainingSource !== 'human' && !(options.pipelineCheck && artifact.trainingSource === 'pipeline-check'))) {
    throw new Error('Incompatible monitor decision head provenance or schema');
  }
  const { labels, dimensions, weights, weightScale, bias, temperature, threshold, frameFeatureKeys, textFeatureDimensions } = artifact;
  if (!Array.isArray(labels) || labels.length !== monitorDecisionLabels.length
    || !labels.every((label, i) => label === monitorDecisionLabels[i])
    || !Array.isArray(frameFeatureKeys) || frameFeatureKeys.length < 1 || frameFeatureKeys.length > 256
    || !frameFeatureKeys.every((name, i) => typeof name === 'string' && featureName.test(name) && (i === 0 || name > frameFeatureKeys[i - 1]))
    || !isFiniteNumber(textFeatureDimensions) || !Number.isSafeInteger(textFeatureDimensions)
    || textFeatureDimensions < 1 || textFeatureDimensions > 16_384
    || !isFiniteNumber(dimensions) || dimensions !== textFeatureDimensions + frameFeatureKeys.length
    || typeof weights !== 'string' || weights.length > maxArtifactBytes
    || !isFiniteNumber(weightScale) || weightScale <= 0 || !Array.isArray(bias) || bias.length !== labels.length || !bias.every(isFiniteNumber)
    || !isFiniteNumber(temperature) || temperature <= 0
    || !isFiniteNumber(threshold) || threshold < 0 || threshold > alwaysAbstain) {
    throw new Error('Invalid monitor decision head');
  }
  const elements = monitorDecisionLabels.length * dimensions;
  const packed = Buffer.from(weights, 'base64');
  const maxDot = 32_768 * weightScale * (textFeatureDimensions + frameFeatureKeys.length * maxFrameValue);
  if (packed.length !== elements * 2 || packed.toString('base64') !== weights
    || bias.some(value => !Number.isFinite((Math.abs(value) + maxDot) / temperature))) {
    throw new Error('Invalid monitor decision head coefficients');
  }
  const coefficients = new Int16Array(elements);
  for (let index = 0; index < elements; index++) coefficients[index] = packed.readInt16LE(index * 2);

  const predict = (input: unknown): MonitorDecisionPrediction => {
    if (!isRecord(input) || !Array.isArray(input.textFeatureIds) || input.textFeatureIds.length > textFeatureDimensions
      || input.textFeatureIds.some((id, index, ids) => !Number.isSafeInteger(id) || id < 0 || id >= textFeatureDimensions
        || (index > 0 && id <= ids[index - 1])) || !isRecord(input.frameFeatures)) {
      throw new Error('Invalid monitor decision features');
    }
    const frame = input.frameFeatures;
    const frameValues = frameFeatureKeys.map(key => frame[key]);
    if (Object.keys(frame).length !== frameFeatureKeys.length
      || !frameValues.every((value): value is number => isFiniteNumber(value) && Math.abs(value) <= maxFrameValue)) {
      throw new Error('Invalid monitor decision frame features');
    }
    const logits = monitorDecisionLabels.map((_, row) => {
      const offset = row * dimensions;
      let sum = 0;
      for (const id of input.textFeatureIds as number[]) sum += coefficients[offset + id]!;
      for (const [id, value] of frameValues.entries()) sum += value * coefficients[offset + textFeatureDimensions + id]!;
      return (bias[row] + sum * weightScale) / temperature;
    });
    const maximum = Math.max(...logits);
    const score = 1 / logits.reduce((sum, logit) => sum + Math.exp(logit - maximum), 0);
    return { label: score >= threshold ? monitorDecisionLabels[logits.indexOf(maximum)]! : null, score };
  };

  return { predict, frameFeatureKeys: Object.freeze([...frameFeatureKeys]), textFeatureDimensions };
}
