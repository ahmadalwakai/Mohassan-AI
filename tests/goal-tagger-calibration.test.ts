import { describe, expect, it } from 'vitest';
import { chooseThreshold } from '../scripts/ads-training/calibrate-goal-tagger.js';

const decisions = (count: number, confidence: number, correct = true, valid = true) =>
  Array.from({ length: count }, () => ({ confidence, correct, valid }));

describe('development-only goal confidence calibration', () => {
  it('chooses the greatest coverage that meets precision and both sample floors', () => {
    const rows = [...decisions(150, 0.99), ...decisions(50, 0.9), ...decisions(50, 0.5, false)];
    expect(chooseThreshold(rows)).toMatchObject({ status: 'passed', threshold: 0.9,
      accepted: 200, correct: 200, precision: 1, coverage: 0.8, rows: 250 });
  });

  it('never splits a confidence tie to exclude the wrong member', () => {
    const rows = [...decisions(100, 0.99), ...decisions(1, 0.99, false), ...decisions(24, 0.8)];
    const forward = chooseThreshold(rows), reverse = chooseThreshold([...rows].reverse());
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ status: 'failed', threshold: 0.8, accepted: 125, correct: 124, coverage: 1 });
    expect(forward.precision).toBe(124 / 125);
  });

  it('uses all development rows in coverage even when some cannot be accepted', () => {
    const exactFloor = chooseThreshold([...decisions(100, 0.97), ...decisions(25, 1, false, false)]);
    expect(exactFloor).toMatchObject({ status: 'passed', accepted: 100, coverage: 0.8 });
    const belowFloor = chooseThreshold([...decisions(100, 0.97), ...decisions(26, 1, false, false)]);
    expect(belowFloor).toMatchObject({ status: 'failed', accepted: 100, precision: 1, rows: 126 });
    expect(belowFloor.coverage).toBe(100 / 126);
  });

  it('does not declare success from fewer than 100 accepted cases', () => {
    expect(chooseThreshold(decisions(99, 0.99))).toMatchObject({ status: 'failed', accepted: 99, precision: 1, coverage: 1 });
    expect(chooseThreshold(decisions(100, 0.99))).toMatchObject({ status: 'passed', accepted: 100, precision: 1, coverage: 1 });
  });

  it('reports failure at useful coverage instead of manufacturing precision by rejecting most rows', () => {
    const result = chooseThreshold([...decisions(100, 0.99), ...decisions(100, 0.8, false)]);
    expect(result).toMatchObject({ status: 'failed', threshold: 0.8, accepted: 200, correct: 100, precision: 0.5, coverage: 1 });
  });

  it('reports empty and wholly invalid development data as failure', () => {
    for (const rows of [[], decisions(100, 0.99, true, false)]) {
      expect(chooseThreshold(rows)).toMatchObject({ status: 'failed', accepted: 0, correct: 0, precision: 0, coverage: 0 });
    }
  });
});
