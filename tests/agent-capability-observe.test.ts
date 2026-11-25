import { expect, it } from 'vitest';
import { caseFixtureSchema, withCapabilityHarness } from '../scripts/agent-capability-bench/observe.js';

// The inputs below are existing regression inputs from assistant-live-test-repairs-chat,
// assistant-hands-http-chat, assistant-open-read-chat, assistant-clarification-time-audit,
// assistant-user-fact-memory-chat and assistant-desktop-chat.
// They exercise the observer and do not enter the capability corpus.
const JAPAN = 'https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%8A%D8%A7%D8%A8%D8%A7%D9%86';
const JAPAN_TITLE = 'اليابان - ويكيبيديا';
const JAPAN_FACT = 'اليابان دولة جزرية في شرق آسيا، عاصمتها طوكيو وهي أكبر مدنها.';

it('observes real controller routes, ordered tool calls, answers and fixture misses without network traffic', async () => {
  const originalFetch = globalThis.fetch;
  await withCapabilityHarness(async observe => {
    const computation = await observe({ id: 'existing-calculation-regression', turns: [{ text: 'Calculate 37 × 24.' }] });
    expect(computation.turns[0]).toMatchObject({ status: 'completed', handler: 'local_computation', questionCount: 0, steps: 1,
      toolCalls: [{ tool: 'calculate' }], boundaryCalls: [], fixtureMisses: 0, modelCalls: 0, unexpectedEffects: 0 });
    expect(computation.turns[0]?.answer).toContain('888');
    expect(computation.turns[0]?.latencyMs).toBeGreaterThan(0);

    const fixture = caseFixtureSchema.parse({
      searches: [{ query: 'ما عاصمة اليابان', results: [{ title: 'اليابان', url: JAPAN, snippet: 'اليابان دولة جزرية عاصمتها طوكيو وعدد سكانها' }] }],
      pages: [{ url: JAPAN, html: `<title>${JAPAN_TITLE}</title><main><p>${JAPAN_FACT}</p></main>` }],
    });
    const publicLookup = await observe({ id: 'existing-factual-regression', fixture, turns: [{ text: 'ما عاصمة اليابان؟' }] });
    expect(publicLookup.turns[0]).toMatchObject({ status: 'completed', source: 'public_lookup', fixtureMisses: 0, modelCalls: 0, unexpectedEffects: 0 });
    expect(publicLookup.turns[0]?.boundaryCalls.map(call => call.tool)).toEqual(['knowledge_search', 'read', 'search', 'read']);
    expect(publicLookup.turns[0]?.toolCalls.map(call => call.tool)).toEqual(['read', 'search', 'read']);
    expect(publicLookup.turns[0]?.answer).toContain('عاصمتها طوكيو');

    const missing = await observe({ id: 'existing-factual-regression-without-fixture', turns: [{ text: 'ما عاصمة اليابان؟' }] });
    expect(missing.turns[0]?.fixtureMisses).toBeGreaterThan(0);
    expect(missing.turns[0]?.boundaryCalls).toContainEqual({ tool: 'search', argument: 'ما عاصمة اليابان', outcome: 'missing_fixture' });
    expect(missing.turns[0]?.answer).not.toContain(JAPAN_FACT);

    const open = await observe({ id: 'existing-open-page-regression', fixture: { pages: [{ url: 'https://field-notes.test',
      title: 'Field Notes', text: 'Field Notes This site keeps short records of each visit to the field. Each note names the place and the date.' }] },
    turns: [{ text: 'افتح https://field-notes.test واعرض لي محتواه' }] });
    expect(open.turns[0]).toMatchObject({ status: 'completed', fixtureMisses: 0, unexpectedEffects: 0 });
    expect(open.turns[0]?.answer).toContain('Each note names the place and the date.');
  });
  expect(globalThis.fetch).toBe(originalFetch);
});

it('counts a clarification once and binds a follow-up to the actual pending question', async () => {
  await withCapabilityHarness(async observe => {
    const result = await observe({ id: 'existing-clarification-regression', turns: [
      { text: 'What about it?' }, { text: 'Calculate 37 × 24.', answerQuestion: true },
    ] });
    expect(result.turns[0]).toMatchObject({ status: 'waiting_user', conversationStatus: 'waiting_user', questionCount: 1, steps: 0 });
    expect(result.turns[1]).toMatchObject({ status: 'completed', questionCount: 0, steps: 1 });
    expect(result.turns[1]?.answer).toContain('888');
  });
});

it('verifies exact memory through the real isolated store', async () => {
  await withCapabilityHarness(async observe => {
    const result = await observe({ id: 'existing-memory-regression', turns: [{ text: 'Remember that I prefer Arabic.' }] });
    expect(result.turns[0]).toMatchObject({ status: 'completed', modelCalls: 0, fixtureMisses: 0, unexpectedEffects: 0,
      verification: { reviewStatus: 'verified' } });
    expect(result.turns[0]?.boundaryCalls.map(call => call.tool)).toEqual(['memory_write_exact', 'memory_reconcile_exact']);
  });
});

it('feeds an approval through the controller and replays only declared desktop calls', async () => {
  const command = { kind: 'file_delete', path: 'old.txt', folder: '~/Desktop', what: 'file' };
  const fixture = caseFixtureSchema.parse({ desktop: [
    { command, approved: false, outcome: { status: 'needs_approval', text: 'سأنقل الملف إلى سلة المحذوفات. هل أتابع؟',
      approval: { prompt: 'أريد نقل الملف «old.txt» إلى سلة المحذوفات. هل أتابع؟', detail: 'لا حذف نهائي.', label: 'حذف old.txt' } } },
    { command, approved: true, outcome: { status: 'completed', text: 'نقلت الملف `old.txt` إلى سلة المحذوفات.' } },
  ] });
  await withCapabilityHarness(async observe => {
    const result = await observe({ id: 'existing-desktop-approval-regression', fixture, turns: [
      { text: 'احذف ملف old.txt من سطح المكتب' }, { text: '', approve: true },
    ] });
    const recorded = { tool: 'desktop', argument: 'file_delete', outcome: 'recorded' };
    expect(result.turns[0]).toMatchObject({ status: 'waiting_approval', boundaryCalls: [recorded], unexpectedEffects: 0 });
    expect(result.turns[1]).toMatchObject({ status: 'completed', boundaryCalls: [recorded], unexpectedEffects: 0 });
    expect(result.turns[1]?.answer).toContain('old.txt');
  });
});

it('rejects duplicate replay keys and URL credentials before execution', () => {
  expect(caseFixtureSchema.safeParse({ searches: [
    { query: 'Rain', results: [] }, { query: 'rain', results: [] },
  ] }).success).toBe(false);
  expect(caseFixtureSchema.safeParse({ pages: [{ url: 'https://user:pass@example.com/', title: JAPAN_TITLE, text: JAPAN_FACT }] }).success).toBe(false);
  expect(caseFixtureSchema.safeParse({ pages: [{ url: 'https://%', title: JAPAN_TITLE, text: JAPAN_FACT }] }).success).toBe(false);
});
