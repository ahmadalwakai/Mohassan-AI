import { matchText } from '../mind/normalize.js';

export type WritingLanguage = 'ar' | 'en';

export interface WritingSource {
  title: string;
  text: string;
  url?: string;
  page?: number;
  layout?: 'pdf';
  /** Offset of this source in the original input, when it is an excerpt. */
  offset?: number;
}

export interface EvidenceSpan {
  source: WritingSource;
  /** UTF-16 offsets in source.text, with end exclusive. */
  start: number;
  end: number;
  text: string;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const honorific = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Rev|Sgt)\.|(?<!\p{L})[دأ]\.)$/u;
const initials = /^\s*(?:(?!I\.)[A-Z]\.\s*)+$/u;
const enumerator = /^\s*[\p{Nd}]{1,3}\.$/u;
const sentenceEnd = /[.!?؟。！？…](?:[»”"')\]]|\[\p{Nd}+\])*$/u;
const listStart = /^[\t ]*(?:[-*+•▪◦]|[\p{Nd}]{1,3}[.)]|#{1,6})[\t ]/u;

/** PDF extraction keeps physical layout lines. Only remove wraps from the segmentation view. */
function pdfBoundaries(text: string): string {
  return text.replace(/(?:\r\n|[\r\n\u2028])(?:[\t ]*(?:\r\n|[\r\n\u2028]))*/gu, (breaks, at: number) => {
    if (!/^(?:\r\n|[\r\n\u2028])$/u.test(breaks)) return breaks;
    const before = text.slice(Math.max(0, at - 64), at).trimEnd();
    const after = text.slice(at + breaks.length, at + breaks.length + 32);
    if (listStart.test(after) || sentenceEnd.test(before) && !honorific.test(before)) return breaks;
    return ' '.repeat(breaks.length);
  });
}

/** Segment with Unicode sentence boundaries, retaining the literal string and its source offsets. */
export function sentenceSpans(source: WritingSource): EvidenceSpan[] {
  const spans: EvidenceSpan[] = [];
  let start = 0;
  let pending = '';
  const emit = () => {
    const raw = source.text.slice(start, start + pending.length);
    const text = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const from = start + raw.length - raw.trimStart().length;
    spans.push({ source, start: from, end: from + text.length, text });
  };
  const layout = source.layout === 'pdf' ? pdfBoundaries(source.text) : source.text;
  for (const { index, segment } of segmenter.segment(layout)) {
    const previous = pending.trimEnd();
    const joins = !/[\r\n\u2028\u2029]\s*$/u.test(pending)
      && (honorific.test(previous) || initials.test(previous) && /^\p{Lu}/u.test(segment) || enumerator.test(previous));
    if (joins) {
      pending += segment;
      continue;
    }
    emit();
    start = index;
    pending = segment;
  }
  emit();
  return spans;
}

const stopwords = new Set(matchText(
  'a an the and or but as at by for from in into of on onto to with about is are was were be been being '
  + 'it its he she they we you them their this that these those which who has have had will can could would may '
  + 'في من عن على الى حتى مع عند خلال بين لدى قبل بعد دون او و ف ثم كما هو هي هم هن هذا هذه ذلك تلك التي الذي الذين اللواتي كان كانت يكون تكون تم قد لقد ان بان فان وان',
).split(/\s+/u));

const negation = /(?<!\p{L})(?:no|not|none|neither|never|without|cannot|لا|ليس|ليست|لم|لن|غير|دون)(?!\p{L})|n't(?!\p{L})/u;
const numeric = /(?<!\p{Nd})[+−-]?\p{Nd}+(?:[.,٫٬]\p{Nd}+)*(?:[%٪])?/gu;
const words = /[\p{L}\p{N}]+(?:[’'][\p{L}]+)?/gu;

function terms(text: string): string[] {
  return matchText(text).replace(/[’]/gu, "'").match(words) ?? [];
}

export function wordCount(text: string): number {
  return (text.match(/\S+/gu) ?? []).length;
}

export function wordSet(text: string): Set<string> {
  return new Set(terms(text).filter(word => !stopwords.has(word) && !/^\p{N}+$/u.test(word)).map(word =>
    word.replace(/^[وف]?ال(?=\p{Script=Arabic}{3})/u, '').replace(/(?<=[a-z]{3})ies$/u, 'y').replace(/(?<=[a-z]{3})(?<!s)s$/u, ''),
  ));
}

function common(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  for (const word of smaller) if (larger.has(word)) count++;
  return count;
}

/** Jaccard overlap, the weight of a word-overlap graph edge. */
export function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const shared = common(left, right);
  const total = left.size + right.size - shared;
  return total ? shared / total : 0;
}

export function numericTerms(text: string): string[] {
  return (matchText(text).match(numeric) ?? [])
    .map(value => value.replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/٪/gu, '%').replace(/−/gu, '-'));
}

function wordPairs(tokens: readonly string[]): Set<string> {
  return new Set(tokens.slice(1).map((word, index) => `${tokens[index]} ${word}`));
}

/** Detect near repeats while retaining differences in amounts, negation and word order. */
export function exactOrRedundant(left: string, right: string): boolean {
  if (left === right) return true;
  if (numericTerms(left).join(' ') !== numericTerms(right).join(' ')) return false;
  if (negation.test(matchText(left)) !== negation.test(matchText(right))) return false;
  const a = terms(left), b = terms(right);
  if (a.join(' ') === b.join(' ')) return Boolean(a.length);
  if (Math.min(a.length, b.length) < 6 || overlap(new Set(a), new Set(b)) < 0.8) return false;
  const aPairs = wordPairs(a), bPairs = wordPairs(b);
  return common(aPairs, bPairs) / Math.max(aPairs.size, bPairs.size) >= 0.72;
}
