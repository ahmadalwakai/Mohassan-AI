import { parseExchangeRateTable } from '../../apps/server/src/assistant/reasoning/currency.js';
import type { DevelopmentCase } from './reasoning-development.js';

export const currencyDevelopmentTable = parseExchangeRateTable({
  asOf: '2025-02-20', source: 'Development fixture', base: 'EUR',
  rates: { USD: '1.25', GBP: '0.8', SAR: '5', EGP: '50', JPY: '160', KWD: '0.3125' },
});

// Development evaluation only. The loops enumerate exact rational examples locally.
const conversions = [
  { name: 'en-base', request: (n: number) => `Convert ${n * 4} EUR to USD`, expected: (n: number) => n * 5 },
  { name: 'en-cross', request: (n: number) => `How much is ${n * 5} US dollars in pounds sterling?`, expected: (n: number) => n * 32 / 10 },
  { name: 'ar-standard', request: (n: number) => `حوّل ${n * 4} يورو إلى دولار أمريكي`, expected: (n: number) => n * 5 },
  { name: 'ar-egyptian', request: (n: number) => `${n} دولار بكام بالجنيه المصري؟`, expected: (n: number) => n * 40 },
  { name: 'ar-gulf', request: (n: number) => `كم يسوي ${n} دولار بالريال السعودي؟`, expected: (n: number) => n * 4 },
  { name: 'ar-levantine', request: (n: number) => `قديش ${n * 5} ريال سعودي بالين؟`, expected: (n: number) => n * 160 },
];

export const currencyCases: readonly DevelopmentCase[] = conversions.flatMap(({ name, request, expected }) =>
  Array.from({ length: 11 }, (_, index): DevelopmentCase => ({
    id: `currency-${name}-${index + 1}`, category: 'currency', request: request(index + 1),
    expected: String(expected(index + 1)), options: { rates: currencyDevelopmentTable },
  })));
