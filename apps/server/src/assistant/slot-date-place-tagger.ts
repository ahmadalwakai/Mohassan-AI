import { createHash } from 'node:crypto';
import { z } from 'zod';
import { slotBioDecode, slotClassifier, slotGruDirection, slotPosteriors } from './slot-tagger-math.js';

/** Inactive five-tag date/place proposals only. No routing/activation, factual truth, resolved dates/places or permission is represented here. */
export const DATE_PLACE_SLOT_TAGGER_FORMAT = 'mohassan-slot-date-place-tagger-ts-v1';
export const DATE_PLACE_SLOT_FEATURE_VERSION = 'slot-token-ngrams-unicode14-v1';
const CANONICAL_VERSION = 'typed-ieee754-be-v1';
const UNICODE_SHA256 = '8f4b98daa142959f0aa45b4e362fb05b8d32caed2487dd915ba7475725f3425a';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WEIGHT_BYTES = 4 * 1024 * 1024;
const MAX_CODEPOINTS = 512;
const MAX_TOKENS = 80;
const CACHE_LIMIT = 512;
export const DATE_PLACE_SLOT_TAGS = ['O', 'B-place', 'I-place', 'B-date', 'I-date'] as const;
export const DATE_PLACE_SLOT_LABELS = ['place', 'date'] as const;
export type DatePlaceSlotLabel = (typeof DATE_PLACE_SLOT_LABELS)[number];
export type DatePlaceAcceptedSlotLabel = 'date' | 'place';
const TENSOR_NAMES = ['embedding.weight', 'encoder.weight_ih_l0', 'encoder.weight_hh_l0', 'encoder.bias_ih_l0', 'encoder.bias_hh_l0', 'encoder.weight_ih_l0_reverse', 'encoder.weight_hh_l0_reverse', 'encoder.bias_ih_l0_reverse', 'encoder.bias_hh_l0_reverse', 'classifier.weight', 'classifier.bias'] as const;
type TensorName = (typeof TENSOR_NAMES)[number];
type Range = readonly [number, number];
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Codepoint = z.number().int().min(0).max(0x10ffff);
const Ranges = z.array(z.tuple([Codepoint, Codepoint])).max(5000);
const Threshold = z.number().finite().min(0).max(1.000001);

export const DatePlaceSlotManifestSchema = z.object({
  format: z.literal(DATE_PLACE_SLOT_TAGGER_FORMAT),
  featureVersion: z.literal(DATE_PLACE_SLOT_FEATURE_VERSION),
  canonicalVersion: z.literal(CANONICAL_VERSION),
  modelId: Hash,
  active: z.literal(false),
  dimensions: z.object({ buckets: z.number().int().min(128).max(65536), embedding: z.number().int().min(4).max(32), hidden: z.number().int().min(4).max(64) }).strict(),
  weights: z.object({
    dtype: z.literal('float32-le'), bytes: z.number().int().positive().max(MAX_WEIGHT_BYTES), sha256: Hash, maxAbsValue: z.literal(64),
    tensors: z.array(z.object({ name: z.enum(TENSOR_NAMES), shape: z.array(z.number().int().positive().max(65536)).min(1).max(2),
      offsetFloats: z.number().int().min(0).max(MAX_WEIGHT_BYTES / 4), count: z.number().int().positive().max(MAX_WEIGHT_BYTES / 4) }).strict()).length(TENSOR_NAMES.length),
  }).strict(),
  labels: z.array(z.enum(DATE_PLACE_SLOT_TAGS)).length(DATE_PLACE_SLOT_TAGS.length),
  unicode: z.object({ version: z.literal('14.0.0'), sha256: Hash, wordRanges: Ranges, digitRanges: Ranges, uppercaseRanges: Ranges, spaceRanges: Ranges,
    assignedRanges: Ranges, lowercaseMap: z.array(z.tuple([Codepoint, z.string().min(1).max(6)])).max(2000) }).strict(),
  calibration: z.object({ temperature: z.number().finite().positive().max(100), thresholds: z.object({ date: Threshold, place: Threshold }).strict(),
    acceptedLabels: z.tuple([z.literal('date'), z.literal('place')]),
    abstainedLabels: z.tuple([]),
    confidence: z.literal('minimum_predicted_tag_posterior') }).strict(),
  source: z.object({ format: z.literal('mohassan-slot-date-place-gru-v2'), run: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    candidate: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), selectionSha256: Hash, planSha256: Hash, modelSha256: Hash, weightsSha256: Hash,
    calibrationSha256: Hash, selectionReportSha256: Hash, paritySha256: Hash, assignmentHash: Hash }).strict(),
  limits: z.object({ maxTextCodepoints: z.literal(MAX_CODEPOINTS), maxTokens: z.literal(MAX_TOKENS), maxWeightBytes: z.literal(MAX_WEIGHT_BYTES) }).strict(),
}).strict();
export type DatePlaceSlotManifest = z.infer<typeof DatePlaceSlotManifestSchema>;

