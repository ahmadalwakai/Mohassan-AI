import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadSlotTagger, slotTaggerModelId, type SlotTaggerManifest } from '../apps/server/src/assistant/slot-tagger.js';

const fixture = path.resolve('tests/fixtures/slot-tagger-v1');
const manifest = JSON.parse(readFileSync(path.join(fixture, 'manifest.json'), 'utf8')) as SlotTaggerManifest;
const weights = readFileSync(path.join(fixture, 'weights.bin'));
const parity = JSON.parse(readFileSync(path.join(fixture, 'parity.json'), 'utf8')) as { modelId: string; cases: Array<{
  text: string; tokens: unknown[]; featureIds: number[][]; flags: number[][]; logits: number[][]; tags: number[];
  raw: Record<string, unknown>[]; hypotheses: Record<string, unknown>[];
}> };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identified = (value: SlotTaggerManifest) => {
  const { modelId: _modelId, ...body } = value;
  return { ...value, modelId: slotTaggerModelId(body) };
};
function changed(update: (value: SlotTaggerManifest) => void) {
  const copy = structuredClone(manifest); update(copy); return identified(copy);
}
function withWeights(update: (copy: Buffer, metadata: SlotTaggerManifest) => void) {
  const copy = Buffer.from(weights), metadata = structuredClone(manifest);
  update(copy, metadata);
  metadata.weights.sha256 = metadata.source.weightsSha256 = hash(copy);
  return { copy, metadata: identified(metadata) };
}

describe('read-only own slot tagger loader', () => {
  it('can disable every source-token cache insertion without changing inference', () => {
    const cached = loadSlotTagger(manifest, weights);
    const uncached = loadSlotTagger(manifest, weights, { cacheEmbeddings: false });
    const input = 'Privatezyx in Oslo tomorrow.';
    const set = vi.spyOn(Map.prototype, 'set');
    try {
      const raw = uncached.inspect(input);
      expect(set.mock.calls.some(([key]) => key === 'privatezyx' || key === 'oslo' || key === 'tomorrow')).toBe(false);
      set.mockClear();
      const ordinary = cached.inspect(input);
      expect(set.mock.calls.some(([key]) => key === 'privatezyx')).toBe(true);
      expect(raw).toEqual(ordinary);
    } finally { set.mockRestore(); }
  });

  it('loads bounded JSON bytes, strings or plain metadata and verifies an optional model pin', () => {
    const string = JSON.stringify(manifest);
    for (const metadata of [manifest, string, Buffer.from(string)]) {
      const tagger = loadSlotTagger(metadata, weights, { expectedModelId: manifest.modelId });
      expect(tagger.modelId).toBe(manifest.modelId);
      expect(tagger.weightsBytes).toBe(weights.length);
    }
    expect(() => loadSlotTagger(manifest, weights, { expectedModelId: '0'.repeat(64) })).toThrow('MODEL_ID_MISMATCH');
  });

  it('rejects content-address changes rather than accepting changed calibration', () => {
    const copy = structuredClone(manifest);
    copy.calibration.thresholds.date = 0.9;
    expect(() => loadSlotTagger(copy, weights)).toThrow('MODEL_ID_MISMATCH');
    expect(() => loadSlotTagger(manifest, Buffer.concat([weights, Buffer.alloc(4)]))).toThrow('WEIGHTS_INVALID');
    const corrupt = Buffer.from(weights); corrupt[0] ^= 1;
    expect(() => loadSlotTagger(manifest, corrupt)).toThrow('WEIGHTS_INVALID');
  });

  it('rejects extra or missing tensor metadata, shapes, ordering and unsupported labels', () => {
    expect(() => loadSlotTagger(changed(value => { value.weights.tensors[0].shape[0] += 1; }), weights)).toThrow('WEIGHTS_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.weights.tensors[1].offsetFloats += 1; }), weights)).toThrow('WEIGHTS_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.weights.tensors[1].name = 'classifier.weight'; }), weights)).toThrow('WEIGHTS_INVALID');
    expect(() => loadSlotTagger(changed(value => { (value.weights.tensors[0] as unknown as Record<string, unknown>).extra = true; }), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.weights.tensors.push(value.weights.tensors[0]); }), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.labels[0] = 'B-place'; }), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(changed(value => { (value.calibration.thresholds as Record<string, number>).time = 0; }), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.source.weightsSha256 = '0'.repeat(64); }), weights)).toThrow('WEIGHTS_INVALID');
  });

  it('rejects nonfinite or excessively large floats even with recomputed checksums', () => {
    for (const value of [Infinity, NaN, 1e10]) {
      const changedWeights = withWeights(copy => copy.writeFloatLE(value, 0));
      expect(() => loadSlotTagger(changedWeights.metadata, changedWeights.copy)).toThrow('WEIGHTS_INVALID');
    }
  });

  it('rejects Unicode table drift and unsupported feature versions', () => {
    expect(() => loadSlotTagger(changed(value => { value.unicode.wordRanges[0][1] += 1; }), weights)).toThrow('UNICODE_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.featureVersion = 'different' as never; }), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(changed(value => { value.unicode.version = '15.0.0' as never; }), weights)).toThrow('MANIFEST_INVALID');
  });

  it('bounds manifests before arbitrary getters, cycles or deep input can be processed', () => {
    expect(() => loadSlotTagger(' '.repeat(256 * 1024 + 1), weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger(Buffer.from([0xff]), weights)).toThrow('MANIFEST_INVALID');
    let accessed = false;
    const getters = { get format() { accessed = true; return manifest.format; } };
    expect(() => loadSlotTagger(getters, weights)).toThrow('MANIFEST_INVALID');
    expect(accessed).toBe(false);
    const hidden = structuredClone(manifest);
    Object.defineProperty(hidden.weights.tensors[0], 'hiddenShape', { value: [999], enumerable: false });
    expect(() => loadSlotTagger(hidden, weights)).toThrow('MANIFEST_INVALID');
    const arrayGetters = structuredClone(manifest);
    Object.defineProperty(arrayGetters.unicode.wordRanges, '0', { get() { accessed = true; return [0, 999]; } });
    expect(() => loadSlotTagger(arrayGetters, weights)).toThrow('MANIFEST_INVALID');
    expect(accessed).toBe(false);
    const excessive = structuredClone(manifest);
    excessive.unicode.wordRanges = Array(5001).fill([0, 0]);
    expect(() => loadSlotTagger(JSON.stringify(excessive), weights)).toThrow('MANIFEST_INVALID');
    const cycle: Record<string, unknown> = {}; cycle.child = cycle;
    expect(() => loadSlotTagger(cycle, weights)).toThrow('MANIFEST_INVALID');
    expect(() => loadSlotTagger({ ...manifest, active: true }, weights)).toThrow('MANIFEST_INVALID');
  });

  it('copies validated weights and metadata so later caller mutations cannot alter inference', () => {
    const mutableWeights = Buffer.from(weights), mutableManifest = structuredClone(manifest);
    const tagger = loadSlotTagger(mutableManifest, mutableWeights);
    const before = tagger.inspect('From Paris to Paris on Monday.');
    mutableWeights.fill(0); mutableManifest.calibration.temperature = 99;
    mutableManifest.unicode.lowercaseMap[0][1] = 'X';
    expect(tagger.inspect('From Paris to Paris on Monday.')).toEqual(before);
    expect(Object.keys(tagger).sort()).toEqual(['infer', 'inspect', 'modelId', 'weightsBytes']);
  });
});

