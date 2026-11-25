import type { CapabilityCase } from './corpus.js';
import type { CapabilityCaseObservation } from './observe.js';

export const failureStages = ['understanding', 'routing', 'planning', 'tool', 'answer', 'verification'] as const;
export type FailureStage = (typeof failureStages)[number];

interface Failure {
  turn: number;
  stage: FailureStage;
  check: string;
}

type Turn = CapabilityCaseObservation['turns'][number];
type Expectation = CapabilityCase['turns'][number]['expect'];

export function includesLiteral(answer: string, value: string): boolean {
  const normalize = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
  return normalize(answer).includes(normalize(value));
}

function normalizeDigits(text: string): string {
  const digits = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
  return text.replace(/[٠-٩۰-۹]/gu, digit => String(digits.indexOf(digit) % 10)).replaceAll('−', '-');
}

export function normalizedNumber(value: string): string | null {
  const token = normalizeDigits(value.trim());
  const result = /^([+-]?)(\d{1,3}(?:[,٬]\d{3})+|\d+)(?:[.٫](\d+))?$/u.exec(token);
  if (!result) return null;
  const sign = result[1] === '-' ? '-' : '';
  const integral = result[2]!.replace(/[,٬]/gu, '').replace(/^0+(?=\d)/u, '');
  const decimals = result[3]?.replace(/0+$/u, '');
  if (decimals) return `${sign}${integral}.${decimals}`;
  return integral === '0' ? integral : `${sign}${integral}`;
}

export function includesNumber(answer: string, value: string): boolean {
  const expected = normalizedNumber(value);
  if (expected === null) return false;
  for (const [token] of normalizeDigits(answer).matchAll(/[+-]?\d+(?:[,.٫٬]\d+)*(?:[eE][+-]?\d+|(?:[/⁄]\d+)+)?/gu)) {
    if (normalizedNumber(token) === expected) return true;
  }
  return false;
}

function containsInOrder(actual: readonly string[], required: readonly string[]): boolean {
  let next = 0;
  for (const value of actual) if (value === required[next]) next++;
  return next === required.length;
}

function checkTurn(expectation: Expectation, observed: Turn, turn: number): Failure[] {
  if (observed.error && observed.error !== 'chat_failed') {
    const stage = observed.error === 'missing_question' ? 'understanding' : observed.error === 'missing_approval' ? 'planning' : 'tool';
    return [{ turn, stage, check: observed.error }];
  }
  const failures: Failure[] = [];
  const fail = (stage: FailureStage, check: string) => failures.push({ turn, stage, check });
  const match = (observed: string | null | undefined, allowed: string[] | undefined) =>
    !allowed || (observed != null && allowed.includes(observed));

  if (!match(observed.source, expectation.source)) fail('understanding', 'source');
  if (!match(observed.operation, expectation.operation)) fail('understanding', 'operation');
  if (observed.questionCount !== expectation.questionCount) fail('understanding', 'question-count');
  if (!match(observed.route, expectation.route)) fail('routing', 'route');
  if (!match(observed.handler, expectation.handler)) fail('routing', 'handler');
  if (observed.steps > expectation.maxSteps) fail('planning', 'step-budget');
  const tools = observed.toolCalls.map(call => call.tool);
  const boundaryTools = observed.boundaryCalls.map(call => call.tool);
  const requiredTools = expectation.requiredTools ?? [];
  const durable = observed.toolCalls.filter(call => call.outcome === 'recorded').map(call => call.tool);
  const boundary = observed.boundaryCalls.filter(call => call.outcome === 'recorded').map(call => call.tool);
  if (!containsInOrder(durable, requiredTools) && !containsInOrder(boundary, requiredTools)) fail('tool', 'required-tool-order');
  const attemptedTools = new Set([...tools, ...boundaryTools]);
  if (expectation.forbiddenTools?.some(tool => attemptedTools.has(tool))) fail('tool', 'forbidden-tool');
  if (observed.fixtureMisses > 0) fail('tool', 'fixture-miss');
  if (attemptedTools.has('unexpected_fetch')) fail('tool', 'unexpected-network');
  else if (observed.unexpectedEffects > 0) fail('tool', 'unexpected-effect');
  if (observed.modelCalls > 0) fail('tool', 'model-call');
  if (observed.error) fail('tool', 'controller-error');

  for (const [index, required] of expectation.requiredContent.entries()) {
    const includes = required.match === 'number' ? includesNumber : includesLiteral;
    if (!required.anyOf.some(value => includes(observed.answer, value))) fail('answer', `required-content-${index + 1}`);
  }
  for (const [index, forbidden] of expectation.forbiddenContent.entries()) {
    if (includesLiteral(observed.answer, forbidden)) fail('answer', `forbidden-content-${index + 1}`);
  }
  if (!match(observed.status, expectation.status)) fail('verification', 'run-status');
  if (expectation.verification && expectation.verification !== observed.verification.status) fail('verification', 'verification');
  return failures;
}

