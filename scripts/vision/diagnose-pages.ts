/**
 * Where does a full page lose words? Every visible word of a captured screenshot (capture-lines.ts)
 * is traced through the reader: never inside a detected line ("missed"), inside a line that was
 * dropped (empty, junk, low confidence, short), inside a kept line that also holds another row of
 * text ("multi-row"), or inside a clean kept line but read wrong ("misread"). Read words that sit on
 * no visible text at all ("phantom") are counted apart from wrong words on real text ("extra").
 *
 *   npx tsx scripts/vision/diagnose-pages.ts --captures artifacts/vision-real-v1/captures-site2 \
 *     --select artifacts/vision-real-v1/bench-site2-final/ocr-v1-real2.json --out artifacts/vision-real-v1/diag/site2.json
 *   npx tsx scripts/vision/diagnose-pages.ts --captures artifacts/vision-real-v1/captures --variant desktop --per-site 4 --out ...
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createOcrPool, cropToHeight, decodeImage, detectBase, findTextLines, joinPieces, loadOcrModelFromBytes, padBox, readOcrModelFiles, recognizeLine, splitWide, toLogical, WORD_GAP, type LineBox, type LineCrop, type LinePiece, type LineRecognition } from '../../packages/vision/src/index.ts';

type Char = [node: number, offset: number, ch: string, l: number, t: number, r: number, b: number, element: number, visible: number];
type Element = [rtl: number, size: number, letterCase: number, skip: string, family: string, weight: string];
interface Capture { id: string; url: string; site: string; lang: string; split: string; variant: string; dpr?: number; png: string; chars: Char[]; elements: Element[]; title?: string }

const SKIP = new Set(['hidden', 'icon-font', 'faint', 'tiny']);
const BOT_CHECK = /just a moment|لحظة…|attention required|access denied|are you a robot|captcha|verify you are human|security check/iu;
const JUNK = /^[\s\-_.,:;'"`~^|\\/()[\]{}<>«»•…*+=]*$/u;
const PIECE_WIDTH = 896;
const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (text: string) => fold(text).split(' ').filter(word => word.length >= 2);

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export interface Candidate { line: LineBox; status: 'kept' | 'empty' | 'junk' | 'low-confidence' | 'short' | 'no-crop' | 'page-low'; text: string; confidence: number; multiRow: boolean; truthChars: number; cuts: number[]; lostPieces: number }
interface TruthWord { text: string; folded: string; cx: number; cy: number; h: number; size: number; chars: { cx: number; cy: number }[] }

/** Visible truth words with their pixel positions (the same visible characters bench-captures.ts compares with). */
function truthWords(capture: Capture, scale: number): TruthWord[] {
  const byNode = new Map<number, Char[]>();
  for (const c of capture.chars) {
    const element = capture.elements[c[7]];
    if (!c[8] || !element || SKIP.has(element[3])) continue;
    const list = byNode.get(c[0]) ?? [];
    list.push(c);
    byNode.set(c[0], list);
  }
  const out: TruthWord[] = [];
  for (const chars of byNode.values()) {
    chars.sort((a, b) => a[1] - b[1]);
    let current: Char[] = [];
    const flush = () => {
      const letters = current.filter(c => c[2].trim());
      if (letters.length) {
        const text = letters.map(c => { const letterCase = capture.elements[c[7]][2]; return letterCase === 1 ? c[2].toUpperCase() : letterCase === 2 ? c[2].toLowerCase() : c[2]; }).join('');
        for (const folded of words(text)) {
          const points = letters.map(c => ({ cx: ((c[3] + c[5]) / 2) * scale, cy: ((c[4] + c[6]) / 2) * scale }));
          const heights = letters.map(c => (c[6] - c[4]) * scale).sort((a, b) => a - b);
          out.push({ text, folded, cx: points.reduce((s, p) => s + p.cx, 0) / points.length, cy: points.reduce((s, p) => s + p.cy, 0) / points.length,
            h: heights[Math.floor(heights.length / 2)], size: capture.elements[letters[0][7]][1] * scale, chars: points });
        }
      }
      current = [];
    };
    let rowY = Number.NaN;
    for (const c of chars) {
      const cy = (c[4] + c[6]) / 2, height = Math.max(1, c[6] - c[4]);
      if (!c[2].trim() || (current.length && Math.abs(cy - rowY) > 0.5 * height)) flush();
      if (!c[2].trim()) continue;
      if (!current.length) rowY = cy;
      current.push(c);
    }
    flush();
  }
  return out;
}

