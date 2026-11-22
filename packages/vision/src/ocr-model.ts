import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Tensor } from './ocr-math.js';

/** The exported own OCR model: a validated manifest plus float32 tensors. */
export const OCR_FORMAT = 'mohassan-ocr-ts-v1';
export const MAX_OCR_WEIGHT_BYTES = 16 * 1024 * 1024;
export const MAX_OCR_MANIFEST_BYTES = 512 * 1024;
export const TENSOR_NAMES = ['conv0.weight', 'conv0.bias', 'conv1.weight', 'conv1.bias', 'conv2.weight', 'conv2.bias', 'conv3.weight', 'conv3.bias', 'conv4.weight', 'conv4.bias',
  'rnn.weight_ih_l0', 'rnn.weight_hh_l0', 'rnn.bias_ih_l0', 'rnn.bias_hh_l0', 'rnn.weight_ih_l0_reverse', 'rnn.weight_hh_l0_reverse', 'rnn.bias_ih_l0_reverse', 'rnn.bias_hh_l0_reverse',
  'fc.weight', 'fc.bias'] as const;
export type TensorName = (typeof TENSOR_NAMES)[number];
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Pool = z.union([z.tuple([z.number().int().min(1).max(4), z.number().int().min(1).max(4)]), z.null()]);

export const OcrManifestSchema = z.object({
  format: z.literal(OCR_FORMAT),
  modelId: Hash,
  createdAt: z.string().max(40),
  input: z.object({ height: z.literal(32), channels: z.literal(1), normalize: z.object({ mean: z.number().finite(), std: z.number().finite().positive() }).strict(),
    downsample: z.literal(4), maxWidth: z.number().int().min(64).max(4096) }).strict(),
  architecture: z.object({ channels: z.array(z.number().int().min(1).max(512)).length(5), hidden: z.number().int().min(8).max(512), pools: z.array(Pool).length(5),
    classes: z.number().int().min(2).max(1024) }).strict(),
  classes: z.array(z.string().min(1).max(8)).min(2).max(1024),
  weights: z.object({ dtype: z.literal('float32-le'), bytes: z.number().int().positive().max(MAX_OCR_WEIGHT_BYTES), sha256: Hash, maxAbsValue: z.number().finite().positive().max(1000),
    tensors: z.array(z.object({ name: z.enum(TENSOR_NAMES), shape: z.array(z.number().int().positive().max(65536)).min(1).max(4),
      offsetFloats: z.number().int().min(0), count: z.number().int().positive() }).strict()).length(TENSOR_NAMES.length) }).strict(),
  training: z.object({}).passthrough().optional(),
  source: z.object({}).passthrough().optional(),
}).strict();
export type OcrManifest = z.infer<typeof OcrManifestSchema>;

export class OcrModelError extends Error {
  constructor(readonly code: 'manifest_invalid' | 'weights_invalid' | 'shape_invalid') { super(`OCR_MODEL_${code.toUpperCase()}`); }
}

