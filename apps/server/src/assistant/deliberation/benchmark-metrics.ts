export type BenchmarkDecision = { kind: 'act'; route: string } | { kind: 'ask' } | { kind: 'abstain' };

export interface BenchmarkPrediction {
  decision: BenchmarkDecision;
  confidence: number;
}

interface BenchmarkObservation extends BenchmarkPrediction {
  expected: BenchmarkDecision;
}

export function sameDecision(left: BenchmarkDecision, right: BenchmarkDecision): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== 'act' || right.kind === 'act' && left.route === right.route;
}

export function measureDecisions(rows: readonly BenchmarkObservation[]) {
  if (!rows.length) throw new Error('At least one decision is required to compute metrics.');
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  let correct = 0;
  let wrongActions = 0;
  let unnecessaryQuestions = 0;
  for (const row of rows) {
    const { confidence, decision, expected } = row;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be in [0, 1].');
    const matched = Number(sameDecision(decision, expected));
    correct += matched;
    if (decision.kind === 'act' && !matched) wrongActions++;
    if (decision.kind === 'ask' && expected.kind !== 'ask') unnecessaryQuestions++;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))];
    bin.count++;
    bin.confidence += confidence;
    bin.correct += matched;
  }
  const count = rows.length;
  return {
    count,
    correct,
    wrongActions,
    unnecessaryQuestions,
    accuracy: correct / count,
    wrongActionRate: wrongActions / count,
    unnecessaryQuestionRate: unnecessaryQuestions / count,
    expectedCalibrationError: bins.reduce((error, bin) => error + Math.abs(bin.correct - bin.confidence), 0) / count,
  };
}

export function fitDecisionTemperature(
  development: readonly { margin: number; correct: boolean }[], confidenceForMargin: (margin: number, temperature: number) => number,
  grid: readonly number[],
): { temperature: number; meanNegativeLogLikelihood: number } {
  if (!development.length || !grid.length || grid.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Calibration requires development observations and a positive temperature grid.');
  }
  let temperature = grid[0];
  let meanNegativeLogLikelihood = Infinity;
  for (const candidate of grid) {
    let loss = 0;
    for (const row of development) {
      const confidence = confidenceForMargin(row.margin, candidate);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be in [0, 1].');
      const probability = row.correct ? confidence : 1 - confidence;
      loss -= Math.log(Math.max(Number.EPSILON, probability));
    }
    const meanLoss = loss / development.length;
    if (meanLoss < meanNegativeLogLikelihood) {
      temperature = candidate;
      meanNegativeLogLikelihood = meanLoss;
    }
  }
  return { temperature, meanNegativeLogLikelihood };
}
