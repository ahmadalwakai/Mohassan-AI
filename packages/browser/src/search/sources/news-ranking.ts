import type { SearchHit } from '../../research.js';
import { searchTokens, type RankedHit } from '../ranking.js';

const englishNews = /(?:^(?:please )?(?:(?:show me|give me|tell me|what is|what are|what's) )?(?:the )?(?:(?:latest|breaking|recent|current|today's) )?|\b(?:latest|breaking|recent|current) )(?:news|headlines)\b(?: (?:on|about|from|in|for)\b)?/u;
const arabicNews = /(?:^(?:(?:ما(?: هي)?|اريد|اعطني) )?(?:(?:اخر|احدث) )?|(?<![\p{L}\p{N}])(?:اخر|احدث) )(?:ال)?اخبار(?![\p{L}\p{N}])(?: (?:عن|حول|بشان|في)(?![\p{L}\p{N}]))?/u;
const eventQuestion = /(?<![\p{L}\p{N}])(?:what (?:has )?happened|ماذا (?:حدث|حصل)|ما (?:حدث|حصل))(?![\p{L}\p{N}])/u;
const timeWording = /(?<![\p{L}\p{N}])(?:(?<today>today(?:'s)?|اليوم)|(?<yesterday>yesterday(?:'s)?|امس)|(?<week>this week|هذا الاسبوع)|(?<month>this month|هذا الشهر))(?![\p{L}\p{N}])/u;
type NewsTimePeriod = 'today' | 'yesterday' | 'week' | 'month';

function normalizedText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[أإآٱ]/gu, 'ا')
    .replace(/[\u0640\p{M}\p{Cf}]/gu, '').replace(/[‘’]/gu, "'").replace(/\s+/gu, ' ').trim();
}

function unquotedQuestion(question: string): string {
  return normalizedText(question.replace(/"[^"]*"/gu, ' '));
}

export function newsTimePeriod(question: string): NewsTimePeriod | undefined {
  const groups = timeWording.exec(unquotedQuestion(question))?.groups;
  if (!groups) return undefined;
  if (groups.today) return 'today';
  if (groups.yesterday) return 'yesterday';
  return groups.week ? 'week' : 'month';
}

export function hasNewsWording(question: string): boolean {
  const normalized = unquotedQuestion(question);
  return englishNews.test(normalized) || arabicNews.test(normalized)
    || eventQuestion.test(normalized) && timeWording.test(normalized);
}

export function newsTopicTokens(query: { question: string; phrases: readonly string[]; tokens: readonly string[] }): string[] {
  const question = unquotedQuestion(query.question);
  const withoutNewsWording = question.replace(englishNews, ' ').replace(arabicNews, ' ');
  const subject = timeWording.test(question)
    ? withoutNewsWording.replace(eventQuestion, ' ').replace(new RegExp(timeWording, 'gu'), ' ')
    : withoutNewsWording;
  const retained = new Set([...searchTokens(subject), ...query.phrases.flatMap(searchTokens)]);
  const removed = new Set(searchTokens(question).filter(term => !retained.has(term)));
  return query.tokens.filter(term => !removed.has(term));
}

export function sameNewsTitle(a: string, b: string): boolean {
  const titleText = (title: string) => normalizedText(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const left = titleText(a), right = titleText(b);
  if (!left || !right) return false;
  if (left === right) return true;

  // A change in the figures can be the story itself. Only compare near matches
  // with the same numbers, and require enough shared words to identify the event.
  const numbers = (title: string) => (title.match(/\p{N}+/gu) ?? []).join(' ');
  if (numbers(left) !== numbers(right)) return false;
  const leftWords = new Set(searchTokens(left)), rightWords = new Set(searchTokens(right));
  const common = [...leftWords].filter(word => rightWords.has(word)).length;
  return common >= 4 && common / (leftWords.size + rightWords.size - common) >= 0.8;
}

export const newsEvidence = Symbol('newsEvidence');
export type NewsHit = SearchHit & {
  [newsEvidence]: { date: number; kind: 'published' | 'updated' | 'indexed'; relevance: number };
};

export function asNewsHit(hit: SearchHit): NewsHit | undefined {
  return newsEvidence in hit ? hit as NewsHit : undefined;
}

export function newsRelevance(terms: string[], title: string, summary: string): number {
  const titleWords = new Set(searchTokens(title));
  const summaryWords = new Set(searchTokens(summary));
  const matches = terms.map(term => titleWords.has(term) ? 2 : Number(summaryWords.has(term)));
  if (matches.filter(Boolean).length < Math.min(4, Math.ceil(terms.length * 0.6))) return 0;
  return matches.reduce((sum, match) => sum + match, 0);
}

export function mergeNewsHits<T extends NewsHit>(hits: T[]): T[][] {
  const sorted = [...hits].sort((a, b) => {
    const left = a[newsEvidence], right = b[newsEvidence];
    return right.relevance - left.relevance || right.date - left.date || a.url.localeCompare(b.url);
  });
  const links = new Map<string, T[]>();
  for (const hit of sorted) {
    const matches = links.get(hit.url);
    if (matches) matches.push(hit);
    else links.set(hit.url, [hit]);
  }
  const groups: T[][] = [];
  for (const matches of links.values()) {
    const group = groups.find(([first]) => sameNewsTitle(first.title, matches[0].title));
    if (group) group.push(...matches);
    else groups.push(matches);
  }
  return groups;
}

export function rankNewsHits(results: readonly { provider: string; hits: SearchHit[] }[], limit: number): RankedHit[] {
  const news = results.flatMap(({ provider, hits }) => hits.slice(0, 40).flatMap(hit => {
    const evidence = asNewsHit(hit);
    return evidence ? [{ ...evidence, provider }] : [];
  }));
  const merged = mergeNewsHits(news).map(group => {
    // When the same link has a publisher date, prefer it over a search index timestamp.
    const preferred = group.find(hit => hit.url === group[0].url && hit[newsEvidence].kind === 'published') ?? group[0];
    const { title, url, snippet, [newsEvidence]: evidence } = preferred;
    return {
      title, url, snippet,
      providers: [...new Set(group.filter(hit => hit.url === url).map(hit => hit.provider))].sort(),
      relevance: 'lexical' as const,
      score: evidence.relevance,
      date: evidence.date,
    };
  }).sort((a, b) => b.score - a.score || b.date - a.date || a.url.localeCompare(b.url));

  const countByHost = new Map<string, number>();
  const ranked: RankedHit[] = [];
  for (const { date, ...hit } of merged) {
    const host = new URL(hit.url).hostname;
    const count = countByHost.get(host) ?? 0;
    if (count >= 3) continue;
    countByHost.set(host, count + 1);
    ranked.push(hit);
    if (ranked.length >= limit) break;
  }
  return ranked;
}
