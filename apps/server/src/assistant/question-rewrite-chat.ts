import type { Kysely } from 'kysely';
import { analyzeCompoundRequest } from './compound-request.js';
import { recognizeEverydayClarification } from './everyday-clarification.js';
import { webQuestion } from './hands.js';
import { reviewGeneratedPublicQuery } from './public-query-provenance.js';
import { parseQuestionRewriteRequest } from './question-rewrite-request.js';
import { rewriteFollowUpQuestion, type QuestionHistory } from './question-rewriter.js';
import { splitReplyDirective } from './reply-directive.js';
import { parseRequestContextState } from './request-context.js';
import { assessRequestScope, reviewPublicProjection } from './request-scope.js';
import { decideHostRequestRoute, decideRequestRoute, type RequestRoutingInput, type RoutingHandler, type RoutingReason } from './routing-decision.js';
import { arbitrateComponent } from './model-relations-arbiter.js';

export function renderQuestionRewrite(request: string, handler: RoutingHandler | undefined): string | null {
  if (handler !== 'writing') return null;
  const supplied = parseQuestionRewriteRequest(request);
  if (!supplied) return null;
  const question = rewriteFollowUpQuestion(supplied.question, supplied.history);
  if (supplied.omitEndingPunctuation) return question.replace(/[.!?؟…]+$/u, '').trimEnd();
  if (/[?؟]$/u.test(question)) return question;
  return question.replace(/[.!…]+$/u, '').trimEnd() + (/\p{Script=Arabic}/u.test(question) ? '؟' : '?');
}

export async function completeQuestionRewrite(request: string, state: { routing?: { handler: RoutingHandler }; dropHeld?: boolean },
  dropHeld: () => Promise<void>, finish: (question: string) => Promise<void>): Promise<boolean> {
  const question = renderQuestionRewrite(request, state.routing?.handler);
  if (question === null) return false;
  // Steering invalidates a held action even when the replacement ends before browser setup.
  if (state.dropHeld) {
    await dropHeld();
    state.dropHeld = false;
  }
  await finish(question);
  return true;
}

export function questionRewriteHandsPlan(reason: RoutingReason | undefined, contextualQuery: string | null, conversationQuery: string | null) {
  const rewritten = reason === 'rewritten_question' && contextualQuery ? webQuestion(contextualQuery) : null;
  return rewritten ?? (conversationQuery ? webQuestion(conversationQuery) : null);
}

const questionStart = /^(?:(?:and|but)\s+)?(?:what|which|who|whom|whose|where|when|why|how|do|does|did|is|are|was|were|has|have|can|could|will|would|then|after that)\b|^[وف]?(?:هل|من|ما|ماذا|أي|كم|كيف|أين|متى|لماذا|وين|ليش|ماذا بعد|بعد ذلك)(?=\s|[؟?]|$)/iu;

async function readTurns(db: Kysely<any>, conversationId: string): Promise<QuestionHistory['turns']> {
  const messages = await db.selectFrom('chat_messages').select(['role', 'text'])
    .where('conversation_id', '=', conversationId).where('role', 'in', ['user', 'assistant'])
    .orderBy('created_at', 'desc').limit(16).execute();
  const turns: Array<{ question: string; answer?: string }> = [];
  for (const message of messages.reverse()) {
    const last = turns.at(-1);
    if (message.role === 'user') turns.push({ question: message.text });
    else if (last) last.answer = message.text;
  }
  return turns;
}

/** Resolve ordinary public follow-ups before routing while retaining the raw message as the authority. */
export async function routeWithQuestionHistory(db: Kysely<any>, conversationId: string, publicTerms: unknown, allowLive: boolean,
  input: RequestRoutingInput) {
  const fallback = () => allowLive ? decideHostRequestRoute(input) : decideRequestRoute(input);
  if (!allowLive || process.env.MOHASSAN_QUESTION_REWRITER !== '1' || input.pendingQuestion
    || !questionStart.test(input.text) || splitReplyDirective(input.text).directive) return fallback();
  const previous = parseRequestContextState(input.context)?.sourceAssessment;
  if (previous?.source !== 'public_lookup' || previous.operation !== 'lookup' || !previous.publicQueryEligible) return fallback();
  if (recognizeEverydayClarification(input.text, input.previousTurns === undefined || input.previousTurns > 0)) return fallback();

  const scopeOptions = { contextKind: 'follow_up' as const, previous };
  const current = assessRequestScope(input.text, scopeOptions);
  if (!current.publicQueryEligible || current.operation !== 'lookup' || current.constraints
    || analyzeCompoundRequest(input.text).kind !== 'single') return fallback();

  const original = fallback();
  if (original.reason === 'request_refused' || original.reason === 'scratch_refuse' || original.reason === 'scratch_out_of_scope'
    || original.availability === 'restricted') return original;
  const turns = await readTurns(db, conversationId);
  const question = rewriteFollowUpQuestion(input.text, { turns });
  if (question === input.text || !reviewGeneratedPublicQuery(input.text, question, publicTerms).eligible
    || !reviewPublicProjection(input.text, question, scopeOptions).eligible) return original;

  const routed = decideRequestRoute({ ...input, text: question });
  if (routed.route !== 'web_search' || routed.handler !== 'search' || !routed.sourceAssessment.publicQueryEligible) return original;
  const source: typeof current = { ...current, reasons: ['inherited_source'] };
  const resolution = { ...routed.resolution, kind: 'follow_up' as const, original: input.text.replace(/\s+/gu, ' ').trim(),
    query: question, sourceAssessment: source };
  const rewritten = { ...routed, reason: 'rewritten_question' as const, resolution, sourceAssessment: source, publicQuery: question };
  if (original.handler !== 'search' || !original.publicQuery || original.publicQuery === question) return rewritten;
  return arbitrateComponent('question-rewrite', { text: input.text, runId: input.turnId, conversationState: resolution.kind },
    { component: 'question-rewriter', label: rewritten.reason, result: rewritten },
    [{ component: 'factual-lookup', label: original.reason, result: original }]);
}
