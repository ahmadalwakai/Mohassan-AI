import { describe, expect, it } from 'vitest';
import { cropToHeight, findTextLines, orderLines, splitWide } from './layout.js';

/** A page with "glyph" rectangles laid out as lines, dark on light. */
function page(width: number, height: number, lines: { y: number; x: number; glyphs: number; glyphW?: number; glyphH?: number; gap?: number; color?: number }[], background = 240): Uint8Array {
  const gray = new Uint8Array(width * height).fill(background);
  for (const line of lines) {
    const glyphW = line.glyphW ?? 8, glyphH = line.glyphH ?? 14, gap = line.gap ?? 4;
    for (let g = 0; g < line.glyphs; g++) {
      const x0 = line.x + g * (glyphW + gap);
      for (let y = line.y; y < line.y + glyphH; y++) for (let x = x0; x < x0 + glyphW; x++) if (x < width && y < height) gray[y * width + x] = line.color ?? 20;
    }
  }
  return gray;
}

describe('text line layout', () => {
  it('finds separate lines and keeps words together', () => {
    const gray = page(400, 200, [
      { y: 20, x: 20, glyphs: 12 },
      { y: 60, x: 20, glyphs: 6 },
      { y: 60, x: 20 + 6 * 12 + 10, glyphs: 5 }, // a word space inside the same line
      { y: 120, x: 200, glyphs: 8 },
    ]);
    const lines = findTextLines(gray, 400, 200);
    expect(lines).toHaveLength(3);
    const byTop = lines.slice().sort((a, b) => a.y - b.y);
    expect(byTop[0].components).toBe(12);
    expect(byTop[1].components).toBe(11);
    expect(byTop[1].w).toBeGreaterThan(6 * 12 + 5 * 12);
    expect(byTop.every(line => line.polarity === 'dark')).toBe(true);
  });
  it('reads light text on a dark background and ignores a full-width rule', () => {
    const gray = page(300, 120, [{ y: 30, x: 30, glyphs: 10, color: 235 }], 30);
    for (let x = 0; x < 300; x++) gray[90 * 300 + x] = 200;
    const lines = findTextLines(gray, 300, 120);
    expect(lines).toHaveLength(1);
    expect(lines[0].polarity).toBe('light');
    expect(lines[0].components).toBe(10);
  });
  it('orders blocks top to bottom and side-by-side lines in the text direction', () => {
    const lines = [
      { x: 200, y: 10, w: 80, h: 12, id: 'right-top' },
      { x: 10, y: 10, w: 80, h: 12, id: 'left-top' },
      { x: 10, y: 60, w: 80, h: 12, id: 'left-bottom' },
    ];
    const ltr = orderLines(lines, 'ltr').map(entry => entry.line.id);
    expect(ltr).toEqual(['left-top', 'right-top', 'left-bottom']);
    const rtl = orderLines(lines, 'rtl').map(entry => entry.line.id);
    expect(rtl).toEqual(['right-top', 'left-top', 'left-bottom']);
  });
  it('resamples a box to 32 rows and splits very wide crops at quiet columns', () => {
    const gray = page(2000, 60, [{ y: 10, x: 10, glyphs: 120, glyphW: 10, glyphH: 20, gap: 6 }]);
    const crop = cropToHeight(gray, 2000, { x: 0, y: 5, w: 2000, h: 30 }, 32, 4096)!;
    expect(crop.width).toBe(Math.round(2000 / (30 / 32)));
    const pieces = splitWide(crop, 32, 800);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((sum, piece) => sum + piece.width, 0)).toBe(crop.width);
    for (const piece of pieces) expect(piece.width).toBeLessThanOrEqual(800);
  });
});
