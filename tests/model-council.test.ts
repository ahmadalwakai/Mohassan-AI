import { describe, expect, it, vi } from 'vitest';
import { ModelCouncilSchema } from '@mohassan/contracts';
import { createModelCouncil, PIPELINE, rankHits, readerPrompt, selectPassage, WEB_SEARCH, type CouncilTurn, type ModelCouncilOptions } from '../apps/server/src/assistant/model-council.js';
import { modelRegistry } from '../packages/model-relations/src/registry.js';
import type { ModelRunResult } from '../packages/model-relations/src/runtime.js';

const page = (text: string, title = 'Baylight Archive', url = 'https://baylight.example/records') => ({ kind: 'page' as const, text, title, url });
// Synthetic turn evidence. The answer oracle is the value embedded in the exact source sentence.
const OPENING = 'May 17, 2020';
const QUOTE = `The Baylight Library opened on ${OPENING} after five years of planning and construction.`;
const QUESTION = 'When did the Baylight Library open?';

function fakeModels(answers: Record<string, ModelRunResult | (() => Promise<ModelRunResult>)>) {
  const run = vi.fn(async (modelId: string): Promise<ModelRunResult> => {
    const answer = answers[modelId];
    return typeof answer === 'function' ? answer() : answer ?? { ok: false, reason: 'absent', elapsedMs: 1 };
  });
  const options: ModelCouncilOptions = {
    runner: { run },
    resolve: async entry => ({ entry, state: Object.hasOwn(answers, entry.id) ? entry.state : 'absent', artifacts: [] }),
  };
  return { options, run };
}

const ok = (output: unknown): ModelRunResult => ({ ok: true, output, elapsedMs: 1 });

function turn(overrides: Partial<CouncilTurn> = {}): CouncilTurn {
  return {
    question: QUESTION, previous: null,
    pipeline: { text: QUOTE, status: 'completed' },
    evidence: [], history: [{ role: 'user', content: QUESTION }],
    baseline: { route: 'web_search', refusal: 'allow', speechAct: 'request', turnType: 'new', question: QUESTION },
    signal: new AbortController().signal, ...overrides,
  };
}

describe('model council building blocks', () => {
  it('picks the passage that shares the most question words', () => {
    const passage = selectPassage(QUESTION, [page(`Weather in Milltown is mild in spring and autumn every year.\n${QUOTE}`)]);
    expect(passage?.text).toBe(QUOTE);
    expect(selectPassage(QUESTION, [page('Nothing about the question is written in this unrelated paragraph.')])).toBeNull();
  });

  it('frames the reading prompt in the question language', () => {
    expect(readerPrompt('متى افتُتحت المكتبة؟', 'نص')).toBe('نص\n\nسؤال: متى افتُتحت المكتبة؟\nالجواب:');
    expect(readerPrompt('When was it built?', 'Text')).toBe('Text\n\nQuestion: When was it built?\nAnswer:');
  });

  it('ranks search hits by question words and selects one per site', () => {
    const ranked = rankHits('Baylight Library opening', [
      { title: 'Weather today', url: 'https://weather.example/today', snippet: 'Sunny' },
      { title: 'Baylight Archive', url: 'https://archive.example/records' },
      { title: 'Baylight Library opening', url: 'https://library.example/opening', snippet: QUOTE },
      { title: 'Baylight Library', url: 'https://archive.example/library' },
    ]);
    expect(ranked.map(hit => hit.url)).toEqual(['https://library.example/opening', 'https://archive.example/library']);
  });

  it('accepts stored version 1 records without a discussion', () => {
    const oldRecord = { version: 1, chosen: 'pipeline', changed: false, reason: 'Original decision', elapsedMs: 0, members: [] };
    expect(ModelCouncilSchema.parse(oldRecord)).toEqual(oldRecord);
  });
});

