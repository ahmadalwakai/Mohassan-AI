import { ModelCouncilSchema } from '@mohassan/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNCIL_WEB_BUDGET_MS, runCouncilWebAnswer } from '../apps/server/src/assistant/council-web-answer.js';
import { createModelCouncil, type CouncilTurn, type ModelCouncilOptions } from '../apps/server/src/assistant/model-council.js';
import { modelRegistry } from '../packages/model-relations/src/registry.js';
import type { ModelRunResult } from '../packages/model-relations/src/runtime.js';

// Fictional evidence. The answer oracle is computed from the date embedded in each fake page.
const question = 'When did the Baylight Library open?';
const opening = new Date(Date.UTC(2030, 4, 17)).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const alternate = opening.replace('2030', String(2030 + 1));
const record = (date: string, label = 'Baylight Archive') => ({
  kind: 'page' as const, title: label, url: `https://example.org/${label.toLowerCase().replace(/ /gu, '-')}`,
  text: `The Baylight Library opened on ${date} after several years of planning and construction.`,
});
const evidence = record(opening);
const contradiction = record(alternate, 'Baylight Library Records');

const ok = (output: unknown): ModelRunResult => ({ ok: true, output, elapsedMs: 0 });
const baseline: CouncilTurn['baseline'] = { route: 'web_search', refusal: 'allow', speechAct: 'request', turnType: 'new' };
const input = {
  question, previous: null, history: [{ role: 'user', content: question }] as const, baseline,
  signal: new AbortController().signal, progress: () => {},
};

function fakeCouncil(
  models: Record<string, (input: unknown, signal?: AbortSignal) => Promise<ModelRunResult>>,
  options: Partial<ModelCouncilOptions> = {},
) {
  return createModelCouncil({
    runner: { run: (id, modelInput, signal) => models[id]!(modelInput, signal) },
    registry: modelRegistry.filter(member => Object.hasOwn(models, member.id)),
    resolve: async entry => ({ entry, state: entry.state, artifacts: [] }),
    weight: (id, role) => ({
      weight: role === 'pipeline' ? 0 : id === 'reading-v3-last' ? 0.5 : 0.25,
      measured: role !== 'pipeline', weightSource: 'Test simulation weights',
    }),
    ...options,
  });
}

afterEach(() => { vi.useRealTimers(); });

