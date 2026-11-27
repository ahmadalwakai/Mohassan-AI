import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { SkillGapObservation } from '@mohassan/contracts';
import { collectStateEvidence, criterionLabel, decideVerdict, settleOpenSteps, tryEnterPhase, type RunLedger } from '../assistant/agent-run.js';
import type { BrainState } from '../assistant/brain.js';
import type { EffectiveRequestSource } from '../assistant/effective-request-source.js';
import { requiresVerbatimReply, reviewReplyCandidate } from '../assistant/reply-turn.js';
import { monitorChat } from '../monitors/chat.js';
import { registerReminderContext } from './chat-context.js';
import { handleReminderChat, reminderRouting, type ChatReminderStore } from './chat.js';

const stores = new WeakMap<Kysely<any>, ChatReminderStore>();

export function registerReminderChat(db: Kysely<any>, store: ChatReminderStore) {
  stores.set(db, store);
  registerReminderContext(db);
}

interface ReminderTurn {
  db: Kysely<any>;
  state: BrainState;
  runId: string;
  ownerId: string;
  id: string;
  run: Record<string, unknown>;
  effectiveSource: EffectiveRequestSource;
  runTransaction<T>(id: string, runId: string, work: (tx: Kysely<any>) => Promise<T>): Promise<T>;
  pause(id: string, runId: string, state: BrainState, status: 'waiting_user', fields: Record<string, unknown>, text: string): Promise<void>;
  addMessage(tx: Kysely<any>, id: string, role: 'assistant', text: string): Promise<void>;
  recordTerminalRun(tx: Kysely<any>, runId: string, status: 'completed' | 'partial' | 'blocked'): Promise<void>;
  ledgerSafe(state: BrainState, runId: string, change: (ledger: RunLedger) => void): void;
  recordSkillGap?(tx: Kysely<any>, observation: SkillGapObservation): Promise<void>;
  scrub<T>(value: T): T;
  releaseVault(): void;
}

export async function dispatchReminderTurn(turn: ReminderTurn): Promise<boolean> {
  const { db, state, runId, ownerId, id, run, effectiveSource, ledgerSafe, scrub } = turn;
  const decision = await monitorChat(db)?.beforeReminder({
    ownerId, conversationId: id, runId, text: effectiveSource.request, state,
  });
  const store = stores.get(db);
  if (!store || run.intent !== 'task' || typeof run.attempt !== 'number') return false;
  const transact = <T>(work: (tx: Transaction<any>) => Promise<T>) => turn.runTransaction(id, runId, tx => {
    if (!tx.isTransaction) throw new Error('The reminder turn requires a chat transaction.');
    return work(tx as Transaction<any>);
  });
  const handled = await handleReminderChat({ store, db, state, userId: ownerId, conversationId: id, runId, attempt: run.attempt,
    request: effectiveSource.request, routing: state.routing, now: new Date(effectiveSource.evaluatedAt), transact,
    monitorDecision: decision });
  if (!handled) return false;

  state.routing = reminderRouting;
  ledgerSafe(state, runId, ledger => {
    tryEnterPhase(ledger, 'understanding', Date.now());
    if (ledger.context) ledger.context.limitations = ledger.context.limitations.filter(item => item !== 'reminders');
  });
  if ('question' in handled) {
    const question = scrub(handled.question);
    await turn.pause(id, runId, state, 'waiting_user', { question: JSON.stringify(question) }, question.prompt);
    return true;
  }

  // The active run and account are checked by the host's transaction fence. A reminder
  // change, its reply and the run verdict commit together even on edit or cancel.
  await transact(async tx => {
    const result = await handled.publish(tx);
    const verbatim = requiresVerbatimReply(state);
    const reply = reviewReplyCandidate(state, { text: scrub(result.text) }, result.status, verbatim);
    const { text } = reply;
    let { status } = reply;
    if (verbatim && status === 'completed' && state.completionReview && !state.completionReview.allowCompletion) status = 'partial';
    const at = new Date();
    ledgerSafe(state, runId, ledger => {
      collectStateEvidence(ledger, state, at.getTime());
      ledger.path ??= 'direct';
      settleOpenSteps(ledger, status, at.getTime());
      if (ledger.path === 'direct') tryEnterPhase(ledger, 'answering', at.getTime());
      status = decideVerdict(ledger, { hostStatus: status, review: state.completionReview ?? null, at: at.getTime(),
        enforced: state.supervision?.contract.mode === 'enforced',
        criterionLabels: Object.fromEntries((state.supervision?.contract.criteria ?? []).map(item => [item.id, criterionLabel(ledger, item.id, item.description)])),
      }).status;
    });
    await turn.addMessage(tx, id, 'assistant', text);
    if (state.completionReview) await tx.insertInto('chat_events').values({ id: randomUUID(), conversation_id: id, run_id: runId,
      kind: 'task_review', message: 'مراجعة شروط المهمة المعلنة؛ لا تعني تصديق كل عبارة في الجواب.',
      data: JSON.stringify({ contractHash: state.supervision?.contract.hash, review: state.completionReview }),
    }).execute();
    await tx.updateTable('chat_conversations').set({ status: 'idle', active_run_id: null, progress: null, error: null, updated_at: at }).where('id', '=', id).execute();
    await tx.updateTable('chat_runs').set({ status, state: JSON.stringify(scrub(state)), updated_at: at }).where('id', '=', runId).execute();
    await turn.recordTerminalRun(tx, runId, status);
    if (status !== 'completed') await turn.recordSkillGap?.(tx, { ownerId, chatRunId: runId, outcome: status, signal: state.gapSignal ?? null });
  });
  turn.releaseVault();
  return true;
}
