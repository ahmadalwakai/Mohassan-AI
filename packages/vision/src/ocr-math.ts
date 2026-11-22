/**
 * The OCR network's arithmetic on plain Float32Arrays: 3x3 convolutions, max
 * pooling, a bidirectional GRU, a linear head and greedy CTC decoding. It
 * mirrors scripts/vision/model.py; parity.json from the export keeps it honest.
 */

export interface Tensor { readonly shape: readonly number[]; readonly data: Float32Array }

/**
 * `input` is [channels][height][width]; returns ReLU(conv3x3(input) + bias), same height and width.
 * One output row at a time: the 3x3 neighbourhoods of that row are laid out contiguously
 * (im2col) so every output value is one long dot product, which the JIT runs well.
 */
export function conv3x3Relu(input: Float32Array, channels: number, height: number, width: number, weight: Tensor, bias: Tensor): Float32Array {
  const out = weight.shape[0], inChannels = weight.shape[1];
  if (inChannels !== channels || weight.shape[2] !== 3 || weight.shape[3] !== 3 || bias.shape[0] !== out) throw new Error('conv shape');
  const K = channels * 9, w = weight.data, b = bias.data;
  // Blocks of columns keep the patch in cache while every output channel reads it.
  const block = Math.max(8, Math.min(width, Math.floor(49152 / K)));
  const result = new Float32Array(out * height * width), patch = new Float32Array(block * K);
  const tail = K % 4, main = K - tail;
  for (let y = 0; y < height; y++) {
    for (let x0 = 0; x0 < width; x0 += block) {
      const count = Math.min(block, width - x0);
      for (let c = 0; c < channels; c++) {
        for (let ky = 0; ky < 3; ky++) {
          const iy = y + ky - 1, tap = c * 9 + ky * 3;
          if (iy < 0 || iy >= height) {
            for (let i = 0; i < count; i++) { const p = i * K + tap; patch[p] = 0; patch[p + 1] = 0; patch[p + 2] = 0; }
            continue;
          }
          const inRow = (c * height + iy) * width;
          for (let i = 0; i < count; i++) {
            const x = x0 + i, p = i * K + tap;
            patch[p] = x > 0 ? input[inRow + x - 1] : 0;
            patch[p + 1] = input[inRow + x];
            patch[p + 2] = x + 1 < width ? input[inRow + x + 1] : 0;
          }
        }
      }
      for (let o = 0; o < out; o++) {
        const wBase = o * K, bo = b[o], outRow = (o * height + y) * width + x0;
        for (let i = 0; i < count; i++) {
          const pBase = i * K;
          let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
          for (let k = 0; k < main; k += 4) {
            s0 += w[wBase + k] * patch[pBase + k];
            s1 += w[wBase + k + 1] * patch[pBase + k + 1];
            s2 += w[wBase + k + 2] * patch[pBase + k + 2];
            s3 += w[wBase + k + 3] * patch[pBase + k + 3];
          }
          let sum = bo + s0 + s1 + s2 + s3;
          for (let k = main; k < K; k++) sum += w[wBase + k] * patch[pBase + k];
          result[outRow + i] = sum > 0 ? sum : 0;
        }
      }
    }
  }
  return result;
}

export function maxPool(input: Float32Array, channels: number, height: number, width: number, poolH: number, poolW: number): { data: Float32Array; height: number; width: number } {
  const outH = Math.floor(height / poolH), outW = Math.floor(width / poolW);
  const result = new Float32Array(channels * outH * outW);
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let best = -Infinity;
        for (let py = 0; py < poolH; py++) {
          const row = c * height * width + (y * poolH + py) * width + x * poolW;
          for (let px = 0; px < poolW; px++) { const value = input[row + px]; if (value > best) best = value; }
        }
        result[(c * outH + y) * outW + x] = best;
      }
    }
  }
  return { data: result, height: outH, width: outW };
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

