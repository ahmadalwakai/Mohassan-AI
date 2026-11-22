import { detectBase, hasArabic, toLogical } from './bidi.js';
import { decodeImage, describeImage, type ImageFacts } from './image.js';
import { cropToHeight, findTextLines, orderLines, padBox, splitWide, type Box, type LineBox, type LinePiece } from './layout.js';
import type { OcrModel } from './ocr-model.js';
import { recognizeLine, type LineCrop, type LineRecognition } from './recognize.js';

export interface ReadLine {
  readonly text: string;
  readonly visual: string;
  readonly confidence: number;
  readonly box: Box;
  readonly block: number;
  readonly row: number;
  readonly direction: 'ltr' | 'rtl';
  /** The 32-row crops the model saw, only when `includeCrops` was asked for (debugging and evaluation). */
  readonly crops?: readonly LineCrop[];
}

export interface ImageReading {
  readonly facts: ImageFacts;
  readonly lines: readonly ReadLine[];
  readonly blocks: readonly string[];
  readonly text: string;
  readonly direction: 'ltr' | 'rtl' | 'mixed' | 'none';
  readonly kind: 'screenshot' | 'document' | 'photo' | 'graphic';
  readonly candidates: number;
  readonly dropped: number;
  readonly durationMs: number;
  readonly modelId: string;
}

export interface Recognizer { (crops: readonly LineCrop[]): Promise<readonly LineRecognition[]> }

export interface ReadImageOptions {
  readonly model: OcrModel;
  /** Batched recognition, for a worker pool; defaults to in-process inference. */
  readonly recognize?: Recognizer;
  readonly maxLines?: number;
  readonly minConfidence?: number;
  /**
   * On a legible image (at least `LEGIBLE_LINES` lines read with confidence 0.9 or more), lines below
   * this confidence are dropped too: there they are almost always specks of a photo or a texture
   * read as letters. An image with no legible line keeps its best-effort lines down to `minConfidence`.
   */
  readonly pageMinConfidence?: number;
  readonly signal?: AbortSignal;
  readonly includeCrops?: boolean;
}

