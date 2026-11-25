import { setImmediate } from 'node:timers/promises';
import type { AgentPage } from '@mohassan/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describe as describeReply, runHands, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { withAnswerSelectionMode, type SelectionObservation } from '../apps/server/src/assistant/selection/hands-selection.js';

const { rankAnswer, rankCalibratedAnswer, acceptsLegacyCandidate } = vi.hoisted(() => ({
  rankAnswer: vi.fn(), rankCalibratedAnswer: vi.fn(), acceptsLegacyCandidate: vi.fn(),
}));
vi.mock('../apps/server/src/assistant/selection/ranker.js', () => ({ rankAnswer, rankCalibratedAnswer, acceptsLegacyCandidate }));

const question = 'Who invented the telephone?';
const legacyQuote = 'John Taylor invented the telephone used at the exhibit.';
const goodQuote = 'Alexander Graham Bell invented the telephone.';

function page(url: string, title: string, text: string): AgentPage {
  return {
    id: url, url, title, text, elements: [], hash: url, observedAt: '2026-11-25T00:00:00Z',
    signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 },
  };
}

const oldPage = page('https://example.org/telephone', 'Telephone', legacyQuote);
const bestPage = page('https://example.org/early-telephones', 'Early telephones', goodQuote);
const disambiguation = page('https://example.org/other', 'The telephone (disambiguation)', 'Telephone may refer to several unrelated topics.');
const askPage: HandsPlan = { steps: [{ kind: 'ask_page', question }], next: 1, lang: 'en' };

function rankerVerdict(source: AgentPage | null) {
  const selected = source ? { url: source.url, text: goodQuote, score: 6, reasons: [], kind: 'sentence' } : null;
  const decision = {
    intent: { language: 'en', type: 'person' }, reason: selected ? 'selected' : 'no-evidence',
    selected, ranked: selected ? [selected] : [], threshold: 5,
  };
  rankAnswer.mockReturnValue(decision);
  rankCalibratedAnswer.mockReturnValue(decision);
}

const searchPlan = (): HandsPlan => ({ steps: [{ kind: 'search', site: null, query: question, ask: true }], next: 0, lang: 'en' });

function searchIO(): HandsIO {
  return {
    page: async () => null, step: async () => {}, settle: async observed => observed,
    search: async () => [oldPage, bestPage, disambiguation].map(observed => ({ title: observed.title, url: observed.url, snippet: observed.text })),
    read: async url => {
      const observed = [oldPage, bestPage, disambiguation].find(candidate => candidate.url === url);
      return observed ? { kind: 'page', page: observed } : { kind: 'unreadable' };
    },
    act: async () => { throw new Error('No browser action expected'); },
    prepare: async () => null, approve: async () => {}, hold: async () => {}, pause: async () => {},
  };
}

