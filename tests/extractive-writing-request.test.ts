import { expect, it } from 'vitest';
import { parseExtractiveWriting } from '../apps/server/src/assistant/writing/request.js';
import pages from './fixtures/extractive-writing/public-pages.json';
import userTexts from './fixtures/extractive-writing/user-texts.json';

const moon = pages.find(item => item.id === 'page-ar-moon')!;
const eclipse = pages.find(item => item.id === 'page-en-solar-eclipse')!;
// These bodies come from the human-authored, verification-only fixture corpus.
const letter = userTexts.find(item => item.id === 'user-en-austen-8')!;
const checklist = userTexts.find(item => item.id === 'user-ar-work-checklist')!;

it('keeps an explicit presentation outside the subject and prefers it over source wording', () => {
  expect(parseExtractiveWriting('How does photosynthesis work in detail?')).toMatchObject({
    source: { kind: 'search', query: 'photosynthesis' }, topic: 'photosynthesis', format: 'detailed',
  });
  expect(parseExtractiveWriting('Explain how photosynthesis works briefly')).toMatchObject({ topic: 'photosynthesis', format: 'line' });
  expect(parseExtractiveWriting('What is the difference between photosynthesis and solar eclipse in bullets?')).toMatchObject({
    kind: 'comparison', subjects: ['photosynthesis', 'solar eclipse'], format: 'bullets',
  });
  expect(parseExtractiveWriting(`Summarize these bullet points in one paragraph: ${checklist.text}`)).toMatchObject({
    kind: 'summary', format: 'paragraph', source: { kind: 'paste', text: checklist.text },
  });
  expect(parseExtractiveWriting(`Summarize this text in two points: ${letter.text}`)).toMatchObject({ format: 'bullets', count: 2 });
});

it('binds bare process follow-ups to recent reads in Arabic and English', () => {
  for (const request of ['How does it work?', 'كيف يَعمَل؟']) {
    expect(parseExtractiveWriting(request)).toMatchObject({ kind: 'explanation', source: { kind: 'page', recent: true, all: false } });
  }
  expect(parseExtractiveWriting('How does photosynthesis work on this page?')).toMatchObject({
    kind: 'explanation', topic: 'photosynthesis', source: { kind: 'page', recent: false },
  });
});

it('keeps source address and PDF wrappers out of tool arguments', () => {
  expect(parseExtractiveWriting(`Summarize (${moon.url}).`)?.source).toEqual({ kind: 'urls', urls: [moon.url] });
  expect(parseExtractiveWriting(`Summarize these links: "${moon.url}" and "${eclipse.url}"`)?.source)
    .toEqual({ kind: 'urls', urls: [moon.url, eclipse.url] });
  expect(parseExtractiveWriting('Summarize the PDF: «Moon facts.pdf»')?.source)
    .toEqual({ kind: 'pdf', paths: ['Moon facts.pdf'], all: false });
  expect(parseExtractiveWriting('لخّص ملف PDF: تقرير.pdf')?.source)
    .toEqual({ kind: 'pdf', paths: ['تقرير.pdf'], all: false });
});

it('treats explicitly quoted or multi-sentence prose as local text and keeps original offsets', () => {
  for (const [prefix, body, suffix] of [
    ['Explain this phrase “', letter.keyFacts[0], '” briefly.'],
    ['Explain the following sentence “', checklist.text, '”.'],
    ['Explain «', letter.text, '»'],
    ['اشرح العبارة التالية «', eclipse.url, '».'],
  ]) {
    const request = prefix + body + suffix;
    const task = parseExtractiveWriting(request);
    expect(task?.source).toEqual({ kind: 'paste', text: body, offset: prefix.length });
    expect(request.slice(prefix.length, prefix.length + body.length)).toBe(body);
  }
  expect(parseExtractiveWriting(`Explain “solar eclipse” using ${eclipse.url}`)).toMatchObject({
    topic: 'solar eclipse', source: { kind: 'urls', urls: [eclipse.url] },
  });
});

it('preserves original routes for unrelated actions and topics without a text operand', () => {
  for (const request of [
    'Order a pizza', 'Order a pizza: large', 'Sort the products by price', 'List dates for upcoming climate conferences',
    'How did the bridge collapse?', 'Compare current flight prices from London to Rome', 'كيف أشغل المتصفح؟',
    'How do you work?', 'Explain how you work', 'اشرح نفسك',
    `Summarize these notes and email them: ${letter.text}`,
  ]) expect(parseExtractiveWriting(request), request).toBeNull();
  expect(parseExtractiveWriting('Summarize my last report')?.source).toEqual({ kind: 'missing' });
  expect(parseExtractiveWriting(`Sort my notes by date: ${letter.text}`)).toMatchObject({
    kind: 'restructure', structure: { chronological: 'ascending' }, source: { kind: 'paste', text: letter.text },
  });
});
