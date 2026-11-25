import { readFileSync } from 'node:fs';
import type { AgentPage } from '@mohassan/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHands, webQuestion, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { classifyQuestion } from '../apps/server/src/assistant/selection/answer-types.js';
import { foldText } from '../packages/skills/src/stems.js';

type Language = 'ar' | 'en';
interface FixturePage {
  id: string;
  language: Language;
  title: string;
  url: string;
  revisionUrl: string;
  text: string;
}
interface FixtureQuestion {
  id: string;
  language: Language;
  question: string;
  pageIds: string[];
  expected: string[][];
}

const pages: FixturePage[] = JSON.parse(readFileSync(new URL('./fixtures/answer-selection/pages.json', import.meta.url), 'utf8'));
const questions: FixtureQuestion[] = JSON.parse(readFileSync(new URL('./fixtures/answer-selection/questions.json', import.meta.url), 'utf8'));
const pagesById = new Map(pages.map(page => [page.id, page]));
const normalize = (text: string) => foldText(text.normalize('NFKD').replace(/[\p{M}\p{Cf}ـ]/gu, '')).replace(/\s+/gu, ' ').trim();

function includesAnswer(text: string, expected: readonly string[][]): boolean {
  const folded = normalize(text);
  return expected.some(alternative => alternative.every(atom => folded.includes(normalize(atom))));
}

function observedPage(page: FixturePage): AgentPage {
  return {
    id: page.id, url: page.url, title: page.title, text: page.text, elements: [], hash: page.id,
    observedAt: '2026-11-25T00:00:00Z', documentStatus: 200,
    signals: { captcha: false, card: false, otp: false, password: false }, scroll: { top: 0, height: 0, viewport: 0 },
  };
}

async function replay(testCase: FixtureQuestion): Promise<string | null> {
  const observed = testCase.pageIds.map(id => observedPage(pagesById.get(id)!));
  const reads = new Map(observed.map(page => [page.url, page]));
  const io: HandsIO = {
    read: async url => {
      const page = reads.get(url);
      return page ? { kind: 'page', page } : { kind: 'disallowed' };
    },
    search: async () => observed.map(({ url, title, text }) => ({ url, title, snippet: text.slice(0, 6000) })),
    act: async () => { throw new Error('Fixture replay must use the supplied HTTP reads'); },
    page: async () => null,
    prepare: async () => null,
    settle: async page => page,
    step: async () => {},
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
  const search = webQuestion(testCase.question)?.find(step => step.kind === 'search' && step.ask);
  const plan: HandsPlan = { next: 0, lang: testCase.language, steps: [search ?? { kind: 'search', query: testCase.question, site: null, ask: true }] };
  const result = await runHands(plan, io);
  expect(result.kind, testCase.id).toBe('done');
  return plan.found?.lines[0] ?? null;
}

type Outcome = 'correct' | 'wrong' | 'abstained';
type Counts = Record<Outcome, number>;
const emptyCounts = (): Counts => ({ correct: 0, wrong: 0, abstained: 0 });
const regressionExpectations = {
  'en-telephone-01': 'correct', 'ar-messi-01': 'correct', 'ar-algeria-01': 'correct',
  'ar-rain-01': 'abstained', 'en-rain-01': 'correct', 'ar-red-sea-01': 'abstained', 'en-sky-01': 'correct',
  'ar-wwii-01': 'correct', 'ar-rain-06': 'correct', 'en-rain-05': 'correct',
  'ar-japan-04': 'correct', 'ar-japan-05': 'abstained', 'en-africa-asia-area': 'correct',
  'en-amazon-nile-comparison': 'abstained', 'en-trench-baikal-depth': 'abstained',
} satisfies Record<string, Outcome>;
const regressions = new Set([...Object.keys(regressionExpectations), 'ar-sky-01']);

describe('answer selection on frozen public page excerpts', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('has 60 or more distinct attributed pages and 200 or more bilingual cases with source-backed oracles', () => {
    expect(pagesById.size).toBe(pages.length);
    expect(new Set(pages.map(page => page.url)).size).toBeGreaterThanOrEqual(60);
    expect(new Set(questions.map(question => question.id)).size).toBe(questions.length);
    expect(questions.length).toBeGreaterThanOrEqual(200);
    for (const language of ['ar', 'en'] as const) {
      expect(questions.filter(question => question.language === language).length).toBeGreaterThanOrEqual(90);
    }
    for (const page of pages) {
      expect(new URL(page.revisionUrl).searchParams.get('oldid'), page.id).toMatch(/^\d+$/u);
    }
    for (const testCase of questions) {
      expect(testCase.pageIds.length, testCase.id).toBeGreaterThan(0);
      const candidates = testCase.pageIds.map(id => {
        const page = pagesById.get(id);
        expect(page, testCase.id).toBeDefined();
        return page!;
      });
      if (testCase.expected.length) {
        expect(candidates.some(page => includesAnswer(`${page.title}\n${page.text}`, testCase.expected)), testCase.id).toBe(true);
      }
    }
  });

  it('reports the lead quote selected by the current and flagged hands paths on the same sources', async () => {
    const totals = {
      current: { ar: emptyCounts(), en: emptyCounts() },
      ranker: { ar: emptyCounts(), en: emptyCounts() },
    };
    const reasons = {
      current: { ar: emptyCounts(), en: emptyCounts() },
      ranker: { ar: emptyCounts(), en: emptyCounts() },
    };
    const regressionOutcomes: Record<string, Partial<Record<keyof typeof totals, Outcome>>> = {};
    for (const mode of ['current', 'ranker'] as const) {
      vi.stubEnv('MOHASSAN_ANSWER_SELECTION', mode === 'ranker' ? '1' : undefined);
      const wrong: string[] = [];
      for (const testCase of questions) {
        const quote = await replay(testCase);
        const outcome: Outcome = !quote ? 'abstained' : includesAnswer(quote, testCase.expected) ? 'correct' : 'wrong';
        totals[mode][testCase.language][outcome]++;
        if (classifyQuestion(testCase.question).type === 'reason') reasons[mode][testCase.language][outcome]++;
        if (outcome === 'wrong') wrong.push(testCase.id);
        if (regressions.has(testCase.id)) (regressionOutcomes[testCase.id] ??= {})[mode] = outcome;
      }
      console.info(`Answer selection ${mode} wrong case IDs: ${wrong.join(', ')}`);
    }
    console.info(`Answer selection corpus totals: ${JSON.stringify(totals)}`);
    console.info(`Answer selection reason totals: ${JSON.stringify(reasons)}`);
    console.info(`Answer selection regression outcomes: ${JSON.stringify(regressionOutcomes)}`);
    for (const [id, outcome] of Object.entries(regressionExpectations)) {
      expect(regressionOutcomes[id]?.ranker, id).toBe(outcome);
    }
    for (const language of ['ar', 'en'] as const) {
      expect(totals.ranker[language].wrong).toBeLessThan(totals.current[language].wrong);
      expect(totals.ranker[language].correct).toBeGreaterThan(0);
    }
  });
});
