import { describe, expect, it, vi } from 'vitest';
import { createRunLedger, restoreRunLedger } from '../apps/server/src/assistant/agent-run.js';
import { splitPlanClauses } from '../apps/server/src/assistant/plan/clauses.js';
import { compilePlan } from '../apps/server/src/assistant/plan/compiler.js';
import { executePlan, type PlanAttempt, type PlanToolResult } from '../apps/server/src/assistant/plan/executor.js';
import type { PlanReference, PlanStep, PlanTool, PlanValue, ResolvedStepInputs } from '../apps/server/src/assistant/plan/types.js';
import { planDevelopmentCases } from './fixtures/assistant-plan-development-cases.js';

type Family = (typeof planDevelopmentCases)[number]['family'];
type ExpectedReference = [sourceIndex: number, kind: PlanReference['kind']];
type ExpectedStep = [tool: PlanTool, output: PlanValue['type'], references?: ExpectedReference[]];
const expected: Record<Family, ExpectedStep[]> = {
  'calculate-search': [['compute', 'number'], ['search', 'text']],
  'search-calculate': [['search', 'number'], ['compute', 'number', [[0, 'number']]]],
  'calculate-calculate': [['compute', 'number'], ['compute', 'number', [[0, 'number']]]],
  'search-compare': [['search', 'number'], ['search', 'number'], ['compare', 'text', [[0, 'value'], [1, 'value']]]],
  'remember-recall': [['remember', 'text'], ['recall', 'text', [[0, 'value']]]],
  'read-pdf': [['read', 'text'], ['pdf', 'file', [[0, 'text']]]],
};

const now = new Date('2026-11-25T10:00:00Z');
const config = { now, capabilities: { search: true, browser: true, memory: true } };
const makeLedger = (runId: string) => createRunLedger({ runId, at: now.getTime() });

function fixtureValue(type: PlanValue['type'], index: number): PlanValue {
  switch (type) {
    case 'number': return { type, value: 613.75 + index };
    case 'text': return { type, value: `Mock tool result ${index + 1}` };
    case 'list': return { type, value: [`Mock list item ${index + 1}`] };
    case 'file': return { type, value: '/assistant/documents/test-document.pdf' };
    case 'entity': return { type, value: 'Mock official site', url: 'https://example.org/official' };
  }
}

function expectedSteps({ family, clauseAnchors }: (typeof planDevelopmentCases)[number]): ExpectedStep[] {
  // These cases ask for a city's name as an entity and for other facts as text.
  if (family === 'calculate-search' && /capital|عاصمة/u.test(clauseAnchors[1]!)) {
    return [['compute', 'number'], ['search', 'entity']];
  }
  return expected[family];
}

