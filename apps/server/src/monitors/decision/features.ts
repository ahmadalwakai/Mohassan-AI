import { redactCredentialText } from '@mohassan/cognitive';
import { z } from 'zod';
import { monitorDecisionLabels } from '../../../../../packages/model-relations/src/monitor-decision.js';
import { featureIndices } from '../../../../../packages/scratch-classifiers/src/features.js';
import { monitorTrainingTextsAllowed } from './exclusion.js';
import { MONITOR_CONTEXT_FEATURES, monitorContextFeatures, type MonitorContextFrame } from './frame.js';

export const MONITOR_TEXT_FEATURE_BUCKETS = 4_096;
export const MONITOR_DECISION_FRAME_FEATURE_KEYS = [...MONITOR_CONTEXT_FEATURES].sort();

const frameFeatures = z.strictObject(Object.fromEntries(MONITOR_DECISION_FRAME_FEATURE_KEYS.map(key => [key, z.number().min(0).max(8_000)])));
const textFeatureIds = z.array(z.number().int().min(0).max(MONITOR_TEXT_FEATURE_BUCKETS - 1)).max(MONITOR_TEXT_FEATURE_BUCKETS)
  .refine(ids => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
export const MonitorDecisionFeaturesSchema = z.strictObject({
  language: z.enum(['ar', 'en']), frameFeatures, textFeatureIds,
  conversationState: z.enum(['pending', 'follow-up', 'initial']), length: z.number().int().min(0).max(8_000),
});
export type MonitorDecisionFeatures = z.infer<typeof MonitorDecisionFeaturesSchema>;

export const MonitorDecisionSnapshotSchema = MonitorDecisionFeaturesSchema.extend({
  monitorDecision: z.enum(['offer', 'propose']), reasonerDecision: z.enum(monitorDecisionLabels), reasonerScore: z.number().min(0).max(1),
});
export type MonitorDecisionSnapshot = z.infer<typeof MonitorDecisionSnapshotSchema>;
export type MonitorProposalDecisionSnapshot = MonitorDecisionSnapshot;

function textForHashing(text: string) {
  return redactCredentialText(text.slice(0, 8_000).normalize('NFKC'))
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>«»"'`]+/giu, ' url ')
    .replace(/[^\s@<>«»"'`]+@[^\s@<>«»"'`]+/gu, ' email ')
    .replace(/\p{N}+/gu, '0');
}

/** Fixed-schema, redacted text buckets with no identifiers or conversation strings. */
export function monitorDecisionFeatures(frame: MonitorContextFrame): MonitorDecisionFeatures {
  const { current, previousAssistant, language, history } = frame;
  const counts = monitorContextFeatures(frame);
  return {
    language, frameFeatures: counts,
    textFeatureIds: featureIndices(textForHashing(current.text), MONITOR_TEXT_FEATURE_BUCKETS,
      previousAssistant ? textForHashing(previousAssistant.text) : undefined).sort((a, b) => a - b),
    conversationState: frame.previousAssistant?.pending ? 'pending' : history.length ? 'follow-up' : 'initial',
    length: Math.min(current.text.length, 8_000),
  };
}

export function monitorProposalDecisionSnapshot(frame: MonitorContextFrame,
  baseline: { decision: MonitorDecisionSnapshot['reasonerDecision']; score: number },
  monitorDecision: MonitorDecisionSnapshot['monitorDecision'], guardTexts: readonly string[] = []): MonitorDecisionSnapshot | undefined {
  const benchmarkInputs = [...guardTexts, frame.current.text, ...frame.history.map(turn => turn.text), frame.assistantAnswer?.text ?? ''];
  if (!monitorTrainingTextsAllowed(benchmarkInputs)) return;
  return { ...monitorDecisionFeatures(frame), monitorDecision, reasonerDecision: baseline.decision, reasonerScore: baseline.score };
}
