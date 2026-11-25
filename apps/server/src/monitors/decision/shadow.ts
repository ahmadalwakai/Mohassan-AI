import { monitorDecisionType, type MonitorDecisionClaim, type MonitorDecisionLabel } from '../../../../../packages/model-relations/src/monitor-decision.js';
import { deferArbiterReview, modelRelationsManager, recordArbiterReview } from '../../assistant/model-relations-arbiter.js';
import type { MonitorDecisionFeatures } from './features.js';

export function monitorDecisionShadowEnabled(): boolean {
  return process.env.MOHASSAN_MONITOR_CONTEXT_SHADOW === '1' && process.env.MOHASSAN_MODEL_RELATIONS !== 'off';
}

export async function reviewMonitorDecision(input: {
  runId: string;
  baseline: MonitorDecisionClaim;
  features: MonitorDecisionFeatures;
  protected?: boolean;
}): Promise<MonitorDecisionLabel> {
  const { runId, baseline, features } = input;
  if (!monitorDecisionShadowEnabled()) return baseline.label;
  const review = () => modelRelationsManager.reviewMonitorDecision(features, baseline, features, { protected: input.protected });
  if (input.protected || baseline.label !== 'offer' || !modelRelationsManager.canApplyArbiter(monitorDecisionType)) {
    deferArbiterReview(runId, async () => (await review()).log);
    return baseline.label;
  }
  const { action, log } = await review();
  recordArbiterReview(runId, log);
  return action;
}
