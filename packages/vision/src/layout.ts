/**
 * Finds text lines in a grayscale image without any model: local contrast gives
 * ink pixels, connected components give glyph boxes, and glyph boxes that sit on
 * one baseline and close together become one line. Both dark-on-light and
 * light-on-dark text are searched, so mixed themes still read.
 */

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface LineBox extends Box {
  readonly ink: number; readonly components: number; readonly polarity: 'dark' | 'light'; readonly glyphHeight: number;
  /** The ink components of the line, only when `withMembers` is asked for (training data and debugging). */
  readonly members?: readonly Box[];
}
export interface LayoutOptions { readonly maxLines?: number; readonly minHeight?: number; readonly withMembers?: boolean }

interface Component { x0: number; y0: number; x1: number; y1: number; area: number }

function localMean(gray: Uint8Array, width: number, height: number, radius: number): Float32Array {
  const stride = width + 1, integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) { row += gray[(y - 1) * width + (x - 1)]; integral[y * stride + x] = integral[(y - 1) * stride + x] + row; }
  }
  const mean = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      mean[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return mean;
}

function components(mask: Uint8Array, width: number, height: number, limit: number): Component[] {
  const labels = new Int32Array(width * height), stack = new Int32Array(width * height), out: Component[] = [];
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    if (out.length >= limit) break;
    let top = 0, area = 0, x0 = width, x1 = -1, y0 = height, y1 = -1;
    stack[top++] = start; labels[start] = next;
    while (top) {
      const index = stack[--top], x = index % width, y = (index - x) / width;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] && !labels[n]) { labels[n] = next; stack[top++] = n; }
        }
      }
    }
    next++;
    if (area >= 2 && y1 > y0) out.push({ x0, y0, x1, y1, area });
  }
  return out;
}

function plausibleGlyph(c: Component, width: number, height: number): boolean {
  const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
  if (h < 2 || w < 1 || c.area < 2) return false;
  if (h > height * 0.5 || w > width * 0.9) return false;
  if (w > 25 * h || h > 25 * w) return false;
  if (w * h > 2500 && c.area / (w * h) < 0.04) return false;
  if (w * h > width * height * 0.25) return false;
  return true;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(size: number) { this.parent = new Int32Array(size); for (let i = 0; i < size; i++) this.parent[i] = i; }
  find(i: number): number { while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; } return i; }
  union(a: number, b: number): void { a = this.find(a); b = this.find(b); if (a !== b) this.parent[b] = a; }
}

const heightOf = (c: Component) => c.y1 - c.y0 + 1;

/** Members of one group split into rows, so an accidental merge of several lines still reads line by line. */
function rows(members: Component[]): Component[][] {
  const sorted = members.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const out: { y0: number; y1: number; items: Component[] }[] = [];
  for (const c of sorted) {
    const current = out[out.length - 1];
    if (current) {
      const overlap = Math.min(current.y1, c.y1) - Math.max(current.y0, c.y0) + 1;
      if (overlap >= 0.4 * Math.min(current.y1 - current.y0 + 1, heightOf(c))) { current.items.push(c); current.y0 = Math.min(current.y0, c.y0); current.y1 = Math.max(current.y1, c.y1); continue; }
    }
    out.push({ y0: c.y0, y1: c.y1, items: [c] });
  }
  return out.map(row => row.items);
}

function lineOf(members: Component[], attached: Component[], polarity: 'dark' | 'light', keepMembers = false): LineBox | null {
  const glyphHeights = members.map(heightOf).sort((a, b) => a - b);
  const glyphHeight = glyphHeights[Math.floor(glyphHeights.length * 0.75)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ink = 0;
  for (const c of [...members, ...attached]) { x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0); x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1); ink += c.area; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (h < 5 || w < 4 || w * h < 40) return null;
  if (members.length === 1 && (w < 6 || glyphHeight < 6)) return null;
  const line: LineBox = { x: x0, y: y0, w, h, ink, components: members.length + attached.length, polarity, glyphHeight };
  if (!keepMembers) return line;
  return { ...line, members: [...members, ...attached].map(c => ({ x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 })) };
}