export interface GruDirection { readonly weightIh: Tensor; readonly weightHh: Tensor; readonly biasIh: Tensor; readonly biasHh: Tensor }

/** One GRU direction over `steps` inputs of size `inputSize` (row-major [steps][inputSize]); returns [steps][hidden]. */
export function gruDirection(inputs: Float32Array, steps: number, inputSize: number, direction: GruDirection, reverse: boolean): Float32Array {
  const hidden = direction.weightHh.shape[1];
  if (direction.weightIh.shape[0] !== 3 * hidden || direction.weightIh.shape[1] !== inputSize || direction.weightHh.shape[0] !== 3 * hidden
    || direction.biasIh.shape[0] !== 3 * hidden || direction.biasHh.shape[0] !== 3 * hidden) throw new Error('gru shape');
  const wIh = direction.weightIh.data, wHh = direction.weightHh.data, bIh = direction.biasIh.data, bHh = direction.biasHh.data;
  const output = new Float32Array(steps * hidden), h = new Float32Array(hidden), next = new Float32Array(hidden);
  const gi = new Float32Array(3 * hidden), gh = new Float32Array(3 * hidden);
  for (let index = 0; index < steps; index++) {
    const t = reverse ? steps - 1 - index : index, inBase = t * inputSize;
    for (let g = 0; g < 3 * hidden; g++) {
      let sumIn = bIh[g], sumH = bHh[g];
      const rowIn = g * inputSize, rowH = g * hidden;
      for (let i = 0; i < inputSize; i++) sumIn += wIh[rowIn + i] * inputs[inBase + i];
      for (let j = 0; j < hidden; j++) sumH += wHh[rowH + j] * h[j];
      gi[g] = sumIn; gh[g] = sumH;
    }
    for (let j = 0; j < hidden; j++) {
      const r = sigmoid(gi[j] + gh[j]), z = sigmoid(gi[hidden + j] + gh[hidden + j]);
      const n = Math.tanh(gi[2 * hidden + j] + r * gh[2 * hidden + j]);
      next[j] = (1 - z) * n + z * h[j];
    }
    h.set(next);
    output.set(h, t * hidden);
  }
  return output;
}

/** logits[t][k] = bias[k] + sum_j weight[k][j] * features[t][j] */
export function linear(features: Float32Array, steps: number, inputSize: number, weight: Tensor, bias: Tensor): Float32Array {
  const classes = weight.shape[0];
  if (weight.shape[1] !== inputSize || bias.shape[0] !== classes) throw new Error('linear shape');
  const out = new Float32Array(steps * classes), w = weight.data, b = bias.data;
  for (let t = 0; t < steps; t++) {
    for (let k = 0; k < classes; k++) {
      let sum = b[k];
      const row = k * inputSize, base = t * inputSize;
      for (let j = 0; j < inputSize; j++) sum += w[row + j] * features[base + j];
      out[t * classes + k] = sum;
    }
  }
  return out;
}

export interface CtcResult { readonly indices: number[]; readonly confidences: number[]; readonly argmax: number[] }

/** Collapse repeats and drop blanks (class 0); confidence is the softmax probability of each emitted class. */
export function greedyCtc(logits: Float32Array, steps: number, classes: number): CtcResult {
  const indices: number[] = [], confidences: number[] = [], argmax: number[] = [];
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    const base = t * classes;
    let best = 0, bestValue = logits[base], max = logits[base];
    for (let k = 1; k < classes; k++) { const value = logits[base + k]; if (value > bestValue) { bestValue = value; best = k; } if (value > max) max = value; }
    argmax.push(best);
    if (best !== previous && best !== 0) {
      let sum = 0;
      for (let k = 0; k < classes; k++) sum += Math.exp(logits[base + k] - max);
      indices.push(best);
      confidences.push(Math.exp(bestValue - max) / sum);
    }
    previous = best;
  }
  return { indices, confidences, argmax };
}
