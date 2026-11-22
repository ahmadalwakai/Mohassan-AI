/**
 * Turn captured screenshots into labelled line crops, using exactly the reader's own pipeline.
 *
 *   npx tsx scripts/vision/match-lines.ts --captures artifacts/vision-real-v1/captures --out artifacts/vision-real-v1/lines [--part 0/4]
 *
 * Each screenshot goes through decodeImage → findTextLines → padBox → cropToHeight → splitWide,
 * as in packages/vision/src/read-image.ts, so the model trains on the crops it will see. A crop is
 * kept only when the page's own characters explain it: every glyph-sized ink component touches a
 * visible character box, every visible letter touches ink, no character is cut at the edges, the
 * characters sit on one row, and none comes from an element that cannot be trusted (faint, icon
 * font, ellipsis, transformed). The line's ink must also fit its text: tall enough for the
 * font size (not the counter of a bold letter or an underline), on the same row as the
 * characters' boxes (not a light-polarity band between two rows), and of the polarity the
 * crop's own background implies. A text run the crop cuts through (the next character of the
 * same text node touches ours but lies outside) means the ink and the browser's boxes disagree
 * there, so the label could be short; such a line is dropped too. Training screenshots are also re-encoded as JPEG and as a
 * downscaled JPEG, the way shared screenshots look. Labels are built in build_real_shards.py.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropToHeight, decodeImage, findTextLines, padBox, splitWide, type Box } from '../../packages/vision/src/index.ts';

/** Bot-check and block pages (same pattern as capture-lines.ts): not the site's content, never used. */
const BOT_CHECK = /just a moment|لحظة…|attention required|access denied|are you a robot|captcha|verify you are human|security check/iu;

const HEIGHT = 32, MAX_WIDTH = 1024, PIECE_WIDTH = 896;
const UNTRUSTED = new Set(['faint', 'icon-font', 'ellipsis', 'transform', 'vertical', 'tiny', 'transformed']);
const PUNCT = new Set([...'.,:;\'"`·•‐-–—_،؛!¡?؟|/\\()[]{}«»']);
const SPACE = /^\s$/u;

type Char = [node: number, offset: number, ch: string, l: number, t: number, r: number, b: number, element: number, visible: number];
type Element = [rtl: number, size: number, letterCase: number, skip: string, family: string, weight: string];
interface Capture { id: string; url: string; site: string; lang: string; split: string; variant: string; dpr: number; viewport: [number, number]; png: string; chars: Char[]; elements: Element[]; generated?: boolean; title?: string }
interface PlacedChar { order: number; ch: string; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; element: Element; space: boolean }

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const hashInt = (text: string) => parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16);
const intersects = (a: { x0: number; y0: number; x1: number; y1: number }, b: Box, margin = 0) =>
  a.x0 - margin < b.x + b.w && a.x1 + margin > b.x && a.y0 - margin < b.y + b.h && a.y1 + margin > b.y;
const median = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };

/** True when the box's background (its median pixel) sits on the side the line's polarity says it should. */
function polarityFits(gray: Uint8Array, width: number, box: Box, polarity: 'dark' | 'light'): boolean {
  const values: number[] = [];
  const x0 = Math.max(0, Math.floor(box.x)), x1 = Math.min(width, Math.ceil(box.x + box.w));
  const rows = gray.length / width;
  const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(rows, Math.ceil(box.y + box.h));
  const step = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0)) / 4000));
  for (let i = 0, y = y0; y < y1; y++) for (let x = x0; x < x1; x++, i++) if (i % step === 0) values.push(gray[y * width + x]);
  if (values.length < 4) return false;
  values.sort((a, b) => a - b);
  const low = values[Math.floor(values.length * 0.1)], high = values[Math.floor(values.length * 0.9)], middle = values[Math.floor(values.length / 2)];
  if (high - low < 24) return false;
  return polarity === 'dark' ? middle > (low + high) / 2 : middle < (low + high) / 2;
}

