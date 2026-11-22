/**
 * Read captured screenshots end to end and compare each with the text the page showed.
 *
 *   npx tsx scripts/vision/bench-captures.ts --captures artifacts/vision-real-v1/captures-site2 --model artifacts/vision/ocr-v1 \
 *     --out artifacts/vision-real-v1/bench-site2/ocr-v1.json [--variant desktop] [--per-site 3] [--workers 3]
 *
 * The truth for a screenshot is every character the browser reported as visible there
 * (capture-lines.ts), one line per row of each text node, leaving out what a reader is not asked
 * to read (hidden, icon fonts, faint, tiny). Scores come from compareWithTruth in read-image.ts,
 * the same comparison as the seven benchmark pages. Screenshots are picked deterministically, so
 * every model reads the same ones. Bot-check pages and screenshots whose truth has fewer than
 * 20 words are skipped. Text inside frames and images is not in the truth, so on pages with ads
 * or picture text the precision is a lower bound; comparing models on the same pages is fair.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createOcrPool, loadOcrModelFromBytes, readImage, readOcrModelFiles } from '../../packages/vision/src/index.ts';
import { compareWithTruth } from './read-image.ts';

type Char = [node: number, offset: number, ch: string, l: number, t: number, r: number, b: number, element: number, visible: number];
type Element = [rtl: number, size: number, letterCase: number, skip: string, family: string, weight: string];
interface Capture { id: string; url: string; site: string; lang: string; split: string; variant: string; png: string; chars: Char[]; elements: Element[]; title?: string }

const SKIP = new Set(['hidden', 'icon-font', 'faint', 'tiny']);
/** Bot-check and block pages (same pattern as capture-lines.ts) are not the site's content. */
const BOT_CHECK = /just a moment|لحظة…|attention required|access denied|are you a robot|captcha|verify you are human|security check/iu;
/** Fewer visible words than this means the truth was not captured (a transparent overlay over the page, text in frames). */
const MIN_TRUTH_WORDS = 20;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** The page's visible text in the screenshot: one line per row of each text node, in document order. */
export function truthOf(capture: Capture): string {
  const byNode = new Map<number, Char[]>();
  for (const c of capture.chars) {
    const element = capture.elements[c[7]];
    if (!c[8] || !element || SKIP.has(element[3])) continue;
    const list = byNode.get(c[0]) ?? [];
    list.push(c);
    byNode.set(c[0], list);
  }
  const text = (chars: Char[]) => chars.map(c => { const letterCase = capture.elements[c[7]][2]; return letterCase === 1 ? c[2].toUpperCase() : letterCase === 2 ? c[2].toLowerCase() : c[2]; }).join('');
  const lines: string[] = [];
  for (const [, chars] of [...byNode.entries()].sort((a, b) => a[0] - b[0])) {
    chars.sort((a, b) => a[1] - b[1]);
    let row: Char[] = [];
    let rowY = 0;
    for (const c of chars) {
      const cy = (c[4] + c[6]) / 2, height = Math.max(1, c[6] - c[4]);
      if (row.length && Math.abs(cy - rowY) > 0.5 * height) { lines.push(text(row)); row = []; }
      if (!row.length) rowY = cy;
      row.push(c);
    }
    if (row.length) lines.push(text(row));
  }
  return lines.map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}

async function main() {
  const captures = arg('--captures', join('artifacts', 'vision-real-v1', 'captures-site2'))!;
  const modelDir = arg('--model', join('artifacts', 'vision', 'ocr-v1'))!;
  const out = arg('--out')!;
  const variant = arg('--variant', 'desktop')!;
  const perSite = Number(arg('--per-site', '3'));
  const names = (await readdir(captures)).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort();
  const picked: Capture[] = [], skipped: string[] = [];
  const taken = new Map<string, number>();
  for (const name of names) {
    const capture = JSON.parse(await readFile(join(captures, name), 'utf-8')) as Capture;
    if (capture.variant !== variant || (taken.get(capture.site) ?? 0) >= perSite) continue;
    if (BOT_CHECK.test(capture.title ?? '') || truthOf(capture).split(/\s+/u).filter(word => word.length >= 2).length < MIN_TRUTH_WORDS) { skipped.push(capture.id); continue; }
    taken.set(capture.site, (taken.get(capture.site) ?? 0) + 1);
    picked.push(capture);
  }
  const files = await readOcrModelFiles(modelDir);
  const model = loadOcrModelFromBytes(files.manifestBytes, files.weightsBytes);
  const pool = createOcrPool({ manifestBytes: files.manifestBytes, weightsBytes: files.weightsBytes, size: Number(arg('--workers', '3')) });
  const pooled = await pool.ready();
  console.log(`model ${model.manifest.modelId.slice(0, 12)} pool ${pooled}; ${picked.length} screenshots from ${taken.size} sites; skipped ${skipped.length} (bot-check page or no truth)`);
  const results: ({ id: string; site: string; lang: string; url: string; ms: number; lines: number } & ReturnType<typeof compareWithTruth>)[] = [];
  const started = Date.now();
  try {
    for (const capture of picked) {
      const truth = truthOf(capture);
      const bytes = new Uint8Array(await readFile(join(captures, capture.png)));
      const t0 = Date.now();
      const reading = await readImage(bytes, { model, ...(pooled ? { recognize: crops => pool.recognize(crops) } : {}) });
      const comparison = compareWithTruth(reading.lines.map(line => line.text), truth);
      results.push({ id: capture.id, site: capture.site, lang: capture.lang, url: capture.url, ms: Date.now() - t0, lines: reading.lines.length, ...comparison });
      console.log(`${capture.site.padEnd(24)} recall ${comparison.wordRecall.toFixed(3)} precision ${comparison.wordPrecision.toFixed(3)} words ${comparison.truthWords} ${Date.now() - t0}ms`);
    }
  } finally {
    await pool.close();
  }
  const total = (filter: (r: (typeof results)[number]) => boolean) => {
    const rows = results.filter(filter);
    const truth = rows.reduce((s, r) => s + r.truthWords, 0), read = rows.reduce((s, r) => s + r.readWords, 0);
    const hits = rows.reduce((s, r) => s + r.wordRecall * r.truthWords, 0);
    return { screenshots: rows.length, truthWords: truth, wordRecall: truth ? hits / truth : 0, wordPrecision: read ? hits / read : 0,
      meanRecall: rows.length ? rows.reduce((s, r) => s + r.wordRecall, 0) / rows.length : 0 };
  };
  const summary = { modelDir, modelId: model.manifest.modelId, captures, variant, perSite, skipped, seconds: Math.round((Date.now() - started) / 1000),
    all: total(() => true), ar: total(r => r.lang === 'ar'), en: total(r => r.lang === 'en'), results };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 1), 'utf-8');
  console.log('all', JSON.stringify(summary.all), '\nar', JSON.stringify(summary.ar), '\nen', JSON.stringify(summary.en));
}

if (process.argv[1] && /bench-captures\.ts$/u.test(process.argv[1])) main().catch(error => { console.error(error); process.exit(1); });
