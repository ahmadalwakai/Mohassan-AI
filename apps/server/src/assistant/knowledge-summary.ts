import type { Claim, Evidence, Lang } from './mind/contract.js';
import type { LocalReply } from './mind/limits.js';
import type { LocalKnowledgeDocument } from './local-knowledge.js';
import { knowledgeSummaryRequest, matchesKnowledgeTitle } from './knowledge-document-request.js';

type SummaryRequest = NonNullable<ReturnType<typeof knowledgeSummaryRequest>>;

export function knowledgeQuoteClaim(title: string, quote: string, lang: Lang, bullet = false): string {
  return `${bullet ? '- ' : ''}${lang === 'ar' ? 'من مستند' : 'From document'} «${title}»: «${quote}»`;
}

const documentIdentity = (document: LocalKnowledgeDocument) => `${document.title}\0${document.source.replace(/#\d+$/u, '')}`;
const chunkNumber = (source: string) => Number(/#(\d+)$/u.exec(source)?.[1] ?? 0);

/** Summarize one source with exact excerpts in source order. */
export function summarizeKnowledgeDocument(request: SummaryRequest, documents: readonly LocalKnowledgeDocument[], lang: Lang): LocalReply | null {
  const named = documents.filter(document => matchesKnowledgeTitle(request.title, document.title));
  if (!named.length || new Set(named.map(documentIdentity)).size !== 1) return null;
  const sentence = new Intl.Segmenter(lang, { granularity: 'sentence' });
  const chunks = named.toSorted((left, right) => chunkNumber(left.source) - chunkNumber(right.source));
  const limit = request.count ?? 3;
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const document of chunks) {
    for (const entry of sentence.segment(document.text)) {
      const quote = entry.segment.trim();
      // Keep only whole, distinct statements within the evidence record bounds.
      if (!quote || quote.length > 320 || seen.has(quote)) continue;
      seen.add(quote);
      evidence.push({ id: `document-summary-${evidence.length + 1}`, source: 'knowledge', title: document.title, sourceRef: document.source, quote });
      if (evidence.length >= limit) break;
    }
    if (evidence.length >= limit) break;
  }
  if (!evidence.length) return null;
  const claims: Claim[] = evidence.map(item => ({
    text: knowledgeQuoteClaim(item.title!, item.quote, lang, request.bullet), support: [item.id], status: 'single_source',
  }));
  return { status: 'completed', text: claims.map(claim => claim.text).join('\n'), claims, evidence };
}
