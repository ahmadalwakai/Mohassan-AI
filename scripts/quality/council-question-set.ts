import { createHash } from 'node:crypto';

/** Frozen questions and answer criteria from council-questions.ts at 29448ae (retrieved 2026-11-27).
 * https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/quality/council-questions.ts
 */
export const QUESTIONS: { id: string; text: string; expected: RegExp; fact: string }[] = [
  { id: 'd1', text: 'متى سقط جدار برلين؟', expected: /1989|١٩٨٩/u, fact: '1989' },
  { id: 'd2', text: 'متى تأسست جامعة الدول العربية؟', expected: /1945|١٩٤٥/u, fact: '1945' },
  { id: 'd3', text: 'متى بدأت الحرب العالمية الثانية؟', expected: /1939|١٩٣٩/u, fact: '1939' },
  { id: 'd4', text: 'متى انتهت الحرب العالمية الأولى؟', expected: /1918|١٩١٨/u, fact: '1918' },
  { id: 'd5', text: 'متى استقلت الجزائر؟', expected: /1962|١٩٦٢/u, fact: '1962' },
  { id: 'd6', text: 'متى ولد نجيب محفوظ؟', expected: /1911|١٩١١/u, fact: '1911' },
  { id: 'e1', text: 'When did the Berlin Wall fall?', expected: /1989/u, fact: '1989' },
  { id: 'e2', text: 'When was the United Nations founded?', expected: /1945/u, fact: '1945' },
  { id: 'e3', text: 'When did World War II end?', expected: /1945/u, fact: '1945' },
  { id: 'p1', text: 'How many people live in Japan?', expected: /\b12[2-6](?:[.,]\d+)?\s*million|\b12[2-6],\d{3},\d{3}\b/iu, fact: '122–126 million' },
  { id: 'p2', text: 'How many people live in Egypt?', expected: /\b(?:10[4-9]|11\d)(?:[.,]\d+)?\s*million|\b(?:10[4-9]|11\d),\d{3},\d{3}\b/iu, fact: '104–119 million' },
  { id: 'p3', text: 'What is the population of France?', expected: /\b6[6-9](?:[.,]\d+)?\s*million|\b6[6-9],\d{3},\d{3}\b/iu, fact: '66–69 million' },
];

export const setSha256 = createHash('sha256').update(JSON.stringify(QUESTIONS.map(({ id, text }) => ({ id, text })))).digest('hex');
export const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
// The live council and date scripts measured Wikipedia HTTP 429s and use this spacing between questions.
export const LIVE_QUESTION_SPACING_MS = 8_000;
