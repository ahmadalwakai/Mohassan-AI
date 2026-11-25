import { describe, expect, it } from 'vitest';
import { sentenceSpans, type EvidenceSpan, type WritingSource } from '../apps/server/src/assistant/writing/evidence.js';
import { explain, explanationSections } from '../apps/server/src/assistant/writing/explanation.js';
import { restructure } from '../apps/server/src/assistant/writing/restructure.js';
import publicPages from './fixtures/extractive-writing/public-pages.json';
import userTexts from './fixtures/extractive-writing/user-texts.json';

function assertLiteral(spans: readonly EvidenceSpan[]) {
  for (const span of spans) expect(span.text).toBe(span.source.text.slice(span.start, span.end));
}

// Human-authored public-domain excerpts from NASA's STEM Team. Joined for evaluation only, never for training.
const satellite: WritingSource = {
  title: 'What Is a Satellite?',
  url: 'https://www.nasa.gov/learning-resources/for-kids-and-students/what-is-a-satellite-grades-5-8/',
  text: [
    'A satellite is a moon, planet or machine that orbits a planet or star.',
    'For example, Earth is a satellite because it orbits the sun.',
    'That’s because satellites fly above the clouds, dust and molecules in the atmosphere that can block the view from ground level.',
    'TV signals only travel in straight lines.',
  ].join(' '),
};

// Human-authored public-domain excerpts from Federal Register notices 2020-27581 and 2020-26070 respectively.
const aprilNotice = 'For Comments: Comments must be received no later than April 5, 2021.';
const februaryNotice = 'DATES: Comments and related material must be received by the Coast Guard on or before February 3, 2021.';
const federalRegister: WritingSource = {
  title: 'Federal Register',
  text: [aprilNotice, februaryNotice].join('\n'),
};

describe('extractive explanations', () => {
  it('fills only the categories supported by the source and leaves missing categories empty', () => {
    const [{ sections }] = explain([satellite], { language: 'en' });
    expect(Object.keys(sections)).toEqual(explanationSections);
    expect(sections.definition[0]?.text).toBe('A satellite is a moon, planet or machine that orbits a planet or star.');
    expect(sections.how).toEqual([]);
    expect(sections.why[0]?.text).toMatch(/^That’s because satellites fly/u);
    expect(sections.example[0]?.text).toBe('For example, Earth is a satellite because it orbits the sun.');
    expect(sections.limits[0]?.text).toBe('TV signals only travel in straight lines.');
    assertLiteral(Object.values(sections).flat());
  });

  it('quotes bilingual evidence for mechanisms and supports more evidence when asked for detail', () => {
    const rainbow = publicPages.find(page => page.id === 'page-ar-rainbow')!;
    const waterCycle = publicPages.find(page => page.id === 'page-en-water-cycle')!;
    const [arabic] = explain([rainbow], { language: 'ar', topic: rainbow.title });
    const [english] = explain([waterCycle], { language: 'en', topic: waterCycle.title, detailed: true });
    expect(arabic.sections.definition[0]?.text).toContain('ظاهرة طبيعية فيزيائية');
    expect(arabic.sections.how[0]?.text).toContain('ينكسر ضوء الشمس الساقط');
    expect(english.sections.how).toHaveLength(2);
    expect(english.sections.how[0]?.text).toContain('exchange of energy');
    assertLiteral([arabic, english].flatMap(group => Object.values(group.sections).flat()));
  });

  it('keeps comparison subjects tied to their own evidence even when one is mentioned by the other', () => {
    const earth = publicPages.find(page => page.id === 'page-en-earth')!;
    const eclipse = publicPages.find(page => page.id === 'page-en-solar-eclipse')!;
    const subjects = [earth.title, eclipse.title];
    const [first, second] = explain([eclipse, earth], { language: 'en', subjects });
    expect(first.subject).toBe(earth.title);
    expect(first.sections.definition[0]?.source).toBe(earth);
    expect(second.subject).toBe(eclipse.title);
    expect(second.sections.definition[0]?.source).toBe(eclipse);
    assertLiteral([first, second].flatMap(group => Object.values(group.sections).flat()));
    expect(explain([eclipse], { language: 'en', subjects })[0]?.sections.definition).toEqual([]);
  });
});

