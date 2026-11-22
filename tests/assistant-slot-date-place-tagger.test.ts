import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATE_PLACE_SLOT_TAGS, DatePlaceSlotManifestSchema, DatePlaceSlotTaggerError, datePlaceSlotModelId, loadDatePlaceSlotTagger,
  type DatePlaceSlotManifest } from '../apps/server/src/assistant/slot-date-place-tagger.js';
import { loadSlotTagger } from '../apps/server/src/assistant/slot-tagger.js';
import { slotBioDecode, slotClassifier, slotGruDirection } from '../apps/server/src/assistant/slot-tagger-math.js';

const directory = path.resolve('artifacts/brain-slot-date-place-typescript-v1/typescript-export-v1-20261121-a');
const PIN = '4443f07d0322db1326de784b5aae4b04023cd4b3125877a8de854bf7d96e9314';
const fixture13 = path.resolve('tests/fixtures/slot-tagger-v1');
const source13 = JSON.parse(readFileSync(path.join(fixture13, 'manifest.json'), 'utf8'));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const identified = (value: DatePlaceSlotManifest): DatePlaceSlotManifest => { const { modelId: _id, ...body } = value; return { ...value, modelId: datePlaceSlotModelId(body) }; };
function tiny() {
  // In-memory structural fixture only: no trained weights, output artifact or quality claim.
  const buckets = 128, embedding = 4, hidden = 4;
  const shapes: Record<string, number[]> = { 'embedding.weight': [buckets, embedding], 'encoder.weight_ih_l0': [12, 10], 'encoder.weight_hh_l0': [12, hidden],
    'encoder.bias_ih_l0': [12], 'encoder.bias_hh_l0': [12], 'encoder.weight_ih_l0_reverse': [12, 10], 'encoder.weight_hh_l0_reverse': [12, hidden],
    'encoder.bias_ih_l0_reverse': [12], 'encoder.bias_hh_l0_reverse': [12], 'classifier.weight': [5, 8], 'classifier.bias': [5] };
  let count = 0;
  const tensors = Object.entries(shapes).map(([name, shape]) => { const total = shape.reduce((a, b) => a * b, 1), entry = { name, shape, offsetFloats: count, count: total }; count += total; return entry; });
  const weights = Buffer.alloc(count * 4), last = tensors.at(-1)!;
  weights.writeFloatLE(2, (last.offsetFloats + 3) * 4); weights.writeFloatLE(1.8, (last.offsetFloats + 4) * 4);
  const { modelId: _id, ...old } = source13;
  const body = DatePlaceSlotManifestSchema.omit({ modelId: true }).parse({ ...old, format: 'mohassan-slot-date-place-tagger-ts-v1', dimensions: { buckets, embedding, hidden },
    weights: { dtype: 'float32-le', bytes: weights.length, sha256: hash(weights), maxAbsValue: 64, tensors }, labels: [...DATE_PLACE_SLOT_TAGS],
    calibration: { temperature: 1, thresholds: { date: 0.1, place: 0.9 }, acceptedLabels: ['date', 'place'], abstainedLabels: [], confidence: 'minimum_predicted_tag_posterior' },
    source: { format: 'mohassan-slot-date-place-gru-v2', run: 'unit-fixture-untrained', candidate: 'unit-fixture-untrained', selectionSha256: '0'.repeat(64), planSha256: '0'.repeat(64),
      modelSha256: '0'.repeat(64), weightsSha256: hash(weights), calibrationSha256: '0'.repeat(64), selectionReportSha256: '0'.repeat(64), paritySha256: '0'.repeat(64), assignmentHash: '0'.repeat(64) } });
  return { manifest: { ...body, modelId: datePlaceSlotModelId(body) }, weights };
}
const load = (manifest: DatePlaceSlotManifest, weights: Uint8Array) => loadDatePlaceSlotTagger(manifest, weights, { expectedModelId: manifest.modelId });

