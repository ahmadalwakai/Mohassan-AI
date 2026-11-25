import { Buffer } from 'node:buffer';
import model from './learned-model.json' with { type: 'json' };

type LearnedLabel = 'allow' | 'out_of_scope' | 'unsafe';
type LearnedRefusalCode = Exclude<LearnedLabel, 'allow'>;

const arabicLetters: Readonly<Record<string, string>> = {
  أ: 'ا', إ: 'ا', آ: 'ا', ٱ: 'ا', ى: 'ي', ة: 'ه',
};
const classes = ['allow', 'out_of_scope', 'unsafe'] as const;
const weights = model.weights.map(encoded => Buffer.from(encoded, 'base64'));

function normalize(text: string): string {
  let prefix = '';
  let size = 0;
  for (const char of text) {
    if (size === 512) break;
    prefix += char;
    size++;
  }
  return prefix.normalize('NFKC').toLowerCase()
    .replace(/[أإآٱىة]/gu, char => arabicLetters[char])
    .replace(/[٠-٩۰-۹]/gu, char => String((char.charCodeAt(0) & 0xf)))
    .replace(/[ـً-ٰٟ]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function featureBucket(feature: string): number {
  let hash = 2166136261;
  for (const char of feature) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return (hash >>> 0) % model.buckets;
}

export function refusalFeatureBuckets(text: string): ReadonlySet<number> {
  const normalized = normalize(text);
  const buckets = new Set<number>();
  if (!normalized) return buckets;
  const chars = Array.from(`^${normalized}$`);
  for (let width = 2; width <= 5; width++) {
    for (let start = 0; start + width <= chars.length; start++) {
      buckets.add(featureBucket(`c:${chars.slice(start, start + width).join('')}`));
    }
  }
  const words = normalized.split(' ');
  for (let index = 0; index < words.length; index++) {
    buckets.add(featureBucket(`w:${words[index]}`));
    if (index + 1 < words.length) buckets.add(featureBucket(`w:${words[index]} ${words[index + 1]}`));
  }
  return buckets;
}

export function scoreLearnedRefusal(text: string): { label: LearnedLabel; confidence: number } {
  const buckets = refusalFeatureBuckets(text);
  if (!buckets.size) return { label: 'allow', confidence: 1 };
  const logits = weights.map((row, label) => {
    let sum = 0;
    for (const bucket of buckets) sum += row.readInt16LE(bucket * 2);
    return (sum * model.scale + model.bias[label]) / model.temperature;
  });
  const top = Math.max(...logits);
  const label = classes[logits.indexOf(top)];
  const confidence = 1 / logits.reduce((total, logit) => total + Math.exp(logit - top), 0);
  return { label, confidence };
}

export function classifyLearnedRefusal(text: string): { code: LearnedRefusalCode; confidence: number } | null {
  const { label, confidence } = scoreLearnedRefusal(text);
  if (label === 'allow') return null;
  const threshold = model.thresholds[label];
  return threshold !== null && confidence >= threshold ? { code: label, confidence } : null;
}