export class DatePlaceSlotTaggerError extends Error {
  constructor(readonly code: 'manifest_invalid' | 'model_id_mismatch' | 'weights_invalid' | 'unicode_invalid' | 'input_invalid' | 'inference_invalid') {
    super(`DATE_PLACE_SLOT_TAGGER_${code.toUpperCase()}`);
  }
}

/** Portable JSON addressing: all numbers are represented by their IEEE754 bytes. */
function typedCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    return `{"$f64":"${bytes.toString('hex')}"}`;
  }
  if (Array.isArray(value)) return `[${value.map(typedCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${typedCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new DatePlaceSlotTaggerError('manifest_invalid');
}

export function datePlaceSlotModelId(manifest: Omit<DatePlaceSlotManifest, 'modelId'>): string {
  return digest(typedCanonical(manifest));
}

function boundedJson(value: unknown): unknown {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    if ((typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength) > MAX_MANIFEST_BYTES) throw new DatePlaceSlotTaggerError('manifest_invalid');
    try { value = JSON.parse(typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value)); }
    catch { throw new DatePlaceSlotTaggerError('manifest_invalid'); }
  }
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0, characters = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 30000 || item.depth > 8) throw new DatePlaceSlotTaggerError('manifest_invalid');
    if (typeof item.value === 'string') characters += item.value.length;
    else if (item.value && typeof item.value === 'object') {
      if (seen.has(item.value)) throw new DatePlaceSlotTaggerError('manifest_invalid');
      seen.add(item.value);
      if (Array.isArray(item.value)) {
        if (item.value.length > 5000 || Object.getPrototypeOf(item.value) !== Array.prototype || Object.getOwnPropertySymbols(item.value).length) throw new DatePlaceSlotTaggerError('manifest_invalid');
        const descriptors = Object.getOwnPropertyDescriptors(item.value);
        if (Object.keys(descriptors).some(key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))) throw new DatePlaceSlotTaggerError('manifest_invalid');
        for (let index = 0; index < item.value.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new DatePlaceSlotTaggerError('manifest_invalid');
          pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      } else {
        const prototype = Object.getPrototypeOf(item.value);
        if (prototype !== Object.prototype && prototype !== null) throw new DatePlaceSlotTaggerError('manifest_invalid');
        const descriptors = Object.getOwnPropertyDescriptors(item.value);
        if (Object.keys(descriptors).length > 32 || Object.getOwnPropertySymbols(item.value).length) throw new DatePlaceSlotTaggerError('manifest_invalid');
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!('value' in descriptor) || !descriptor.enumerable) throw new DatePlaceSlotTaggerError('manifest_invalid');
          characters += key.length;
          pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      }
    } else if (item.value !== null && !['number', 'boolean'].includes(typeof item.value)) throw new DatePlaceSlotTaggerError('manifest_invalid');
    if (characters > MAX_MANIFEST_BYTES) throw new DatePlaceSlotTaggerError('manifest_invalid');
  }
  return value;
}

function inRanges(value: number, ranges: readonly Range[]): boolean {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const index = (low + high) >>> 1, range = ranges[index];
    if (value < range[0]) high = index - 1;
    else if (value > range[1]) low = index + 1;
    else return true;
  }
  return false;
}

function validRanges(ranges: readonly Range[]) {
  let previous = -1;
  return ranges.every(range => {
    const valid = range[0] <= range[1] && range[0] > previous;
    previous = range[1]; return valid;
  });
}

interface Token {
  readonly text: string;
  readonly startCodepoint: number;
  readonly endCodepoint: number;
  readonly startUtf16: number;
  readonly endUtf16: number;
}
interface LiteralSpan extends Omit<Token, 'text'> { readonly text: string }
export interface DatePlaceSlotHypothesis extends LiteralSpan {
  readonly kind: 'hypothesis';
  readonly label: DatePlaceAcceptedSlotLabel;
  readonly confidence: number;
  readonly threshold: number;
}
export interface RawDatePlaceSlotDiagnostic extends LiteralSpan {
  readonly label: DatePlaceSlotLabel;
  readonly confidence: number;
  readonly reason: 'accepted' | 'below_threshold' | 'label_abstained';
}
export interface DatePlaceSlotResult {
  readonly scope: 'inactive_date_place_hypotheses';
  readonly active: false;
  readonly modelId: string;
  readonly tokenCount: number;
  readonly hypotheses: readonly DatePlaceSlotHypothesis[];
  readonly raw: readonly RawDatePlaceSlotDiagnostic[];
}
export interface DatePlaceSlotInspection extends DatePlaceSlotResult {
  readonly tokens: readonly Token[];
  readonly featureIds: readonly (readonly number[])[];
  readonly flags: readonly (readonly number[])[];
  readonly logits: readonly (readonly number[])[];
  readonly tags: readonly number[];
}
export interface ReadonlyDatePlaceSlotTagger {
  readonly active: false;
  readonly modelId: string;
  readonly weightsBytes: number;
  infer(text: string): DatePlaceSlotResult;
  inspect(text: string): DatePlaceSlotInspection;
}

function expectedShapes(buckets: number, dim: number, hidden: number): Record<TensorName, number[]> {
  return { 'embedding.weight': [buckets, dim], 'encoder.weight_ih_l0': [3 * hidden, dim + 6], 'encoder.weight_hh_l0': [3 * hidden, hidden],
    'encoder.bias_ih_l0': [3 * hidden], 'encoder.bias_hh_l0': [3 * hidden], 'encoder.weight_ih_l0_reverse': [3 * hidden, dim + 6],
    'encoder.weight_hh_l0_reverse': [3 * hidden, hidden], 'encoder.bias_ih_l0_reverse': [3 * hidden], 'encoder.bias_hh_l0_reverse': [3 * hidden],
    'classifier.weight': [DATE_PLACE_SLOT_TAGS.length, 2 * hidden], 'classifier.bias': [DATE_PLACE_SLOT_TAGS.length] };
}

/** Validates/copies a separately versioned inactive five-tag model. The caller MUST supply a trusted, independently pinned model ID. */
export function loadDatePlaceSlotTagger(manifestInput: unknown, bytes: Uint8Array, options: { expectedModelId: string; cacheEmbeddings?: boolean }): ReadonlyDatePlaceSlotTagger {
  if (!options || !Hash.safeParse(options.expectedModelId).success) throw new DatePlaceSlotTaggerError('model_id_mismatch');
  const parsed = DatePlaceSlotManifestSchema.safeParse(boundedJson(manifestInput));
  if (!parsed.success) throw new DatePlaceSlotTaggerError('manifest_invalid');
  const manifest = parsed.data;
  const { modelId, ...body } = manifest;
  if (datePlaceSlotModelId(body) !== modelId || options.expectedModelId !== modelId) throw new DatePlaceSlotTaggerError('model_id_mismatch');
  const { buckets, embedding: dim, hidden } = manifest.dimensions;
  if ((buckets & (buckets - 1)) !== 0 || manifest.labels.some((tag, index) => tag !== DATE_PLACE_SLOT_TAGS[index])) throw new DatePlaceSlotTaggerError('manifest_invalid');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== manifest.weights.bytes || bytes.byteLength > MAX_WEIGHT_BYTES || bytes.byteLength % 4 !== 0) throw new DatePlaceSlotTaggerError('weights_invalid');
  const copied = Uint8Array.from(bytes);
  if (digest(copied) !== manifest.weights.sha256 || manifest.source.weightsSha256 !== manifest.weights.sha256) throw new DatePlaceSlotTaggerError('weights_invalid');
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const floats = littleEndian ? new Float32Array(copied.buffer) : Float32Array.from({ length: copied.length / 4 }, (_, index) => new DataView(copied.buffer).getFloat32(index * 4, true));
  for (const value of floats) if (!Number.isFinite(value) || Math.abs(value) > manifest.weights.maxAbsValue) throw new DatePlaceSlotTaggerError('weights_invalid');
  const shapes = expectedShapes(buckets, dim, hidden);
  const tensors = {} as Record<TensorName, Float32Array>;
  let offset = 0;
  for (const [index, tensor] of manifest.weights.tensors.entries()) {
    if (tensor.name !== TENSOR_NAMES[index] || tensor.offsetFloats !== offset || tensor.shape.length !== shapes[tensor.name].length
      || tensor.shape.some((size, position) => size !== shapes[tensor.name][position]) || tensor.count !== tensor.shape.reduce((product, size) => product * size, 1)) throw new DatePlaceSlotTaggerError('weights_invalid');
    offset += tensor.count;
    if (offset > floats.length) throw new DatePlaceSlotTaggerError('weights_invalid');
    tensors[tensor.name] = floats.subarray(tensor.offsetFloats, offset);
  }
  if (offset !== floats.length) throw new DatePlaceSlotTaggerError('weights_invalid');
  const { sha256: unicodeHash, ...unicode } = manifest.unicode;
  if (unicodeHash !== UNICODE_SHA256 || digest(typedCanonical(unicode)) !== unicodeHash
    || ![unicode.wordRanges, unicode.digitRanges, unicode.uppercaseRanges, unicode.spaceRanges, unicode.assignedRanges].every(validRanges)) throw new DatePlaceSlotTaggerError('unicode_invalid');
  let previous = -1;
  for (const [codepoint] of unicode.lowercaseMap) {
    if (codepoint <= previous) throw new DatePlaceSlotTaggerError('unicode_invalid'); previous = codepoint;
  }
  const lower = new Map(unicode.lowercaseMap);

  function tokenize(text: string): Token[] {
    if (typeof text !== 'string' || !text || text.length > MAX_CODEPOINTS * 2) throw new DatePlaceSlotTaggerError('input_invalid');
    let count = 0, nonSpace = false;
    // Validate the complete input before allocating token or model-output arrays.
    for (const char of text) {
      const codepoint = char.codePointAt(0)!;
      if (++count > MAX_CODEPOINTS || !inRanges(codepoint, unicode.assignedRanges)) throw new DatePlaceSlotTaggerError('input_invalid');
      nonSpace ||= !inRanges(codepoint, unicode.spaceRanges);
    }
    if (!nonSpace) throw new DatePlaceSlotTaggerError('input_invalid');
    const tokens: Token[] = [];
    let codepointIndex = 0, utf16Index = 0, startCp = -1, startUtf16 = -1;
    const append = (startCodepoint: number, endCodepoint: number, start: number, end: number) => {
      if (tokens.length >= MAX_TOKENS) throw new DatePlaceSlotTaggerError('input_invalid');
      tokens.push(Object.freeze({ text: text.slice(start, end), startCodepoint, endCodepoint, startUtf16: start, endUtf16: end }));
    };
    const flush = () => {
      if (startCp >= 0) append(startCp, codepointIndex, startUtf16, utf16Index);
      startCp = startUtf16 = -1;
    };
    for (const char of text) {
      const value = char.codePointAt(0)!;
      if (inRanges(value, unicode.wordRanges)) {
        if (startCp < 0) { startCp = codepointIndex; startUtf16 = utf16Index; }
      } else {
        flush();
        if (!inRanges(value, unicode.spaceRanges)) append(codepointIndex, codepointIndex + 1, utf16Index, utf16Index + char.length);
      }
      codepointIndex += 1; utf16Index += char.length;
    }
    flush();
    return tokens;
  }

  function foldToken(text: string): string {
    const normalized = text.normalize('NFC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
    let value = '';
    for (const char of normalized) {
      const codepoint = char.codePointAt(0)!;
      const digit = codepoint >= 0x660 && codepoint <= 0x669 ? String(codepoint - 0x660)
        : codepoint >= 0x6f0 && codepoint <= 0x6f9 ? String(codepoint - 0x6f0) : lower.get(codepoint) ?? char;
      for (const folded of digit) value += inRanges(folded.codePointAt(0)!, unicode.spaceRanges) ? ' ' : folded;
    }
    return value.replace(/ +/g, ' ').replace(/^ +| +$/g, '');
  }

  // No source-token cache by default. An explicit host-only benchmark may opt in.
  const embeddingCache = options.cacheEmbeddings === true ? new Map<string, Float64Array>() : undefined;
  function features(text: string): number[] {
    const marked = ['^', ...foldToken(text), '$'];
    const hashed = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0) & (buckets - 1);
    const ids = [hashed(`token:${marked.join('')}`)];
    for (const size of [2, 3, 4]) for (let index = 0; index <= marked.length - size; index++) ids.push(hashed(`c${size}:${marked.slice(index, index + size).join('')}`));
    if (ids.length > 1600) throw new DatePlaceSlotTaggerError('input_invalid');
    return ids;
  }

  function flags(token: Token): number[] {
    let arabic = false, latin = false, digit = false, uppercase = false, punctuation = true;
    for (const char of token.text) {
      const value = char.codePointAt(0)!;
      const lowered = lower.get(value) ?? char;
      arabic ||= value >= 0x600 && value <= 0x6ff;
      latin ||= lowered >= 'a' && lowered <= 'z';
      digit ||= inRanges(value, unicode.digitRanges);
      uppercase ||= inRanges(value, unicode.uppercaseRanges);
      punctuation &&= value === 95 || !inRanges(value, unicode.wordRanges);
    }
    return [Number(arabic), Number(latin), Number(digit), Number(uppercase), Number(punctuation), Math.min(token.endCodepoint - token.startCodepoint, 20) / 20];
  }

  function embedding(text: string, ids: readonly number[]): Float64Array {
    const key = embeddingCache ? foldToken(text) : '';
    const cached = embeddingCache?.get(key);
    if (cached) return cached;
    const vector = new Float64Array(dim);
    for (const id of ids) for (let index = 0; index < dim; index++) vector[index] += tensors['embedding.weight'][id * dim + index];
    for (let index = 0; index < dim; index++) vector[index] /= ids.length;
    if (embeddingCache) {
      if (embeddingCache.size >= CACHE_LIMIT) embeddingCache.delete(embeddingCache.keys().next().value!);
      embeddingCache.set(key, vector);
    }
    return vector;
  }

  function direction(inputs: readonly Float64Array[], reverse: boolean): Float64Array[] {
    return slotGruDirection(inputs, hidden, tensors, reverse, () => { throw new DatePlaceSlotTaggerError('inference_invalid'); });
  }

  function decode(logits: readonly Float64Array[]): number[] {
    return slotBioDecode(logits, DATE_PLACE_SLOT_TAGS, () => { throw new DatePlaceSlotTaggerError('inference_invalid'); });
  }

  function evaluate(text: string, inspect: boolean): DatePlaceSlotResult | DatePlaceSlotInspection {
    const tokens = tokenize(text);
    const ids = tokens.map(token => features(token.text)), shapeFlags = tokens.map(flags);
    const inputs = tokens.map((token, index) => Float64Array.from([...embedding(token.text, ids[index]), ...shapeFlags[index]]));
    const forward = direction(inputs, false), backward = direction(inputs, true);
    const logits = slotClassifier(forward, backward, hidden, DATE_PLACE_SLOT_TAGS.length, tensors['classifier.weight'], tensors['classifier.bias'],
      () => { throw new DatePlaceSlotTaggerError('inference_invalid'); });
    const tags = decode(logits);
    const probabilities = slotPosteriors(logits, manifest.calibration.temperature, () => { throw new DatePlaceSlotTaggerError('inference_invalid'); });
    const raw: RawDatePlaceSlotDiagnostic[] = [], hypotheses: DatePlaceSlotHypothesis[] = [];
    let index = 0;
    while (index < tags.length) {
      const tag = DATE_PLACE_SLOT_TAGS[tags[index]];
      if (tag === 'O') { index++; continue; }
      if (!tag.startsWith('B-')) throw new DatePlaceSlotTaggerError('inference_invalid');
      const label = tag.slice(2) as DatePlaceSlotLabel, start = index;
      index++;
      while (index < tags.length && DATE_PLACE_SLOT_TAGS[tags[index]] === `I-${label}`) index++;
      let confidence = 1;
      for (let token = start; token < index; token++) confidence = Math.min(confidence, probabilities[token][tags[token]]);
      if (!Number.isFinite(confidence)) throw new DatePlaceSlotTaggerError('inference_invalid');
      const first = tokens[start], last = tokens[index - 1];
      const threshold = label === 'date' || label === 'place' ? manifest.calibration.thresholds[label] : undefined;
      const reason = threshold === undefined || threshold > 1 ? 'label_abstained' : confidence >= threshold ? 'accepted' : 'below_threshold';
      const span = { label, text: text.slice(first.startUtf16, last.endUtf16), startCodepoint: first.startCodepoint, endCodepoint: last.endCodepoint,
        startUtf16: first.startUtf16, endUtf16: last.endUtf16, confidence };
      raw.push(Object.freeze({ ...span, reason }));
      if (reason === 'accepted' && (label === 'date' || label === 'place')) hypotheses.push(Object.freeze({ ...span, label, kind: 'hypothesis', threshold: threshold! }));
    }
    const result: DatePlaceSlotResult = Object.freeze({ scope: 'inactive_date_place_hypotheses', active: false, modelId, tokenCount: tokens.length, raw: Object.freeze(raw), hypotheses: Object.freeze(hypotheses) });
    if (!inspect) return result;
    return Object.freeze({ ...result, tokens: Object.freeze(tokens), featureIds: Object.freeze(ids.map(values => Object.freeze(values))),
      flags: Object.freeze(shapeFlags.map(values => Object.freeze(values))), logits: Object.freeze(logits.map(values => Object.freeze(Array.from(values)))), tags: Object.freeze(tags) });
  }

  return Object.freeze({ active: false, modelId, weightsBytes: copied.byteLength,
    infer: (text: string) => evaluate(text, false) as DatePlaceSlotResult,
    inspect: (text: string) => evaluate(text, true) as DatePlaceSlotInspection });
}