const PIECE_WIDTH = 896;
const LEGIBLE_LINES = 3;
const JUNK = /^[\s\-_.,:;'"`~^|\\/()[\]{}<>«»•…*+=]*$/u;

/**
 * The readings of one line's pieces (visual order, left to right) as one visual string: a space
 * only where a word space separated two pieces (`splitWide` marks it) or the model read one at the
 * edge, so a cut between two letters of one word does not split the word.
 */
export function joinPieces(readings: readonly string[], pieces: readonly { readonly spaceBefore?: boolean }[]): string {
  let out = '', space = false;
  readings.forEach((reading, index) => {
    if (index > 0 && (pieces[index]?.spaceBefore || /^\s/u.test(reading))) space = true;
    const text = reading.trim();
    if (!text) return;
    out += out && space ? ` ${text}` : text;
    space = /\s$/u.test(reading);
  });
  return out;
}

/**
 * On a legible image (at least `LEGIBLE_LINES` lines read with confidence 0.9 or more), lines under
 * `pageMin` are dropped: there they are almost always specks of a photo or a texture read as letters.
 * An image with no legible line keeps all its lines, so a hard image still gets a best-effort reading.
 */
export function keepLegible<T extends { readonly confidence: number }>(lines: readonly T[], pageMin: number): T[] {
  return lines.filter(line => line.confidence >= 0.9).length >= LEGIBLE_LINES ? lines.filter(line => line.confidence >= pageMin) : lines.slice();
}

/** Read an image end to end: facts, text lines, text in reading order. */
export async function readImage(bytes: Uint8Array, options: ReadImageOptions): Promise<ImageReading> {
  const started = performance.now();
  const { model } = options;
  const decoded = await decodeImage(bytes);
  const facts = describeImage(decoded);
  const found = findTextLines(decoded.gray, decoded.width, decoded.height, { maxLines: options.maxLines ?? 300 });
  const recognize: Recognizer = options.recognize ?? (async crops => crops.map(crop => recognizeLine(model, crop)));
  const prepared: { line: LineBox; box: Box; pieces: LinePiece[] }[] = [];
  for (const line of found) {
    const box = padBox(line, decoded.width, decoded.height);
    const crop = cropToHeight(decoded.gray, decoded.width, box, model.height, Math.max(model.maxWidth, 64) * 8);
    if (!crop) continue;
    const pieces = splitWide(crop, model.height, Math.min(PIECE_WIDTH, model.maxWidth)).filter(piece => piece.width >= 8 && piece.width <= model.maxWidth);
    if (pieces.length) prepared.push({ line, box, pieces });
  }
  options.signal?.throwIfAborted();
  const flat = prepared.flatMap(item => item.pieces);
  const results = flat.length ? await recognize(flat) : [];
  if (results.length !== flat.length) throw new Error('OCR_RECOGNIZER_MISMATCH');
  const minConfidence = options.minConfidence ?? 0.35;
  const read: { box: Box; visual: string; text: string; confidence: number; direction: 'ltr' | 'rtl'; crops?: LineCrop[] }[] = [];
  let cursor = 0, dropped = 0;
  for (const item of prepared) {
    const part = results.slice(cursor, cursor + item.pieces.length);
    cursor += item.pieces.length;
    const visual = joinPieces(part.map(piece => piece.visual), item.pieces);
    const chars = part.reduce((sum, piece) => sum + piece.chars, 0);
    const confidence = chars ? part.reduce((sum, piece) => sum + piece.confidence * piece.chars, 0) / chars : 0;
    if (!visual || JUNK.test(visual) || confidence < minConfidence || (visual.length <= 2 && confidence < 0.8)) { dropped++; continue; }
    const base = detectBase(visual);
    const text = toLogical(visual, base).trim();
    read.push({ box: item.box, visual, text, confidence, direction: base === 'R' ? 'rtl' : 'ltr', ...(options.includeCrops ? { crops: item.pieces } : {}) });
  }
  const legible = keepLegible(read, options.pageMinConfidence ?? 0.7);
  dropped += read.length - legible.length;
  read.splice(0, read.length, ...legible);
  const arabicChars = read.reduce((sum, line) => sum + (line.direction === 'rtl' ? line.text.length : 0), 0);
  const totalChars = read.reduce((sum, line) => sum + line.text.length, 0);
  const direction: ImageReading['direction'] = !totalChars ? 'none' : arabicChars === 0 ? 'ltr' : arabicChars === totalChars ? 'rtl' : arabicChars >= totalChars * 0.6 ? 'rtl' : arabicChars <= totalChars * 0.4 ? 'ltr' : 'mixed';
  const ordered = orderLines(read.map(line => ({ ...line.box, line })), direction === 'rtl' ? 'rtl' : 'ltr');
  const lines: ReadLine[] = ordered.map(entry => ({ text: entry.line.line.text, visual: entry.line.line.visual, confidence: Math.round(entry.line.line.confidence * 1000) / 1000,
    box: entry.line.line.box, block: entry.block, row: entry.row, direction: entry.line.line.direction, ...(entry.line.line.crops ? { crops: entry.line.line.crops } : {}) }));
  const blocks: string[] = [];
  for (const line of lines) {
    const previous = lines[lines.indexOf(line) - 1];
    if (!previous || previous.block !== line.block) blocks.push(line.text);
    else if (previous.row === line.row) blocks[blocks.length - 1] += ` ${line.text}`;
    else blocks[blocks.length - 1] += `\n${line.text}`;
  }
  const textArea = read.reduce((sum, line) => sum + line.box.w * line.box.h, 0) / (decoded.width * decoded.height);
  const kind: ImageReading['kind'] = facts.surface === 'photo' && textArea < 0.08 ? 'photo'
    : textArea >= 0.25 && lines.length >= 6 && facts.surface !== 'photo' ? 'document'
      : facts.surface === 'graphic' || lines.length >= 4 ? 'screenshot' : 'graphic';
  return {
    facts, lines, blocks, text: blocks.join('\n\n'), direction, kind, candidates: found.length, dropped,
    durationMs: Math.round(performance.now() - started), modelId: model.modelId,
  };
}

export { hasArabic };
