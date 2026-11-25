import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { capabilityCaseSchema } from '../scripts/agent-capability-bench/corpus.js';
import { withCapabilityHarness } from '../scripts/agent-capability-bench/observe.js';
import { importCanard, importMintaka, importTyDiQA } from '../scripts/agent-capability-bench/v2/qa.js';

it('maps linked facts and comparative labels while grouping translations and counting unscoreable gold answers', () => {
  const base = { id: 'record', question: 'Which work appeared first?', translations: { ar: 'أي عمل ظهر أولاً؟' }, complexityType: 'comparative' };
  const result = importMintaka(JSON.stringify([
    { ...base, answer: { answerType: 'entity', answer: [{ name: 'Q123', label: { en: 'Novel A', ar: 'العمل ألف' } }] } },
    { ...base, id: 'number', complexityType: 'count', answer: { answerType: 'numerical', answer: [42] } },
    { ...base, id: 'missing-label', answer: { answerType: 'entity', answer: [{ name: 'Q456', label: { en: 'Work B', ar: null } }] } },
    { ...base, id: 'unlinked', answer: { answerType: 'entity', answer: null } },
    { ...base, id: 'boolean', answer: { answerType: 'boolean', answer: [true] } },
    { ...base, id: 'echo', answer: { answerType: 'entity', answer: [{ name: 'Q789', label: { en: 'first', ar: 'أولاً' } }] } },
  ]));
  expect(result.seen).toBe(12);
  expect(result.dropped).toEqual({ 'missing-entity-label': 1, 'unlinked-answer': 2, 'boolean-answer': 2, 'answer-in-question': 2 });
  expect(result.candidates.map(({ key, family, item }) => [key, family, item.language, item.area])).toEqual([
    ['record:ar', 'record', 'ar', 'comparison'],
    ['record:en', 'record', 'en', 'comparison'],
    ['number:ar', 'number', 'ar', 'factual'],
    ['number:en', 'number', 'en', 'factual'],
    ['missing-label:en', 'missing-label', 'en', 'comparison'],
  ]);
  expect(result.candidates[0]?.item.turns[0]?.expect.requiredContent).toEqual([{ match: 'literal', anyOf: ['العمل ألف'] }]);
  expect(result.candidates[2]?.item.turns[0]?.expect.requiredContent).toEqual([{ match: 'number', anyOf: ['42'] }]);
  for (const { item } of result.candidates) {
    const validated = capabilityCaseSchema.parse({ id: 'adapter-check', provenance: { author: 'human', source: 'test-vector' }, ...item });
    expect(validated.fixture?.wikiArticleCoverage).toBe('closed-replay');
    expect(validated.turns[0]?.expect).toMatchObject({ source: ['public_lookup'], operation: ['lookup'], requiredTools: ['read'] });
  }
});

it('preserves the TyDi passage and verifies answer offsets in UTF-8 bytes', () => {
  const passage = 'تقع طوكيو في اليابان.';
  const answer = 'طوكيو';
  const start = Buffer.byteLength('تقع ');
  const ar = { id: 'ar-one', language: 'arabic', document_title: 'طوكيو', passage_text: passage, question_text: 'ما عاصمة اليابان؟',
    answers: [{ text: answer, start_byte: start, limit_byte: start + Buffer.byteLength(answer) }] };
  const en = { id: 'en-one', language: 'english', document_title: 'Earth', passage_text: 'Earth has 7 continents.',
    question_text: 'How many continents are there?', answers: [{ text: '7', start_byte: 10, limit_byte: 11 }] };
  const incorrect = { ...ar, id: 'wrong', answers: [{ ...ar.answers[0], start_byte: start - 1 }] };
  const sameArticle = { ...ar, id: 'ar-two', question_text: 'ما هي عاصمة اليابان؟' };
  const result = importTyDiQA([ar, incorrect, sameArticle].map(value => JSON.stringify(value)).join('\n'), JSON.stringify(en));
  expect(result.seen).toBe(4);
  expect(result.dropped).toEqual({ 'invalid-answer-span': 1 });
  expect(result.candidates[0]?.item.turns[0]).toMatchObject({ text: ar.question_text, expect: { requiredContent: [{ match: 'literal', anyOf: [answer] }] } });
  expect(result.candidates[0]?.item.fixture?.pages).toEqual([{ text: passage, title: ar.document_title,
    url: `https://ar.wikipedia.org/wiki/${encodeURIComponent(ar.document_title)}` }]);
  expect(result.candidates[0]?.family).toBe(result.candidates[1]?.family);
  expect(result.candidates[0]?.key).not.toBe(result.candidates[1]?.key);
  expect(result.candidates[2]?.item.turns[0]?.expect.requiredContent).toEqual([{ match: 'number', anyOf: ['7'] }]);
});

