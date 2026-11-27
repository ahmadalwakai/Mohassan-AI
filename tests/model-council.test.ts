import { describe, expect, it, vi } from 'vitest';
import { ModelCouncilSchema } from '@mohassan/contracts';
import {
  createModelCouncil, decide, rankHits, readerPrompt, selectPassage, states, wantsWeb,
  type Candidate, type CouncilHistory, type CouncilRunner, type CouncilTurn,
} from '../apps/server/src/assistant/model-council.js';
import type { ModelRunResult } from '../packages/model-relations/src/runtime.js';

const page = (text: string, title = 'Paris - Encyclopedia', url = 'https://example.org/paris') => ({ kind: 'page' as const, text, title, url });
const PARIS = 'Paris is the capital and largest city of France. It is located on the river Seine in the north of the country.';

function runner(answers: Record<string, ModelRunResult | ((signal: AbortSignal) => Promise<ModelRunResult>)>): CouncilRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(modelId, _input, signal) {
      calls.push(modelId);
      const answer = answers[modelId];
      if (typeof answer === 'function') return answer(signal!);
      return answer ?? { ok: false, reason: 'absent', elapsedMs: 1 };
    },
  };
}

function waitForAbort<T>(signal: AbortSignal, aborted: (signal: AbortSignal) => void): Promise<T> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => {
    aborted(signal);
    reject(signal.reason);
  }, { once: true }));
}

const year = 1989;
const yearFormats = ['latn', 'arab', 'arabext'].map(numberingSystem => new Intl.NumberFormat('ar', { numberingSystem, useGrouping: false }));

function turn(overrides: Partial<CouncilTurn> = {}): CouncilTurn {
  return {
    question: 'What is the capital of France?', previous: null,
    pipeline: { text: 'The capital of France is Paris.', status: 'completed' },
    evidence: [], history: [{ role: 'user', content: 'What is the capital of France?' }],
    baseline: { route: 'web_search', refusal: 'allow', speechAct: 'request', turnType: 'new', question: 'What is the capital of France?' },
    v5MayAnswer: false, signal: new AbortController().signal, ...overrides,
  };
}

describe('model council building blocks', () => {
  it('picks the passage that shares the most question words', () => {
    const passage = selectPassage('What is the capital of France?', [page(`Weather in Lyon is mild in spring and autumn every year.\n${PARIS}`)]);
    expect(passage?.text).toBe(PARIS);
    expect(selectPassage('What is the capital of France?', [page('Nothing about the question is written in this unrelated paragraph.')])).toBeNull();
  });

  it('frames the reading prompt in the question language', () => {
    expect(readerPrompt('ما هي عاصمة فرنسا؟', 'نص')).toBe('نص\n\nسؤال: ما هي عاصمة فرنسا؟\nالجواب:');
    expect(readerPrompt('When was it built?', 'Text')).toBe('Text\n\nQuestion: When was it built?\nAnswer:');
  });

  it('checks that a text states an answer, numbers exactly', () => {
    expect(states(PARIS, 'Paris')).toBe(true);
    expect(states('Completed in 1889 for the fair.', '1889')).toBe(true);
    expect(states('Completed in 1887 for the fair.', '1889')).toBe(false);
    expect(states('باريس هي عاصمة فرنسا', 'باريس')).toBe(true);
  });

  it('matches Western, Arabic-Indic and Eastern Arabic-Indic digits in either position', () => {
    for (const pageFormat of yearFormats) {
      for (const answerFormat of yearFormats) {
        const text = `افتتح متحف المدينة رسمياً في سنة ${pageFormat.format(year)}.`;
        expect(states(text, answerFormat.format(year))).toBe(true);
        expect(states(pageFormat.format(year * 10), answerFormat.format(year))).toBe(false);
        expect(states(text, `افتتح رسمياً متحف المدينة في سنة ${answerFormat.format(year)}`)).toBe(true);
        expect(states(text, `افتتح رسمياً متحف المدينة في سنة ${answerFormat.format(year + 1)}`)).toBe(false);
      }
    }
  });

  it('ranks search hits by question words, one per site, whatever the site', () => {
    const ranked = rankHits('capital of France', [
      { title: 'Weather today', url: 'https://weather.example/today', snippet: 'Sunny' },
      { title: 'France - Wikipedia', url: 'https://en.wikipedia.org/wiki/France', snippet: 'A country in Europe' },
      { title: 'Capital of France guide', url: 'https://travel.example/france-capital', snippet: 'The capital of France is Paris' },
      { title: 'Paris, capital of France', url: 'https://en.wikipedia.org/wiki/Paris', snippet: 'capital' },
    ]);
    expect(ranked.map(hit => hit.url)).toEqual(['https://travel.example/france-capital', 'https://en.wikipedia.org/wiki/Paris']);
  });

  it('sends a request to the web when the rules or a routing model do', () => {
    const base = turn().baseline;
    expect(wantsWeb(base)).toBe(true);
    expect(wantsWeb({ ...base, route: 'chat' })).toBe(false);
    expect(wantsWeb({ ...base, route: 'chat' }, { stages: [{ stage: 'router', winner: 'existing-rules', models: [
      { model: 'router-b0', outcome: 'ok', attempted: true, elapsedMs: 3, returned: { hash: 'h', label: 'web_search' } }] }] } as never)).toBe(true);
  });
});