describe('exact Unicode, feature, GRU and BIO parity', () => {
  const tagger = loadSlotTagger(manifest, weights);

  it('matches independent NumPy fixtures for every token, feature ID, flag and legal decoded tag', () => {
    expect(parity.modelId).toBe(tagger.modelId);
    for (const sample of parity.cases) {
      const actual = tagger.inspect(sample.text);
      expect(actual.tokens).toEqual(sample.tokens);
      expect(actual.featureIds).toEqual(sample.featureIds);
      expect(actual.flags).toEqual(sample.flags);
      expect(actual.tags).toEqual(sample.tags);
      for (const [row, expected] of sample.logits.entries()) for (const [column, value] of expected.entries()) {
        expect(Math.abs(actual.logits[row][column] - value)).toBeLessThan(5e-5);
      }
      for (const [index, raw] of actual.raw.entries()) {
        const { confidence, ...literal } = raw;
        const { confidence: expectedConfidence, ...expectedLiteral } = sample.raw[index];
        expect(literal).toEqual(expectedLiteral);
        expect(confidence).toBeCloseTo(expectedConfidence as number, 6);
      }
      expect(actual.raw).toHaveLength(sample.raw.length);
      expect(actual.hypotheses).toHaveLength(sample.hypotheses.length);
      for (const [index, hypothesis] of actual.hypotheses.entries()) {
        const { confidence, ...literal } = hypothesis;
        const { confidence: expectedConfidence, ...expectedLiteral } = sample.hypotheses[index];
        expect(literal).toEqual(expectedLiteral);
        expect(confidence).toBeCloseTo(expectedConfidence as number, 6);
      }
    }
  });

  it('retains exact repeated entities, emoji offsets and Python-specific whitespace semantics', () => {
    const text = '😀 Paris to Paris\u001cLondon\u0085Friday\ufeffRome';
    const inspected = tagger.inspect(text);
    const paris = inspected.tokens.filter(token => token.text === 'Paris');
    expect(paris).toHaveLength(2);
    expect(paris[0].startUtf16).toBe(paris[0].startCodepoint + 1);
    expect(inspected.tokens.some(token => token.text === '\ufeff')).toBe(true);
    expect(inspected.tokens.some(token => token.text === '\u0085' || token.text === '\u001c')).toBe(false);
    for (const raw of inspected.raw) {
      expect(text.slice(raw.startUtf16, raw.endUtf16)).toBe(raw.text);
      expect(Array.from(text).slice(raw.startCodepoint, raw.endCodepoint).join('')).toBe(raw.text);
    }
  });

  it('bounds the complete request without silently truncating source text', () => {
    for (const text of ['', ' '.repeat(512), 'a'.repeat(513), '😀'.repeat(513), Array(81).fill('a').join(' '), '\ud800', '\u0378']) {
      expect(() => tagger.infer(text)).toThrow('INPUT_INVALID');
    }
    expect(tagger.inspect(`😀${'a'.repeat(511)}`).tokens.at(-1)?.endCodepoint).toBe(512);
    expect(tagger.inspect(`😀${'a'.repeat(511)}`).tokens.at(-1)?.endUtf16).toBe(513);
  });

  it('returns frozen date/place hypotheses separately from raw diagnostics and exposes no action authority', () => {
    const result = tagger.infer('A visit to Porto next Tuesday.');
    expect(result.hypotheses.length).toBeGreaterThan(0); // synthetic fixture biases date, without claiming truth
    for (const hypothesis of result.hypotheses) {
      expect(['date', 'place']).toContain(hypothesis.label);
      expect(hypothesis.kind).toBe('hypothesis');
      expect(hypothesis.confidence).toBeGreaterThanOrEqual(hypothesis.threshold);
      expect(Object.keys(hypothesis).some(key => /permission|verified|query|action|success/iu.test(key))).toBe(false);
      expect(Object.isFrozen(hypothesis)).toBe(true);
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.hypotheses)).toBe(true);
    expect(Object.isFrozen(result.raw)).toBe(true);
  });

  it('keeps a highly confident disabled raw time label out of accepted hypotheses', () => {
    const changedWeights = withWeights((copy, metadata) => {
      const bias = metadata.weights.tensors.find(tensor => tensor.name === 'classifier.bias')!;
      for (let index = 0; index < 13; index++) copy.writeFloatLE(-20, (bias.offsetFloats + index) * 4);
      copy.writeFloatLE(15, (bias.offsetFloats + 5) * 4);
      copy.writeFloatLE(14.9, (bias.offsetFloats + 6) * 4);
    });
    const disabled = loadSlotTagger(changedWeights.metadata, changedWeights.copy).infer('Next Tuesday in Porto');
    expect(disabled.raw.length).toBeGreaterThan(0);
    expect(disabled.raw.every(raw => raw.label === 'time' && raw.reason === 'label_abstained')).toBe(true);
    expect(disabled.hypotheses).toEqual([]);
  });
});