async function variantsOf(capture: Capture, png: Buffer): Promise<{ name: string; bytes: Buffer }[]> {
  const out = [{ name: 'clean', bytes: png }];
  if (capture.split !== 'train') return out;
  const h = hashInt(capture.id);
  out.push({ name: 'jpeg', bytes: await sharp(png).jpeg({ quality: 35 + (h % 50) }).toBuffer() });
  const meta = await sharp(png).metadata();
  if (h % 3 === 0 && meta.width) out.push({ name: 'small', bytes: await sharp(png).resize({ width: Math.round(meta.width * 0.75) }).jpeg({ quality: 55 + (h % 35) }).toBuffer() });
  return out;
}

async function matchOne(capture: Capture, bytes: Buffer) {
  const image = await decodeImage(new Uint8Array(bytes));
  const scale = image.width / capture.viewport[0];
  const placed: PlacedChar[] = [];
  for (const c of capture.chars) {
    if (!c[8]) continue;
    const element = capture.elements[c[7]];
    if (!element || element[3] === 'hidden') continue;
    const x0 = c[3] * scale, y0 = c[4] * scale, x1 = c[5] * scale, y1 = c[6] * scale;
    placed.push({ order: c[0] * 100000 + c[1], ch: c[2], x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, element, space: SPACE.test(c[2]) });
  }
  const lines = findTextLines(image.gray, image.width, image.height, { maxLines: 400, withMembers: true });
  const reasons: Record<string, number> = {};
  const reject = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const pieces: { o: number; w: number; line: number; piece: number; of: number; base: string; size: number; box: number[]; chars: [number, string, number, number, number, number][] }[] = [];
  const pixels: Buffer[] = [];
  let offset = 0;
  lines.forEach((line, lineIndex) => {
    const box = padBox(line, image.width, image.height);
    const inside = (c: PlacedChar) => c.cx >= box.x && c.cx < box.x + box.w && c.cy >= box.y && c.cy < box.y + box.h;
    const own = placed.filter(inside);
    const letters = own.filter(c => !c.space);
    if (!letters.length) { reject('no-chars'); return; }
    const untrusted = letters.find(c => UNTRUSTED.has(c.element[3]));
    if (untrusted) { reject(`style-${untrusted.element[3]}`); return; }
    const heights = letters.map(c => c.y1 - c.y0);
    const rowHeight = median(heights);
    if (Math.max(...letters.map(c => c.cy)) - Math.min(...letters.map(c => c.cy)) > 0.6 * rowHeight) { reject('multi-row'); return; }
    const size = median(letters.map(c => c.element[1])) * scale;
    if (line.h < 0.35 * size) { reject('ink-small'); return; }
    const top = Math.min(...letters.map(c => c.y0)), bottom = Math.max(...letters.map(c => c.y1));
    if (Math.min(bottom, line.y + line.h) - Math.max(top, line.y) < 0.75 * line.h) { reject('off-row'); return; }
    if (!polarityFits(image.gray, image.width, box, line.polarity)) { reject('polarity'); return; }
    const nodes = new Set(letters.map(c => Math.floor(c.order / 100000)));
    const cutRun = placed.some(c => !c.space && !inside(c) && nodes.has(Math.floor(c.order / 100000)) && c.cy >= box.y && c.cy < box.y + box.h
      && letters.some(o => Math.max(c.x0 - o.x1, o.x0 - c.x1) < 0.2 * size));
    if (cutRun) { reject('cut-run'); return; }
    // A glyph cut by the crop's left or right edge.
    const cut = placed.some(c => !c.space && !inside(c) && c.cy >= box.y && c.cy < box.y + box.h
      && Math.min(c.x1, box.x + box.w) - Math.max(c.x0, box.x) > 0.3 * (c.x1 - c.x0));
    if (cut) { reject('partial-char'); return; }
    const members = line.members ?? [];
    const glyphSized = (m: Box) => m.h >= Math.max(3, 0.35 * line.glyphHeight) || m.w >= 0.5 * line.glyphHeight;
    if (members.some(m => glyphSized(m) && !letters.some(c => intersects(c, m, 1)))) { reject('unlabeled-ink'); return; }
    if (letters.some(c => !PUNCT.has(c.ch) && !members.some(m => intersects(c, m, 0)))) { reject('missing-ink'); return; }
    const crop = cropToHeight(image.gray, image.width, box, HEIGHT, MAX_WIDTH * 8);
    if (!crop) { reject('crop'); return; }
    const parts = splitWide(crop, HEIGHT, PIECE_WIDTH);
    const step = box.h / HEIGHT;
    const rtlShare = letters.filter(c => c.element[0] === 1).length / letters.length;
    let column = 0;
    parts.forEach((part, partIndex) => {
      const start = column; column += part.width;
      if (part.width < 8 || part.width > MAX_WIDTH) { reject('piece-width'); return; }
      const px0 = box.x + start * step, px1 = box.x + column * step;
      const mine = own.filter(c => c.cx >= px0 && c.cx < px1);
      if (!mine.some(c => !c.space)) { reject('empty-piece'); return; }
      if (mine.some(c => !c.space && (c.x0 < px0 - 0.3 * (c.x1 - c.x0) || c.x1 > px1 + 0.3 * (c.x1 - c.x0)))) { reject('cut-piece'); return; }
      pieces.push({ o: offset, w: part.width, line: lineIndex, piece: partIndex, of: parts.length, base: rtlShare >= 0.5 ? 'rtl' : 'ltr', size: Math.round(size * 10) / 10,
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)],
        chars: mine.sort((a, b) => a.order - b.order).map(c => [c.order, c.ch, Math.round(c.cx * 10) / 10, Math.round(c.x0 * 10) / 10, Math.round(c.x1 * 10) / 10, c.element[2]]) });
      pixels.push(Buffer.from(part.pixels.buffer, part.pixels.byteOffset, part.pixels.byteLength));
      offset += part.pixels.byteLength;
    });
  });
  return { width: image.width, height: image.height, scale, lines: lines.length, pieces, reasons, pixels: Buffer.concat(pixels) };
}

