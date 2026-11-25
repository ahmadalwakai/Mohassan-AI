import type {Latency} from '@mohassan/contracts';

// Half-octave buckets cover 0.125 ms through 2^28 ms, then an overflow bucket.
// Changes to these boundaries require a new snapshot version.
export const latencyBoundsMs = Object.freeze(Array.from({length: 63}, (_, index) => 2 ** ((index - 6) / 2)));
export const histogramBytes = (latencyBoundsMs.length + 1) * Float64Array.BYTES_PER_ELEMENT;
export const histogramBucketCount = latencyBoundsMs.length + 1;

export type Histogram = {
  counts: Float64Array;
  samples: number;
  maxMs: number;
};

export function createHistogram(): Histogram {
  return {counts: new Float64Array(histogramBucketCount), samples: 0, maxMs: 0};
}

export function latencyBucketIndex(ms: number): number {
  let lower = 0;
  let upper = latencyBoundsMs.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (ms <= latencyBoundsMs[middle]) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

export function addLatency(histogram: Histogram, bucketIndex: number, ms: number): void {
  histogram.counts[bucketIndex]++;
  histogram.samples++;
  histogram.maxMs = Math.max(histogram.maxMs, ms);
}

export function mergeHistograms(target: Histogram, source: Histogram): void {
  for (let index = 0; index < histogramBucketCount; index++) {
    target.counts[index] += source.counts[index];
  }
  target.samples += source.samples;
  target.maxMs = Math.max(target.maxMs, source.maxMs);
}

export function summarizeHistogram(histogram?: Histogram): Latency {
  if (!histogram?.samples) return {samples: 0, p50: null, p90: null, p99: null};
  // Nearest ranks, as in scripts/perf/fixture.ts and the discrete percentile
  // algorithm at https://www.postgresql.org/docs/18/functions-aggregate.html
  // (retrieved 2026-11-25). Report bucket upper bounds or the observed overflow maximum.
  const ranks = [0.5, 0.9, 0.99].map(probability => Math.ceil(probability * histogram.samples));
  const values: number[] = [];
  let observed = 0;
  for (let index = 0; index < histogramBucketCount && values.length < ranks.length; index++) {
    observed += histogram.counts[index];
    while (values.length < ranks.length && observed >= ranks[values.length]) {
      values.push(latencyBoundsMs[index] ?? histogram.maxMs);
    }
  }
  return {samples: histogram.samples, p50: values[0], p90: values[1], p99: values[2]};
}
