import { describe, expect, it } from 'vitest';
import { joinPieces, keepLegible } from './read-image.js';

describe('reading a whole image', () => {
  it('drops unsure lines on a legible image and keeps a hard image best-effort', () => {
    const page = [0.99, 0.97, 0.95, 0.62, 0.41, 0.88].map((confidence, id) => ({ id, confidence }));
    expect(keepLegible(page, 0.7).map(line => line.id)).toEqual([0, 1, 2, 5]);
    const hard = [0.85, 0.62, 0.41].map((confidence, id) => ({ id, confidence }));
    expect(keepLegible(hard, 0.7).map(line => line.id)).toEqual([0, 1, 2]);
  });
  it('joins the pieces of a long line with a space only at word spaces', () => {
    expect(joinPieces(['the quick bro', 'wn fox'], [{}, {}])).toBe('the quick brown fox');
    expect(joinPieces(['the quick', 'brown fox'], [{}, { spaceBefore: true }])).toBe('the quick brown fox');
  });
});
