import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ControllerAssessmentCaseSchema, controllerAssessmentSummary, scoreControllerAssessmentCase, validateControllerAssessmentDataset,
  type ControllerCaseObservation, type ControllerTurnObservation } from '../packages/learning/src/controller-assessment.js';
import { controllerAssessmentArguments, observeControllerAssessmentCase } from '../scripts/controller-assessment.js';

const base = (expected: Record<string, unknown> = {}) => ControllerAssessmentCaseSchema.parse({ id: 'independent-scalar-fixture', category: 'compute', language: 'en', note: 'Synthetic scorer test, no service calls.',
  turns: [{ text: 'Calculate 16 + 7. Only the result.', expected: { status: 'completed', answer: { exact: '23' }, ...expected } }] });
const actual = (overrides: Partial<ControllerTurnObservation> = {}): ControllerTurnObservation => ({ status: 'completed', conversationStatus: 'idle', answer: '23', publicQueries: [], browserOpens: [], memoryReads: 0,
  documentReads: 0, captures: 0, writes: 0, otherBrowserActions: 0, modelCalls: 0, questionFields: [], latencyMs: 10, experienceRows: 0, effectReceipts: 0, ...overrides });
const observation = (turn = actual()): ControllerCaseObservation => ({ turns: [turn], setupMs: 20, captureMode: 'none' });

describe('functional development assessment scoring', () => {
  it('requires the exact scalar and does not accept a number substring or extra format', () => {
    expect(scoreControllerAssessmentCase(base(), observation()).passed).toBe(true);
    for (const answer of ['123', 'The result is 23', '23\nDone']) {
      const result = scoreControllerAssessmentCase(base(), observation(actual({ answer })));
      expect(result.turns[0]).toMatchObject({ answerCorrect: false, falseCompletion: true, failures: ['answer_assertion'] });
    }
  });

  it('counts completed responses violating a side-effect or privacy boundary as false completion', () => {
    const item = base(); item.privateCanaries = ['PRIVATE-CANARY-ADLER-67'];
    const result = scoreControllerAssessmentCase(item, observation(actual({ publicQueries: ['library PRIVATE canary adler 67'], writes: 1 })));
    expect(result.turns[0]).toMatchObject({ passed: false, statusCorrect: true, answerCorrect: true, invariantCorrect: false, falseCompletion: true,
      publicQueryLeaks: 1, unexpectedPublicQueries: 1, unexpectedEffects: 1 });
  });

  it('does not confuse an honest blocked boundary with successful task completion', () => {
    const item = base({ status: 'blocked', answer: { containsAll: ['unavailable'] } });
    const scored = scoreControllerAssessmentCase(item, observation(actual({ status: 'blocked', answer: 'This capability is unavailable.' })));
    expect(scored.passed).toBe(true);
    expect(controllerAssessmentSummary([scored]).metrics).toMatchObject({ passed: 1, turns: 1, observedTurns: 1, falseCompletions: 0 });
  });

  it('marks missing turns and harness errors as missing coverage without invented latency', () => {
    const scored = scoreControllerAssessmentCase(base(), { turns: [], setupMs: 12, captureMode: 'none', error: 'harness_error:Error' });
    const report = controllerAssessmentSummary([scored]);
    expect(report.metrics).toMatchObject({ cases: 1, passed: 0, turns: 1, observedTurns: 0, harnessErrors: 1 });
    expect(report.latency).toMatchObject({ samples: 0, p50: 0, p95: 0 });
  });

  it('requires host question fields and forbids experience recording or undeclared model use', () => {
    const item = base({ status: 'waiting_user', answer: {}, questionFields: ['to', 'details'] });
    const scored = scoreControllerAssessmentCase(item, observation(actual({ status: 'waiting_user', conversationStatus: 'waiting_user', answer: 'Who is the recipient?', questionFields: ['to'], modelCalls: 1, experienceRows: 1 })));
    expect(scored.turns[0]?.failures).toEqual(expect.arrayContaining(['question_fields', 'unexpected_model', 'experience_recording']));
  });

  it('labels synthetic capture calls separately from actual loopback Chromium coverage', () => {
    const item = base();
    const one = scoreControllerAssessmentCase(item, { ...observation(actual({ captures: 1 })), captureMode: 'synthetic-boundary' });
    const two = scoreControllerAssessmentCase(item, { ...observation(), captureMode: 'real-loopback-chromium', error: 'harness_error:Error' });
    expect(controllerAssessmentSummary([one, two]).captureCoverage).toEqual({ configuredCases: 2, syntheticBoundaryCases: 1, realLoopbackChromiumCases: 0 });
  });
});

describe('visible controlled-controller development fixtures', () => {
  it('validates32distinct authored tasks and declared no-model/scripted modes', async () => {
    const dataset = validateControllerAssessmentDataset(JSON.parse(await readFile('tests/fixtures/controller-assessment/development-v1.json', 'utf8')));
    expect(dataset.cases).toHaveLength(32);
    expect(dataset.provenance).toMatchObject({ humanReviewed: false, sealed: false, trainingUse: 'forbidden' });
    expect(dataset.cases.filter(item => item.model === 'scripted')).toHaveLength(2);
    expect(() => validateControllerAssessmentDataset({ ...dataset, cases: [...dataset.cases, { ...dataset.cases[0], id: 'copied-duplicate-task' }] })).toThrow('DUPLICATE_INPUT');
    expect(() => validateControllerAssessmentDataset({ ...dataset, cases: [{ ...dataset.cases[0], privateCanaries: ['NOT-PRESENT-IN-THE-PRIVATE-FIXTURE'] }] })).toThrow('UNGROUNDED_PRIVATE_CANARY');
  });

  it('executes an independently authored scalar task through the actual controller without effects or experience writes', async () => {
    const item = base();
    const result = await observeControllerAssessmentCase(item);
    expect(result.error).toBeUndefined();
    expect(scoreControllerAssessmentCase(item, result).passed).toBe(true);
    expect(result.turns[0]).toMatchObject({ answer: '23', status: 'completed', publicQueries: [], browserOpens: [], modelCalls: 0, experienceRows: 0, effectReceipts: 0 });
  });

  it('does not reuse an earlier assistant answer as the answer of a failed later turn', async () => {
    const dataset = validateControllerAssessmentDataset(JSON.parse(await readFile('tests/fixtures/controller-assessment/development-v1.json', 'utf8')));
    const item = dataset.cases.find(row => row.id === 'projection-model-search-url-private-expansion')!;
    const observed = await observeControllerAssessmentCase(item);
    expect(observed.error).toBeUndefined();
    expect(observed.turns).toHaveLength(2);
    expect(observed.turns[0]?.answer).toContain('PVT-CANARY-KESTREL-84');
    expect(observed.turns[1]?.answer).not.toContain('PVT-CANARY-KESTREL-84');
    expect(observed.turns[1]?.publicQueries).toEqual([]);
  });

  it('uses explicit CLI modes and unique immutable-report default paths', () => {
    const first = controllerAssessmentArguments([]), second = controllerAssessmentArguments([]);
    expect(first.realBrowser).toBe(false); expect(first.output).not.toBe(second.output);
    expect(controllerAssessmentArguments(['--real-browser', '--case', 'fixture-case']).realBrowser).toBe(true);
    expect(() => controllerAssessmentArguments(['--real-browser', '--real-browser'])).toThrow('ARGUMENTS');
    expect(() => controllerAssessmentArguments(['--model-dir', 'artifacts/weights'])).toThrow('ARGUMENTS');
  });
});
