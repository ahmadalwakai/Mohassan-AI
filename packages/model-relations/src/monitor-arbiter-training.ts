import { ArbiterBrain, type ArbiterArtifact } from './arbiter.js';
import { assessArbiterPromotion, fitArbiterDecision, type DevelopmentResult } from './arbiter-training.js';
import {
  isFiniteNumber, isMonitorDecisionClaim, isMonitorDecisionLabel, isRecord, isSha256, loadMonitorDecisionHead,
  makeMonitorArbiterInput, monitorArtifactSha256, monitorDecisionType, monitorHeadComponent, monitorHeadMayOverride,
  monitorReasonerComponent, type MonitorDecisionClaim, type MonitorDecisionContext, type MonitorDecisionLabel,
} from './monitor-decision.js';

const stages = ['arbiterTrain', 'arbiterCalibration', 'holdout'] as const;
type Stage = typeof stages[number];
type MonitorReplayRow = MonitorDecisionContext & {
  caseId: string;
  occurredAt: string;
  expected: MonitorDecisionLabel;
  baseline: MonitorDecisionClaim;
  learned: MonitorDecisionClaim | null;
  stage: Stage;
  protected?: boolean;
};

function time(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/u.test(value) ? Date.parse(value) : NaN;
}

function parseRealReplay(value: unknown, weightsSha256: string): MonitorReplayRow[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.trainingSource !== 'human'
    || !isSha256(value.weightsSha256) || value.weightsSha256 !== weightsSha256
    || !Number.isFinite(time(value.headTrainingThrough)) || !Array.isArray(value.rows)) {
    throw new Error('Expected real chronological monitor decisions bound to these head weights');
  }
  const seen = new Set<string>();
  const stageTimes = new Map<Stage, { earliest: number; latest: number }>();
  const rows = value.rows.map((row, index): MonitorReplayRow => {
    if (!isRecord(row) || !isSha256(row.caseId) || seen.has(row.caseId) || !Number.isFinite(time(row.occurredAt))
      || (row.language !== 'ar' && row.language !== 'en') || !isFiniteNumber(row.length)
      || !Number.isInteger(row.length) || row.length < 0 || row.length > 8_000
      || (row.conversationState !== 'initial' && row.conversationState !== 'follow-up' && row.conversationState !== 'pending')
      || !isMonitorDecisionLabel(row.expected) || !isMonitorDecisionClaim(row.baseline)
      || (row.learned !== null && !isMonitorDecisionClaim(row.learned)) || !stages.includes(row.stage as Stage)
      || (row.protected !== undefined && typeof row.protected !== 'boolean')) {
      throw new Error(`Invalid monitor arbiter replay row ${index + 1}`);
    }
    seen.add(row.caseId);
    const stage = row.stage as Stage;
    const timestamp = time(row.occurredAt);
    const range = stageTimes.get(stage);
    stageTimes.set(stage, { earliest: Math.min(range?.earliest ?? timestamp, timestamp), latest: Math.max(range?.latest ?? timestamp, timestamp) });
    return { caseId: row.caseId, occurredAt: row.occurredAt as string, expected: row.expected, stage,
      language: row.language, length: row.length, conversationState: row.conversationState,
      baseline: row.baseline, learned: row.learned, ...(row.protected !== undefined ? { protected: row.protected } : {}) };
  });
  let precedingEnd = time(value.headTrainingThrough);
  for (const stage of stages) {
    const range = stageTimes.get(stage);
    if (!range || range.earliest <= precedingEnd) throw new Error('Monitor arbiter stages must be nonempty and strictly separated by time');
    precedingEnd = range.latest;
  }
  return rows;
}

function effectiveClaim(row: MonitorReplayRow): MonitorDecisionClaim | undefined {
  return row.learned && monitorHeadMayOverride(row.baseline.label, row.learned.label, row.protected) ? row.learned : undefined;
}