describe('agent-written plan compiler development cases, never training data', () => {
  it('contains at least 60 unique messages in each language', () => {
    for (const lang of ['ar', 'en']) {
      const requests = planDevelopmentCases.filter(row => row.lang === lang).map(row => row.request);
      expect(requests.length).toBeGreaterThanOrEqual(60);
      expect(new Set(requests).size).toBe(requests.length);
    }
  });

  it.each(planDevelopmentCases)('compiles the steps, order, and references for $id', testCase => {
    const { request, lang, clauseAnchors } = testCase;
    const plan = compilePlan(request, config);
    expect(plan.lang).toBe(lang);
    const steps = expectedSteps(testCase);
    expect(plan.steps.map(step => [step.tool, step.output, step.success])).toEqual(steps.map(([tool, output]) => [tool, output, output]));
    expect(new Set(plan.steps.map(step => step.id)).size).toBe(plan.steps.length);
    for (const [index, step] of plan.steps.entries()) {
      expect(step.text).toContain(clauseAnchors[index]);
      expect(step.inputs.text).toBe(step.text);
      const refs = steps[index]![2] ?? [];
      expect(step.inputs.references.map(ref => [plan.steps.findIndex(source => source.id === ref.stepId), ref.kind])).toEqual(refs);
      expect(step.dependsOn).toEqual(refs.map(([earlier]) => plan.steps[earlier]!.id));
    }
  });

  it.each(planDevelopmentCases)('completes end to end with mocked tools for $id', async testCase => {
    const { id, request, family, lang } = testCase;
    const plan = compilePlan(request, config);
    const steps = expectedSteps(testCase);
    const ledger = makeLedger(id);
    const values = steps.map(([, output], index) => fixtureValue(output, index));
    if (family === 'remember-recall') values[1] = values[0]!;
    let savedValue: PlanValue | undefined;
    const runTool = vi.fn(async (step: PlanStep, _inputs: ResolvedStepInputs): Promise<PlanToolResult> => {
      const value = values[plan.steps.findIndex(candidate => candidate.id === step.id)]!;
      if (step.tool === 'remember') savedValue = value;
      if (step.tool === 'recall') return savedValue ? { ok: true, value: savedValue } : { ok: false };
      return { ok: true, value };
    });

    const result = await executePlan(plan, { runTool, ledger });

    expect(result.status).toBe('completed');
    expect(result.question).toBeNull();
    expect(result.steps.map(step => step.status)).toEqual(steps.map(() => 'succeeded'));
    expect(result.steps.map(step => 'value' in step ? step.value : null)).toEqual(values);
    expect(runTool).toHaveBeenCalledTimes(steps.length);
    expect(ledger.plan?.steps.map(step => step.state)).toEqual(steps.map(() => 'verified'));
    expect(new Set(ledger.evidence.map(record => record.stepId))).toEqual(new Set(plan.steps.map(step => step.id)));
    expect(restoreRunLedger(ledger, id)).toBe(ledger);
    const paragraphs = result.text.split('\n\n');
    expect(paragraphs).toHaveLength(steps.length);
    for (const [index, step] of plan.steps.entries()) {
      const call = runTool.mock.calls.find(([called]) => called.id === step.id);
      const expectedRefs = steps[index]![2] ?? [];
      expect(call?.[1].references.map(({ value }) => value)).toEqual(expectedRefs.map(([earlier]) => values[earlier]));
      if (family === 'calculate-calculate' && index === 1) expect(call?.[1].text).toContain(String(values[0]!.value));
      expect(paragraphs[index]).toMatch(new RegExp(`^${index + 1}\\. .+ — ${lang === 'ar' ? 'تم' : 'Completed'}\\n`));
      expect(paragraphs[index]).toContain(String(values[index]!.value));
    }
  });
});

