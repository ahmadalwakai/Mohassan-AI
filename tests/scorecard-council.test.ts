import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { councilCorrect, readCouncilCases } from '../scripts/scorecard/council-cases.js';

describe('council suite reference', () => {
  it('reads named cases without running the referenced script', async () => {
    const published = await readFile(new URL('../scripts/quality/council-questions.ts', import.meta.url), 'utf8');
    const cases = readCouncilCases(published);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.map(item => item.language)).toEqual(expect.arrayContaining(['ar', 'en']));
    expect(cases.map(item => item.id)).toHaveLength(new Set(cases.map(item => item.id)).size);
  });

  it('preserves language, regular expression flags and the first answer line', () => {
    const [ar, en] = readCouncilCases(`const QUESTIONS = [
      { id: 'arabic', text: 'اذكر اللون', expected: /أخضر/u },
      { id: 'english', text: 'Name the colour', expected: /green/iu },
    ]; throw new Error('must never be executed');`);
    expect(ar?.language).toBe('ar');
    expect(en?.language).toBe('en');
    expect(councilCorrect(en!.expected, '\n GREEN \nSource')).toBe(true);
    expect(councilCorrect(en!.expected, 'Missing answer.\nGreen')).toBe(false);
    expect(councilCorrect(en!.expected, null)).toBe(false);
  });

  it('rejects expressions and duplicate case IDs', () => {
    expect(() => readCouncilCases('const QUESTIONS = loadQuestions();')).toThrow();
    const row = `{ id: 'repeat', text: 'What colour?', expected: /green/ }`;
    expect(() => readCouncilCases(`const QUESTIONS = [${row}, ${row}];`)).toThrow();
  });
});