export function scoreCapabilityCase(item: CapabilityCase, observation: CapabilityCaseObservation) {
  const turns = item.turns.map(({ expect }, index) => {
    const observed = observation.turns[index];
    if (!observed) return { latencyMs: null, completedWithFailure: false,
      failures: [{ turn: index + 1, stage: 'tool' as const, check: 'unobserved-turn' }] };
    const failures = checkTurn(expect, observed, index + 1);
    return { status: observed.status, source: observed.source, operation: observed.operation, route: observed.route,
      routeReason: observed.routeReason,
      handler: observed.handler, steps: observed.steps, tools: observed.toolCalls.map(call => call.tool),
      boundaryTools: observed.boundaryCalls.map(({ tool, outcome }) => ({ tool, outcome })), fixtureMisses: observed.fixtureMisses,
      unexpectedEffects: observed.unexpectedEffects,
      planSteps: observed.planSteps, questionCount: observed.questionCount, verification: observed.verification,
      latencyMs: observed.latencyMs,
      completedWithFailure: observed.status === 'completed' && failures.length > 0, failures };
  });
  const failures = turns.flatMap(turn => turn.failures);
  return { id: item.id, area: item.area, language: item.language, variety: item.variety,
    passed: failures.length === 0, stage: failures[0]?.stage ?? null, failures, setupMs: observation.setupMs,
    turns, latencyMs: observation.turns.length ? observation.turns.reduce((sum, turn) => sum + turn.latencyMs, 0) : null,
    completedWithFailure: turns.some(turn => turn.completedWithFailure) };
}

export type CapabilityScore = ReturnType<typeof scoreCapabilityCase>;

export function wilson95(passed: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = passed / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const halfWidth = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return [passed === 0 ? 0 : center - halfWidth, passed === total ? 1 : center + halfWidth];
}

function summarize(scores: readonly CapabilityScore[]) {
  const passed = scores.filter(score => score.passed).length;
  const latency = scores.flatMap(score => score.latencyMs === null ? [] : [score.latencyMs]).sort((a, b) => a - b);
  const percentile = (value: number) => latency.length ? latency[Math.ceil(value * latency.length) - 1]! : null;
  const countStages = (includesStage: (score: CapabilityScore, stage: FailureStage) => boolean) =>
    Object.fromEntries(failureStages.map(stage => [stage, scores.filter(score => includesStage(score, stage)).length]));
  return { passed, total: scores.length, rate: scores.length ? passed / scores.length : null,
    wilson95: wilson95(passed, scores.length), p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    measuredLatency: latency.length, completedWithFailure: scores.filter(score => score.completedWithFailure).length,
    primaryFailureStages: countStages((score, stage) => score.stage === stage),
    anyFailureStages: countStages((score, stage) => score.failures.some(failure => failure.stage === stage)) };
}

export function summarizeCapability(scores: readonly CapabilityScore[]) {
  const group = (labelOf: (score: CapabilityScore) => string) => Object.fromEntries(
    [...new Set(scores.map(labelOf))].sort().map(label => [label, summarize(scores.filter(score => labelOf(score) === label))]),
  );
  return { overall: summarize(scores), byArea: group(score => score.area), byLanguage: group(score => score.language),
    byVariety: group(score => score.variety), byAreaAndLanguage: group(score => `${score.area}/${score.language}`) };
}