describe('plan clause and reference boundaries', () => {
  it.each([
    ['Search for the book "Think, Then Search and Find" and calculate 3 * 5.', ['Search for the book "Think, Then Search and Find"', 'calculate 3 * 5.']],
    ['ابحث عن كتاب «ثم ابحث عن الاستقلال» واحسب ٥ × ٤', ['ابحث عن كتاب «ثم ابحث عن الاستقلال»', 'احسب ٥ × ٤']],
    ['Search for salt and pepper recipes and calculate 3 * 5.', ['Search for salt and pepper recipes', 'calculate 3 * 5.']],
    ['ابحث عن الملوخية والسبانخ واحسب ٥ × ٤', ['ابحث عن الملوخية والسبانخ', 'احسب ٥ × ٤']],
    ['اقرأ https://example.org/after-that ثم احسب ٥ × ٤', ['اقرأ https://example.org/after-that', 'احسب ٥ × ٤']],
    ['Read https://example.org/then/and then calculate 8.5 * 2.', ['Read https://example.org/then/and', 'calculate 8.5 * 2.']],
    ['Write a letter. Body: Finish this and then publish it.', ['Write a letter. Body: Finish this and then publish it.']],
    ['احسب ٥ × ٤ وبعد هيك دوّر على عاصمة السويد', ['احسب ٥ × ٤', 'دوّر على عاصمة السويد']],
    ['احسب ٥ × ٤ وبعد كذا شوف سعر الذهب', ['احسب ٥ × ٤', 'شوف سعر الذهب']],
    ['احسب ٥ × ٤ ومن بعد قلّب على سعر الفضة', ['احسب ٥ × ٤', 'قلّب على سعر الفضة']],
  ])('preserves literal data and joined nouns in %s', (text, clauses) => {
    expect(splitPlanClauses(text as string)).toEqual(clauses);
  });

  it.each([
    'Search for the official site for Bristol City Council, then read it.',
    'ابحث عن الموقع الرسمي لبلدية لندن ثم اقرأه',
  ])('passes the entity and source URL from %s into a read', async request => {
    const plan = compilePlan(request, config);
    const ledger = makeLedger('entity-reference');
    const found: PlanValue = { type: 'entity', value: 'Council website', url: 'https://example.org/official' };
    const runTool = vi.fn(async (step: PlanStep, _inputs: ResolvedStepInputs): Promise<PlanToolResult> => step.tool === 'search'
      ? { ok: true, value: found } : { ok: true, value: { type: 'text', value: 'Page content' } });
    expect(plan.steps.map(({ tool, output }) => [tool, output])).toEqual([['search', 'entity'], ['read', 'text']]);
    expect(plan.steps[1]?.inputs.references).toEqual([expect.objectContaining({ stepId: plan.steps[0]?.id, kind: 'entity' })]);
    expect((await executePlan(plan, { runTool, ledger })).status).toBe('completed');
    expect(runTool.mock.calls[1]?.[1].references[0]?.value).toEqual(found);
  });

  it('does not send a private value to a public search', async () => {
    const plan = compilePlan('Recall my saved company name, then search for it.', config);
    const ledger = makeLedger('private-reference');
    const runTool = vi.fn(async (_step: PlanStep): Promise<PlanToolResult> => ({
      ok: true, value: { type: 'text', value: 'Private company name' },
    }));
    const result = await executePlan(plan, { runTool, ledger });
    expect(result.status).toBe('partial');
    expect(runTool.mock.calls.map(([step]) => step.tool)).toEqual(['recall']);
    expect(result.steps.map(step => step.status)).toEqual(['succeeded', 'failed']);
  });

  it('preserves a list result as structured input for a document', async () => {
    const plan = compilePlan('Search for a list of botanical gardens in London, then make a PDF from the result.', config);
    const items: PlanValue = { type: 'list', value: ['Kew Gardens', 'Chelsea Physic Garden'] };
    const runTool = vi.fn(async ({ tool }: PlanStep, _input: ResolvedStepInputs): Promise<PlanToolResult> =>
      tool === 'search' ? { ok: true, value: items } : { ok: true, value: fixtureValue('file', 1) });
    const result = await executePlan(plan, { runTool, ledger: makeLedger('list-to-pdf') });
    expect(plan.steps.map(step => step.output)).toEqual(['list', 'file']);
    expect(runTool.mock.calls[1]?.[1].references[0]?.value).toEqual(items);
    expect(result.status).toBe('completed');
  });
});