describe('council web answers', () => {
  it('finishes search and reads before the council; sends its chosen answer and names the source', async () => {
    const phases: string[] = [];
    const reader = vi.fn(async (modelInput: unknown) => {
      phases.push('reader');
      expect(modelInput).toMatchObject({ prompt: expect.stringContaining(evidence.text) });
      return ok({ text: opening });
    });
    const council = fakeCouncil({ 'reading-v3-last': reader, 'reading-v4-hn-last': reader });
    const outcome = await runCouncilWebAnswer({
      ...input, progress: phase => { phases.push(phase); },
      search: async () => {
        phases.push('search-and-read');
        return { pages: [evidence, contradiction] };
      },
      deliberate: council.deliberate,
    });
    expect(phases).toEqual(['search', 'search-and-read', 'council', 'reader', 'reader']);
    expect(outcome.status).toBe('completed');
    expect(outcome.council?.discussion?.decision.chosen).toBe('reading-v3-last');
    expect(outcome.council?.discussion?.proposals).toContainEqual({ member: 'pipeline', answer: '' });
    expect(outcome.council?.members[0]).toMatchObject({ model: 'web-search', outcome: 'ok' });
    expect(outcome.text).toBe(`${opening}\n\n**Source:** [${evidence.title}](${evidence.url})\n\nChecked by the model council after a web search.`);
    expect(ModelCouncilSchema.parse(outcome.council)).toEqual(outcome.council);
  });

  it('sends only the verified pipeline claim when an independent reader agrees', async () => {
    const council = fakeCouncil({ 'reading-v3-last': async () => ok({ text: opening }) });
    const outcome = await runCouncilWebAnswer({ ...input, search: async () => ({ pages: [evidence] }), deliberate: council.deliberate });
    expect(outcome.council?.discussion?.decision.chosen).toBe('pipeline');
    expect(outcome.council?.discussion?.proposals).toContainEqual({
      member: 'pipeline', answer: opening, evidenceUrl: evidence.url, evidenceQuote: evidence.text,
    });
    expect(outcome.text.startsWith(`${opening}\n\n`)).toBe(true);
  });

  it('states when results contain no usable pages and does not generate an ungrounded reply', async () => {
    const reader = vi.fn(async () => ok({ text: opening }));
    const backupSearch = vi.fn();
    const council = fakeCouncil({ 'reading-v3-last': reader, 'chat-v4': reader }, { search: backupSearch });
    const outcome = await runCouncilWebAnswer({
      ...input, search: async () => ({ pages: [{ ...evidence, kind: 'knowledge' }, { ...evidence, text: '' }] }),
      deliberate: council.deliberate,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(backupSearch).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'partial', text: 'I could not find usable evidence in the web search.',
      council: { chosen: 'uncertain' } });
  });

  it('states disagreement and lists evidence without sending a dissenting member’s answer', async () => {
    const council = fakeCouncil({
      'reading-v3-last': async () => ok({ text: opening }),
      'reading-v4-hn-last': async () => ok({ text: alternate }),
    });
    const outcome = await runCouncilWebAnswer({
      ...input, search: async () => ({ pages: [evidence, contradiction] }), deliberate: council.deliberate,
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.council?.chosen).toBe('uncertain');
    expect(outcome.text).toContain('could not agree');
    expect(outcome.text).toContain(evidence.title);
    expect(outcome.text).toContain(contradiction.title);
    expect(outcome.text).not.toContain(opening);
    expect(outcome.text).not.toContain(alternate);
  });

  it('reports an empty registry in English without sending the cited pipeline claim', async () => {
    const council = fakeCouncil({});
    const outcome = await runCouncilWebAnswer({ ...input, search: async () => ({ pages: [evidence] }), deliberate: council.deliberate });
    expect(outcome.council?.chosen).toBe('uncertain');
    expect(outcome.council?.discussion?.proposals).toContainEqual({ member: 'pipeline', answer: opening, evidenceUrl: evidence.url, evidenceQuote: evidence.text });
    expect(outcome.text).toContain('No council model produced an answer proposal or completed a check.');
    expect(outcome.text).toContain(evidence.url);
    expect(outcome.text).not.toContain(opening);
  });

  it('reports missing council artifacts in Arabic and keeps the cited pipeline claim private', async () => {
    const arabicQuestion = 'ما عاصمة فريدونيا؟';
    const capital = 'مارلو';
    const page = { ...evidence, title: 'دليل فريدونيا', text: `عاصمة فريدونيا هي ${capital}.` };
    const reader = vi.fn(async () => ok({ text: capital }));
    const council = fakeCouncil({ 'reading-v3-last': reader }, {
      resolve: async entry => ({ entry, state: 'absent', artifacts: [] }),
    });
    const outcome = await runCouncilWebAnswer({
      ...input, question: arabicQuestion, history: [], search: async () => ({ pages: [page] }), deliberate: council.deliberate,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(outcome.council?.chosen).toBe('uncertain');
    expect(outcome.council?.discussion?.proposals).toContainEqual(expect.objectContaining({ member: 'pipeline', evidenceUrl: page.url, evidenceQuote: page.text }));
    expect(outcome.text).toContain('لم يقدّم أي نموذج في المجلس اقتراحًا للجواب أو يُكمل فحصه.');
    expect(outcome.text).toContain(page.title);
    expect(outcome.text).not.toContain(capital);
  });

  it('returns the time-limit reply immediately when the queued request is already over budget', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const search = vi.fn();
    const deliberate = vi.fn();
    const progress = vi.fn();
    const answer = await runCouncilWebAnswer({ ...input, search, deliberate, progress, startedAt: -COUNCIL_WEB_BUDGET_MS - 1 });
    expect(answer).toEqual({ status: 'partial', text: 'Time limit reached. The model council could not verify an answer in time.' });
    expect(search).not.toHaveBeenCalled();
    expect(deliberate).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it('cancels a hung search at the shared deadline and never starts deliberation afterwards', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    let searchSignal: AbortSignal | undefined;
    const search: NonNullable<CouncilTurn['search']> = (_question, signal) => {
      searchSignal = signal;
      return new Promise(() => {});
    };
    const deliberate = vi.fn();
    const answer = runCouncilWebAnswer({ ...input, search, deliberate, budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(searchSignal?.aborted).toBe(true);
    expect(deliberate).not.toHaveBeenCalled();
    expect(await answer).toEqual({
      status: 'partial', text: 'Time limit reached. The model council could not verify an answer in time.',
    });
  });

  it('sends the verified council decision with a time-limit label if a member is still running', async () => {
    const hungMember = vi.fn((_modelInput: unknown, _signal?: AbortSignal): Promise<ModelRunResult> => new Promise(() => {}));
    const council = fakeCouncil({
      'reading-v3-last': async () => ok({ text: opening }),
      'reading-v4-hn-last': hungMember,
    });
    const search = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { pages: [evidence] };
    };
    const outcome = await runCouncilWebAnswer({ ...input, search, deliberate: council.deliberate, budgetMs: 350 });
    expect(hungMember).toHaveBeenCalledOnce();
    expect(hungMember.mock.lastCall?.[1]?.aborted).toBe(true);
    expect(outcome.status).toBe('completed');
    expect(outcome.council?.chosen).toBe('pipeline');
    expect(outcome.text).toContain(opening);
    expect(outcome.text).toContain('Time limit reached. This is the best answer');
  });

  it('retains a completed verifier objection when its next check reaches the deadline', async () => {
    const verify = vi.fn<() => Promise<ModelRunResult>>()
      .mockResolvedValueOnce(ok({ label: 'insufficient' }))
      .mockImplementation(() => new Promise(() => {}));
    const council = fakeCouncil({
      'reading-v3-last': async () => ok({ text: opening }),
      'head-sufficiency': verify,
    });
    const outcome = await runCouncilWebAnswer({
      ...input, search: async () => ({ pages: [evidence] }), deliberate: council.deliberate, budgetMs: 350,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(outcome.council?.discussion?.checks).toContainEqual({
      checker: 'head-sufficiency', member: 'pipeline', verdict: 'contradicts',
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.council?.chosen).toBe('uncertain');
    expect(outcome.text).not.toContain(opening);
  });
});