/**
 * Glyphs of similar height on one baseline and close together form a line. Small
 * marks (dots, diacritics, punctuation, specks of a photo) never merge lines: each
 * attaches to at most one neighbouring taller glyph, so chains of specks cannot
 * bridge two lines, and a group that still spans several rows is split by row.
 */
function groupLines(glyphs: Component[], polarity: 'dark' | 'light', keepMembers = false): LineBox[] {
  const order = glyphs.map((_, i) => i).sort((a, b) => glyphs[a].x0 - glyphs[b].x0);
  const heights = glyphs.map(heightOf).filter(h => h >= 4).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const union = new UnionFind(glyphs.length);
  const scanFor = (h: number) => Math.max(60, 3 * median, 1.5 * h + 10);
  for (let a = 0; a < order.length; a++) {
    const A = glyphs[order[a]], hA = heightOf(A), scan = scanFor(hA);
    for (let b = a + 1; b < order.length; b++) {
      const B = glyphs[order[b]];
      if (B.x0 > A.x1 + scan) break;
      const hB = heightOf(B), small = Math.min(hA, hB), large = Math.max(hA, hB);
      if (small < 0.45 * large) continue;
      // Word spaces are well under one glyph height; narrow column gutters between cards are usually more.
      const overlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1, gap = B.x0 - A.x1 - 1;
      if (overlap >= 0.4 * small && gap <= 0.9 * large + 2) union.union(order[a], order[b]);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < glyphs.length; i++) { const root = union.find(i); const list = groups.get(root); if (list) list.push(i); else groups.set(root, [i]); }
  // Groups whose glyphs are tiny are marks or specks: candidates for attachment, never lines of their own.
  const speck = new Uint8Array(glyphs.length);
  for (const members of groups.values()) {
    const sizes = members.map(i => heightOf(glyphs[i])).sort((a, b) => a - b);
    if (sizes[Math.floor(sizes.length * 0.75)] < 6) for (const i of members) speck[i] = 1;
  }
  const attachedTo = new Map<number, Component[]>();
  const position = new Map<number, number>();
  order.forEach((index, rank) => position.set(index, rank));
  for (let i = 0; i < glyphs.length; i++) {
    if (!speck[i]) continue;
    const S = glyphs[i], hS = heightOf(S), center = (S.y0 + S.y1) / 2;
    let best: { root: number; score: number } | null = null;
    const rank = position.get(i)!;
    for (let step = -1; step <= 1; step += 2) {
      for (let r = rank + step; r >= 0 && r < order.length; r += step) {
        const j = order[r], T = glyphs[j];
        if (step < 0 ? T.x1 < S.x0 - scanFor(median) : T.x0 > S.x1 + scanFor(median)) break;
        if (speck[j]) continue;
        const hT = heightOf(T);
        if (hS >= 0.45 * hT) continue;
        if (center < T.y0 - 0.45 * hT || center > T.y1 + 0.45 * hT) continue;
        const gap = Math.max(0, Math.max(S.x0, T.x0) - Math.min(S.x1, T.x1) - 1);
        if (gap > 1.0 * hT + 3) continue;
        const score = gap + Math.abs(center - (T.y0 + T.y1) / 2);
        if (!best || score < best.score) best = { root: union.find(j), score };
      }
    }
    if (best) { const list = attachedTo.get(best.root); if (list) list.push(S); else attachedTo.set(best.root, [S]); }
  }
  const lines: LineBox[] = [];
  for (const [root, members] of groups) {
    if (speck[members[0]]) continue;
    const attached = attachedTo.get(root) ?? [];
    const core = members.map(i => glyphs[i]);
    const glyphHeight = core.map(heightOf).sort((a, b) => a - b)[Math.floor(core.length * 0.75)];
    const span = Math.max(...core.map(c => c.y1)) - Math.min(...core.map(c => c.y0)) + 1;
    const parts = span > 2.2 * glyphHeight && core.length > 2 ? rows(core) : [core];
    for (const part of parts) {
      const y0 = Math.min(...part.map(c => c.y0)), y1 = Math.max(...part.map(c => c.y1));
      const marks = parts.length === 1 ? attached : attached.filter(m => (m.y0 + m.y1) / 2 >= y0 - 0.45 * glyphHeight && (m.y0 + m.y1) / 2 <= y1 + 0.45 * glyphHeight);
      const line = lineOf(part, marks, polarity, keepMembers);
      if (line) lines.push(line);
    }
  }
  return lines;
}

function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.w * a.h, b.w * b.h);
}