beforeEach(() => {
  vi.stubEnv('MOHASSAN_ANSWER_SELECTION', undefined);
  rankAnswer.mockReset();
  rankCalibratedAnswer.mockReset();
  acceptsLegacyCandidate.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('answer selection in Hands', () => {
  it('keeps the existing search and open-page replies by default', async () => {
    rankerVerdict(null);
    const plan = searchPlan();
    expect(await runHands(plan, searchIO())).toMatchObject({ kind: 'done', status: 'completed' });
    expect(plan.found?.lines[0]).toBe(legacyQuote);
    expect(describeReply(askPage, oldPage).text).toContain(`> ${legacyQuote}`);
    expect(rankCalibratedAnswer).not.toHaveBeenCalled();
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
  });

  it('lets the ranker choose across the already admitted reads only when enabled', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(bestPage);
    const plan = searchPlan();
    const result = await runHands(plan, searchIO());
    expect(rankCalibratedAnswer).toHaveBeenCalledWith(question, [oldPage, bestPage]);
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
    expect(plan.found).toMatchObject({ url: bestPage.url, lines: [goodQuote], readAt: bestPage.observedAt });
    expect(result).toMatchObject({ kind: 'done', status: 'completed', text: expect.stringContaining(goodQuote) });
    expect(describeReply(askPage, bestPage).text).toContain(`> ${goodQuote}`);
  });

  it('retains the current browser fallback as the browser evidence', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(bestPage);
    const earlier = { ...oldPage, text: 'The telephone is a device that allows conversations over a distance.' };
    const io = searchIO();
    io.read = undefined;
    io.act = async action => action.text === earlier.url ? earlier : bestPage;
    const plan = searchPlan();
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'completed' });
    expect(rankCalibratedAnswer).toHaveBeenCalledWith(question, [bestPage]);
  });

  it('excludes final URLs rejected by the judge even when results redirect to them', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(bestPage);
    const alias = 'https://example.org/telephone-redirect';
    const io = searchIO();
    const search = io.search!;
    const read = io.read!;
    io.search = async (query, limit) => (await search(query, limit)).map(hit => hit.url === oldPage.url ? { ...hit, url: alias } : hit);
    io.read = async url => read(url === alias ? oldPage.url : url);
    const plan = { ...searchPlan(), rejected: [`${oldPage.url}#lead`] };
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'completed' });
    expect(rankCalibratedAnswer).toHaveBeenCalledWith(question, [bestPage]);
    expect(plan.found?.url).toBe(bestPage.url);
    rankerVerdict(null);
    acceptsLegacyCandidate.mockReturnValue(true);
    const retry = { ...searchPlan(), rejected: plan.rejected };
    expect(await runHands(retry, io)).toMatchObject({ kind: 'done', status: 'partial' });
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
  });

  it('only shadows the ranker for live questions even when the flag is enabled', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    vi.stubEnv('VITEST', undefined);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const query = 'What is the price of gold today?';
    const quote = 'The price of gold rose to 2,400 dollars an ounce today.';
    const market = page('https://example.org/gold-price', 'Gold price today', quote);
    const io = searchIO();
    io.search = async () => [{ title: market.title, url: market.url, snippet: quote }];
    io.read = async () => ({ kind: 'page', page: market });
    rankerVerdict(null);
    const plan = searchPlan();
    plan.steps = [{ kind: 'search', site: null, query, ask: true }];
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'completed' });
    expect(plan.found?.lines[0]).toBe(quote);
    await setImmediate();
    expect(rankCalibratedAnswer).toHaveBeenCalledWith(query, [market]);
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ scope: 'search', applied: false, ranker: 'abstain' });
  });

  it('renders an abstention in either entry point when enabled', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(null);
    acceptsLegacyCandidate.mockReturnValue(false);
    const plan = searchPlan();
    expect(await runHands(plan, searchIO())).toMatchObject({ kind: 'done', status: 'partial' });
    expect(plan.found).toBeUndefined();
    const result = describeReply(askPage, oldPage);
    expect(result.status).toBe('partial');
    expect(result.text).not.toContain(legacyQuote);
    expect(acceptsLegacyCandidate).toHaveBeenCalledTimes(2);
    expect(acceptsLegacyCandidate).toHaveBeenCalledWith(question, oldPage, legacyQuote);
  });

  it('keeps only the validated legacy lead when the calibrated ranker abstains', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(null);
    acceptsLegacyCandidate.mockReturnValue(true);
    const extraQuote = 'The telephone invented for this exhibit included a different speaker.';
    const source = { ...oldPage, text: `${legacyQuote} ${extraQuote}` };
    const io = searchIO();
    const read = io.read!;
    io.read = async url => url === source.url ? { kind: 'page', page: source } : read(url);
    const plan = searchPlan();
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'completed' });
    expect(plan.found?.lines).toEqual([legacyQuote]);
    expect(describeReply(askPage, source).text).toContain(`> ${legacyQuote}`);
    expect(describeReply(askPage, source).text).not.toContain(extraQuote);
    expect(acceptsLegacyCandidate).toHaveBeenCalledWith(question, source, legacyQuote);
  });

  it('replays the historical unsupported behavior while combined mode abstains', () => {
    const unsupported = { intent: { language: 'en', type: 'unknown' }, reason: 'unsupported-question', selected: null, ranked: [], threshold: 61 };
    rankAnswer.mockReturnValue(unsupported);
    rankCalibratedAnswer.mockReturnValue(unsupported);
    const capture = vi.fn<(observation: SelectionObservation) => void>();
    const historical = withAnswerSelectionMode('ranker-only', () => describeReply(askPage, oldPage), capture);
    expect(historical.text).toContain(`> ${legacyQuote}`);
    expect(capture).toHaveBeenCalledWith({
      question, pages: [oldPage], baseline: { url: oldPage.url, text: legacyQuote }, scope: 'open-page', live: false, decision: unsupported, choice: 'legacy',
    });
    expect(withAnswerSelectionMode('combined', () => describeReply(askPage, oldPage)).status).toBe('partial');
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
  });

  it('isolates actual legacy and combined replays without changing the flag', async () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankerVerdict(bestPage);
    const legacy = searchPlan();
    const combined = searchPlan();
    const capture = vi.fn<(observation: SelectionObservation) => void>();
    await Promise.all([
      withAnswerSelectionMode('legacy', () => runHands(legacy, searchIO()), capture),
      withAnswerSelectionMode('combined', () => runHands(combined, searchIO())),
    ]);
    expect(legacy.found?.lines[0]).toBe(legacyQuote);
    expect(combined.found?.lines[0]).toBe(goodQuote);
    expect(capture).toHaveBeenCalledWith({
      question, pages: [oldPage, bestPage], baseline: { url: oldPage.url, text: legacyQuote }, scope: 'search', live: false, decision: undefined, choice: 'legacy',
    });
    expect(rankCalibratedAnswer).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit page title questions and abstains after a combined ranker failure', () => {
    vi.stubEnv('MOHASSAN_ANSWER_SELECTION', '1');
    rankCalibratedAnswer.mockImplementation(() => { throw new Error('Broken ranker'); });
    const titledPage = { ...oldPage, text: `${oldPage.title}\n${oldPage.text}` };
    const plan: HandsPlan = { steps: [{ kind: 'ask_page', question: 'What is the page title?' }], next: 1, lang: 'en' };
    expect(describeReply(plan, titledPage).text).toContain(`> ${oldPage.title}`);
    expect(rankCalibratedAnswer).not.toHaveBeenCalled();
    expect(describeReply(askPage, oldPage).status).toBe('partial');
    expect(acceptsLegacyCandidate).not.toHaveBeenCalled();
  });

  it('records shadow disagreement without logging questions, URLs or quotes', async () => {
    vi.stubEnv('VITEST', undefined);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    rankerVerdict(oldPage);
    const reply = describeReply(askPage, oldPage);
    expect(reply.text).toContain(`> ${legacyQuote}`);
    await setImmediate();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'answer_selection_shadow', scope: 'open-page', applied: false,
      language: 'en', answerType: 'person', reason: 'selected',
      baseline: 'answer', ranker: 'answer', sameSource: true, sameQuote: false,
    });
    for (const privateValue of [question, oldPage.url, legacyQuote, goodQuote]) expect(line).not.toContain(privateValue);
  });
});