describe('optional frozen learned candidate parity', () => {
  const directory = path.resolve('artifacts/brain-slot-development-v1/typescript-export-v1-20261121-a');
  it.skipIf(!existsSync(path.join(directory, 'weights.bin')))('matches the learned candidate independent NumPy logits and calibrated hypotheses', () => {
    const metadata = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const learned = loadSlotTagger(metadata, readFileSync(path.join(directory, 'weights.bin')), { expectedModelId: metadata.modelId });
    const expected = JSON.parse(readFileSync(path.join(directory, 'parity.json'), 'utf8')) as typeof parity;
    for (const sample of expected.cases) {
      const actual = learned.inspect(sample.text);
      expect(actual.tokens).toEqual(sample.tokens);
      expect(actual.featureIds).toEqual(sample.featureIds);
      expect(actual.flags).toEqual(sample.flags);
      expect(actual.tags).toEqual(sample.tags);
      expect(actual.raw).toHaveLength(sample.raw.length);
      for (const [index, raw] of actual.raw.entries()) {
        const { confidence, ...literal } = raw;
        const { confidence: expectedConfidence, ...expectedLiteral } = sample.raw[index];
        expect(literal).toEqual(expectedLiteral);
        expect(confidence).toBeCloseTo(expectedConfidence as number, 5);
      }
      for (const [row, values] of sample.logits.entries()) for (const [column, value] of values.entries()) {
        expect(Math.abs(actual.logits[row][column] - value)).toBeLessThan(5e-5);
      }
      expect(actual.hypotheses).toHaveLength(sample.hypotheses.length);
    }
  });
});
