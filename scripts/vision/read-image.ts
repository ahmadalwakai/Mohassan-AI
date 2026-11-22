/**
 * Read one image with the own OCR model and print what Mohassan would see.
 *
 *   npx tsx scripts/vision/read-image.ts <image.png> [--model artifacts/vision/ocr-v1] [--json out.json] [--truth page.txt]
 *
 * With --truth, the page text the screenshot was taken from is compared with the
 * reading: word recall, word precision and the character error rate of the lines
 * that match a ground-truth line.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOcrModel, readImage } from '../../packages/vision/src/index.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = current;
  }
  return previous[b.length];
}

export function compareWithTruth(readLines: readonly string[], truth: string) {
  const truthWords = new Map<string, number>();
  for (const word of fold(truth).split(' ').filter(word => word.length >= 2)) truthWords.set(word, (truthWords.get(word) ?? 0) + 1);
  const readWords = new Map<string, number>();
  for (const line of readLines) for (const word of fold(line).split(' ').filter(word => word.length >= 2)) readWords.set(word, (readWords.get(word) ?? 0) + 1);
  let hit = 0, readTotal = 0, truthTotal = 0;
  for (const [word, count] of truthWords) { truthTotal += count; hit += Math.min(count, readWords.get(word) ?? 0); }
  for (const count of readWords.values()) readTotal += count;
  const truthLines = truth.split(/\r?\n/u).map(line => fold(line)).filter(line => line.length >= 4);
  let matchedChars = 0, matchedErrors = 0, matchedLines = 0;
  for (const line of readLines) {
    const folded = fold(line);
    if (folded.length < 4) continue;
    let best: { distance: number; length: number } | null = null;
    for (const candidate of truthLines) {
      if (Math.abs(candidate.length - folded.length) > Math.max(6, folded.length * 0.5)) continue;
      const distance = editDistance(folded, candidate);
      if (!best || distance < best.distance) best = { distance, length: candidate.length };
    }
    if (best && best.distance <= Math.max(2, best.length * 0.4)) { matchedLines++; matchedChars += best.length; matchedErrors += best.distance; }
  }
  return { wordRecall: truthTotal ? hit / truthTotal : 0, wordPrecision: readTotal ? hit / readTotal : 0, truthWords: truthTotal, readWords: readTotal,
    matchedLines, readLines: readLines.length, matchedLineCer: matchedChars ? matchedErrors / matchedChars : null };
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: read-image.ts <image> [--model dir] [--json out] [--truth text-file]'); process.exit(2); }
  const modelDir = arg('--model') ?? process.env.MOHASSAN_OCR_MODEL_DIR ?? join(process.cwd(), 'artifacts', 'vision', 'ocr-v1');
  const model = await loadOcrModel(modelDir);
  const bytes = new Uint8Array(await readFile(file));
  const dump = arg('--dump');
  const started = performance.now();
  const reading = await readImage(bytes, { model, includeCrops: Boolean(dump) });
  const elapsed = Math.round(performance.now() - started);
  if (dump) {
    // Every crop the model saw, stacked into one sheet with its reading, for looking at by eye.
    const { default: sharp } = await import('sharp');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dump, { recursive: true });
    const crops = reading.lines.flatMap((line, index) => (line.crops ?? []).map(crop => ({ crop, index, text: line.text, confidence: line.confidence })));
    const scale = 2, gap = 6, rowHeight = 32 * scale + gap, width = Math.max(64, ...crops.map(item => item.crop.width)) * scale;
    const composites = await Promise.all(crops.map(async (item, row) => ({
      input: await sharp(Buffer.from(item.crop.pixels), { raw: { width: item.crop.width, height: 32, channels: 1 } }).resize({ width: item.crop.width * scale, height: 32 * scale, kernel: 'nearest' }).png().toBuffer(),
      top: row * rowHeight, left: 0 })));
    await sharp({ create: { width, height: Math.max(rowHeight, crops.length * rowHeight), channels: 3, background: { r: 60, g: 60, b: 60 } } }).composite(composites).png().toFile(join(dump, 'crops.png'));
    await writeFile(join(dump, 'crops.json'), JSON.stringify(crops.map((item, row) => ({ row, line: item.index, width: item.crop.width, text: item.text, confidence: item.confidence })), null, 1), 'utf-8');
    console.log('dumped', crops.length, 'crops to', join(dump, 'crops.png'));
  }
  console.log(`${reading.facts.width}x${reading.facts.height} ${reading.kind} direction=${reading.direction} lines=${reading.lines.length} candidates=${reading.candidates} dropped=${reading.dropped} ${elapsed}ms`);
  console.log(reading.text);
  let comparison: ReturnType<typeof compareWithTruth> | undefined;
  const truthFile = arg('--truth');
  if (truthFile) {
    comparison = compareWithTruth(reading.lines.map(line => line.text), await readFile(truthFile, 'utf-8'));
    console.log('comparison', JSON.stringify(comparison));
  }
  const out = arg('--json');
  if (out) await writeFile(out, JSON.stringify({ file, elapsedMs: elapsed, modelId: reading.modelId, reading, comparison }, null, 1), 'utf-8');
}

if (process.argv[1] && /read-image\.ts$/u.test(process.argv[1])) main().catch(error => { console.error(error); process.exit(1); });
