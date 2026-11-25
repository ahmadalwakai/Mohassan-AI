import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { checkAnswerLine } from '../apps/server/src/assistant/answer-check.js';
import { judge } from '../apps/server/src/assistant/judge.js';
import { selectSearchAnswer, withAnswerSelectionMode } from '../apps/server/src/assistant/selection/hands-selection.js';
import { acceptsLegacyCandidate, rankCalibratedAnswer } from '../apps/server/src/assistant/selection/ranker.js';

const page = (title: string, text: string) => ({ title, text, url: 'https://library.example/reference' });

describe('source-backed search facts', () => {
  it('separates an Arabic locative question frame from the name it asks about', () => {
    const ask = 'أين توجد بلدة جبيل؟';
    const answer = 'جبيل بلدة تاريخية تقع على الساحل اللبناني.';
    const other = 'البترون بلدة تاريخية تقع على الساحل اللبناني.';
    const nearby = 'تقع البترون على الساحل اللبناني بالقرب من جبيل.';
    const negative = 'جبيل لا تقع على ساحل البحر الأحمر.';
    expect(rankCalibratedAnswer(ask, [page('جبيل', `${other} ${nearby} ${answer}`)]).selected?.text).toBe(answer);
    expect(rankCalibratedAnswer(ask, [page('جبيل', `${nearby} ${negative}`)]).selected).toBeNull();
  });

  it('binds a coordinated capital description to its shared owner', () => {
    const ask = 'What is the capital city of Sweden?';
    const answer = 'Stockholm is the capital and most populous city of Sweden.';
    const other = 'Oslo is the capital and most populous city of Norway.';
    const negative = 'Gothenburg is not the capital and most populous city of Sweden.';
    expect(rankCalibratedAnswer(ask, [page('Sweden', `${other} ${negative} ${answer}`)]).selected?.text).toBe(answer);
    expect(rankCalibratedAnswer(ask, [page('Sweden', `${other} ${negative}`)]).selected).toBeNull();
  });

  it('uses a direct authorship assertion even when a publication note follows it', () => {
    const ask = 'Who wrote the play The Importance of Being Earnest?';
    const answer = 'The Importance of Being Earnest is a play by Oscar Wilde, first published in 1899.';
    const other = 'Lady Windermere’s Fan is a play by Oscar Wilde, first published in 1893.';
    const byline = 'By Jane Smith, published on 2 June.';
    const titleOnly = page(answer, 'Drama from the nineteenth century.');
    expect(rankCalibratedAnswer(ask, [page('Drama', `${other} ${byline} ${answer}`)]).selected?.text).toBe(answer);
    expect(acceptsLegacyCandidate(ask, page('Drama', answer), answer)).toBe(true);
    expect(rankCalibratedAnswer(ask, [page('Drama', `${other} ${byline}`), titleOnly]).selected).toBeNull();
    const reply = (quote: string) => `${quote}\n\n**Source:** [Drama](https://library.example/reference)`;
    expect(judge({ question: ask, reply: reply(answer), status: 'completed' }).decision).not.toBe('withhold');
    expect(checkAnswerLine(ask, byline).reasons).toContain('meta_line');
    expect(checkAnswerLine(ask, 'The site published on 2 June.').reasons).toContain('meta_line');
  });

  it.each([
    ['Which currency does Portugal use?', 'Portugal', 'The euro is the official currency of Portugal and Spain.', 'The krone is the official currency of Norway.'],
    ['إيش عملة الكويت؟', 'الكويت', 'الدينار الكويتي هو العملة الوطنية في الكويت.', 'الريال هو العملة الوطنية في قطر.'],
  ])('requires the currency assertion to identify the requested owner for %s', (ask, title, answer, other) => {
    expect(rankCalibratedAnswer(ask, [page(title, `${other} ${answer}`)]).selected?.text).toBe(answer);
    expect(rankCalibratedAnswer(ask, [page(title, other)]).selected).toBeNull();
  });

  it('requires a majority of the requested whole and retains the source’s measurement basis', () => {
    const ask = 'Which mineral constitutes the majority of the sample’s sediment?';
    const answer = 'Quartz constitutes 65 percent of the dry sediment of the sample by mass.';
    const underHalf = 'Mica constitutes 49 percent of the sediment of the sample.';
    const wrongScope = 'Calcite accounts for 80 percent of the sediment of the adjacent sample.';
    const subset = 'Shell fragments account for 90 percent of parts of the sediment of the sample.';
    const negation = 'Quartz does not account for 65 percent of the sediment of the sample.';
    const joint = 'Calcite and mica together make up 65 percent of the sediment of the sample.';
    const distractors = `${underHalf} ${wrongScope} ${subset} ${negation} ${joint}`;
    expect(rankCalibratedAnswer(ask, [page('Sediment analysis', `${distractors} ${answer}`)]).selected?.text).toBe(answer);
    expect(rankCalibratedAnswer(ask, [page('Sediment analysis', distractors)]).selected).toBeNull();
  });

  it.each([
    ['Which currency does Morocco use?', 'The Moroccan dirham is the national currency of Morocco.', 'The euro is the national currency of Morocco.'],
    ['Which metal makes up most of the alloy?', 'Copper accounts for 68 percent of the alloy.', 'Nickel accounts for 68 percent of the alloy.'],
  ])('withholds incompatible assertions across read sources for %s', (ask, first, second) => {
    const source = page('Handbook', first);
    const alternate = { ...page('Gazette', second), url: 'https://gazette.example/reference' };
    expect(rankCalibratedAnswer(ask, [source, { ...alternate, text: first }]).selected?.text).toBe(first);
    expect(rankCalibratedAnswer(ask, [source, alternate])).toMatchObject({ selected: null, reason: 'conflicting-evidence' });
  });

  it('does not let a legacy lead settle conflicting claims', () => {
    const observed = (url: string, text: string): AgentPage => ({
      url, title: 'Materials handbook', text, id: url, hash: url, elements: [], observedAt: '2025-07-09T00:00:00Z',
      signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 800, viewport: 800 },
    });
    const first = observed('https://materials.example/handbook', 'Tin accounts for 56 percent of the solder.');
    const second = observed('https://solder.example/guide', 'Lead accounts for 56 percent of the solder.');
    const answer = withAnswerSelectionMode('combined', () => selectSearchAnswer(
      'Which element constitutes most of the solder?',
      { url: first.url, title: first.title, lines: [first.text], readAt: first.observedAt },
      [{ kind: 'page', page: first }, { kind: 'page', page: second }], null,
      { readableOverHttp: () => true, rejected: () => false, live: false },
    ));
    expect(answer).toBeUndefined();
  });
});