async function main() {
  const captures = arg('--captures', join('artifacts', 'vision-real-v1', 'captures'))!;
  const out = arg('--out', join('artifacts', 'vision-real-v1', 'lines'))!;
  const [part, parts] = (arg('--part', '0/1')!).split('/').map(Number);
  await mkdir(out, { recursive: true });
  const files = (await readdir(captures)).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort().filter((_, index) => index % parts === part);
  const totals: Record<string, number> = {};
  let kept = 0, seen = 0, done = 0;
  const started = Date.now();
  for (const file of files) {
    const capture = JSON.parse(await readFile(join(captures, file), 'utf-8')) as Capture;
    if (!capture.generated && BOT_CHECK.test(capture.title ?? '')) { totals['bot-check-page'] = (totals['bot-check-page'] ?? 0) + 1; done++; continue; }
    const png = await readFile(join(captures, capture.png));
    for (const variant of await variantsOf(capture, png)) {
      try {
        const result = await matchOne(capture, variant.bytes);
        await writeFile(join(out, `${capture.id}.${variant.name}.u8`), result.pixels);
        await writeFile(join(out, `${capture.id}.${variant.name}.json`), JSON.stringify({ capture: capture.id, variant: variant.name, url: capture.url, site: capture.site, lang: capture.lang,
          split: capture.split, source: capture.variant, dpr: capture.dpr, generated: Boolean(capture.generated), image: [result.width, result.height], scale: result.scale,
          lines: result.lines, reasons: result.reasons, pieces: result.pieces }));
        seen += result.lines; kept += result.pieces.length;
        for (const [reason, count] of Object.entries(result.reasons)) totals[reason] = (totals[reason] ?? 0) + count;
      } catch (error) {
        console.log(`failed ${capture.id} ${variant.name}: ${(error as Error).message.slice(0, 160)}`);
      }
    }
    done++;
    if (done % 20 === 0) console.log(`part ${part}/${parts}: ${done}/${files.length} screenshots, lines ${seen}, pieces kept ${kept}, ${Math.round((Date.now() - started) / 1000)}s`);
  }
  console.log(`part ${part}/${parts} done: ${files.length} screenshots, detected lines ${seen}, pieces kept ${kept}`);
  console.log('rejections', JSON.stringify(Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1]))));
}

main().catch(error => { console.error(error); process.exit(1); });
