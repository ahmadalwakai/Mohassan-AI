import { createHash } from 'node:crypto';
import { OCR_FORMAT, TENSOR_NAMES, type OcrManifest, type TensorName } from './ocr-model.js';

/** A shape-valid OCR model for worker tests, with no trained parameters. */
export function createTinyOcrModel() {
  const height = 32;
  const hidden = 8;
  const classes = ['<blank>', 'a'];
  const channels = [1, 1, 1, 1, 1];
  const pools: OcrManifest['architecture']['pools'] = [[2, 2], [2, 2], [2, 1], [2, 1], null];
  const features = channels[4] * pools.reduce((rows, pool) => rows / (pool?.[0] ?? 1), height);
  const gates = 3 * hidden;
  const tensorsByName = new Map<TensorName, number[]>();
  for (const [index, output] of channels.entries()) {
    tensorsByName.set(`conv${index}.weight` as TensorName, [output, channels[index - 1] ?? 1, 3, 3]);
    tensorsByName.set(`conv${index}.bias` as TensorName, [output]);
  }
  for (const suffix of ['', '_reverse'] as const) {
    tensorsByName.set(`rnn.weight_ih_l0${suffix}`, [gates, features]);
    tensorsByName.set(`rnn.weight_hh_l0${suffix}`, [gates, hidden]);
    tensorsByName.set(`rnn.bias_ih_l0${suffix}`, [gates]);
    tensorsByName.set(`rnn.bias_hh_l0${suffix}`, [gates]);
  }
  tensorsByName.set('fc.weight', [classes.length, 2 * hidden]);
  tensorsByName.set('fc.bias', [classes.length]);
  let offsetFloats = 0;
  const tensors = TENSOR_NAMES.map(name => {
    const shape = tensorsByName.get(name)!;
    const count = shape.reduce((product, dimension) => product * dimension, 1);
    const tensor = { name, shape, count, offsetFloats };
    offsetFloats += count;
    return tensor;
  });
  const weightsBytes = new Uint8Array(offsetFloats * Float32Array.BYTES_PER_ELEMENT);
  const modelId = createHash('sha256').update(weightsBytes).digest('hex');
  const manifest: OcrManifest = {
    format: OCR_FORMAT, modelId, createdAt: new Date(0).toISOString(),
    input: { height, channels: 1, normalize: { mean: 0, std: 1 }, downsample: 4, maxWidth: 64 },
    architecture: { channels, hidden, classes: classes.length, pools },
    classes,
    weights: { dtype: 'float32-le', bytes: weightsBytes.byteLength, sha256: modelId, maxAbsValue: 1, tensors },
  };
  return { modelId, manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)), weightsBytes };
}
