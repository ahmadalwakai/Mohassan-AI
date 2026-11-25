import { readFileSync } from 'node:fs';
import type { AgentPage } from '@mohassan/browser';
import { describe, expect, it } from 'vitest';
import { runHands, webQuestion, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { combinedCalibration, originalCalibration, type SelectionCalibration } from '../apps/server/src/assistant/selection/calibration.js';
import { withAnswerSelectionMode, type SelectionObservation } from '../apps/server/src/assistant/selection/hands-selection.js';
import { acceptsLegacyCandidate, calibratedScorer, decidePreparedAnswer, prepareAnswerSelection, type PreparedSelection } from '../apps/server/src/assistant/selection/ranker.js';
import { foldText } from '../packages/skills/src/stems.js';
import { emptyLeadCounts, leadSummary, type LeadCounts, type Outcome } from './fixtures/answer-selection/metrics.js';
import { validateAnswerSelectionSplit, type AnswerSelectionPartition, type AnswerSelectionSplit } from './fixtures/answer-selection/split.js';

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
const split: AnswerSelectionSplit = JSON.parse(readFileSync(new URL('./fixtures/answer-selection/split.json', import.meta.url), 'utf8'));
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

const modes = ['legacy', 'ranker-only', 'combined'] as const;
type Chooser = typeof modes[number];

async function replay(testCase: FixtureQuestion, mode: Chooser, capture?: (value: SelectionObservation) => void): Promise<string | null> {
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
  const result = await withAnswerSelectionMode(mode, () => runHands(plan, io), capture);
  expect(result.kind, testCase.id).toBe('done');
  return plan.found?.lines[0] ?? null;
}

const languages = ['ar', 'en'] as const;
const byLanguage = (): Record<Language, LeadCounts> => ({ ar: emptyLeadCounts(), en: emptyLeadCounts() });
const grade = (testCase: FixtureQuestion, quote?: string | null): Outcome => !quote ? 'abstained' : includesAnswer(quote, testCase.expected) ? 'correct' : 'wrong';

function partition(name: AnswerSelectionPartition): FixtureQuestion[] {
  validateAnswerSelectionSplit(split, pages, questions);
  const ids = new Set(split[name].questionIds);
  return questions.filter(question => ids.has(question.id));
}

const regressionExpectations = {
  'en-telephone-01': 'correct', 'ar-messi-01': 'correct', 'ar-algeria-01': 'correct',
  'ar-rain-01': 'abstained', 'en-rain-01': 'correct', 'ar-red-sea-01': 'abstained', 'en-sky-01': 'correct',
  'ar-wwii-01': 'correct', 'ar-rain-06': 'correct', 'en-rain-05': 'correct',
  'ar-japan-04': 'correct', 'ar-japan-05': 'abstained', 'en-africa-asia-area': 'correct',
  'en-amazon-nile-comparison': 'abstained', 'en-trench-baikal-depth': 'abstained',
} satisfies Record<string, Outcome>;

function checkOriginalRanker(testCase: FixtureQuestion, actual: Outcome): void {
  const expected = (regressionExpectations as Partial<Record<string, Outcome>>)[testCase.id];
  if (expected) expect(actual, testCase.id).toBe(expected);
}

interface DevelopmentCase {
  fixture: FixtureQuestion;
  baseline: Outcome;
  fallback: Outcome;
  prepared?: PreparedSelection;
}

async function prepareDevelopmentCases(): Promise<DevelopmentCase[]> {
  const development: DevelopmentCase[] = [];
  for (const fixture of partition('development')) {
    let observation: SelectionObservation | undefined;
    const baseline = grade(fixture, await replay(fixture, 'legacy', value => { observation = value; }));
    if (!observation || observation.live) {
      development.push({ fixture, baseline, fallback: baseline });
      continue;
    }
    const { question, pages: admitted, baseline: lead } = observation;
    const source = lead && admitted.find(page => page.url === lead.url);
    const fallback = grade(fixture, source && lead && acceptsLegacyCandidate(question, source, lead.text) ? lead.text : null);
    const prepared = prepareAnswerSelection(question, admitted);
    // A grid search only needs candidates that can clear the fixed evidence gates.
    development.push({ fixture, baseline, fallback, prepared: { ...prepared, candidates: prepared.candidates.filter(candidate => candidate.eligible) } });
  }
  return development;
}

interface CalibrationResult {
  calibration: SelectionCalibration;
  outcomes: Record<Language, LeadCounts>;
  missedWrongBudget: number;
  correct: number;
  wrong: number;
  distance: number;
}

/** The single shared grid and objective are fixed before reading the holdout scorecard. */
function calibrate(development: readonly DevelopmentCase[]) {
  const legacy = byLanguage();
  const eligibleCorrect = { ar: 0, en: 0 };
  for (const { fixture, baseline, fallback, prepared } of development) {
    legacy[fixture.language][baseline]++;
    if (fallback === 'correct' || prepared?.candidates.some(candidate => grade(fixture, candidate.text) === 'correct')) eligibleCorrect[fixture.language]++;
  }
  const wrongBudget = { ar: Math.floor(legacy.ar.wrong / 3), en: Math.floor(legacy.en.wrong / 3) };
  const trials: CalibrationResult[] = [];
  for (const type of [8, 12, 16]) for (const inferredEntity of [16, 22, 28]) for (const overlap of [14, 26, 38]) for (const position of [0, 7, 14]) {
    const weights = { type, inferredEntity, overlap, position };
    const scorer = calibratedScorer(weights);
    const predictions = development.map(item => {
      const top = item.prepared && decidePreparedAnswer(item.prepared, scorer, -Infinity).selected;
      return { ...item, score: top?.score ?? -Infinity, ranker: grade(item.fixture, top?.text) };
    });
    for (const threshold of [49, 55, 61, 67, 73, 79, 85, 91, 97]) {
      const calibration = { ...weights, threshold };
      const outcomes = byLanguage();
      for (const item of predictions) outcomes[item.fixture.language][item.score >= threshold ? item.ranker : item.fallback]++;
      const missedWrongBudget = languages.reduce((total, lang) => total + Math.max(0, outcomes[lang].wrong - wrongBudget[lang]), 0);
      const distance = (Object.keys(calibration) as (keyof SelectionCalibration)[])
        .reduce((total, key) => total + Math.abs(calibration[key] - originalCalibration[key]), 0);
      trials.push({ calibration, outcomes, missedWrongBudget, correct: outcomes.ar.correct + outcomes.en.correct,
        wrong: outcomes.ar.wrong + outcomes.en.wrong, distance });
    }
  }
  trials.sort((left, right) => left.missedWrongBudget - right.missedWrongBudget || right.correct - left.correct
    || left.wrong - right.wrong || left.distance - right.distance);
  return { legacy, eligibleCorrect, wrongBudget, trials: trials.length, best: trials[0] };
}

describe('answer selection on frozen public page excerpts', () => {
  it('has 60 or more distinct attributed pages and 200 or more bilingual cases with source-backed oracles', () => {
    expect(pagesById.size).toBe(pages.length);
    expect(new Set(pages.map(page => page.url)).size).toBeGreaterThanOrEqual(60);
    expect(new Set(questions.map(question => question.id)).size).toBe(questions.length);
    expect(questions.length).toBeGreaterThanOrEqual(200);
    for (const language of languages) {
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

  it('calibrates on development pages only', async () => {
    const development = await prepareDevelopmentCases();
    const result = calibrate(development);
    console.info(`Answer selection development calibration: ${JSON.stringify(result)}`);
    expect(combinedCalibration).toEqual(result.best.calibration);
    const combined = byLanguage();
    const original = byLanguage();
    for (const { fixture } of development) {
      combined[fixture.language][grade(fixture, await replay(fixture, 'combined'))]++;
      const outcome = grade(fixture, await replay(fixture, 'ranker-only'));
      original[fixture.language][outcome]++;
      checkOriginalRanker(fixture, outcome);
    }
    console.info(`Answer selection original ranker development: ${JSON.stringify(original)}`);
    expect(combined).toEqual(result.best.outcomes);
  });

  it('reports the frozen holdout with Wilson intervals', async () => {
    const holdout = partition('holdout');
    const totals = { legacy: byLanguage(), 'ranker-only': byLanguage(), combined: byLanguage() };
    const validatedFallback = byLanguage();
    for (const fixture of holdout) {
      for (const mode of modes) {
        let choice: SelectionObservation['choice'] | undefined;
        const outcome = grade(fixture, await replay(fixture, mode, value => { choice = value.choice; }));
        if (choice === 'validated-legacy') validatedFallback[fixture.language][outcome]++;
        totals[mode][fixture.language][outcome]++;
        if (mode === 'ranker-only') checkOriginalRanker(fixture, outcome);
      }
    }
    const scorecard = modes.flatMap(chooser => languages.map(language => {
      const counts = totals[chooser][language];
      const observations = holdout.filter(fixture => fixture.language === language).length;
      expect(counts.correct + counts.wrong + counts.abstained).toBe(observations);
      return { chooser, language, observations, outcomes: leadSummary(counts) };
    }));
    console.info(`Answer selection holdout SHA-256: ${split.holdout.sha256}`);
    console.info(`Answer selection holdout scorecard: ${JSON.stringify(scorecard)}`);
    console.info(`Answer selection holdout validated fallback: ${JSON.stringify(validatedFallback)}`);
  });
});
