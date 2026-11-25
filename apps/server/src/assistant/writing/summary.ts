import {
  exactOrRedundant, numericTerms, overlap, sentenceSpans, wordCount, wordSet,
  type EvidenceSpan, type WritingSource,
} from './evidence.js';

export type WritingFormat = 'line' | 'paragraph' | 'bullets' | 'detailed' | 'table';

const targets = {
  line: { sentences: 1, words: 45, characters: 320, maximum: 1 },
  paragraph: { sentences: 3, words: 120, characters: 900, maximum: 5 },
  bullets: { sentences: 4, words: 160, characters: 1200, maximum: 12 },
  detailed: { sentences: 8, words: 280, characters: 2100, maximum: 12 },
  table: { sentences: 6, words: 220, characters: 1650, maximum: 12 },
};

/** Sentence and text budgets are upper bounds. A source sentence is never clipped to fill one. */
export function summaryTarget(format: WritingFormat, count?: number) {
  const { sentences, words, characters, maximum } = targets[format];
  const requested = count !== undefined && Number.isInteger(count) && count > 0;
  return { sentences: requested ? Math.min(count, maximum) : sentences, words, characters };
}

interface Candidate {
  span: EvidenceSpan;
  words: Set<string>;
  length: number;
  sourceIndex: number;
  position: number;
  title: number;
  numbers: number;
  complete: number;
  degree: number;
  score: number;
  similarity: number;
}

const graphLimit = 480;
const sourceChrome = /^(?:#{1,6}\s+|\.{3}|…\s|\[\s*edit\s*\]|\[\s*عدل\s*\])/iu;
const proseEnding = /[.!?؟。！？…](?:[»”"')\]]|\[\p{Nd}+\])*$/u;

function candidatesFor(source: WritingSource, sourceIndex: number, target: ReturnType<typeof summaryTarget>): Candidate[] {
  const titleWords = wordSet(source.title);
  return sentenceSpans(source).flatMap((span, position) => {
    const length = wordCount(span.text);
    if (length > target.words || span.text.length > target.characters || sourceChrome.test(span.text)) return [];
    const words = wordSet(span.text);
    const complete = Number(proseEnding.test(span.text));
    const title = titleWords.size ? [...titleWords].filter(word => words.has(word)).length / titleWords.size : 0;
    if (!complete && title === 1 && words.size === titleWords.size) return [];
    return [{
      span, words, length, sourceIndex, position: 1 / (1 + position / 4),
      title, complete, numbers: Math.min(2, numericTerms(span.text).length) / 2, degree: 0, score: 0, similarity: 0,
    }];
  });
}

/** Keep a bounded, distributed sentence graph for long documents and retain each source's lead. */
function graphCandidates(bySource: Candidate[][]): Candidate[] {
  if (bySource.reduce((sum, source) => sum + source.length, 0) <= graphLimit) return bySource.flat();
  const active = bySource.filter(source => source.length);
  const eligible = active.slice(0, graphLimit);
  let remaining = graphLimit;
  const groups = eligible.map(source => {
    const limit = Math.min(source.length, Math.floor(graphLimit / eligible.length));
    remaining -= limit;
    return { source, limit };
  });
  for (const group of groups) {
    const additional = Math.min(group.source.length - group.limit, remaining);
    group.limit += additional;
    remaining -= additional;
  }
  return groups.flatMap(({ source, limit }) => {
    if (source.length <= limit) return source;
    if (limit === 1) return source.slice(0, 1);
    return Array.from({ length: limit }, (_, index) => source[Math.floor(index * (source.length - 1) / (limit - 1))]!);
  });
}

function scoreGraph(candidates: Candidate[]) {
  let max = 0;
  for (const [index, left] of candidates.entries()) {
    for (let rightIndex = index + 1; rightIndex < candidates.length; rightIndex++) {
      const right = candidates[rightIndex]!;
      const weight = overlap(left.words, right.words);
      // Ignore very weak ties and discount close repeats as evidence of centrality.
      if (weight < 0.1 || weight >= 0.8) continue;
      left.degree += weight;
      right.degree += weight;
      max = Math.max(max, left.degree, right.degree);
    }
  }
  for (const item of candidates) {
    const centrality = max ? item.degree / max : 0;
    item.score = 0.35 * centrality + 0.32 * item.position + 0.18 * item.title + 0.08 * item.numbers + 0.07 * item.complete;
  }
}

/** Select real sentences with lexical centrality and novelty, then put them back into source order. */
export function summarize(sources: readonly WritingSource[], format: WritingFormat, count?: number): EvidenceSpan[] {
  const target = summaryTarget(format, count);
  const candidates = graphCandidates(sources.map((source, index) => candidatesFor(source, index, target)));
  scoreGraph(candidates);
  const selected: Candidate[] = [];
  const used = new Set<string>();
  // PDF pages from the same document share a title or URL, so page count alone earns no diversity bonus.
  const sourceIds = sources.map(source => source.url ?? source.title);
  let words = target.words, characters = target.characters;
  while (selected.length < target.sentences) {
    const ranking = (candidate: Candidate) => candidate.score - 0.15 * candidate.similarity
      + (used.has(sourceIds[candidate.sourceIndex]!) ? 0 : 0.15);
    let best: Candidate | undefined;
    for (const candidate of candidates) {
      if (candidate.length > words || candidate.span.text.length > characters
        || best && ranking(candidate) <= ranking(best)
        || selected.some(item => exactOrRedundant(item.span.text, candidate.span.text))) continue;
      best = candidate;
    }
    if (!best) break;
    selected.push(best);
    used.add(sourceIds[best.sourceIndex]!);
    words -= best.length;
    characters -= best.span.text.length;
    for (const candidate of candidates) candidate.similarity = Math.max(candidate.similarity, overlap(candidate.words, best.words));
  }
  return selected.sort((left, right) => left.sourceIndex - right.sourceIndex || left.span.start - right.span.start).map(item => item.span);
}
