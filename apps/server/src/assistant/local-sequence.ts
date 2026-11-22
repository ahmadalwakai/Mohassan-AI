import { analyzeCompoundRequest } from './compound-request.js';
import { evaluateLocalComputation } from './local-computation.js';
import type { Claim, Evidence } from './mind/contract.js';
import { evaluateSelfQuestion, type SelfFacts } from './self-knowledge.js';

/**
 * Two or more requests in one message, joined by a sequence word: «كم حاصل 17 × 23؟ ثم اذكر في جملتين ما الأدوات التي
 * تستطيع استخدامها الآن فعلياً» (real request rq039, 2026-11-22). This is step 4 of the task cycle («التخطيط») for the
 * parts the host answers by itself: the message is split where compound-request.ts finds the sequence word, each part
 * goes to a local answerer (the calculator, then the questions about Mohassan), and the answers are joined in the order
 * they were asked.
 *
 * Only a message whose every part is a local answer is taken. One part that needs the web, a tool or an action («احسب
 * 5 + 3 ثم ابحث عن …», «احسب … ثم أرسل النتيجة») makes the whole message null, and the paths that ran before this
 * planner run as they did: no half answer hides the part it did not do. Nothing here calls a model, the network or a tool.
 */
export const MAX_SEQUENCE_PARTS = 4;

export interface LocalSequenceDeps {
  now: Date;
  /** The host's facts for this conversation, as the questions about the assistant already receive them. */
  self: SelfFacts;
}

export interface LocalSequencePart {
  source: 'computation' | 'self';
  /** The owner's words for this part, exactly as written. */
  request: string;
  text: string;
  status: 'completed' | 'partial' | 'blocked';
  claims: Claim[];
  evidence: Evidence[];
}

export interface LocalSequence {
  status: 'completed' | 'partial' | 'blocked';
  text: string;
  lang: 'ar' | 'en';
  parts: LocalSequencePart[];
}

/**
 * The parts of a message in order, or null when it is one request or has too many parts to take. A sequence word before
 * a request compound-request.ts does not know ends one part («… ثم اذكر …»); a calculation after another request («ما
 * قدراتك؟ ثم احسب ٣ × ٣») is a part of its own too, since the calculator answers it here. Any other follow-up action
 * (save, send, open, …) keeps the message whole, and the paths before this planner keep it.
 */
function split(text: string, depth: number): string[] | null {
  // Every call reads a strictly shorter span; the depth bound only caps the work on a pathological message.
  if (depth > MAX_SEQUENCE_PARTS * 2) return null;
  const analysis = analyzeCompoundRequest(text);
  if (analysis.kind === 'unsupported_tail' && analysis.tail?.text && analysis.primary.text) {
    const head = split(analysis.primary.text, depth + 1);
    const rest = head && split(analysis.tail.text, depth + 1);
    return head && rest ? [...head, ...rest] : null;
  }
  if (analysis.kind === 'compound' && analysis.pendingActions.length && !analysis.forbiddenActions.length && !analysis.formatting.length
    && analysis.pendingActions.every(action => action.kind === 'compute')) {
    return [analysis.primary.text, ...analysis.pendingActions.map(action => action.text)];
  }
  return [text.trim()];
}

function parts(request: string): string[] | null {
  const found = split(request, 0);
  return found && found.length >= 2 && found.length <= MAX_SEQUENCE_PARTS && found.every(part => part.trim()) ? found : null;
}

function answer(request: string, deps: LocalSequenceDeps): LocalSequencePart | null {
  const computation = evaluateLocalComputation(request, deps.now);
  if (computation) {
    // A calculation with its own follow-up action («احسب … ثم احفظ») is not a whole local answer.
    if (computation.compound?.pendingActions.length || computation.compound?.forbiddenActions.length) return null;
    return { source: 'computation', request, text: computation.text, status: computation.status, claims: computation.claims, evidence: computation.evidence };
  }
  const self = evaluateSelfQuestion(request, deps.self);
  if (self && (self.status === 'completed' || self.status === 'partial' || self.status === 'blocked')) {
    return { source: 'self', request, text: self.text, status: self.status, claims: self.claims, evidence: self.evidence };
  }
  return null;
}

/** The joined local answer of a message of several parts, or null when it is not one (see the module comment). */
export function evaluateLocalSequence(request: string, deps: LocalSequenceDeps): LocalSequence | null {
  if (typeof request !== 'string' || !request.trim() || !Number.isFinite(deps.now.getTime())) return null;
  const split = parts(request);
  if (!split) return null;
  const answered: LocalSequencePart[] = [];
  for (const part of split) {
    const reply = answer(part, deps);
    if (!reply) return null;
    answered.push(reply);
  }
  const completed = answered.filter(part => part.status === 'completed').length;
  return {
    status: completed === answered.length ? 'completed' : completed ? 'partial' : 'blocked',
    text: answered.map(part => part.text.trim()).join('\n\n'),
    lang: /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en',
    parts: answered,
  };
}
