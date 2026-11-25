import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';
import { calendarCases } from './fixtures/reasoning-calendar.js';
import { comparisonCases } from './fixtures/reasoning-comparison.js';
import { currencyCases } from './fixtures/reasoning-currency.js';
import { developmentNow, type DevelopmentCase } from './fixtures/reasoning-development.js';
import { numberWordCases } from './fixtures/reasoning-number-words.js';
import { wordProblemCases } from './fixtures/reasoning-word-problems.js';

/**
 * Deterministic development checks only. The fixtures use executable numeric
 * enumeration and fixed reference values, with no model or API in the data
 * generation or evaluation path. These fixtures are excluded from training.
 */
const cases = [...comparisonCases, ...calendarCases, ...currencyCases, ...wordProblemCases, ...numberWordCases];
type Mode = 'before' | 'after';
const results = { before: new Map<string, ReturnType<typeof score>>(), after: new Map<string, ReturnType<typeof score>>() };

function score(test: DevelopmentCase) {
  const reply = evaluateLocalComputation(test.request, developmentNow, test.options);
  const status = reply?.status ?? 'unhandled';
  const value = reply?.evidence.find(item => item.id === REASONING_VALUE_ID || item.id === 'calculation')?.value ?? null;
  return { status, value, exact: status === (test.status ?? (test.expected === null ? 'blocked' : 'completed'))
    && value === test.expected };
}

beforeAll(() => {
  for (const [mode, flag] of [['before', '0'], ['after', '1']] as const) {
    vi.stubEnv('MOHASSAN_REASONING', flag);
    for (const test of cases) results[mode].set(test.id, score(test));
  }
});

afterAll(() => vi.unstubAllEnvs());

it('reports exact development accuracy with the flag off and on', () => {
  const categories = new Set(cases.map(test => test.category));
  const answerCount = cases.filter(test => test.expected !== null).length;
  expect(answerCount).toBeGreaterThanOrEqual(300);
  expect(new Set(cases.map(test => test.id)).size).toBe(cases.length);
  console.info(`${answerCount} exact-value cases and ${cases.length - answerCount} gap cases`);
  for (const category of categories) {
    const group = cases.filter(test => test.category === category);
    const measure = (set: DevelopmentCase[], mode: Mode) => set.filter(test => results[mode].get(test.id)?.exact).length;
    const ar = group.filter(test => /\p{Script=Arabic}/u.test(test.request));
    const en = group.filter(test => !ar.includes(test));
    const report = (set: DevelopmentCase[]) => `${measure(set, 'before')}/${set.length} → ${measure(set, 'after')}/${set.length}`;
    console.info(`${category} ${report(group)} (ar ${report(ar)}, en ${report(en)})`);
  }
});

it.each(cases)('$id returns an exact value or the expected gap', test => {
  const result = results.after.get(test.id);
  expect(result, test.request).toMatchObject({
    status: test.status ?? (test.expected === null ? 'blocked' : 'completed'),
    value: test.expected,
  });
});