describe('the referee', () => {
  const candidate = (model: string, text: string, extra: Partial<Candidate> = {}): Candidate =>
    ({ model, text, reply: text, outcome: 'ok', ms: 5, agreements: 0, judge: 'send', ...extra });

  it('keeps a standing pipeline answer and names who agreed and who differed', () => {
    const decision = decide({ v5MayAnswer: false }, true, [candidate('pipeline', 'The capital is Paris.'),
      candidate('reading-v3-last', 'Paris', { inEvidence: true }), candidate('chat-v5', 'Lyon')]);
    expect(decision).toMatchObject({ chosen: 'pipeline', changed: false });
    expect(decision.reason).toContain('وافقه: نموذج القراءة v3');
    expect(decision.reason).toContain('خالفه: نموذج المحادثة v5');
  });

  it('sends a model answer found in the pages and backed by another member when the pipeline has none', () => {
    const decision = decide({ v5MayAnswer: true }, false, [candidate('pipeline', 'I could not find it.'),
      candidate('chat-v5', 'It is Paris.', { agreements: 1 }), candidate('reading-v3-last', 'Paris', { inEvidence: true, agreements: 1 })]);
    expect(decision).toMatchObject({ chosen: 'reading-v3-last', changed: true });
  });

  it('keeps a lone guess in the record instead of sending it, even when it is in the pages', () => {
    const decision = decide({ v5MayAnswer: false }, false, [candidate('pipeline', 'I could not find it.'),
      candidate('reading-v3-last', '2022', { inEvidence: true })]);
    expect(decision).toMatchObject({ chosen: 'pipeline', changed: false });
    expect(decision.reason).toContain('لم يُرسل تخمين منفرد');
  });

  it('never sends a model answer the pages do not contain, except v5 as the existing last resort', () => {
    const cases = [candidate('reading-v3-last', 'Lyon', { inEvidence: false }), candidate('chat-v5', 'Lyon')];
    expect(decide({ v5MayAnswer: true }, false, cases)).toMatchObject({ chosen: 'chat-v5', changed: true });
    expect(decide({ v5MayAnswer: false }, false, cases)).toMatchObject({ chosen: 'pipeline', changed: false });
    expect(decide({ v5MayAnswer: true }, false, [candidate('chat-v5', 'Lyon', { judge: 'withhold' })])).toMatchObject({ chosen: 'pipeline' });
  });
});