describe('registry council deliberation', () => {
  it('records all rounds, absent artifacts and untrained heads while keeping a standing answer', async () => {
    const search = vi.fn();
    const models = fakeModels({
      'reading-v3-last': ok({ text: OPENING }),
      'reading-abstain-verifier': ok({ verdict: 'supports' }),
      'slot-date-place-tagger': ok({ hypotheses: [{ label: 'date', text: OPENING }] }),
    });
    const council = createModelCouncil({ ...models.options, v5: async () => 'The library opened in an unknown year.' });
    const outcome = await council.deliberate(turn({ evidence: [page(QUOTE)], search }));
    expect(outcome).toMatchObject({ changed: false, chosen: PIPELINE, text: QUOTE, status: 'completed' });
    expect(search).not.toHaveBeenCalled();
    expect(outcome.council.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'reading-v4-hn-last', label: 'نموذج القراءة v4', outcome: 'failed', note: expect.stringContaining('absent') }),
      expect.objectContaining({ model: 'question-edit', label: 'رأس إعادة صياغة السؤال', outcome: 'failed', note: expect.stringContaining('untrained') }),
    ]));
    expect(outcome.council.discussion).toMatchObject({
      proposals: expect.arrayContaining([
        { member: 'reading-v3-last', answer: OPENING, evidenceUrl: page(QUOTE).url, evidenceQuote: QUOTE },
        { member: 'chat-v5', answer: '' },
      ]),
      checks: expect.arrayContaining([
        expect.objectContaining({ checker: 'evidence', member: 'reading-v3-last', verdict: 'supports' }),
        expect.objectContaining({ checker: 'judge', member: 'reading-v3-last' }),
        { checker: 'slot-date-place-tagger', member: 'reading-v3-last', verdict: 'supports' },
        { checker: 'reading-abstain-verifier', member: 'reading-v3-last', verdict: 'supports' },
      ]),
      votes: expect.arrayContaining([
        expect.objectContaining({ member: 'reading-v3-last', weight: 0, weightSource: expect.stringContaining('no measured accuracy receipt') }),
      ]),
      decision: { chosen: 'pipeline', reasonAr: expect.any(String), reasonEn: expect.any(String) },
    });
    expect(ModelCouncilSchema.parse(outcome.council)).toEqual(outcome.council);
  });

  it('runs public search before readers and sends a verified answer with measured agreement', async () => {
    const search = vi.fn(async () => ({ pages: [page(QUOTE)] }));
    const models = fakeModels({
      'reading-v3-last': ok({ text: `${OPENING}\nQuestion:` }),
      'reading-v4-hn-last': ok({ text: OPENING }),
    });
    const council = createModelCouncil({ ...models.options, weight: (member, role, language, domain) => {
      expect(language).toBe('en');
      expect(domain).toBe('date');
      return role === 'reader' && member === 'reading-v3-last'
        ? { weight: 0.8, weightSource: 'Fake test receipt', measured: true }
        : { weight: 0, weightSource: 'No test receipt', measured: false };
    } });
    const outcome = await council.deliberate(turn({ pipeline: { text: '', status: 'blocked' }, search }));
    expect(search).toHaveBeenCalledWith(QUESTION, expect.any(AbortSignal));
    expect(outcome).toMatchObject({ changed: true, chosen: 'reading-v3-last', status: 'completed' });
    expect(outcome.text).toContain(OPENING);
    expect(outcome.text).toContain(page(QUOTE).url);
    expect(outcome.council.members).toContainEqual(expect.objectContaining({ model: WEB_SEARCH, label: 'البحث في الويب', outcome: 'ok' }));
  });

  it('records only the runtime failure reason', async () => {
    const detail = 'Could not load /private/model-store-fixture/weights';
    const models = fakeModels({
      'scratch-route': { ok: false, reason: 'incompatible', detail, elapsedMs: 1 },
    });
    const outcome = await createModelCouncil(models.options).deliberate(turn());
    const record = ModelCouncilSchema.parse(outcome.council);
    expect(models.run).toHaveBeenCalledWith('scratch-route', expect.anything(), expect.any(AbortSignal));
    expect(record.members).toContainEqual(expect.objectContaining({
      model: 'scratch-route', label: 'الموجّه الصغير', outcome: 'failed', note: 'incompatible',
    }));
    expect(JSON.stringify(record)).not.toContain(detail);
  });

  it('keeps classifier labels advisory and withholds ungrounded model answers', async () => {
    const models = fakeModels({ 'scratch-route': ok({ label: 'web_search' }), 'chat-v4': ok({ text: OPENING }) });
    const search = vi.fn();
    const council = createModelCouncil({ ...models.options, v5: async () => OPENING,
      weight: () => ({ weight: 1, weightSource: 'Fake test receipt', measured: true }) });
    const outcome = await council.deliberate(turn({ search, pipeline: { text: '', status: 'blocked' },
      baseline: { route: 'writing', refusal: 'allow', speechAct: 'request', turnType: 'new' } }));
    expect(search).not.toHaveBeenCalled();
    expect(outcome.chosen).toBe('uncertain');
    expect(outcome.text).not.toContain(OPENING);
    expect(outcome.council.discussion?.proposals).toContainEqual({ member: 'chat-v5', answer: '' });
  });

  it('allows the labelled v5 fallback only for an eligible blocked turn without pages', async () => {
    const models = fakeModels({});
    const experimental = 'The first shelves stood beside the window.';
    const council = createModelCouncil({ ...models.options, v5: async () => experimental });
    const pipeline = { text: 'I could not find an answer.', status: 'blocked' } as const;
    const eligible = await council.deliberate(turn({ pipeline, v5MayAnswer: true }));
    expect(eligible).toMatchObject({ chosen: 'chat-v5', text: experimental, status: 'completed', changed: true });
    expect(eligible.council.discussion?.proposals).toContainEqual({ member: 'chat-v5', answer: '' });
    const repeated = await council.deliberate(turn({ pipeline: { ...pipeline, text: experimental }, v5MayAnswer: true }));
    expect(repeated).toMatchObject({ chosen: 'chat-v5', changed: true });

    const withoutEligibility = await council.deliberate(turn({ pipeline }));
    expect(withoutEligibility).toMatchObject({ chosen: PIPELINE, text: pipeline.text, changed: false });
    const withPage = await council.deliberate(turn({ pipeline, v5MayAnswer: true, evidence: [page(QUOTE)] }));
    expect(withPage).toMatchObject({ chosen: 'uncertain', status: 'partial' });
    expect(withPage.text).toContain(page(QUOTE).url);
    expect(withPage.text).not.toContain(experimental);
  });

  it('reports uncertainty and lists the read source when the judge withholds a completed reply', async () => {
    const evidence = page(QUOTE);
    const council = createModelCouncil(fakeModels({}).options);
    const outcome = await council.deliberate(turn({
      pipeline: { text: `The Baylight Library opened in 2078.\n\n**Source:** [${evidence.title}](${evidence.url})`, status: 'completed' },
      evidence: [evidence],
    }));
    expect(outcome).toMatchObject({ chosen: 'uncertain', status: 'partial', changed: true });
    expect(outcome.council.members).toContainEqual(expect.objectContaining({ model: PIPELINE, judge: 'withhold' }));
    expect(outcome.text).toContain(evidence.url);
  });

  it('records a timed-out runner while preserving the pipeline response', async () => {
    const models = fakeModels({ 'reading-v3-last': () => new Promise(() => {}) });
    const council = createModelCouncil({ ...models.options, memberMs: { reader: 50 }, budgetMs: 2_000 });
    const started = performance.now();
    const outcome = await council.deliberate(turn({ evidence: [page(QUOTE)] }));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(outcome.council.members.find(member => member.model === 'reading-v3-last')).toMatchObject({ outcome: 'timeout' });
    expect(outcome.chosen).toBe('pipeline');
  });

  it('records an OCR proposal on an attachment turn without replacing its image reply', async () => {
    const models = fakeModels({ 'ocr-v2': ok({ text: 'Scanned line' }) });
    const council = createModelCouncil({ ...models.options, registry: modelRegistry.filter(entry => entry.id.startsWith('ocr')) });
    const outcome = await council.deliberate(turn({
      pipeline: { text: 'The existing image reply.', status: 'completed' },
      images: [new Uint8Array([1])], advisory: true, baseline: { ...turn().baseline, route: 'image' },
    }));
    expect(outcome.chosen).toBe('pipeline');
    expect(outcome.council.members).toContainEqual(expect.objectContaining({ model: 'ocr-v2', label: 'ocr-v2', output: 'Scanned line' }));
    expect(outcome.council.discussion?.proposals).toContainEqual({ member: 'ocr-v2', answer: '' });
  });
});
