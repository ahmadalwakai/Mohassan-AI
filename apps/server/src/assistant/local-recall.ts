import { buildFrame } from './mind/frame.js';
import { recall } from './mind/recall.js';
import type { LocalReply } from './mind/limits.js';
import { explicitKnowledgeDocumentRequest } from './knowledge-document-request.js';

export interface LocalRecallDependencies {
  /** Only explicit evidence returned by the owner's memory adapter belongs here. */
  memory(query: string): Promise<readonly string[]>;
}

export interface LocalRecallContext { intent: 'memory'; topic: string }

/**
 * Reuse the evidence-bound recall capability without enabling the experimental
 * Mind branch. This function cannot save memories or fall back to a public search.
 * It never treats an adapter's free-form explanation as a retrieved memory.
 */
export async function evaluateLocalRecall(request: string, deps: LocalRecallDependencies, signal: AbortSignal, context?: LocalRecallContext): Promise<LocalReply | null> {
  signal.throwIfAborted();
  if (!request.trim() || request.length > 4000 || explicitKnowledgeDocumentRequest(request)) return null;
  const frame = buildFrame(request);
  if (context && context.topic.length <= 600) {
    frame.intent = 'memory_recall';
    frame.personal = true;
    frame.text = `${request}\n${context.topic}`;
  }
  if (frame.intent !== 'memory_recall' || frame.missing.length) return null;
  return recall(frame, request, {
    async memory(query) {
      const evidence = await deps.memory(query);
      signal.throwIfAborted();
      return evidence.slice(0, 30).filter(item => typeof item === 'string' && item.length > 0 && item.length <= 4000);
    },
  }, signal);
}
