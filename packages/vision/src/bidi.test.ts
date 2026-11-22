import { describe, expect, it } from 'vitest';
import { detectBase, toLogical, toVisual } from './bidi.js';

// The same cases as scripts/vision/charset.py's self-test; both sides must agree.
const CASES: [string, 'L' | 'R', string][] = [
  ['مرحبا 123 world', 'R', 'world 123 ابحرم'],
  ['السعر 150 ريال', 'R', 'لاير 150 رعسلا'],
  ['Hello مرحبا', 'L', 'Hello ابحرم'],
  ['hello مرحبا 150', 'L', 'hello 150 ابحرم'],
  ['(تجريبي)', 'R', '(يبيرجت)'],
  ['Price: 12.5%', 'L', 'Price: 12.5%'],
  ['نسبة 12.5% فقط', 'R', 'طقف 12.5% ةبسن'],
  ['تاريخ 22/11/2026', 'R', '22/11/2026 خيرات'],
  ['ABC-123', 'L', 'ABC-123'],
  ['٢٠٢٦ عام', 'R', 'ماع ٢٠٢٦'],
  ['مرحبا، كيف الحال؟', 'R', '؟لاحلا فيك ،ابحرم'],
];

describe('bidi visual order', () => {
  it('matches the Python renderer on the shared cases', () => {
    for (const [logical, base, visual] of CASES) expect(toVisual(logical, base), logical).toBe(visual);
  });
  it('recovers a logical string that draws the same', () => {
    for (const [logical, base, visual] of CASES) {
      const back = toLogical(visual, base);
      expect(toVisual(back, base), logical).toBe(visual);
    }
  });
  it('detects the base direction by letter majority', () => {
    expect(detectBase('مرحبا world')).toBe('R');
    expect(detectBase('hello there يا')).toBe('L');
    expect(detectBase('12345')).toBe('L');
  });
  it('leaves pure Latin and pure Arabic lines consistent', () => {
    expect(toVisual('The quick brown fox')).toBe('The quick brown fox');
    expect(toLogical(toVisual('قراءة الصور من الصفر'))).toBe('قراءة الصور من الصفر');
  });
});
