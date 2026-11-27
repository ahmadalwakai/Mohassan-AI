import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Kysely } from 'kysely';
import type { JudgeVerdict } from '../judge.js';
import type { JudgeShadowInput } from '../judge-shadow.js';
import { enforceReplyConstraints } from '../reply-constraint-review.js';
import { reviewReply, type ReviewFinding, type ReviewResult } from './checks.js';
import { buildConversationLedger, buildConversationSummary, SUMMARY_MIN_MESSAGES, type ConversationLedger, type ConversationSummary, type ReviewMessage } from './ledger.js';

export { ensureChatConversationsTable } from '@mohassan/database';

interface ReviewContext {
  id: string;
  runId: string;
  allowApply: boolean;
  clean: (text: string) => string;
}

export interface ConversationReviewLog {
  version: 1;
  action: ReviewResult['action'];
  applied: boolean;
  findings: ReviewFinding[];
  ms: number;
}

const activeReview = new AsyncLocalStorage<{
  context: ReviewContext;
  ledger?: ConversationLedger;
  startedAt: number;
  replacement?: string;
  withheld?: boolean;
}>();

export function conversationReviewForJudge(input: JudgeShadowInput, verdict: JudgeVerdict, applied: boolean): ConversationReviewLog | undefined {
  const scope = activeReview.getStore();
  if (!scope?.ledger || input.conversationId !== scope.context.id || input.runId !== scope.context.runId) return;
  const withheld = applied && verdict.decision === 'withhold';
  const candidate = applied
    ? (withheld ? verdict.withholdText : verdict.fixedReply) ?? input.reply
    : input.reply;
  try {
    const { clean, allowApply } = scope.context;
    const preserveContent = withheld || !allowApply || Boolean(input.evidence?.some(source => source.kind === 'page'));
    const result = reviewReply(scope.ledger, clean(candidate), { status: input.status, evidence: input.evidence, preserveContent, constraints: input.constraints });
    if (allowApply && !withheld && process.env.MOHASSAN_CONVERSATION_REVIEW_APPLY === '1' && result.action !== 'send') {
      if (!preserveContent) { scope.replacement = clean(result.reply); scope.withheld = result.withheld; }
      else if (result.reply.startsWith(candidate)) scope.replacement = candidate + clean(result.reply.slice(candidate.length));
    }
    if (input.constraints) {
      const checked = enforceReplyConstraints(scope.replacement ?? candidate, input.constraints);
      if (checked.text !== candidate) scope.replacement = checked.text;
      scope.withheld ||= checked.withheld;
    }
    return {
      version: 1, action: result.action, applied: scope.replacement !== undefined && scope.replacement !== candidate,
      findings: result.findings.map(({ check, code }) => ({ check, code })), ms: performance.now() - scope.startedAt,
    };
  } catch {
    reportUnavailable();
  }
}

function reportUnavailable() {
  console.error(JSON.stringify({ level: 'warn', event: 'conversation_review_unavailable' }));
}

// The summary contains only committed messages. The current candidate can
// still be replaced by the completion fence or abandoned before publication.
async function loadLedger(tx: Kysely<any>, { id, clean }: ReviewContext): Promise<ConversationLedger> {
  const rows = await tx.selectFrom('chat_messages').select(['id', 'role', 'text']).where('conversation_id', '=', id)
    .orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  const messages: ReviewMessage[] = rows.map(row => ({ id: row.id, role: row.role, content: clean(row.text) }));
  if (messages.length < SUMMARY_MIN_MESSAGES) return buildConversationLedger(messages);
  const { review_summary } = await tx.selectFrom('chat_conversations').select('review_summary')
    .where('id', '=', id).executeTakeFirstOrThrow();
  const ledger = buildConversationLedger(messages, review_summary as ConversationSummary | undefined);
  const summary = buildConversationSummary(ledger);
  await tx.updateTable('chat_conversations').set({ review_summary: JSON.stringify(summary) }).where('id', '=', id).execute();
  return ledger;
}

export async function reviewJudgedReply<T extends { text: string; withheld: boolean }>(
  transaction: (work: (tx: Kysely<any>) => Promise<ConversationLedger>) => Promise<ConversationLedger>,
  context: ReviewContext,
  judgeReply: () => T,
): Promise<T> {
  const startedAt = performance.now();
  let ledger: ConversationLedger;
  try {
    ledger = await transaction(tx => loadLedger(tx, context));
  } catch {
    reportUnavailable();
    return judgeReply();
  }
  const scope: NonNullable<ReturnType<typeof activeReview.getStore>> = { context, ledger, startedAt };
  try {
    const judged = activeReview.run(scope, judgeReply);
    return scope.replacement === undefined ? judged : { ...judged, text: scope.replacement, withheld: judged.withheld || Boolean(scope.withheld) };
  } finally {
    // The judge queues its file write. Do not retain the transcript through it.
    scope.ledger = undefined;
    scope.replacement = undefined;
  }
}