it('maps a CANARD continuation to supplied-context writing with its human reference held out of the prompt', () => {
  const row = { QuAC_dialog_id: 'same-thread', Question_no: 2, History: ['Article A', 'History', 'Who led it?', 'Leader A'],
    Question: 'When was that?', Rewrite: 'When did Leader A lead Article A?' };
  const result = importCanard(JSON.stringify([
    row, { ...row, Question_no: 1 }, { ...row, QuAC_dialog_id: 'broken-history', History: ['Article A', 'History', 'Who led it?'] },
    { ...row, QuAC_dialog_id: 'unchanged-rewrite', Rewrite: row.Question },
    { ...row, QuAC_dialog_id: 'reference-present', History: [...row.History.slice(0, -1), row.Rewrite] },
  ]));
  expect(result.seen).toBe(5);
  expect(result.dropped).toEqual({ 'no-previous-turn': 1, 'invalid-history': 1, 'no-context-dependent-rewrite': 1, 'rewrite-in-prompt': 1 });
  expect(result.candidates[0]?.family).toBe(row.QuAC_dialog_id);
  const item = result.candidates[0]?.item;
  expect(item?.fixture).toBeUndefined();
  expect(item?.area).toBe('follow-up');
  expect(item?.turns[0]?.text).toContain('Question: Who led it?\nAnswer: Leader A\nFinal question: When was that?');
  expect(item?.turns[0]?.text).not.toContain(row.Rewrite);
  expect(item?.turns[0]?.expect).toMatchObject({ source: ['supplied_content'], operation: ['transform'], route: ['writing'],
    questionCount: 0, requiredContent: [{ match: 'literal', anyOf: ['When did Leader A lead Article A'] }],
    forbiddenTools: ['search', 'read', 'open'] });
});

it('treats an absent Wikipedia article as unavailable only in a closed QA replay', async () => {
  // Reuse the existing public factual regression to exercise actual controller reads.
  const corpus: { cases: unknown[] } = JSON.parse(await readFile(new URL('./fixtures/agent-capability-bench/development.json', import.meta.url), 'utf8'));
  const existing = corpus.cases.find(value => (value as { id?: string }).id === 'dev-factual-019');
  expect(existing).toBeDefined();
  const regression = capabilityCaseSchema.parse(existing);
  expect(regression.fixture?.pages?.length).toBeGreaterThan(0);
  const archive = 'https://example.invalid/wiki/article-archive';
  const article = regression.fixture!.pages![0]!;
  const fixture = {
    searches: regression.fixture!.searches?.map(({ query, results }) => ({ query, results: results.map(hit =>
      hit.url === article.url ? { ...hit, url: archive } : hit) })),
    pages: [{ ...article, url: archive }, ...regression.fixture!.pages!.slice(1)],
  };
  await withCapabilityHarness(async observe => {
    const strict = await observe({ ...regression, fixture });
    const closed = await observe({ ...regression, fixture: { ...fixture, wikiArticleCoverage: 'closed-replay' } });
    const missingProbe = strict.turns[0]?.boundaryCalls.find(call => call.tool === 'read' && call.outcome === 'missing_fixture');
    expect(missingProbe).toBeDefined();
    expect(closed.turns[0]?.boundaryCalls).toContainEqual({ ...missingProbe, outcome: 'unavailable' });
    expect(closed.turns[0]?.toolCalls).toContainEqual({ ...missingProbe, outcome: 'unavailable' });
    expect(closed.turns[0]?.boundaryCalls).toContainEqual({ tool: 'read', argument: archive, outcome: 'recorded' });
    expect(closed.turns[0]?.fixtureMisses).toBe(strict.turns[0]!.fixtureMisses - 1);
    const unrecognized = await observe({ ...regression, fixture: { ...fixture, searches: [], wikiArticleCoverage: 'closed-replay' } });
    expect(unrecognized.turns[0]?.boundaryCalls.some(call => call.tool === 'search' && call.outcome === 'missing_fixture')).toBe(true);
  });
}, 25_000);