describe('extractive restructuring', () => {
  it('keeps the existing heading and literal list items when converting to paragraph groups', () => {
    const agenda = userTexts.find(entry => entry.id === 'user-ar-meeting-agenda')!;
    const { groups } = restructure(agenda, { format: 'paragraph' });
    const table = groups.find(group => group.heading?.text === 'جدول العمل')!;
    expect(table.spans.map(span => span.text)).toEqual(agenda.text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)));
    assertLiteral([table.heading!, ...table.spans]);
  });

  it('changes a paragraph into sentence-sized bullets with a heading drawn from that block', () => {
    const { groups } = restructure(satellite, { format: 'bullets', headings: true });
    expect(groups).toHaveLength(1);
    const [{ heading, spans }] = groups;
    expect(heading?.text).toBe('A satellite is a moon, planet');
    expect(spans).toHaveLength(4);
    expect(spans.map(span => span.text).join(' ')).toBe(satellite.text);
    assertLiteral([heading!, ...spans]);
  });

  it('sorts by date in either direction and keeps items with no date last', () => {
    const undated = satellite.text.slice(0, satellite.text.indexOf('.') + 1);
    const source = { ...federalRegister, text: [federalRegister.text, undated].join('\n') };
    const ascending = restructure(source, { format: 'bullets', chronological: 'ascending' }).groups[0]!.spans;
    const descending = restructure(source, { format: 'bullets', chronological: 'descending' }).groups[0]!.spans;
    expect(ascending.map(span => span.text)).toEqual([februaryNotice, aprilNotice, undated]);
    expect(descending.map(span => span.text)).toEqual([aprilNotice, februaryNotice, undated]);
    assertLiteral([...ascending, ...descending]);
  });

  it('extracts action sentences and explicit date spans in both languages', () => {
    const english = restructure(federalRegister, { format: 'bullets', extract: 'both' });
    expect(english.actions.map(span => span.text)).toEqual([aprilNotice, februaryNotice]);
    expect(english.dates.map(span => span.text)).toEqual(['April 5, 2021', 'February 3, 2021']);
    const vote = userTexts.find(entry => entry.id === 'user-ar-photo-vote')!;
    const arabic = restructure(vote, { format: 'bullets', extract: 'both' });
    expect(arabic.actions[0]?.text).toMatch(/^يجب أن يكون لدى المستخدم حساب مسجل/u);
    expect(arabic.dates.map(span => span.text)).toEqual(['١.١.٢٠١٣', '١.١.٢٠١٣', '30 يناير 2013']);
    assertLiteral([...english.actions, ...english.dates, ...arabic.actions, ...arabic.dates]);
  });

  it('keeps both written month names and recognizes dates joined by the Arabic conjunction', () => {
    const deadlines = userTexts.find(entry => entry.id === 'user-ar-survey-deadlines')!;
    const { dates } = restructure(deadlines, { format: 'bullets', extract: 'dates' });
    expect(dates.map(span => span.text)).toEqual(['اليوم', '20 نوفمبر/تشرين الثاني', '28 نوفمبر/تشرين الثاني', '12 ديسمبر/كانون الأول']);
    assertLiteral(dates);
  });

  it('orders recurring month/day dates when no calendar years are given', () => {
    const election = userTexts.find(entry => entry.id === 'user-ar-committee-election')!;
    const dated = sentenceSpans(election).filter(span => /14 سبتمبر|11 أكتوبر|الأول من نوفمبر/u.test(span.text));
    const source = { ...election, text: dated.toReversed().map(span => span.text).join('\n') };
    const ordered = restructure(source, { format: 'bullets', chronological: 'ascending' }).groups[0]!.spans;
    expect(ordered.map(span => span.text)).toEqual(dated.map(span => span.text));
    assertLiteral(ordered);
  });

  it('extracts open checklist items and skips checked items', () => {
    const source = { ...federalRegister, text: `- [x] ${aprilNotice}\n- [ ] ${februaryNotice}` };
    const result = restructure(source, { format: 'bullets', extract: 'actions' });
    expect(result.groups).toEqual([]);
    expect(result.dates).toEqual([]);
    expect(result.actions.map(span => span.text)).toEqual([`[ ] ${februaryNotice}`]);
    assertLiteral(result.actions);
  });
});