describe('deliberation', () => {
  it('keeps a completed pipeline answer, shows the members, and searches nothing', async () => {
    const search = vi.fn();
    const models = runner({ 'reading-v3-last': { ok: true, output: { text: ' Paris', stopReason: 'eos' }, elapsedMs: 40 } });
    const council = createModelCouncil({ runner: models, v5: async () => 'France capital is Lyon.' });
    const outcome = await council.deliberate(turn({ evidence: [page(PARIS)], search }));
    expect(outcome).toMatchObject({ changed: false, chosen: 'pipeline', text: 'The capital of France is Paris.', status: 'completed' });
    expect(search).not.toHaveBeenCalled();
    const answers = outcome.council.members.filter(member => member.round === 'answer');
    expect(answers.map(member => member.model)).toEqual(['pipeline', 'chat-v5', 'reading-v3-last']);
    expect(answers.find(member => member.model === 'reading-v3-last')).toMatchObject({ output: 'Paris', inEvidence: true, agreements: 1 });
    expect(answers.find(member => member.model === 'pipeline')).toMatchObject({ chosen: true });
    expect(ModelCouncilSchema.parse(outcome.council)).toEqual(outcome.council);
  });

  it('searches the web on the backend when the pipeline read nothing and found nothing, then sends the grounded answer', async () => {
    const search = vi.fn(async () => ({ pages: [page(PARIS, 'Capital of France guide', 'https://travel.example/france-capital')] }));
    const models = runner({ 'reading-v3-last': { ok: true, output: { text: ' Paris\nQuestion:', stopReason: 'length' }, elapsedMs: 40 } });
    // v5 says the same thing, so the reading model's answer is grounded and backed by a second member.
    const council = createModelCouncil({ runner: models, v5: async () => 'The capital of France is Paris.' });
    const outcome = await council.deliberate(turn({ pipeline: { text: 'لم أجد جواباً.', status: 'blocked' }, search }));
    expect(search).toHaveBeenCalledWith('What is the capital of France?', expect.any(AbortSignal));
    expect(outcome).toMatchObject({ changed: true, chosen: 'reading-v3-last', status: 'completed' });
    expect(outcome.text).toContain('Paris');
    expect(outcome.text).toContain('Source: Capital of France guide — https://travel.example/france-capital');
    expect(outcome.text).toContain('reading model v3');
    expect(outcome.council.members.find(member => member.round === 'search')).toMatchObject({ model: 'web-search', outcome: 'ok' });
    expect(models.calls).toContain('reading-v3-last');
    expect(models.calls).not.toContain('chat-v4');
  });

  it('does not search a request that is not a web question', async () => {
    const search = vi.fn();
    const council = createModelCouncil({ runner: runner({}) });
    await council.deliberate(turn({ pipeline: { text: '', status: 'blocked' }, search,
      baseline: { route: 'writing', refusal: 'allow', speechAct: 'request', turnType: 'new' } }));
    expect(search).not.toHaveBeenCalled();
  });

  it('records a member that runs out of time and still decides within the budget', async () => {
    const aborted = vi.fn();
    const never = (signal: AbortSignal) => {
      signal.addEventListener('abort', aborted, { once: true });
      return new Promise<ModelRunResult>(() => {});
    };
    const council = createModelCouncil({ runner: runner({ 'reading-v3-last': never }), memberMs: { reader: 50 }, budgetMs: 2_000 });
    const started = performance.now();
    const outcome = await council.deliberate(turn({ evidence: [page(PARIS)] }));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(aborted).toHaveBeenCalledOnce();
    expect(outcome.council.members.find(member => member.model === 'reading-v3-last')).toMatchObject({ outcome: 'timeout' });
    expect(outcome.chosen).toBe('pipeline');
  });

  it('aborts v5 at its own cap and records a timeout even when v5 rejects', async () => {
    const aborted = vi.fn();
    const cap = 50;
    const v5 = vi.fn((_history: CouncilHistory, signal: AbortSignal) => waitForAbort<string>(signal, aborted));
    const council = createModelCouncil({ runner: runner({}), v5, memberMs: { v5: cap }, budgetMs: 2_000 });
    const request = turn();
    vi.useFakeTimers();
    try {
      const pending = council.deliberate(request);
      await vi.advanceTimersByTimeAsync(cap - 1);
      expect(v5).toHaveBeenCalledOnce();
      expect(aborted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      const signal = v5.mock.calls[0]![1];
      expect(aborted).toHaveBeenCalledWith(signal);
      expect(signal.aborted).toBe(true);
      expect(request.signal.aborted).toBe(false);
      expect(outcome.council.members.find(member => member.model === 'chat-v5')).toMatchObject({ outcome: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards turn cancellation to an active v5 member', async () => {
    const parent = new AbortController();
    const reason = new Error('Turn cancelled');
    const aborted = vi.fn();
    const council = createModelCouncil({ runner: runner({}), v5: async (_history, signal) => {
      const work = waitForAbort<string>(signal, aborted);
      parent.abort(reason);
      return work;
    } });
    const outcome = await council.deliberate(turn({ signal: parent.signal }));
    expect(aborted).toHaveBeenCalledWith(expect.objectContaining({ aborted: true, reason }));
    expect(outcome.council.members.find(member => member.model === 'chat-v5')).toMatchObject({ outcome: 'timeout' });
  });

  it('aborts an understanding model when its round reaches the wall-time budget', async () => {
    const aborted = vi.fn();
    const models = runner({ refusal: signal => waitForAbort<ModelRunResult>(signal, aborted) });
    const council = createModelCouncil({ runner: models, memberMs: { understanding: 50 } });
    const outcome = await council.deliberate(turn());
    expect(aborted).toHaveBeenCalledOnce();
    expect(outcome.council.members.find(member => member.model === 'refusal')).toMatchObject({ outcome: 'timeout', round: 'understanding' });
    expect(models.calls).not.toContain('scratch-refusal');
  });

  it('aborts a search when it reaches its own cap', async () => {
    const aborted = vi.fn();
    const council = createModelCouncil({ runner: runner({}), memberMs: { search: 50 } });
    const outcome = await council.deliberate(turn({ pipeline: { text: '', status: 'blocked' },
      search: (_question, signal) => waitForAbort(signal, aborted) }));
    expect(aborted).toHaveBeenCalledOnce();
    expect(outcome.council.members.find(member => member.round === 'search')).toMatchObject({ outcome: 'timeout' });
  });

  it('records the model runtime’s own timeout as a timeout', async () => {
    const timeout = { ok: false, reason: 'timeout', elapsedMs: 1 } as const;
    const council = createModelCouncil({ runner: runner({ 'reading-v3-last': timeout, 'chat-v4': timeout, arithmetic: timeout }) });
    const read = await council.deliberate(turn({ evidence: [page(PARIS)] }));
    const other = await council.deliberate(turn({ question: 'What is 2 + 3?' }));
    expect(read.council.members.find(member => member.model === 'reading-v3-last')?.outcome).toBe('timeout');
    expect(other.council.members.find(member => member.model === 'chat-v4')?.outcome).toBe('timeout');
    expect(other.council.members.find(member => member.model === 'arithmetic')?.outcome).toBe('timeout');
  });

  it('marks a reading abstention and asks v4 only when nothing was read', async () => {
    const models = runner({
      'reading-v3-last': { ok: true, output: { text: ' غير مذكور في النص', stopReason: 'eos' }, elapsedMs: 9 },
      'chat-v4': { ok: true, output: { text: 'Paris\n\nmore', stopReason: 'length' }, elapsedMs: 9 },
    });
    const council = createModelCouncil({ runner: models });
    const read = await council.deliberate(turn({ question: 'ما هي عاصمة فرنسا؟', evidence: [page('باريس هي عاصمة فرنسا وأكبر مدنها وتقع على نهر السين في شمال البلاد.')] }));
    expect(read.council.members.find(member => member.model === 'reading-v3-last')).toMatchObject({ outcome: 'abstained' });
    expect(models.calls).not.toContain('chat-v4');
    const none = await council.deliberate(turn({ baseline: { route: 'chat', refusal: 'allow', speechAct: 'request', turnType: 'new' } }));
    expect(none.council.members.find(member => member.model === 'chat-v4')).toMatchObject({ outcome: 'ok', output: 'Paris' });
  });
});
