import { expect, it } from 'vitest';
import { overlap, wordCount, wordSet, type WritingSource } from '../apps/server/src/assistant/writing/evidence.js';
import { summaryTarget, summarize, type WritingFormat } from '../apps/server/src/assistant/writing/summary.js';
import pages from './fixtures/extractive-writing/public-pages.json';
import userTexts from './fixtures/extractive-writing/user-texts.json';

const corpora = { pages, userTexts };
const formats: WritingFormat[] = ['line', 'paragraph', 'bullets', 'detailed'];

it('measures the premarked facts, overlapping pairs and length on all 50 archived excerpts', () => {
  const reports = [];
  for (const [corpus, fixtures] of Object.entries(corpora)) {
    for (const language of ['ar', 'en']) {
      for (const format of formats) {
        const rows = fixtures.filter(fixture => fixture.language === language);
        const target = summaryTarget(format);
        let coveredFacts = 0, markedFacts = 0, redundantPairs = 0, pairs = 0, withinBudget = 0, filled = 0;
        for (const fixture of rows) {
          expect(fixture.trainingAllowed).toBe(false);
          const source: WritingSource = {
            title: corpus === 'pages' ? fixture.title : language === 'ar' ? 'النص المرسل' : 'Supplied text',
            text: fixture.text,
            url: fixture.url,
          };
          const selected = summarize([source], format);
          expect(selected.length, fixture.id).toBeGreaterThan(0);
          for (const span of selected) {
            expect(span.source).toBe(source);
            expect(span.text).toBe(source.text.slice(span.start, span.end));
          }
          for (const fact of fixture.keyFacts) {
            expect(fixture.text).toContain(fact);
            markedFacts++;
            if (selected.some(span => span.text.includes(fact))) coveredFacts++;
          }
          const words = selected.map(span => wordSet(span.text));
          for (const [index, left] of words.entries()) {
            for (const right of words.slice(index + 1)) {
              pairs++;
              if (overlap(left, right) >= 0.65) redundantPairs++;
            }
          }
          const totalWords = selected.reduce((sum, span) => sum + wordCount(span.text), 0);
          const totalCharacters = selected.reduce((sum, span) => sum + span.text.length, 0);
          if (selected.length <= target.sentences && totalWords <= target.words && totalCharacters <= target.characters) withinBudget++;
          if (selected.length === target.sentences) filled++;
        }
        expect(withinBudget).toBe(rows.length);
        reports.push({ corpus, language, format, facts: `${coveredFacts}/${markedFacts}`, similarPairs: `${redundantPairs}/${pairs}`,
          withinBudget: `${withinBudget}/${rows.length}`, filled: `${filled}/${rows.length}` });
      }
    }
  }
  expect(pages).toHaveLength(30);
  expect(userTexts).toHaveLength(20);
  expect(new Set([...pages, ...userTexts].map(fixture => fixture.url)).size).toBe(50);
  console.table(reports);
});