export interface OcrModel {
  readonly manifest: OcrManifest;
  readonly modelId: string;
  readonly classes: readonly string[];
  readonly height: 32;
  readonly downsample: 4;
  readonly maxWidth: number;
  readonly normalize: { readonly mean: number; readonly std: number };
  readonly channels: readonly number[];
  readonly hidden: number;
  readonly pools: readonly (readonly [number, number] | null)[];
  readonly tensors: Readonly<Record<TensorName, Tensor>>;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function expectedShapes(manifest: OcrManifest): Record<TensorName, number[]> {
  const [c1, c2, c3, c4, c5] = manifest.architecture.channels, hidden = manifest.architecture.hidden, classes = manifest.architecture.classes;
  const gru = (input: number): Record<string, number[]> => ({ weight_ih: [3 * hidden, input], weight_hh: [3 * hidden, hidden], bias_ih: [3 * hidden], bias_hh: [3 * hidden] });
  const forward = gru(c5 * 2), backward = gru(c5 * 2);
  return {
    'conv0.weight': [c1, 1, 3, 3], 'conv0.bias': [c1], 'conv1.weight': [c2, c1, 3, 3], 'conv1.bias': [c2], 'conv2.weight': [c3, c2, 3, 3], 'conv2.bias': [c3],
    'conv3.weight': [c4, c3, 3, 3], 'conv3.bias': [c4], 'conv4.weight': [c5, c4, 3, 3], 'conv4.bias': [c5],
    'rnn.weight_ih_l0': forward.weight_ih, 'rnn.weight_hh_l0': forward.weight_hh, 'rnn.bias_ih_l0': forward.bias_ih, 'rnn.bias_hh_l0': forward.bias_hh,
    'rnn.weight_ih_l0_reverse': backward.weight_ih, 'rnn.weight_hh_l0_reverse': backward.weight_hh, 'rnn.bias_ih_l0_reverse': backward.bias_ih, 'rnn.bias_hh_l0_reverse': backward.bias_hh,
    'fc.weight': [classes, 2 * hidden], 'fc.bias': [classes],
  };
}

/** Validate manifest and weights completely before any arithmetic runs on them. */
export function loadOcrModelFromBytes(manifestBytes: Uint8Array, weightsBytes: Uint8Array): OcrModel {
  if (manifestBytes.byteLength > MAX_OCR_MANIFEST_BYTES) throw new OcrModelError('manifest_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch { throw new OcrModelError('manifest_invalid'); }
  const result = OcrManifestSchema.safeParse(parsed);
  if (!result.success) throw new OcrModelError('manifest_invalid');
  const manifest = result.data;
  if (manifest.classes.length !== manifest.architecture.classes || manifest.classes[0] !== '<blank>' || new Set(manifest.classes).size !== manifest.classes.length) throw new OcrModelError('manifest_invalid');
  if (weightsBytes.byteLength !== manifest.weights.bytes || weightsBytes.byteLength % 4 !== 0 || weightsBytes.byteLength > MAX_OCR_WEIGHT_BYTES) throw new OcrModelError('weights_invalid');
  const copied = new Uint8Array(new ArrayBuffer(weightsBytes.byteLength));
  copied.set(weightsBytes);
  const sha = digest(copied);
  if (sha !== manifest.weights.sha256 || sha !== manifest.modelId) throw new OcrModelError('weights_invalid');
  const floats = new Float32Array(copied.buffer);
  const limit = manifest.weights.maxAbsValue + 1e-3;
  for (let i = 0; i < floats.length; i++) if (!Number.isFinite(floats[i]) || Math.abs(floats[i]) > limit) throw new OcrModelError('weights_invalid');
  const shapes = expectedShapes(manifest);
  const tensors = {} as Record<TensorName, Tensor>;
  let offset = 0;
  const seen = new Set<string>();
  for (const [index, entry] of manifest.weights.tensors.entries()) {
    if (entry.name !== TENSOR_NAMES[index] || seen.has(entry.name) || entry.offsetFloats !== offset) throw new OcrModelError('shape_invalid');
    const expected = shapes[entry.name];
    if (entry.shape.length !== expected.length || entry.shape.some((size, position) => size !== expected[position])) throw new OcrModelError('shape_invalid');
    const count = entry.shape.reduce((product, size) => product * size, 1);
    if (count !== entry.count || offset + count > floats.length) throw new OcrModelError('shape_invalid');
    tensors[entry.name] = { shape: Object.freeze(entry.shape.slice()), data: floats.subarray(offset, offset + count) };
    seen.add(entry.name);
    offset += count;
  }
  if (offset !== floats.length) throw new OcrModelError('shape_invalid');
  return Object.freeze({
    manifest, modelId: manifest.modelId, classes: Object.freeze(manifest.classes.slice()), height: 32, downsample: 4, maxWidth: manifest.input.maxWidth,
    normalize: Object.freeze({ ...manifest.input.normalize }), channels: Object.freeze(manifest.architecture.channels.slice()), hidden: manifest.architecture.hidden,
    pools: Object.freeze(manifest.architecture.pools.map(pool => pool ? Object.freeze([pool[0], pool[1]] as const) : null)), tensors: Object.freeze(tensors),
  });
}

export async function readOcrModelFiles(dir: string): Promise<{ manifestBytes: Uint8Array; weightsBytes: Uint8Array }> {
  const [manifestBytes, weightsBytes] = await Promise.all([readFile(join(dir, 'manifest.json')), readFile(join(dir, 'weights.bin'))]);
  return { manifestBytes: new Uint8Array(manifestBytes), weightsBytes: new Uint8Array(weightsBytes) };
}

export async function loadOcrModel(dir: string): Promise<OcrModel> {
  const files = await readOcrModelFiles(dir);
  return loadOcrModelFromBytes(files.manifestBytes, files.weightsBytes);
}
