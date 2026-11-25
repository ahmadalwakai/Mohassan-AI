import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql, type Kysely } from 'kysely';
import { judge, type JudgeEvidence, type JudgeVerdict } from '../judge.js';
import { reviewReply } from './checks.js';
import { buildConversationLedger, buildConversationSummary, SUMMARY_MIN_MESSAGES, type ConversationSummary } from './ledger.js';

export interface ConversationReviewSettings {
  apply: boolean;
}

export function conversationReviewSettings(env: NodeJS.ProcessEnv): ConversationReviewSettings {
  return { apply: env.MOHASSAN_CONVERSATION_REVIEW_APPLY === '1' };
}

// Called inside the command chat migration transaction, which owns the schema_migrations lock.
export async function conversationReviewMigration(tx: Kysely<any>) {
  const version = '035_chat_conversation_review';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
  await sql`ALTER TABLE chat_conversations ADD COLUMN review_summary jsonb`.execute(tx);
  await sql`ALTER TABLE chat_messages ADD COLUMN conversation_review jsonb`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version }).execute();
}

interface Publication<Context> {
  id: string;
  runId?: string;
  text: string;
  status: string;
  context?: Context;
  preserveContent?: boolean;
  createdAt?: Date;
}

function judgeMetadata(verdict: JudgeVerdict, applied: boolean, source: 'pre_send' | 'publication') {
  return { decision: verdict.decision, applied, source, codes: verdict.codes };
}

export function createConversationPublicationReviewer<Context extends object>(options: {
  apply?: boolean;
  judgeEnabled: boolean;
  clean: (text: string) => string;
  evidenceFor: (context: Context) => readonly JudgeEvidence[];
}) {
  // A multipart reply can have several judge decisions. Keep them in their
  // original order and scoped to this execution, never to another run.
  const judged = new WeakMap<Context, ReturnType<typeof judgeMetadata>[]>();
  const savepoint = sql`SAVEPOINT conversation_review_publication`;
  const rollback = sql`ROLLBACK TO SAVEPOINT conversation_review_publication`;
  const release = sql`RELEASE SAVEPOINT conversation_review_publication`;
  return {
    recordJudge(context: Context, verdict: JudgeVerdict | null, applyFix: boolean, applyWithhold: boolean) {
      if (!verdict) return;
      const applied = Boolean(applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim())
        || Boolean(applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim());
      const decisions = judged.get(context) ?? [];
      decisions.push(judgeMetadata(verdict, applied, 'pre_send'));
      judged.set(context, decisions);
    },

    // All three callers already hold the conversation row lock. Review, the
    // exact sent message, and the next summary share that same transaction.
    async publish(tx: Kysely<any>, input: Publication<Context>) {
      const start = performance.now();
      const row = {
        id: randomUUID(), conversation_id: input.id, role: 'assistant', text: input.text,
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      };
      const decisions = input.context ? judged.get(input.context) ?? [] : [];
      if (input.context) judged.delete(input.context);
      await savepoint.execute(tx);
      try {
        const messages = (await tx.selectFrom('chat_messages').select(['id', 'role', 'text'])
          .where('conversation_id', '=', input.id).orderBy('created_at', 'asc').orderBy('id', 'asc').execute())
          .flatMap(({ id, role, text }) => typeof text === 'string' && (role === 'user' || role === 'assistant')
            ? [{ id: String(id), role: role as 'user' | 'assistant', content: options.clean(text) }] : []);
        const previousSummary = messages.length >= SUMMARY_MIN_MESSAGES
          ? (await tx.selectFrom('chat_conversations').select('review_summary').where('id', '=', input.id).executeTakeFirst())?.review_summary
          : null;
        const ledger = buildConversationLedger(messages, previousSummary as ConversationSummary | undefined);
        const evidence = input.context ? options.evidenceFor(input.context) : [];
        if (options.judgeEnabled && decisions.length === 0) {
          const userTurns = messages.filter(message => message.role === 'user');
          const verdict = judge({ question: userTurns.at(-1)?.content ?? '', previous: userTurns.at(-2)?.content,
            reply: input.text, status: input.status, evidence });
          decisions.push(judgeMetadata(verdict, false, 'publication'));
        }
        const preserveContent = input.preserveContent || evidence.some(source => source.kind === 'page');
        const result = reviewReply(ledger, input.text, { status: input.status, evidence, preserveContent });
        let text = input.text;
        if (options.apply && result.action !== 'send') {
          if (!preserveContent) text = options.clean(result.reply);
          else if (result.reply.startsWith(text)) text += options.clean(result.reply.slice(text.length));
        }
        if (messages.length + 1 >= SUMMARY_MIN_MESSAGES) {
          const summary = buildConversationSummary(ledger, { id: row.id, role: 'assistant', content: options.clean(text) });
          await tx.updateTable('chat_conversations').set({ review_summary: JSON.stringify(summary) }).where('id', '=', input.id).execute();
        }
        await tx.insertInto('chat_messages').values({
          ...row, text,
          conversation_review: JSON.stringify({
            version: 1, runId: input.runId ?? null, judge: decisions, action: result.action, applied: text !== input.text,
            findings: result.findings.map(({ check, code }) => ({ check, code })), ms: performance.now() - start,
          }),
        }).execute();
      } catch {
        await rollback.execute(tx);
        console.error(JSON.stringify({ level: 'warn', event: 'conversation_review_unavailable' }));
        await tx.insertInto('chat_messages').values(row).execute();
      }
      await release.execute(tx);
    },
  };
}
