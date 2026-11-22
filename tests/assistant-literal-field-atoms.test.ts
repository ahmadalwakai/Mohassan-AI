import { describe, expect, it } from 'vitest';
import { assessRecallCoverage, extractRecallFactAtoms } from '../apps/server/src/assistant/mind/recall-coverage.js';
import { evaluateLocalRecall } from '../apps/server/src/assistant/local-recall.js';

describe('bounded literal quantity/day atoms preserve the whole original source and field identity', () => {
  it('extracts exact numeric and weekday spans from another subject without manufacturing a quote', () => {
    const quote = 'عدد صناديق شحنة ميناء الصباح 27 وتاريخ تسليمها الأحد';
    const result = extractRecallFactAtoms(quote);
    expect(result.kind).toBe('atoms');
    expect(result.atoms.map(atom => [atom.property, atom.value])).toEqual([['quantity', '27'], ['date', 'الأحد']]);
    for (const atom of result.atoms) expect(quote.slice(atom.valueSpan.start, atom.valueSpan.end)).toBe(atom.value);
  });
  it('supports a single literal count without treating its value as a date', async () => {
    const result = await evaluateLocalRecall('من ذاكرتي، أعد كمية صناديق شحنة ميناء الصباح فقط.', {
      memory: async () => ['عدد صناديق شحنة ميناء الصباح 27'],
    }, new AbortController().signal);
    expect(result?.status).toBe('completed'); expect(result?.text).toBe('27');
  });
  it('requires literal assertions rather than negated or conditional noun-label prefixes', () => {
    for (const predicate of ['ليس', 'ليست', 'لا', 'لم', 'لن', 'إِذَا نجح الفحص', 'ربما']) {
      expect(extractRecallFactAtoms(`عدد صناديق شحنة ميناء الصباح ${predicate} 27 وموعد تسليمها الأحد`).kind).toBe('unsupported');
    }
  });
  it('does not inherit a day belonging to a different explicitly named delivery', () => {
    expect(extractRecallFactAtoms('عدد صناديق شحنة ميناء الصباح 27 وموعد تسليم شحنة ميناء المساء الأحد').kind).toBe('unsupported');
  });
  it('does not treat the temporal modifier اليوم as a separately requested date field', () => {
    expect(assessRecallCoverage('ما مدينتي المفضلة في ذاكرتي اليوم؟', [{ quote: 'مدينتي المفضلة هي مسقط', source: 'memory' }]))
      .toMatchObject({ status: 'complete', requestedProperties: ['city'] });
  });
  it('rejects source qualifiers after an otherwise complete pair', () => {
    expect(extractRecallFactAtoms('عدد صناديق شحنة ميناء الصباح 27 وموعد تسليمها الأحد فقط إذا نجح الفحص').kind).toBe('unsupported');
  });
});
