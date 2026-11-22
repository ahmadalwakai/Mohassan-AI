import { detectBase, hasArabic, toLogical } from './bidi.js';
import { decodeImage, describeImage, type ImageFacts } from './image.js';
import { cropToHeight, findTextLines, orderLines, padBox, splitWide, type Box, type LineBox } from './layout.js';
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
  readonly signal?: AbortSignal;
  readonly includeCrops?: boolean;
}

const PIECE_WIDTH = 896;
const JUNK = /^[\s\-_.,:;'"`~^|\\/()[\]{}<>«»•…*+=]*$/u;

/** Read an image end to end: facts, text lines, text in reading order. */
export async function readImage(bytes: Uint8Array, options: ReadImageOptions): Promise<ImageReading> {
  const started = performance.now();
  const { model } = options;
  const decoded = await decodeImage(bytes);
  const facts = describeImage(decoded);
  const found = findTextLines(decoded.gray, decoded.width, decoded.height, { maxLines: options.maxLines ?? 300 });
  const recognize: Recognizer = options.recognize ?? (async crops => crops.map(crop => recognizeLine(model, crop)));
  const prepared: { line: LineBox; box: Box; pieces: LineCrop[] }[] = [];
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
    const visual = part.map(piece => piece.visual.trim()).filter(Boolean).join(' ');
    const chars = part.reduce((sum, piece) => sum + piece.chars, 0);
    const confidence = chars ? part.reduce((sum, piece) => sum + piece.confidence * piece.chars, 0) / chars : 0;
    if (!visual || JUNK.test(visual) || confidence < minConfidence || (visual.length <= 2 && confidence < 0.8)) { dropped++; continue; }
    const base = detectBase(visual);
    const text = toLogical(visual, base).trim();
    read.push({ box: item.box, visual, text, confidence, direction: base === 'R' ? 'rtl' : 'ltr', ...(options.includeCrops ? { crops: item.pieces } : {}) });
  }
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
