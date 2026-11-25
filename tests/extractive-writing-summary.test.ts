import { describe, expect, it } from 'vitest';
import {
  exactOrRedundant, numericTerms, sentenceSpans, wordCount, type WritingSource,
} from '../apps/server/src/assistant/writing/evidence.js';
import { summarize, summaryTarget, type WritingFormat } from '../apps/server/src/assistant/writing/summary.js';

// Human-authored public excerpts for tests only. The tests rearrange these excerpts or alter
// typography for boundary cases. They are never used as model training data.
const constitution = 'https://www.archives.gov/founding-docs/constitution-transcript';
const executive = 'The executive Power shall be vested in a President of the United States of America.';
const courts = 'The judicial Power of the United States, shall be vested in one supreme Court, and in such inferior Courts as the Congress may from time to time ordain and establish.';
const representatives = 'The House of Representatives shall chuse their Speaker and other Officers; and shall have the sole Power of Impeachment.';
const billOfRights = 'https://www.archives.gov/founding-docs/bill-of-rights-transcript';
const amendment = 'The right of the people to be secure in their persons, houses, papers, and effects, against unreasonable searches and seizures, shall not be violated, and no Warrants shall issue, but upon probable cause, supported by Oath or affirmation, and particularly describing the place to be searched, and the persons or things to be seized.';
const nasa = 'https://science.nasa.gov/moon/facts/';
const distance = 'The Moon is an average of 238,855 miles (384,400 kilometers) away.';
const orbit = 'The Moon makes a complete orbit around Earth in 27 Earth days and rotates or spins at that same rate, or in that same amount of time.';
const illumination = 'As the Moon orbits Earth, different parts are in sunlight or darkness at different times.';
const alignment = 'That means 30 Earth-sized planets could fit in between Earth and the Moon.';
// Arabic Wikipedia contributors, CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/
const calligraphyPage = 'https://ar.wikipedia.org/w/index.php?title=%D8%AE%D8%B7_%D8%B9%D8%B1%D8%A8%D9%8A&oldid=56221065';
const calligraphy = 'الخط العربي هو فن وتصميم الكتابة في مختلف اللغات التي تستعمل الحروف العربية.';
const letterforms = 'تتميز الكتابة العربية بكونها متصلة مما يجعلها قابلة لاكتساب أشكال هندسية مختلفة من خلال المد والرجع والاستدارة والتزوية والتشابك والتداخل والتركيب.';
const ornament = 'يقترن فن الخط بالزخرفة العربية حيث يستعمل لتزيين المساجد والقصور، كما أنه يستعمل في تحلية المخطوطات والكتب وخاصة نسخ القرآن الكريم.';

const source = (text: string, title = '', url?: string): WritingSource => ({ title, text, url });

describe('extractive writing evidence', () => {
  it('keeps the exact publisher text and UTF-16 ranges across Arabic, English, list markers and line endings', () => {
    const input = source(`  ${distance}\r\n١. ${calligraphy}  ${letterforms}\n- ${orbit}   `);
    const spans = sentenceSpans(input);
    expect(spans.map(span => span.text)).toEqual([distance, `١. ${calligraphy}`, letterforms, `- ${orbit}`]);
    expect(spans.every(span => span.source === input && input.text.slice(span.start, span.end) === span.text)).toBe(true);
  });

  it('normalizes digits only for matching and keeps differing values and polarity', () => {
    const arabicDigits = distance.replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]).replace(/,/gu, '٬');
    expect(numericTerms(arabicDigits)).toEqual(['238,855', '384,400']);
    expect(exactOrRedundant(distance, arabicDigits)).toBe(true);
    expect(exactOrRedundant(distance, distance.replace('average ', ''))).toBe(true);
    expect(exactOrRedundant(distance, distance.replace('238,855', '384,400'))).toBe(false);
    expect(exactOrRedundant(distance, distance.replace('238,855', '−238,855'))).toBe(false);
    expect(exactOrRedundant(distance, distance.replace('is', 'is not'))).toBe(false);
  });

  it('rejoins physical PDF wraps for segmentation while retaining line breaks inside the cited span', () => {
    const wrapped = distance.replace('miles (', 'miles\r\n(');
    const input: WritingSource = {
      ...source(`${wrapped}\n\n${illumination}\n${orbit}\n- ${alignment}`, 'Moon Facts'),
      layout: 'pdf',
    };
    const spans = sentenceSpans(input);
    expect(spans.map(span => span.text)).toEqual([wrapped, illumination, orbit, `- ${alignment}`]);
    expect(spans.every(span => span.source.text.slice(span.start, span.end) === span.text)).toBe(true);
    expect(sentenceSpans({ ...input, layout: undefined })[0]?.text).toBe(wrapped.split('\r\n')[0]);
  });
});

describe('extractive summaries', () => {
  it('weighs lead position and a matching title independently of word overlap', () => {
    const text = `${executive} ${courts}`;
    expect(summarize([source(text, '', constitution)], 'line').map(span => span.text)).toEqual([executive]);
    expect(summarize([source(text, 'Judicial Power', constitution)], 'line').map(span => span.text)).toEqual([courts]);
  });

  it('raises a central sentence above unrelated lead text and favors numbers in otherwise equal candidates', () => {
    const text = `${executive} ${orbit} ${illumination} ${alignment}`;
    expect(summarize([source(text)], 'line').map(span => span.text)).toEqual([orbit]);
    expect(summarize([source(executive, '', constitution), source(distance, '', nasa)], 'line').map(span => span.text)).toEqual([distance]);
  });

  it('removes repeated sentences across sources while retaining distinct numbers and both source origins', () => {
    const humanSources = [
      source(`${distance} ${orbit}`, 'Moon Facts', nasa),
      source(`${distance.toUpperCase()} ${executive} ${representatives}`, 'Constitution', constitution),
    ];
    const spans = summarize(humanSources, 'bullets');
    expect(spans.map(span => span.text)).toEqual([distance, orbit, executive, representatives]);
    expect(spans.map(span => span.source.url)).toEqual([nasa, nasa, constitution, constitution]);
    expect(spans.every(span => span.source.text.slice(span.start, span.end) === span.text)).toBe(true);
  });

  it.each<WritingFormat>(['line', 'paragraph', 'bullets', 'detailed', 'table'])('honors the %s target without cutting a quote', format => {
    const humanSources = [
      source(`${calligraphy}\n${letterforms}\n${ornament}`, 'خط عربي', calligraphyPage),
      source(`${distance} ${orbit} ${illumination} ${alignment}`, 'Moon Facts', nasa),
    ];
    const spans = summarize(humanSources, format);
    const target = summaryTarget(format);
    expect(spans).toHaveLength(Math.min(7, target.sentences));
    expect(spans.reduce((total, span) => total + wordCount(span.text), 0)).toBeLessThanOrEqual(target.words);
    expect(spans.reduce((total, span) => total + span.text.length, 0)).toBeLessThanOrEqual(target.characters);
    expect(spans.every(span => span.source.text.slice(span.start, span.end) === span.text)).toBe(true);
  });

  it('honors an explicit count and skips a sentence that cannot fit the one-line budget', () => {
    expect(summarize([source(`${executive} ${courts} ${representatives}`, '', constitution)], 'bullets', 2)).toHaveLength(2);
    expect(summarize([source(amendment, '', billOfRights)], 'line')).toEqual([]);
    expect(summarize([source(amendment, '', billOfRights)], 'paragraph').map(span => span.text)).toEqual([amendment]);
  });
});
