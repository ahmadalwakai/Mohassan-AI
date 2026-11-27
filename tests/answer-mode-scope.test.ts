import { describe, expect, it } from 'vitest';
import { classifyCouncilWebTurn } from '../apps/server/src/assistant/answer-mode-scope.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';
import type { RequestContextState } from '../apps/server/src/assistant/request-context.js';

const capabilities = { search: true, browser: true, memory: true, chatModel: true, planner: true, adsModel: true, coding: true, computer: true };
const route = (text: string, context?: RequestContextState | null) => decideRequestRoute({ text, context, capabilities, fullAccess: true }, null);
const classify = (text: string, context?: RequestContextState | null) => {
  const routing = route(text, context);
  return classifyCouncilWebTurn(text, { routing, requestResolution: routing.resolution, previousSource: context?.sourceAssessment });
};

describe('council-web turn scope', () => {
  it.each([
    'What is the capital of France?',
    'ما عاصمة اليابان؟',
    'What is the latest exchange rate for USD to JPY?',
    'How do TypeScript discriminated unions work?',
    'Hello, why does rain fall?',
    'Explain how to create Google Ads campaigns',
  ])('requires public evidence for %s', text => {
    expect(classify(text)).toMatchObject({ kind: 'factual', query: expect.any(String) });
  });

  it('preserves the actual question when the request includes a response directive', () => {
    expect(classify('Explain why rain falls in two short Arabic sentences.')).toMatchObject({
      kind: 'factual', question: 'Explain why rain falls', query: 'why rain falls',
    });
  });

  it('uses the bound public topic for a follow-up search', () => {
    const context = route('What is the population of Japan?').resolution.nextState;
    const turn = classify('What about China?', context);
    expect(turn).toMatchObject({ kind: 'factual', query: expect.stringMatching(/China/i) });
  });

  it('retains both parts of a multi-question factual turn', () => {
    const question = 'Who wrote Hamlet? Then who wrote The Odyssey?';
    expect(classify(question)).toMatchObject({ kind: 'factual', question, query: expect.stringMatching(/Hamlet.*Odyssey/i) });
  });

  it('keeps a turn with a calculation and a public question in factual scope', () => {
    expect(classify('Calculate 12 + 17. Then what city is the capital of France?')).toMatchObject({ kind: 'factual' });
  });

  it('covers explicit searches and a question referring to a public page', () => {
    expect(classify('Search Wikipedia for the Nobel Prize')).toMatchObject({ kind: 'factual', query: expect.stringMatching(/Nobel Prize/i) });
    expect(classify('What is published at https://example.com/guide?')).toMatchObject({ kind: 'factual', query: expect.stringMatching(/example\.com/i) });
  });

  it.each([
    ['Calculate 10 plus 3.', 'arithmetic'],
    ['Nadia has 44 pencils. She gives 6 to Amir and 8 to Lana. How many pencils does Nadia have now?', 'arithmetic'],
    ['ما هي لغتي المفضلة؟', 'personal'],
    ['What is in my saved notes?', 'personal'],
    ['Good morning!', 'conversation'],
    ['What can you do?', 'conversation'],
    ['Open https://example.com/guide', 'action'],
    ['https://example.com/guide', 'action'],
    ['Plan my week.', 'plan'],
    ['Watch https://example.com/guide every hour and notify me when it changes.', 'monitor'],
    ['Create a monitor for public election news', 'monitor'],
    ['Create a Google Ads campaign for my bakery.', 'campaign'],
    ['Translate this sentence into Arabic: I am here.', 'local-content'],
    ['Return these rows as CSV with columns label and count: twine 5, nails 12.', 'local-content'],
    ['Write a poem about gravity.', 'local-content'],
    ['Find the file named sample.txt in Desktop.', 'action'],
    ['When was he born?', 'control'],
    ['طيب هي اتولدت امتى؟', 'control'],
  ])('keeps %s on its existing route', (text, reason) => {
    expect(classify(text)).toEqual({ kind: 'exempt', reason });
  });

  it.each([
    'Explain Newton’s first law.',
    'Report the main differences between HTTP and HTTPS.',
    'Compare PostgreSQL with MySQL to help me choose.',
    'Write a history of Lebanon.',
    'Write a CSV of the populations of France and Japan.',
  ])('withholds an unverified answer if public projection cannot authorize %s', text => {
    expect(classify(text)).toMatchObject({ kind: 'factual', query: null, reason: 'unsafe_query' });
  });

  it.each([
    'Do not search the web. What is the capital of France?',
    'What is the capital of France? Answer without searching the internet.',
    'ما عاصمة فرنسا؟ أجب بدون البحث على الإنترنت.',
  ])('preserves explicit no-web constraints in %s', text => {
    expect(classify(text)).toMatchObject({
      kind: 'factual', query: null, reason: 'search_forbidden',
    });
  });

  it('keeps an implicit question carrying personal details out of public search', () => {
    expect(classifyCouncilWebTurn('What should I do about my headache?', {}))
      .toMatchObject({ kind: 'factual', query: null, reason: 'unsafe_query' });
  });

  it('rejects contextual additions with no authorized public provenance', () => {
    const privateSource = route('What is in my saved notes?').resolution.nextState?.sourceAssessment;
    const routing = route('What is the population of Japan?');
    const forgedContext = { ...routing.resolution, kind: 'follow_up' as const, query: 'population of Japan and the private notes' };
    expect(classifyCouncilWebTurn('What is the population of Japan?', { routing, requestResolution: forgedContext, previousSource: privateSource }))
      .toMatchObject({ kind: 'factual', query: null, reason: 'unsafe_query' });
  });
});
