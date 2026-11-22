/** Internal bounded arithmetic shared by separately versioned inactive slot-model contracts. No loading, token caching, labels-as-authority or routing. */
type Fail = () => never;
const matrix = (rows: readonly Float64Array[], columns: number, fail: Fail) => {
  if (!rows.length || rows.length > 80 || !Number.isInteger(columns) || columns < 1 || columns > 128 || rows.some(row => row.length !== columns)) fail();
};

/** Preserve PyTorch's GRU gate order r,z,n and the bridge's original arithmetic order. */
export function slotGruDirection(inputs: readonly Float64Array[], hidden: number, tensors: Readonly<Record<string, Float32Array>>, reverse: boolean, fail: Fail): Float64Array[] {
  const width = inputs[0]?.length;
  if (!Number.isInteger(hidden) || hidden < 4 || hidden > 64 || width === undefined || width < 10 || width > 38) fail();
  matrix(inputs, width, fail);
  const suffix = reverse ? '_reverse' : '';
  const inputWeight = tensors[`encoder.weight_ih_l0${suffix}`], recurrentWeight = tensors[`encoder.weight_hh_l0${suffix}`];
  const inputBias = tensors[`encoder.bias_ih_l0${suffix}`], recurrentBias = tensors[`encoder.bias_hh_l0${suffix}`];
  if (inputWeight?.length !== hidden * 3 * width || recurrentWeight?.length !== hidden * 3 * hidden
    || inputBias?.length !== hidden * 3 || recurrentBias?.length !== hidden * 3) fail();
  const output = new Array<Float64Array>(inputs.length);
  let state = new Float64Array(hidden);
  const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
  for (let position = 0; position < inputs.length; position++) {
    const index = reverse ? inputs.length - 1 - position : position;
    const input = inputs[index], incoming = new Float64Array(hidden * 3), recurrent = new Float64Array(hidden * 3);
    for (let gate = 0; gate < hidden * 3; gate++) {
      let left = inputBias[gate], right = recurrentBias[gate];
      for (let dimension = 0; dimension < input.length; dimension++) left += inputWeight[gate * input.length + dimension] * input[dimension];
      for (let dimension = 0; dimension < hidden; dimension++) right += recurrentWeight[gate * hidden + dimension] * state[dimension];
      incoming[gate] = left; recurrent[gate] = right;
    }
    const next = new Float64Array(hidden);
    for (let dimension = 0; dimension < hidden; dimension++) {
      const reset = sigmoid(incoming[dimension] + recurrent[dimension]);
      const update = sigmoid(incoming[hidden + dimension] + recurrent[hidden + dimension]);
      const candidate = Math.tanh(incoming[hidden * 2 + dimension] + reset * recurrent[hidden * 2 + dimension]);
      next[dimension] = (1 - update) * candidate + update * state[dimension];
    }
    state = next; output[index] = state;
  }
  return output;
}

export function slotClassifier(forward: readonly Float64Array[], backward: readonly Float64Array[], hidden: number, tagCount: number,
  weights: Float32Array, bias: Float32Array, fail: Fail): Float64Array[] {
  matrix(forward, hidden, fail); matrix(backward, hidden, fail);
  if (forward.length !== backward.length || ![5, 13].includes(tagCount) || weights.length !== tagCount * hidden * 2 || bias.length !== tagCount) fail();
  return forward.map((left, position) => {
    const values = new Float64Array(tagCount);
    for (let tag = 0; tag < tagCount; tag++) {
      let value = bias[tag];
      for (let dimension = 0; dimension < hidden; dimension++) value += weights[tag * hidden * 2 + dimension] * left[dimension]
        + weights[tag * hidden * 2 + hidden + dimension] * backward[position][dimension];
      if (!Number.isFinite(value)) fail();
      values[tag] = value;
    }
    return values;
  });
}

/** Legal BIO paths, deterministic first-index tie breaking, without cross-format tag conversion. */
export function slotBioDecode(logits: readonly Float64Array[], tags: readonly string[], fail: Fail): number[] {
  if (![5, 13].includes(tags.length) || tags[0] !== 'O') fail();
  matrix(logits, tags.length, fail);
  let state = Float64Array.from(logits[0], (value, index) => tags[index].startsWith('I-') ? -Infinity : value);
  const back: Int16Array[] = [];
  for (const emission of logits.slice(1)) {
    const next = new Float64Array(tags.length), preceding = new Int16Array(tags.length);
    for (let current = 0; current < tags.length; current++) {
      let best = -Infinity, from = 0;
      const inside = tags[current].startsWith('I-');
      for (let earlier = 0; earlier < tags.length; earlier++) {
        if (inside && earlier !== current && earlier !== current - 1) continue;
        if (state[earlier] > best) { best = state[earlier]; from = earlier; }
      }
      next[current] = best + emission[current]; preceding[current] = from;
    }
    state = next; back.push(preceding);
  }
  let last = 0;
  for (let index = 1; index < state.length; index++) if (state[index] > state[last]) last = index;
  const path = [last];
  for (let index = back.length - 1; index >= 0; index--) path.push(back[index][path.at(-1)!]);
  return path.reverse();
}

export function slotPosteriors(logits: readonly Float64Array[], temperature: number, fail: Fail): Float64Array[] {
  if (!Number.isFinite(temperature) || temperature <= 0 || temperature > 100 || !logits.length || ![5, 13].includes(logits[0].length)) fail();
  matrix(logits, logits[0].length, fail);
  return logits.map(values => {
    const maximum = Math.max(...values) / temperature;
    const exp = Float64Array.from(values, value => Math.exp(value / temperature - maximum));
    const sum = exp.reduce((total, value) => total + value, 0);
    return Float64Array.from(exp, value => value / sum);
  });
}
