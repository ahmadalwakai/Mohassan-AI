import { comparable, type JudgeEvidence } from './judge.js';

const STOP = new Set(['ما', 'ماذا', 'من', 'متى', 'اين', 'أين', 'كيف', 'كم', 'هل', 'هو', 'هي', 'في', 'على', 'عن', 'الى', 'إلى', 'التي', 'الذي', 'ذلك', 'هذه', 'هذا',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'is', 'are', 'was', 'were', 'what', 'who', 'when', 'where', 'how', 'which', 'does', 'did', 'do', 'and', 'or', 'for', 'with']);
const MAX_PASSAGE = 1_200;
const TEMPLATE = { en: { q: 'Question: ', a: 'Answer:' }, ar: { q: 'سؤال: ', a: 'الجواب:' } } as const;

export function readerPrompt(question: string, passage: string): string {
  const template = /\p{Script=Arabic}/u.test(question) ? TEMPLATE.ar : TEMPLATE.en;
  return `${passage}\n\n${template.q}${question}\n${template.a}`;
}

function words(text: string): string[] {
  return comparable(text).split(' ').filter(word => word.length >= 2 && !STOP.has(word));
}

/** The best passage of the pages for the question: the paragraph sharing the most question words. */
export function selectPassage(question: string, evidence: readonly JudgeEvidence[]): { text: string; title?: string; url?: string } | null {
  const asked = new Set(words(question));
  if (!asked.size) return null;
  let best: { text: string; title?: string; url?: string; score: number } | null = null;
  for (const page of evidence) {
    if (page.kind !== 'page') continue;
    const paragraphs = page.text.split(/\n\s*\n|\n/u).map(part => part.trim()).filter(part => part.length >= 40);
    for (const paragraph of paragraphs) {
      for (let start = 0; start < paragraph.length; start += MAX_PASSAGE) {
        const text = paragraph.slice(start, start + MAX_PASSAGE);
        const score = new Set(words(text).filter(word => asked.has(word))).size;
        if (score > (best?.score ?? 0)) best = { text, title: page.title, url: page.url, score };
      }
    }
  }
  return best && best.score >= Math.min(2, asked.size) ? { text: best.text, title: best.title, url: best.url } : null;
}

/**
 * Search results the council reads, best first: the hits sharing the most question words in their title and snippet,
 * one per site, whatever the site is (an encyclopedia is one source among the others, not the default).
 */
export function rankHits<T extends { title: string; url: string; snippet?: string }>(question: string, hits: readonly T[]): T[] {
  const asked = new Set(words(question));
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return url; } };
  const scored = hits.filter(hit => /^https?:\/\//iu.test(hit.url)).map((hit, index) => ({
    hit, index, score: new Set(words(`${hit.title} ${hit.snippet ?? ''}`).filter(word => asked.has(word))).size,
  })).sort((first, second) => second.score - first.score || first.index - second.index);
  const seen = new Set<string>();
  const ranked: T[] = [];
  for (const { hit, score } of scored) {
    const site = host(hit.url);
    if (score === 0 || seen.has(site)) continue;
    seen.add(site);
    ranked.push(hit);
  }
  return ranked;
}