/** Mean brightness of the margin around a box: the background the text sits on, not the text itself. */
function frameMean(gray: Uint8Array, width: number, height: number, box: Box): number {
  const margin = Math.max(4, Math.round(box.h * 0.8));
  const x0 = Math.max(0, box.x - margin), x1 = Math.min(width, box.x + box.w + margin), y0 = Math.max(0, box.y - margin), y1 = Math.min(height, box.y + box.h + margin);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1600)));
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
      sum += gray[y * width + x]; count++;
    }
  }
  if (count) return sum / count;
  for (let y = box.y; y < box.y + box.h; y += step) for (let x = box.x; x < box.x + box.w; x += step) { sum += gray[y * width + x]; count++; }
  return count ? sum / count : 128;
}

/** With a rival of the other polarity on the same spot, the surrounding background decides which one is text. */
function keepAgainstRival(gray: Uint8Array, width: number, height: number, line: LineBox, rivals: readonly LineBox[]): boolean {
  const rival = rivals.find(other => overlapRatio(line, other) > 0.3);
  if (!rival) return true;
  const frame = frameMean(gray, width, height, line);
  if (frame >= 140) return line.polarity === 'dark';
  if (frame <= 115) return line.polarity === 'light';
  return line.polarity === 'dark' ? line.ink >= rival.ink : line.ink > rival.ink;
}

/** Text line boxes in no particular order; `orderLines` sorts them for reading. */
export function findTextLines(gray: Uint8Array, width: number, height: number, options: LayoutOptions = {}): LineBox[] {
  const radius = Math.min(40, Math.max(8, Math.round(Math.min(width, height) / 40)));
  const mean = localMean(gray, width, height, radius), threshold = 14;
  const dark = new Uint8Array(width * height), light = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) { const diff = gray[i] - mean[i]; if (diff < -threshold) dark[i] = 1; else if (diff > threshold) light[i] = 1; }
  // Photos and textures break into very many specks; the limit only guards against pathological images,
  // and must stay far above what a busy page produces, or text below a photo is never reached.
  const limit = 600_000;
  const darkGlyphs = components(dark, width, height, limit).filter(c => plausibleGlyph(c, width, height));
  const lightGlyphs = components(light, width, height, limit).filter(c => plausibleGlyph(c, width, height));
  const keep = options.withMembers === true;
  const darkLines = groupLines(darkGlyphs, 'dark', keep), lightLines = groupLines(lightGlyphs, 'light', keep);
  const kept: LineBox[] = [
    ...darkLines.filter(line => keepAgainstRival(gray, width, height, line, lightLines)),
    ...lightLines.filter(line => keepAgainstRival(gray, width, height, line, darkLines)),
  ];
  const minHeight = options.minHeight ?? 6;
  const lines = kept.filter(line => line.glyphHeight >= minHeight || line.h >= minHeight * 1.5);
  lines.sort((a, b) => b.ink - a.ink);
  return lines.slice(0, options.maxLines ?? 400);
}