describe('plan recovery with mocked tool failures', () => {
  it('recovers a search on the second retry and passes the recovered value to compute', async () => {
    const plan = compilePlan('Search for the price of gold per gram and calculate how many grams I can buy for $1000.', config);
    const ledger = makeLedger('search-recovery');
    const price: PlanValue = { type: 'number', value: 125, unit: 'USD/g' };
    const runTool = vi.fn(async ({ tool }: PlanStep, _input: ResolvedStepInputs, { strategy }: PlanAttempt): Promise<PlanToolResult> => {
      if (tool === 'compute') return { ok: true, value: { type: 'number', value: 8, unit: 'g' } };
      if (strategy === 'initial') throw new Error('transient provider outage');
      if (strategy === 'another_source') return { ok: false, reason: 'no_result' };
      return { ok: true, value: price };
    });

    const result = await executePlan(plan, { ledger, runTool });

    expect(runTool.mock.calls.map(([step, , attempt]) => [step.tool, attempt.number, attempt.strategy])).toEqual([
      ['search', 1, 'initial'], ['search', 2, 'another_source'], ['search', 3, 'narrower_query'], ['compute', 1, 'initial'],
    ]);
    expect(runTool.mock.calls.at(-1)?.[1].references[0]?.value).toEqual(price);
    expect(result).toMatchObject({ status: 'completed', question: null, steps: [
      { status: 'succeeded', attempts: 3, value: price }, { status: 'succeeded', attempts: 1, value: { type: 'number', value: 8 } },
    ] });
    expect(ledger.plan?.steps.map(step => [step.state, step.attempts])).toEqual([['verified', 3], ['verified', 1]]);
  });

  it('stops after two search retries, skips the dependent calculation, and reports the independent success', async () => {
    const plan = compilePlan('Search for the price of gold per gram and calculate how many grams I can buy for $1000. Finally calculate 6 * 7.', config);
    const ledger = makeLedger('exhausted-search');
    const runTool = vi.fn(async (step: PlanStep): Promise<PlanToolResult> => {
      if (step.tool === 'search') throw new Error('unexpected and private transport details');
      return { ok: true, value: { type: 'number', value: 42 } };
    });

    const result = await executePlan(plan, { ledger, runTool });

    expect(result).toMatchObject({ status: 'partial', steps: [
      { status: 'failed', attempts: 3, reason: 'tool_error' }, { status: 'skipped', attempts: 0, blockedBy: [plan.steps[0]?.id] },
      { status: 'succeeded', attempts: 1, value: { type: 'number', value: 42 } },
    ] });
    expect(result.question).toMatch(/which source or search term/i);
    expect(result.text).toContain('42');
    expect(result.text).toMatch(/skipped/i);
    expect(result.text).not.toContain('private transport details');
    expect(JSON.stringify(ledger)).not.toContain('private transport details');
    expect(runTool.mock.calls.filter(([step]) => step.id === plan.steps[1]?.id)).toHaveLength(0);
    expect(ledger.plan?.steps.map(step => [step.state, step.attempts])).toEqual([['failed', 3], ['skipped', 0], ['verified', 1]]);
  });

  it('rejects an unusable page receipt, tries another source once, and skips PDF creation', async () => {
    const plan = compilePlan('Read https://example.org/wave, then make a PDF from it.', config);
    const ledger = makeLedger('bad-read-receipt');
    const runTool = vi.fn(async (_step: PlanStep, _inputs: ResolvedStepInputs, _attempt: PlanAttempt): Promise<PlanToolResult> =>
      ({ ok: true, value: { type: 'text', value: '  ' } }));

    const result = await executePlan(plan, { ledger, runTool });

    expect(runTool.mock.calls.map(([step, , attempt]) => [step.tool, attempt.strategy])).toEqual([['read', 'initial'], ['read', 'another_source']]);
    expect(result).toMatchObject({ status: 'blocked', steps: [
      { status: 'failed', attempts: 2, reason: 'invalid_result' }, { status: 'skipped', attempts: 0 },
    ] });
    expect(result.question).toMatch(/public page URL/i);
    expect(ledger.plan?.steps.map(step => step.state)).toEqual(['failed', 'skipped']);
  });

  it('does not retry a failed memory write when the effect could already have occurred', async () => {
    const plan = compilePlan('Remember that my company name is Alder Studio, then recall my saved company name.', config);
    const ledger = makeLedger('unknown-memory-effect');
    const runTool = vi.fn(async (_step: PlanStep): Promise<PlanToolResult> => { throw new Error('write acknowledgement lost'); });

    const result = await executePlan(plan, { ledger, runTool });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]?.[0].tool).toBe('remember');
    expect(result).toMatchObject({ status: 'blocked', question: null, steps: [
      { status: 'failed', attempts: 1, reason: 'unknown_effect' }, { status: 'skipped', attempts: 0 },
    ] });
    expect(ledger.plan?.steps.map(step => [step.state, step.attempts])).toEqual([['unknown', 1], ['skipped', 0]]);
  });

  it('asks a single focused question when multiple independent steps fail', async () => {
    const plan = compilePlan('Calculate 9 * 5 then search for the capital of Iceland.', config);
    const ledger = makeLedger('single-question');
    const runTool = vi.fn(async ({ tool }: PlanStep): Promise<PlanToolResult> => ({
      ok: false, reason: 'missing_input', question: tool === 'compute' ? 'Which calculation should I do?' : 'Which subject should I search for?',
    }));

    const result = await executePlan(plan, { ledger, runTool });

    expect(result).toMatchObject({ status: 'blocked', question: 'Which calculation should I do?', steps: [
      { status: 'failed', attempts: 1 }, { status: 'failed', attempts: 1 },
    ] });
    expect(result.text).toContain('Which calculation should I do?');
    expect(result.text).not.toContain('Which subject should I search for?');
    expect(ledger.plan?.steps.map(step => step.state)).toEqual(['failed', 'failed']);
  });
});