describe('strict inactive five-tag model contract', () => {
  it('requires a trusted content pin and rejects the old format in both directions', () => {
    const test = tiny();
    expect(() => loadDatePlaceSlotTagger(test.manifest, test.weights, undefined as never)).toThrow(DatePlaceSlotTaggerError);
    expect(() => loadDatePlaceSlotTagger(test.manifest, test.weights, { expectedModelId: '0'.repeat(64) })).toThrow(DatePlaceSlotTaggerError);
    expect(() => loadDatePlaceSlotTagger(source13, readFileSync(path.join(fixture13, 'weights.bin')), { expectedModelId: source13.modelId })).toThrow(DatePlaceSlotTaggerError);
    expect(() => loadSlotTagger(test.manifest, test.weights)).toThrow();
  });
  it('accepts bounded metadata objects, JSON and UTF8 bytes and exposes only inactive proposals', () => {
    const test = tiny();
    for (const input of [test.manifest, JSON.stringify(test.manifest), Buffer.from(JSON.stringify(test.manifest))]) {
      const model = loadDatePlaceSlotTagger(input, test.weights, { expectedModelId: test.manifest.modelId }), result = model.infer('A synthetic input.');
      expect(model.active).toBe(false); expect(result).toMatchObject({ scope: 'inactive_date_place_hypotheses', active: false, modelId: test.manifest.modelId });
      expect(result.hypotheses.every(item => item.kind === 'hypothesis' && ['date', 'place'].includes(item.label))).toBe(true);
      expect(result).not.toHaveProperty('facts'); expect(result).not.toHaveProperty('actions'); expect(model).not.toHaveProperty('activate');
      expect(Object.isFrozen(model)).toBe(true); expect(Object.isFrozen(result.hypotheses)).toBe(true);
    }
  });
  it.each(['active', 'tags', 'bucket', 'shape', 'offset', 'count', 'extra', 'calibration'] as const)('rejects self-consistent but invalid %s metadata', mutation => {
    const test = tiny(), manifest = structuredClone(test.manifest);
    if (mutation === 'active') (manifest as { active: boolean }).active = true;
    if (mutation === 'tags') [manifest.labels[1], manifest.labels[3]] = [manifest.labels[3], manifest.labels[1]];
    if (mutation === 'bucket') manifest.dimensions.buckets = 129;
    if (mutation === 'shape') manifest.weights.tensors.at(-2)!.shape[0] = 13;
    if (mutation === 'offset') manifest.weights.tensors[1]!.offsetFloats++;
    if (mutation === 'count') manifest.weights.tensors[1]!.count++;
    if (mutation === 'extra') (manifest as unknown as Record<string, unknown>).permission = true;
    if (mutation === 'calibration') manifest.calibration.thresholds.date = -0.1;
    expect(() => load(identified(manifest), test.weights)).toThrow(DatePlaceSlotTaggerError);
  });
  it.each([NaN, Infinity, -Infinity, 64.5, -65])('rejects invalid float %s even after hash and modelId recomputation', value => {
    const test = tiny(), bytes = Buffer.from(test.weights); bytes.writeFloatLE(value, 0);
    const manifest = structuredClone(test.manifest); manifest.weights.sha256 = manifest.source.weightsSha256 = hash(bytes);
    expect(() => load(identified(manifest), bytes)).toThrowError(expect.objectContaining({ code: 'weights_invalid' }));
  });
  it('rejects truncation, trailing bytes, excessive bytes and source-weight hash disagreement', () => {
    const test = tiny();
    for (const bytes of [test.weights.subarray(4), Buffer.concat([test.weights, Buffer.alloc(4)]), Buffer.alloc(4 * 1024 * 1024 + 4)])
      expect(() => load(test.manifest, bytes)).toThrow(DatePlaceSlotTaggerError);
    const changed = structuredClone(test.manifest); changed.source.weightsSha256 = '0'.repeat(64);
    expect(() => load(identified(changed), test.weights)).toThrowError(expect.objectContaining({ code: 'weights_invalid' }));
  });
  it('rejects changed Unicode contracts, cyclic metadata, getters, oversized structures and malformed JSON without invoking accessors', () => {
    const test = tiny(), unicode = structuredClone(test.manifest); unicode.unicode.wordRanges[0][0]++;
    expect(() => load(identified(unicode), test.weights)).toThrowError(expect.objectContaining({ code: 'unicode_invalid' }));
    const cyclic: Record<string, unknown> = { ...test.manifest }; cyclic.self = cyclic;
    const getter = vi.fn(() => true), accessor = { ...test.manifest }; Object.defineProperty(accessor, 'unsafe', { enumerable: true, get: getter });
    for (const input of [cyclic, accessor, { ...test.manifest, extra: 'x'.repeat(256 * 1024 + 1) }, '[', Buffer.from([0xff, 0xfe])])
      expect(() => loadDatePlaceSlotTagger(input, test.weights, { expectedModelId: test.manifest.modelId })).toThrow(DatePlaceSlotTaggerError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('copies weights and metadata, and keeps token caches disabled by default', () => {
    const test = tiny(), model = load(test.manifest, test.weights), expected = model.inspect('Uniqueprivatezyx in Oslo tomorrow.');
    test.weights.fill(255); test.manifest.calibration.thresholds.date = 1.000001;
    const set = vi.spyOn(Map.prototype, 'set');
    try {
      expect(model.inspect('Uniqueprivatezyx in Oslo tomorrow.')).toEqual(expected);
      expect(set.mock.calls.some(([key]) => key === 'uniqueprivatezyx' || key === 'oslo' || key === 'tomorrow')).toBe(false);
    } finally { set.mockRestore(); }
    const other = tiny(), cached = loadDatePlaceSlotTagger(other.manifest, other.weights, { expectedModelId: other.manifest.modelId, cacheEmbeddings: true });
    expect(cached.inspect('Uniqueprivatezyx in Oslo tomorrow.')).toEqual(expected);
  });
  it.each(['', ' '.repeat(10), 'x'.repeat(513), 'x '.repeat(81), '\ud800', '\u0378'])('bounds or rejects unsupported input %j before inference', input => {
    const test = tiny(), model = load(test.manifest, test.weights);
    expect(() => model.infer(input)).toThrowError(expect.objectContaining({ code: 'input_invalid' }));
  });
});

describe('independent bounded arithmetic checks', () => {
  const fail = (): never => { throw new Error('bounded-math-invalid'); };
  it('matches a closed-form GRU recurrence in both directions and a separately computed linear projection', () => {
    const hidden = 4, tensors: Record<string, Float32Array> = {};
    for (const suffix of ['', '_reverse']) {
      tensors[`encoder.weight_ih_l0${suffix}`] = new Float32Array(120); tensors[`encoder.weight_hh_l0${suffix}`] = new Float32Array(48);
      const incoming = tensors[`encoder.bias_ih_l0${suffix}`] = new Float32Array(12), recurrent = tensors[`encoder.bias_hh_l0${suffix}`] = new Float32Array(12);
      incoming.fill(0.25, 8); recurrent.fill(0.5, 8);
    }
    const inputs = Array.from({ length: 3 }, () => new Float64Array(10)), forward = slotGruDirection(inputs, hidden, tensors, false, fail), backward = slotGruDirection(inputs, hidden, tensors, true, fail);
    for (let index = 0; index < 3; index++) {
      for (const value of forward[index]!) expect(value).toBeCloseTo(Math.tanh(0.5) * (1 - 0.5 ** (index + 1)), 15);
      for (const value of backward[index]!) expect(value).toBeCloseTo(Math.tanh(0.5) * (1 - 0.5 ** (3 - index)), 15);
    }
    const weights = new Float32Array(40); weights[3 * 8] = 1; weights[3 * 8 + 4] = 2;
    const projected = slotClassifier(forward, backward, hidden, 5, weights, new Float32Array(5), fail);
    for (let index = 0; index < 3; index++) expect(Array.from(projected[index]!)).toEqual([0, 0, 0, forward[index]![0]! + 2 * backward[index]![0]!, 0]);
  });
  it('preserves legal BIO starts/transitions and deterministic ties, and rejects over-budget shapes', () => {
    const rows = [new Float64Array([0, 0, 100, 0, 100]), new Float64Array([0, 0, 10, 0, 10])];
    const decoded = slotBioDecode(rows, DATE_PLACE_SLOT_TAGS, fail); expect([2, 4]).not.toContain(decoded[0]);
    for (let i = 1; i < decoded.length; i++) if ([2, 4].includes(decoded[i]!)) expect([decoded[i]! - 1, decoded[i]!]).toContain(decoded[i - 1]);
    expect(slotBioDecode([new Float64Array(5), new Float64Array(5)], DATE_PLACE_SLOT_TAGS, fail)).toEqual([0, 0]);
    expect(() => slotBioDecode(Array.from({ length: 81 }, () => new Float64Array(5)), DATE_PLACE_SLOT_TAGS, fail)).toThrow('bounded-math-invalid');
    expect(() => slotClassifier([new Float64Array(4)], [new Float64Array(4)], 4, 13, new Float32Array(40), new Float32Array(5), fail)).toThrow('bounded-math-invalid');
  });
});

const installed = existsSync(path.join(directory, 'weights.bin'));
describe.skipIf(!installed)('frozen selected five-tag actual CPU PyTorch parity (inactive)', () => {
  const metadata = installed ? JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as DatePlaceSlotManifest : undefined;
  const bytes = installed ? readFileSync(path.join(directory, 'weights.bin')) : undefined;
  const parity = installed ? JSON.parse(readFileSync(path.join(directory, 'parity.json'), 'utf8')) as { modelId: string; cases: Array<{
    source: string; text: string; tokens: unknown[]; featureIds: number[][]; flags: number[][]; logits: number[][]; tags: number[];
    raw: Record<string, unknown>[]; hypotheses: Record<string, unknown>[];
  }> } : undefined;
  const model = installed ? loadDatePlaceSlotTagger(metadata, bytes!, { expectedModelId: PIN }) : undefined;
  it('pins untouched selected bytes and calibration, not a new quality or activation claim', () => {
    expect(metadata!.modelId).toBe(PIN); expect(parity!.modelId).toBe(PIN); expect(bytes).toHaveLength(3239828);
    expect(hash(bytes!)).toBe('3b1e0c3a6ec1e4a9f5057aad3358271e592850084e9e23e05fe1828717267e64');
    expect(metadata!.calibration).toMatchObject({ temperature: 1, thresholds: { date: 0.8228255028191475, place: 0.9688093835656453 } });
    expect(metadata!.active).toBe(false); expect(parity!.cases).toHaveLength(25);
    expect(parity!.cases.filter(item => item.source === 'frozen_public_dev_parity')).toHaveLength(12);
    expect(parity!.cases.filter(item => item.source === 'predeclared_unicode_parity_only')).toHaveLength(13);
  });
  it.each(parity?.cases ?? [])('matches real PyTorch logits, literal spans and calibrated hypotheses: $text', sample => {
    const actual = model!.inspect(sample.text);
    expect(actual.tokens).toEqual(sample.tokens); expect(actual.featureIds).toEqual(sample.featureIds); expect(actual.flags).toEqual(sample.flags); expect(actual.tags).toEqual(sample.tags);
    expect(actual.logits).toHaveLength(sample.logits.length);
    for (const [row, expected] of sample.logits.entries()) for (const [column, value] of expected.entries()) expect(Math.abs(actual.logits[row]![column]! - value)).toBeLessThan(5e-5);
    for (const [actualSpans, expectedSpans] of [[actual.raw, sample.raw], [actual.hypotheses, sample.hypotheses]] as const) {
      expect(actualSpans).toHaveLength(expectedSpans.length);
      for (const [index, item] of actualSpans.entries()) {
        const { confidence, ...literal } = item, { confidence: expectedConfidence, ...expectedLiteral } = expectedSpans[index]!;
        expect(literal).toEqual(expectedLiteral); expect(confidence).toBeCloseTo(expectedConfidence as number, 5);
        expect(sample.text.slice(item.startUtf16, item.endUtf16)).toBe(item.text);
        expect([...sample.text].slice(item.startCodepoint, item.endCodepoint).join('')).toBe(item.text);
      }
    }
    expect(actual.scope).toBe('inactive_date_place_hypotheses'); expect(actual.active).toBe(false);
  });
});