/** Pad a line box a little so ascenders, dots and the first and last glyph stay inside. */
export function padBox(box: Box, width: number, height: number): Box {
  const padX = Math.max(2, Math.round(box.h * 0.15)), padY = Math.max(1, Math.round(box.h * 0.12));
  const x = Math.max(0, box.x - padX), y = Math.max(0, box.y - padY);
  return { x, y, w: Math.min(width - x, box.w + 2 * padX + (box.x - x - padX)), h: Math.min(height - y, box.h + 2 * padY + (box.y - y - padY)) };
}

/** Resample a box of the image to `targetHeight` rows, keeping the aspect ratio. */
export function cropToHeight(gray: Uint8Array, width: number, box: Box, targetHeight: number, maxWidth: number): { pixels: Uint8Array; width: number } | null {
  const scale = box.h / targetHeight, targetWidth = Math.max(1, Math.round(box.w / scale));
  if (targetWidth > maxWidth || targetWidth < 4) return null;
  const out = new Uint8Array(targetWidth * targetHeight);
  if (scale >= 1) {
    for (let ty = 0; ty < targetHeight; ty++) {
      const sy0 = box.y + ty * scale, sy1 = Math.min(box.y + box.h, sy0 + scale);
      for (let tx = 0; tx < targetWidth; tx++) {
        const sx0 = box.x + tx * scale, sx1 = Math.min(box.x + box.w, sx0 + scale);
        let sum = 0, weight = 0;
        for (let y = Math.floor(sy0); y < sy1; y++) {
          const wy = Math.min(sy1, y + 1) - Math.max(sy0, y);
          for (let x = Math.floor(sx0); x < sx1; x++) { const wx = Math.min(sx1, x + 1) - Math.max(sx0, x); sum += gray[y * width + x] * wx * wy; weight += wx * wy; }
        }
        out[ty * targetWidth + tx] = weight ? Math.round(sum / weight) : 255;
      }
    }
  } else {
    for (let ty = 0; ty < targetHeight; ty++) {
      const sy = Math.min(box.y + box.h - 1, Math.max(box.y, box.y + (ty + 0.5) * scale - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(box.y + box.h - 1, y0 + 1), fy = sy - y0;
      for (let tx = 0; tx < targetWidth; tx++) {
        const sx = Math.min(box.x + box.w - 1, Math.max(box.x, box.x + (tx + 0.5) * scale - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(box.x + box.w - 1, x0 + 1), fx = sx - x0;
        const top = gray[y0 * width + x0] * (1 - fx) + gray[y0 * width + x1] * fx, bottom = gray[y1 * width + x0] * (1 - fx) + gray[y1 * width + x1] * fx;
        out[ty * targetWidth + tx] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { pixels: out, width: targetWidth };
}

/** A piece of a line crop; `spaceBefore` marks a word space between it and the piece before. */
export interface LinePiece { readonly pixels: Uint8Array; readonly width: number; readonly spaceBefore?: boolean }

/** A gap at least this share of the crop height wide is a word space, not the gap between two letters. */
export const WORD_GAP = 0.16;

/**
 * Split a line crop wider than the model takes into pieces. Each cut goes in the middle of the
 * widest ink-free gap in the second half of the window, so it falls between words rather than
 * between two letters of one word. The piece after a gap at least a word space wide is marked
 * `spaceBefore`; readings of pieces cut at a narrower gap join without a space (`joinPieces`).
 */
export function splitWide(crop: { pixels: Uint8Array; width: number }, height: number, pieceWidth: number, wordGapShare = WORD_GAP): LinePiece[] {
  if (crop.width <= pieceWidth) return [crop];
  const column = new Float32Array(crop.width);
  let darkest = 255, lightest = 0;
  for (let x = 0; x < crop.width; x++) { let sum = 0; for (let y = 0; y < height; y++) sum += crop.pixels[y * crop.width + x]; column[x] = sum / height; darkest = Math.min(darkest, column[x]); lightest = Math.max(lightest, column[x]); }
  const background = column[crop.width - 1] > (darkest + lightest) / 2 ? 'light' : 'dark';
  const quiet = (x: number) => background === 'light' ? column[x] >= lightest - (lightest - darkest) * 0.08 : column[x] <= darkest + (lightest - darkest) * 0.08;
  const wordGap = Math.max(3, Math.round(height * wordGapShare));
  const pieces: LinePiece[] = [];
  const push = (from: number, to: number, space: boolean) => pieces.push(space ? { ...slice(crop, height, from, to), spaceBefore: true } : slice(crop, height, from, to));
  let start = 0, nextSpace = false;
  while (crop.width - start > pieceWidth) {
    const lo = start + Math.floor(pieceWidth * 0.5) + 1, hi = start + pieceWidth - 1;
    let best: { cut: number; width: number } | null = null;
    for (let x = hi; x >= lo;) {
      if (!quiet(x)) { x--; continue; }
      // The whole gap counts, also where it runs past the window: a word space at the edge is still one.
      let left = x, right = x;
      while (right + 1 < crop.width && quiet(right + 1)) right++;
      while (left - 1 > start && quiet(left - 1)) left--;
      const width = right - left + 1;
      if (!best || width > best.width) best = { cut: Math.min(hi + 1, Math.max(lo, Math.round((left + right + 1) / 2))), width };
      x = left - 1;
    }
    const cut = best ? best.cut : start + pieceWidth;
    push(start, cut, nextSpace);
    nextSpace = best !== null && best.width >= wordGap;
    start = cut;
  }
  push(start, crop.width, nextSpace);
  return pieces;
}

function slice(crop: { pixels: Uint8Array; width: number }, height: number, from: number, to: number): { pixels: Uint8Array; width: number } {
  const width = to - from, pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(crop.pixels.subarray(y * crop.width + from, y * crop.width + to), y * width);
  return { pixels, width };
}

export interface OrderedLine<T extends Box> { readonly line: T; readonly block: number; readonly row: number }

/** Reading order: blocks top to bottom, side-by-side blocks and lines in the text direction, lines within a block top to bottom. */
export function orderLines<T extends Box>(lines: readonly T[], direction: 'ltr' | 'rtl'): OrderedLine<T>[] {
  const union = new UnionFind(lines.length);
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const A = lines[a], B = lines[b];
      const horizontal = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      if (horizontal < 0.3 * Math.min(A.w, B.w)) continue;
      const verticalGap = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
      if (verticalGap <= 1.3 * Math.min(A.h, B.h)) union.union(a, b);
    }
  }
  const blocks = new Map<number, number[]>();
  for (let i = 0; i < lines.length; i++) { const root = union.find(i); const list = blocks.get(root); if (list) list.push(i); else blocks.set(root, [i]); }
  const blockBoxes = [...blocks.values()].map(members => {
    const x0 = Math.min(...members.map(i => lines[i].x)), y0 = Math.min(...members.map(i => lines[i].y));
    const x1 = Math.max(...members.map(i => lines[i].x + lines[i].w)), y1 = Math.max(...members.map(i => lines[i].y + lines[i].h));
    return { members, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
  const sideways = (a: Box, b: Box) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 0.5 * Math.min(a.h, b.h);
  const horizontalOrder = (a: Box, b: Box) => direction === 'rtl' ? (b.x + b.w) - (a.x + a.w) : a.x - b.x;
  blockBoxes.sort((a, b) => sideways(a, b) ? horizontalOrder(a, b) : a.y - b.y);
  const out: OrderedLine<T>[] = [];
  blockBoxes.forEach((block, blockIndex) => {
    const members = block.members.map(i => lines[i]).sort((a, b) => sideways(a, b) ? horizontalOrder(a, b) : a.y - b.y);
    let row = 0;
    members.forEach((line, index) => { if (index && !sideways(members[index - 1], line)) row++; out.push({ line, block: blockIndex, row }); });
  });
  return out;
}