const inside = (line: LineBox, x: number, y: number, slack = 1) => x >= line.x - slack && x <= line.x + line.w + slack && y >= line.y - slack && y <= line.y + line.h + slack;
const KEYS = ['hit', 'missed', 'dropped:empty', 'dropped:junk', 'dropped:low-confidence', 'dropped:short', 'dropped:no-crop', 'dropped:page-low', 'multi-row', 'piece-cut', 'cut-box', 'oversized-box', 'misread'] as const;
type Key = (typeof KEYS)[number];
const COUNTERS = [...KEYS, 'truth', 'read', 'readHit', 'phantom', 'extra'];

async function main() {
  const captures = arg('--captures', join('artifacts', 'vision-real-v1', 'captures-site2'))!;
  const modelDir = arg('--model', join('artifacts', 'vision', 'ocr-v1'))!;
  const out = arg('--out')!;
  const variant = arg('--variant', 'desktop')!;
  const perSite = Number(arg('--per-site', '3'));
  const select = arg('--select');
  const wordGap = Number(arg('--word-gap', String(WORD_GAP)));
  const pageMin = Number(arg('--page-min', '0.7'));
  const selected = select ? new Set<string>(JSON.parse(await readFile(select, 'utf-8')).results.map((r: { id: string }) => r.id)) : null;
  const names = (await readdir(captures)).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort();
  const picked: Capture[] = [];
  const taken = new Map<string, number>();
  for (const name of names) {
    const capture = JSON.parse(await readFile(join(captures, name), 'utf-8')) as Capture;
    if (selected ? !selected.has(capture.id) : capture.variant !== variant || (taken.get(capture.site) ?? 0) >= perSite) continue;
    if (!selected && (BOT_CHECK.test(capture.title ?? '') || truthWords(capture, 1).length < 20)) continue;
    taken.set(capture.site, (taken.get(capture.site) ?? 0) + 1);
    picked.push(capture);
  }
  const files = await readOcrModelFiles(modelDir);
  const model = loadOcrModelFromBytes(files.manifestBytes, files.weightsBytes);
  const pool = createOcrPool({ manifestBytes: files.manifestBytes, weightsBytes: files.weightsBytes, size: Number(arg('--workers', '3')) });
  const pooled = await pool.ready();
  const recognize = async (crops: readonly LineCrop[]): Promise<readonly LineRecognition[]> => (pooled ? pool.recognize(crops) : crops.map(crop => recognizeLine(model, crop)));
  console.log(`model ${model.manifest.modelId.slice(0, 12)}; ${picked.length} screenshots from ${new Set(picked.map(c => c.site)).size} sites`);
  const totals: Record<string, number> = Object.fromEntries(COUNTERS.map(k => [k, 0]));
  const pages = [];
  const keptLines: Record<string, unknown>[] = [];
  const examples: Record<string, unknown[]> = {};
  const note = (key: string, item: unknown) => { const list = examples[key] ?? (examples[key] = []); if (list.length < 80) list.push(item); };
  try {
    for (const capture of picked) {
      const decoded = await decodeImage(new Uint8Array(await readFile(join(captures, capture.png))));
      const scale = capture.dpr ?? 1;
      const truth = truthWords(capture, scale);
      const found = findTextLines(decoded.gray, decoded.width, decoded.height, { maxLines: 300 });
      const candidates: Candidate[] = [];
      const prepared: { index: number; pieces: LinePiece[] }[] = [];
      for (const line of found) {
        const box = padBox(line, decoded.width, decoded.height);
        const crop = cropToHeight(decoded.gray, decoded.width, box, model.height, Math.max(model.maxWidth, 64) * 8);
        const all = crop ? splitWide(crop, model.height, Math.min(PIECE_WIDTH, model.maxWidth), wordGap) : [];
        const pieces = all.filter(piece => piece.width >= 8 && piece.width <= model.maxWidth);
        // Piece boundaries back in image pixels: a word that spans one was cut in two by splitWide.
        const cuts: number[] = [];
        let at = 0;
        for (const piece of all.slice(0, -1)) { at += piece.width; cuts.push(box.x + (at * box.h) / model.height); }
        candidates.push({ line, status: 'no-crop', text: '', confidence: 0, multiRow: false, truthChars: 0, cuts, lostPieces: all.length - pieces.length });
        if (pieces.length) prepared.push({ index: candidates.length - 1, pieces });
      }
      const results = await recognize(prepared.flatMap(item => item.pieces));
      let cursor = 0;
      for (const item of prepared) {
        const part = results.slice(cursor, cursor + item.pieces.length);
        cursor += item.pieces.length;
        const visual = joinPieces(part.map(piece => piece.visual), item.pieces);
        const chars = part.reduce((sum, piece) => sum + piece.chars, 0);
        const confidence = chars ? part.reduce((sum, piece) => sum + piece.confidence * piece.chars, 0) / chars : 0;
        const candidate = candidates[item.index];
        candidate.confidence = confidence;
        candidate.text = visual ? toLogical(visual, detectBase(visual)).trim() : '';
        candidate.status = !visual ? 'empty' : JUNK.test(visual) ? 'junk' : confidence < 0.35 ? 'low-confidence' : visual.length <= 2 && confidence < 0.8 ? 'short' : 'kept';
      }
      // As in readImage: on a legible page, lines under the page threshold are dropped as well.
      if (candidates.filter(c => c.status === 'kept' && c.confidence >= 0.9).length >= 3) {
        for (const c of candidates) if (c.status === 'kept' && c.confidence < pageMin) c.status = 'page-low';
      }
      // Which truth characters each candidate holds; two rows of text in one candidate is a vertical merge.
      const holders = (x: number, y: number) => candidates.map((c, i) => (inside(c.line, x, y) ? i : -1)).filter(i => i >= 0);
      const charsIn = candidates.map(() => [] as { cy: number; h: number }[]);
      for (const word of truth) for (const p of word.chars) for (const i of holders(p.cx, p.cy)) charsIn[i].push({ cy: p.cy, h: word.h });
      candidates.forEach((c, i) => {
        const ys = charsIn[i].map(p => p.cy).sort((a, b) => a - b);
        const h = charsIn[i].map(p => p.h).sort((a, b) => a - b)[Math.floor(charsIn[i].length / 2)] ?? 0;
        c.truthChars = ys.length;
        c.multiRow = ys.some((y, k) => k > 0 && y - ys[k - 1] > 0.75 * h);
      });
      const page: Record<string, number> = Object.fromEntries(COUNTERS.map(k => [k, 0]));
      const keptWords = new Map<number, Map<string, number>>();
      candidates.forEach((c, i) => {
        if (c.status !== 'kept') return;
        const bag = new Map<string, number>();
        for (const w of words(c.text)) bag.set(w, (bag.get(w) ?? 0) + 1);
        keptWords.set(i, bag);
      });
      const used = new Map<number, Map<string, number>>();
      for (const word of truth) {
        page.truth++;
        const votes = new Map<number, number>();
        for (const p of word.chars) for (const i of holders(p.cx, p.cy)) votes.set(i, (votes.get(i) ?? 0) + 1);
        const covering = [...votes.entries()].filter(([, n]) => n >= 0.6 * word.chars.length).map(([i]) => i);
        let key: Key;
        if (!covering.length) key = 'missed';
        else {
          const kept = covering.filter(i => candidates[i].status === 'kept');
          if (!kept.length) key = `dropped:${candidates[covering[0]].status}` as Key;
          else {
            const hitIn = kept.find(i => (keptWords.get(i)!.get(word.folded) ?? 0) > (used.get(i)?.get(word.folded) ?? 0));
            if (hitIn !== undefined) {
              key = 'hit';
              const usedBag = used.get(hitIn) ?? new Map<string, number>();
              usedBag.set(word.folded, (usedBag.get(word.folded) ?? 0) + 1);
              used.set(hitIn, usedBag);
            } else {
              const best = kept.reduce((a, b) => ((votes.get(b) ?? 0) > (votes.get(a) ?? 0) ? b : a));
              const c = candidates[best], x0 = Math.min(...word.chars.map(p => p.cx)), x1 = Math.max(...word.chars.map(p => p.cx));
              key = kept.some(i => candidates[i].multiRow) ? 'multi-row'
                : c.cuts.some(x => x > x0 && x < x1) ? 'piece-cut'
                  : (votes.get(best) ?? 0) < word.chars.length ? 'cut-box'
                    : c.line.glyphHeight > 1.3 * word.h ? 'oversized-box' : 'misread';
            }
          }
        }
        page[key]++;
        if (key !== 'hit') {
          const c = covering.length ? candidates[covering[0]] : null;
          note(key, { site: capture.site, id: capture.id, word: word.text, size: Math.round(word.size), h: Math.round(word.h), at: [Math.round(word.cx), Math.round(word.cy)],
            ...(c ? { line: { x: c.line.x, y: c.line.y, w: c.line.w, h: c.line.h, polarity: c.line.polarity, glyph: c.line.glyphHeight, comps: c.line.components }, status: c.status, confidence: Math.round(c.confidence * 100) / 100, read: c.text.slice(0, 80) } : {}) });
        }
      }
      candidates.forEach((c, i) => {
        if (c.status !== 'kept') return;
        const bag = keptWords.get(i)!, usedBag = used.get(i) ?? new Map<string, number>();
        for (const [w, n] of bag) {
          page.read += n;
          const hits = Math.min(n, usedBag.get(w) ?? 0);
          page.readHit += hits;
          if (n > hits) { if (c.truthChars === 0) page.phantom += n - hits; else page.extra += n - hits; }
        }
        if (c.truthChars === 0) note('phantom-line', { site: capture.site, id: capture.id, read: c.text.slice(0, 80), confidence: Math.round(c.confidence * 100) / 100, line: { x: c.line.x, y: c.line.y, w: c.line.w, h: c.line.h, polarity: c.line.polarity } });
        // Every kept line, for designing filters: what it read, how sure, its shape, and how much of it was true.
        keptLines.push({ id: capture.id, site: capture.site, text: c.text, confidence: Math.round(c.confidence * 1000) / 1000, truthChars: c.truthChars,
          words: [...bag.values()].reduce((s, n) => s + n, 0), hits: [...bag.entries()].reduce((s, [w, n]) => s + Math.min(n, usedBag.get(w) ?? 0), 0),
          x: c.line.x, y: c.line.y, w: c.line.w, h: c.line.h, glyph: c.line.glyphHeight, comps: c.line.components, ink: c.line.ink, polarity: c.line.polarity, pieces: c.cuts.length + 1 });
      });
      for (const k of Object.keys(totals)) totals[k] += page[k];
      pages.push({ id: capture.id, site: capture.site, lang: capture.lang, candidates: candidates.length, ...page });
      const dropped = page['dropped:low-confidence'] + page['dropped:junk'] + page['dropped:short'] + page['dropped:empty'] + page['dropped:no-crop'] + page['dropped:page-low'];
      console.log(`${capture.site.padEnd(24)} truth ${String(page.truth).padStart(4)} hit ${String(page.hit).padStart(4)} missed ${String(page.missed).padStart(3)} dropped ${String(dropped).padStart(3)} multi-row ${String(page['multi-row']).padStart(3)} piece-cut ${String(page['piece-cut']).padStart(3)} cut-box ${String(page['cut-box']).padStart(3)} oversized ${String(page['oversized-box']).padStart(3)} misread ${String(page.misread).padStart(3)} | read ${page.read} phantom ${page.phantom} extra ${page.extra}`);
    }
  } finally {
    await pool.close();
  }
  const share = (k: string) => Math.round((1000 * totals[k]) / Math.max(1, totals.truth)) / 10;
  const summary = { modelId: model.manifest.modelId, captures, screenshots: pages.length, totals,
    lostShareOfTruth: Object.fromEntries(KEYS.filter(k => k !== 'hit').map(k => [k, share(k)])),
    recall: totals.hit / Math.max(1, totals.truth), precision: totals.readHit / Math.max(1, totals.read), pages, examples, keptLines };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 1), 'utf-8');
  console.log('\ntotals', JSON.stringify(totals), '\nlost % of truth words', JSON.stringify(summary.lostShareOfTruth), `\nrecall ${summary.recall.toFixed(3)} precision ${summary.precision.toFixed(3)}`);
}

if (process.argv[1] && /diagnose-pages\.ts$/u.test(process.argv[1])) main().catch(error => { console.error(error); process.exit(1); });