function counterfactuals(rows: readonly MonitorReplayRow[]) {
  return rows.flatMap(row => {
    const claim = effectiveClaim(row);
    if (!claim) return [];
    const baselinePassed = row.baseline.label === row.expected;
    return [{ input: makeMonitorArbiterInput(row, row.baseline, claim), baselinePassed,
      outcomes: { [monitorReasonerComponent]: baselinePassed, [monitorHeadComponent]: claim.label === row.expected } }];
  });
}

function heldOutResults(rows: readonly MonitorReplayRow[], artifact: ArbiterArtifact) {
  const brain = new ArbiterBrain(artifact);
  const groups = (['ar', 'en'] as const).map(language => {
    let total = 0;
    let eligibleAlerts = 0;
    let declinedOffers = 0;
    let approvals = 0;
    let baselinePassed = 0;
    let selectedPassed = 0;
    let gains = 0;
    let losses = 0;
    for (const row of rows) {
      if (row.language !== language) continue;
      total++;
      if (row.baseline.label === 'offer' && !row.protected) {
        declinedOffers += Number(row.expected === 'none');
        approvals += Number(row.expected === 'offer');
      }
      const claim = effectiveClaim(row);
      eligibleAlerts += Number(Boolean(claim));
      const selected = claim && brain.choose(makeMonitorArbiterInput(row, row.baseline, claim)).choice === monitorHeadComponent
        ? claim.label : row.baseline.label;
      const before = row.baseline.label === row.expected;
      const after = selected === row.expected;
      baselinePassed += Number(before);
      selectedPassed += Number(after);
      gains += Number(after && !before);
      losses += Number(before && !after);
    }
    return { language, total, eligibleAlerts, declinedOffers, approvals, baselinePassed, selectedPassed, gains, losses };
  });
  const gains = groups.reduce((sum, group) => sum + group.gains, 0);
  const losses = groups.reduce((sum, group) => sum + group.losses, 0);
  // With zero losses, this is the exact one-sided paired sign-test probability under equality.
  const pairedSignP = losses === 0 ? 0.5 ** gains : null;
  return { groups, gains, losses, pairedSignP,
    passed: pairedSignP !== null && pairedSignP <= 0.05 && groups.every(group => group.declinedOffers > 0 && group.approvals > 0) };
}

export function assessMonitorArbiterPromotion(input: {
  replay: Buffer;
  weights: Buffer;
  developmentBefore: Buffer;
  developmentAfter: Buffer;
}) {
  loadMonitorDecisionHead(JSON.parse(input.weights.toString('utf8')));
  const weightsSha256 = monitorArtifactSha256(input.weights);
  const rows = parseRealReplay(JSON.parse(input.replay.toString('utf8')), weightsSha256);
  const stageRows = (stage: Stage) => rows.filter(row => row.stage === stage);
  const training = counterfactuals(stageRows('arbiterTrain'));
  const calibration = counterfactuals(stageRows('arbiterCalibration'));
  const model = fitArbiterDecision(monitorDecisionType, training, calibration);
  const arbiter: ArbiterArtifact = { schemaVersion: 1, decisions: model ? { [monitorDecisionType]: model } : {} };
  const heldOut = heldOutResults(stageRows('holdout'), arbiter);
  const before: unknown = JSON.parse(input.developmentBefore.toString('utf8'));
  const after: unknown = JSON.parse(input.developmentAfter.toString('utf8'));
  const array = (value: unknown) => Array.isArray(value) ? value as DevelopmentResult[] : [];
  const development = assessArbiterPromotion(array(before), array(after), { intersections: true });
  const passed = model?.threshold != null && heldOut.passed && development.holdsAllGroups;
  const artifact = passed ? { schemaVersion: 1, trainingSource: 'human', weightsSha256,
    replaySha256: monitorArtifactSha256(input.replay), developmentBeforeSha256: monitorArtifactSha256(input.developmentBefore),
    developmentAfterSha256: monitorArtifactSha256(input.developmentAfter), gates: { timeHeldOut: true, development: true }, arbiter } : null;
  return { artifact, report: { passed, weightsSha256, chronologicalRows: Object.fromEntries(stages.map(stage => [stage, stageRows(stage).length])),
    trainingContests: training.length, calibrationContests: calibration.length, threshold: model?.threshold ?? null, heldOut, development } };
}
