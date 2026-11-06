import { describe, expect, it } from 'vitest';
import { safeRelative } from './security.ts';

describe('Windows reserved device names at the shared file boundary', () => {
  // Pure validation only: no serial device is opened by this regression suite.
  it.each(['COM¹', 'COM².txt', 'COM³.json', 'LPT¹', 'LPT².txt', 'LPT³.json', 'reports/com¹.txt', 'lpt²/results.txt'])('rejects %s before filesystem access', path => {
    expect(() => safeRelative(path)).toThrow(expect.objectContaining({code: 'UNSAFE_PATH'}));
  });
  it('preserves ordinary Unicode filenames that are not device aliases', () => {
    expect(safeRelative('تقارير/تقرير¹.txt')).toBe('تقارير/تقرير¹.txt');
    expect(safeRelative('reports/comparison.txt')).toBe('reports/comparison.txt');
  });
});
