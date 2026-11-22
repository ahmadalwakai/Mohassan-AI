import { conv3x3Relu, greedyCtc, gruDirection, linear, maxPool } from './ocr-math.js';
import type { OcrModel } from './ocr-model.js';

export interface LineCrop { readonly pixels: Uint8Array; readonly width: number }
export interface LineRecognition { readonly visual: string; readonly confidence: number; readonly minConfidence: number; readonly steps: number; readonly chars: number }

/** Pixels of one 32-pixel-high crop to the model's normalised input, padded to the downsample multiple. */
export function prepareInput(model: OcrModel, crop: LineCrop): { data: Float32Array; width: number } {
  const height = model.height, width = crop.width;
  if (!Number.isInteger(width) || width < 1 || width > model.maxWidth || crop.pixels.length !== width * height) throw new Error('OCR_INPUT_INVALID');
  const padded = width + ((model.downsample - (width % model.downsample)) % model.downsample);
  const tail: number[] = [];
  for (let y = 0; y < height; y++) for (let x = Math.max(0, width - 2); x < width; x++) tail.push(crop.pixels[y * width + x]);
  tail.sort((a, b) => a - b);
  const fill = tail.length ? tail[Math.floor(tail.length / 2)] : 255;
  const { mean, std } = model.normalize;
  const data = new Float32Array(height * padded);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < padded; x++) data[y * padded + x] = ((x < width ? crop.pixels[y * width + x] : fill) / 255 - mean) / std;
  }
  return { data, width: padded };
}

/** Full forward pass for one line; returns logits [steps][classes]. */
export function forward(model: OcrModel, input: Float32Array, width: number): { logits: Float32Array; steps: number } {
  const t = model.tensors;
  let data = input, channels = 1, height: number = model.height, w = width;
  const convs = [['conv0.weight', 'conv0.bias'], ['conv1.weight', 'conv1.bias'], ['conv2.weight', 'conv2.bias'], ['conv3.weight', 'conv3.bias'], ['conv4.weight', 'conv4.bias']] as const;
  for (const [index, [weightName, biasName]] of convs.entries()) {
    const weight = t[weightName], bias = t[biasName];
    data = conv3x3Relu(data, channels, height, w, weight, bias);
    channels = weight.shape[0];
    const pool = model.pools[index];
    if (pool) { const pooled = maxPool(data, channels, height, w, pool[0], pool[1]); data = pooled.data; height = pooled.height; w = pooled.width; }
  }
  if (height !== 2) throw new Error('OCR_SHAPE_INVALID');
  const steps = w, inputSize = channels * height, features = new Float32Array(steps * inputSize);
  for (let c = 0; c < channels; c++) for (let row = 0; row < height; row++) for (let step = 0; step < steps; step++) features[step * inputSize + c * height + row] = data[(c * height + row) * steps + step];
  const hidden = model.hidden;
  const fwd = gruDirection(features, steps, inputSize, { weightIh: t['rnn.weight_ih_l0'], weightHh: t['rnn.weight_hh_l0'], biasIh: t['rnn.bias_ih_l0'], biasHh: t['rnn.bias_hh_l0'] }, false);
  const bwd = gruDirection(features, steps, inputSize, { weightIh: t['rnn.weight_ih_l0_reverse'], weightHh: t['rnn.weight_hh_l0_reverse'], biasIh: t['rnn.bias_ih_l0_reverse'], biasHh: t['rnn.bias_hh_l0_reverse'] }, true);
  const joined = new Float32Array(steps * 2 * hidden);
  for (let step = 0; step < steps; step++) { joined.set(fwd.subarray(step * hidden, (step + 1) * hidden), step * 2 * hidden); joined.set(bwd.subarray(step * hidden, (step + 1) * hidden), step * 2 * hidden + hidden); }
  return { logits: linear(joined, steps, 2 * hidden, t['fc.weight'], t['fc.bias']), steps };
}

export function recognizeLine(model: OcrModel, crop: LineCrop): LineRecognition {
  const input = prepareInput(model, crop);
  const { logits, steps } = forward(model, input.data, input.width);
  const decoded = greedyCtc(logits, steps, model.classes.length);
  const visual = decoded.indices.map(index => model.classes[index]).join('');
  const confidence = decoded.confidences.length ? decoded.confidences.reduce((sum, value) => sum + value, 0) / decoded.confidences.length : 0;
  const minConfidence = decoded.confidences.length ? Math.min(...decoded.confidences) : 0;
  return { visual, confidence, minConfidence, steps, chars: decoded.indices.length };
}
