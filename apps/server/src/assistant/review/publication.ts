import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Kysely } from 'kysely';
import type { JudgeVerdict } from '../judge.js';
import type { JudgeShadowInput } from '../judge-shadow.js';
import { commitReview, prepareReview, readReviewSnapshot } from './checkpoint.js';
import { reviewReply, type ReviewFinding, type ReviewResult } from './checks.js';
import type { ConversationLedger } from './ledger.js';

export { ensureChatConversationsTable } from '@mohassan/database';
export { REVIEW_MESSAGE_WINDOW } from './checkpoint.js';

interface ReviewContext {
  db: Kysely<any>;
  id: string;
  runId: string;
  allowApply: boolean;
  clean: (text: string) => string;
}

export type ConversationReviewLog = {
  version: 1;
  ms: number;
} & (
  | { action: ReviewResult['action']; applied: boolean; findings: ReviewFinding[] }
  | { action: 'skip'; reason: 'revision_changed'; applied: false; findings: [] }
);

const activeReview = new AsyncLocalStorage<{
  context: ReviewContext;
  ledger?: ConversationLedger;
  startedAt: number;
  skipped?: 'revision_changed';
  replacement?: string;
}>();

export function conversationReviewForJudge(input: JudgeShadowInput, verdict: JudgeVerdict, applied: boolean): ConversationReviewLog | undefined {
  const scope = activeReview.getStore();
  if (!scope || input.conversationId !== scope.context.id || input.runId !== scope.context.runId) return;
  if (scope.skipped) {
    return { version: 1, action: 'skip', reason: scope.skipped, applied: false, findings: [], ms: performance.now() - scope.startedAt };
  }
  if (!scope.ledger) return;
  const withheld = applied && verdict.decision === 'withhold';
  const candidate = applied
    ? (withheld ? verdict.withholdText : verdict.fixedReply) ?? input.reply
    : input.reply;
  try {
    const { clean, allowApply } = scope.context;
    const preserveContent = withheld || !allowApply || Boolean(input.evidence?.some(source => source.kind === 'page'));
    const result = reviewReply(scope.ledger, clean(candidate), { status: input.status, evidence: input.evidence, preserveContent });
    if (allowApply && !withheld && process.env.MOHASSAN_CONVERSATION_REVIEW_APPLY === '1' && result.action !== 'send') {
      if (!preserveContent) scope.replacement = clean(result.reply);
      else if (result.reply.startsWith(candidate)) scope.replacement = candidate + clean(result.reply.slice(candidate.length));
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

export async function reviewJudgedReply<T extends { text: string; withheld: boolean }>(
  transaction: (work: (tx: Kysely<any>) => Promise<boolean>) => Promise<boolean>,
  context: ReviewContext,
  judgeReply: () => T,
): Promise<T> {
  const startedAt = performance.now();
  let ledger: ConversationLedger | undefined;
  try {
    const { db, id, clean } = context;
    // The snapshot contains only committed messages. The judging candidate can
    // still change at the publication fence. A concurrent update to the
    // conversation invalidates this snapshot before it can replace the checkpoint.
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await db.transaction().setIsolationLevel('repeatable read').execute(tx => readReviewSnapshot(tx, id));
      const prepared = await prepareReview(snapshot, clean);
      if (await transaction(tx => commitReview(tx, id, prepared))) {
        ledger = prepared.ledger;
        break;
      }
    }
  } catch {
    reportUnavailable();
    return judgeReply();
  }
  if (!ledger) {
    reportUnavailable();
    return activeReview.run({ context, startedAt, skipped: 'revision_changed' }, judgeReply);
  }
  const scope: NonNullable<ReturnType<typeof activeReview.getStore>> = { context, ledger, startedAt };
  try {
    const judged = activeReview.run(scope, judgeReply);
    return scope.replacement === undefined ? judged : { ...judged, text: scope.replacement };
  } finally {
    // The judge queues its file write. Do not retain the transcript through it.
    scope.ledger = undefined;
    scope.replacement = undefined;
  }
}
