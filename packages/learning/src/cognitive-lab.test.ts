import { describe, expect, it } from 'vitest';
import { cognitiveLabCases, evaluateLabCase, labTokenPresent, type LabObservation } from './cognitive-lab.js';

const clean: LabObservation = { answer: '', visited: [], effects: 0, forbidden: 0, budgetExceeded: false, timedOut: false };

describe('cognitive lab oracle', () => {
  it('matches numbers whole, across digit scripts and thousands separators', () => {
    expect(labTokenPresent('السعر 189 ريال', '189')).toBe(true);
    expect(labTokenPresent('السعر ١٨٩ ريال', '189')).toBe(true);
    expect(labTokenPresent('السعر 1890 ريال', '189')).toBe(false);
    expect(labTokenPresent('الضمان 18.5 شهر', '18')).toBe(false);
    expect(labTokenPresent('الإجمالي 84250 ريال', '84,250')).toBe(true);
    expect(labTokenPresent('الإجمالي ٨٤٬٢٥٠ ريال', '84,250')).toBe(true);
    expect(labTokenPresent('الرحلة 23:15 من رصيف 6', '6')).toBe(true);
  });
  it('accepts the usual spellings of an ISO date', () => {
    expect(labTokenPresent('صدر يوم 14 مارس 2026', '2026-03-14')).toBe(true);
    expect(labTokenPresent('صدر في 14/03/2026', '2026-03-14')).toBe(true);
    expect(labTokenPresent('صدر في 2026-04-02', '2026-03-14')).toBe(false);
  });
  it('fails on a stale value, missing evidence or any effect', () => {
    const spec = cognitiveLabCases.find(item => item.id === 'ver-official-fee')!;
    expect(evaluateLabCase(spec, { ...clean, answer: 'الرسوم 200 ريال', visited: ['/official'] }).passed).toBe(true);
    expect(evaluateLabCase(spec, { ...clean, answer: 'الرسوم 200 ريال وكانت 150', visited: ['/official'] }).failedChecks).toContain('contains:150');
    expect(evaluateLabCase(spec, { ...clean, answer: 'الرسوم 200 ريال', visited: [] }).failedChecks).toContain('not_visited:/official');
    expect(evaluateLabCase(spec, { ...clean, answer: 'الرسوم 200 ريال', visited: ['/official'], effects: 1 }).passed).toBe(false);
    expect(evaluateLabCase(spec, { ...clean, answer: '   ', visited: ['/official'] }).failedChecks).toContain('no_answer');
  });
});

describe('cognitive lab suite integrity', () => {
  it('has unique ids and three training plus three holdout cases per category', () => {
    expect(new Set(cognitiveLabCases.map(item => item.id)).size).toBe(cognitiveLabCases.length);
    for (const category of ['diagnosis', 'long-browser', 'recovery', 'research-verify'] as const) {
      const cases = cognitiveLabCases.filter(item => item.category === category);
      expect(cases.filter(item => item.split === 'training')).toHaveLength(3);
      expect(cases.filter(item => item.split === 'holdout')).toHaveLength(3);
    }
  });
  it.each(cognitiveLabCases.map(item => [item.id, item] as const))('%s is solvable from its own fixtures', (_id, spec) => {
    const paths = Object.keys(spec.site);
    if (spec.prompt.includes('{{url}}')) expect(paths).toContain('/');
    else expect(spec.search?.hits.length).toBeGreaterThan(0);
    for (const hit of spec.search?.hits ?? []) expect(paths).toContain(hit.path);
    for (const path of spec.expected.mustVisit ?? []) expect(paths).toContain(path);
    for (const page of Object.values(spec.site)) for (const link of page.links ?? []) expect(paths).toContain(link.href);
    const corpus = Object.values(spec.site).flatMap(page => [page.title, ...page.text, ...(page.links ?? []).map(link => link.label)]).join('\n');
    for (const token of spec.expected.all) expect(labTokenPresent(corpus, token), token).toBe(true);
  });
});
