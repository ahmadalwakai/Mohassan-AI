import { createHash } from 'node:crypto';
import { normalizeLearningText, type LessonScope } from './lessons.ts';

/** Version the retrieval/serialization policy independently from model weights. */
export const LEARNING_CONTEXT_POLICY = 'lexical-chunks-context-v1';
export const LEARNING_CONTEXT_BUDGET = 3200;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const escapedContextLength = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').length;

export interface KnowledgeChunk { index: number; text: string; hash: string; start: number; end: number }
export interface KnowledgeContextDocument {
  id: string; version: number; title: string; text: string; contentHash: string;
  sourceHash: string; source?: string; sourcePath?: string;
}
export interface KnowledgeMatch {
  id: string; version: number; title: string; text: string; hash: string; source: string;
  sourceHash: string; documentHash: string; sourcePath?: string; score: number; trust: 'untrusted';
}
export type LearningContextEntry =
  | { kind: 'lesson'; id: string; text: string; scope?: LessonScope; hash?: string; trust: 'untrusted' }
  | { kind: 'knowledge'; source: string; title: string; text: string; hash: string; documentHash: string; sourceHash: string; trust: 'untrusted' };

export function knowledgeChunks(text: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1600, text.length);
    if (end < text.length) { const breakAt = text.lastIndexOf('\n', end); if (breakAt > start + 800) end = breakAt + 1; }
    const chunk = text.slice(start, end);
    if (chunk.trim()) chunks.push({ index: chunks.length, text: chunk, hash: hash(chunk), start, end });
    start = end;
  }
  return chunks;
}

export function knowledgeQueryTerms(query: string): string[] {
  return [...new Set(normalizeLearningText(query).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 24);
}

/** Same full-document selection for runtime and isolated candidate replay. */
export function selectKnowledgeChunks(documents: readonly KnowledgeContextDocument[], query: string, limit = 3): KnowledgeMatch[] {
  const terms = knowledgeQueryTerms(query);
  if (!terms.length) return [];
  const results: KnowledgeMatch[] = [];
  for (const document of documents) {
    // Never serve cached chunks that disagree with the evaluated document version.
    if (hash(document.text) !== document.contentHash) throw new Error('LEARNING_DOCUMENT_HASH_MISMATCH');
    for (const chunk of knowledgeChunks(document.text)) {
      const normalized = normalizeLearningText(`${document.title} ${chunk.text}`);
      const score = terms.filter(term => normalized.includes(term)).length;
      if (score) results.push({ id: document.id, version: document.version, title: document.title, text: chunk.text,
        hash: chunk.hash, source: `${document.source ?? `knowledge:${document.id}:${document.version}`}#${chunk.index}`,
        sourceHash: document.sourceHash, documentHash: document.contentHash,
        ...(document.sourcePath ? { sourcePath: document.sourcePath } : {}), score, trust: 'untrusted' });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)).slice(0, Math.max(1, Math.min(12, Number.isFinite(limit) ? Math.trunc(limit) : 3)));
}

export function knowledgeContextEntry(row: KnowledgeMatch): LearningContextEntry {
  return { kind: 'knowledge', source: row.source, title: row.title, text: row.text, hash: row.hash,
    documentHash: row.documentHash, sourceHash: row.sourceHash, trust: 'untrusted' };
}

export function lessonContextEntry(row: { id: string; text: string; scope?: LessonScope; hash?: string; content_hash?: string }): LearningContextEntry {
  return { kind: 'lesson', id: row.id, text: row.text, ...(row.scope ? { scope: row.scope } : {}),
    ...(row.hash ?? row.content_hash ? { hash: row.hash ?? row.content_hash } : {}), trust: 'untrusted' };
}

/** Complete entries and hashes only. Skipped chunks remain unevaluated by this query. */
export function serializeLearningContext(entries: readonly LearningContextEntry[], budget = LEARNING_CONTEXT_BUDGET): string {
  const bound = Math.max(0, Math.min(LEARNING_CONTEXT_BUDGET, Number.isFinite(budget) ? Math.trunc(budget) : 0));
  const selected: LearningContextEntry[] = [];
  const encode = (items: readonly LearningContextEntry[]) => JSON.stringify({ policy: LEARNING_CONTEXT_POLICY, trust: 'untrusted', permissionsGranted: false, entries: items });
  for (const entry of entries) {
    if (escapedContextLength(encode([...selected, entry])) <= bound) selected.push(entry);
  }
  return selected.length ? encode(selected) : '';
}
