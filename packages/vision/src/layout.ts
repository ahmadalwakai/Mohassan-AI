/**
 * Finds text lines in a grayscale image without any model: local contrast gives
 * ink pixels, connected components give glyph boxes, and glyph boxes that sit on
 * one baseline and close together become one line. Both dark-on-light and
 * light-on-dark text are searched, so mixed themes still read.
 */

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface LineBox extends Box { readonly ink: number; readonly components: number; readonly polarity: 'dark' | 'light'; readonly glyphHeight: number }
export interface LayoutOptions { readonly maxLines?: number; readonly minHeight?: number }

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
    out.push({ x0, y0, x1, y1, area });
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

function groupLines(glyphs: Component[], polarity: 'dark' | 'light'): LineBox[] {
  const order = glyphs.map((_, i) => i).sort((a, b) => glyphs[a].x0 - glyphs[b].x0);
  const heights = glyphs.map(c => c.y1 - c.y0 + 1).filter(h => h >= 4).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const union = new UnionFind(glyphs.length);
  for (let a = 0; a < order.length; a++) {
    const A = glyphs[order[a]], hA = A.y1 - A.y0 + 1;
    const scan = Math.max(60, 3 * median, 1.5 * hA + 10);
    for (let b = a + 1; b < order.length; b++) {
      const B = glyphs[order[b]];
      if (B.x0 > A.x1 + scan) break;
      const hB = B.y1 - B.y0 + 1, gap = B.x0 - A.x1 - 1;
      const overlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1;
      const small = Math.min(hA, hB), large = Math.max(hA, hB);
      if (small >= 0.45 * large) {
        if (overlap >= 0.4 * small && gap <= 1.2 * large + 3) union.union(order[a], order[b]);
      } else {
        // Dots, marks and punctuation attach to a neighbouring taller glyph.
        const tall = hA >= hB ? A : B, short = hA >= hB ? B : A, center = (short.y0 + short.y1) / 2;
        if (center >= tall.y0 - 0.45 * large && center <= tall.y1 + 0.45 * large && gap <= 1.0 * large + 3) union.union(order[a], order[b]);
      }
    }
  }
  const groups = new Map<number, Component[]>();
  for (let i = 0; i < glyphs.length; i++) { const root = union.find(i); const list = groups.get(root); if (list) list.push(glyphs[i]); else groups.set(root, [glyphs[i]]); }
  const lines: LineBox[] = [];
  for (const members of groups.values()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ink = 0;
    const glyphHeights: number[] = [];
    for (const c of members) { x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0); x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1); ink += c.area; glyphHeights.push(c.y1 - c.y0 + 1); }
    glyphHeights.sort((a, b) => a - b);
    const glyphHeight = glyphHeights[Math.floor(glyphHeights.length * 0.75)];
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (h < 5 || w < 4 || w * h < 40) continue;
    if (members.length === 1 && (w < 6 || glyphHeight < 6)) continue;
    lines.push({ x: x0, y: y0, w, h, ink, components: members.length, polarity, glyphHeight });
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
  const limit = 60_000;
  const darkGlyphs = components(dark, width, height, limit).filter(c => plausibleGlyph(c, width, height));
  const lightGlyphs = components(light, width, height, limit).filter(c => plausibleGlyph(c, width, height));
  const darkLines = groupLines(darkGlyphs, 'dark'), lightLines = groupLines(lightGlyphs, 'light');
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

/** Columns with no ink, used to split a very long line into pieces the model can take. */
export function splitWide(crop: { pixels: Uint8Array; width: number }, height: number, pieceWidth: number): { pixels: Uint8Array; width: number }[] {
  if (crop.width <= pieceWidth) return [crop];
  const column = new Float32Array(crop.width);
  let darkest = 255, lightest = 0;
  for (let x = 0; x < crop.width; x++) { let sum = 0; for (let y = 0; y < height; y++) sum += crop.pixels[y * crop.width + x]; column[x] = sum / height; darkest = Math.min(darkest, column[x]); lightest = Math.max(lightest, column[x]); }
  const background = column[crop.width - 1] > (darkest + lightest) / 2 ? 'light' : 'dark';
  const quiet = (x: number) => background === 'light' ? column[x] >= lightest - (lightest - darkest) * 0.08 : column[x] <= darkest + (lightest - darkest) * 0.08;
  const pieces: { pixels: Uint8Array; width: number }[] = [];
  let start = 0;
  while (crop.width - start > pieceWidth) {
    let cut = -1;
    for (let x = start + pieceWidth - 1; x > start + pieceWidth * 0.5; x--) if (quiet(x)) { cut = x; break; }
    if (cut < 0) cut = start + pieceWidth;
    pieces.push(slice(crop, height, start, cut));
    start = cut;
  }
  pieces.push(slice(crop, height, start, crop.width));
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
