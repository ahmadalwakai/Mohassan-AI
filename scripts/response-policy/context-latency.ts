/** Measure the real history assembly path using synthetic rows in an offline PGlite database. */
import { createDatabase } from '@mohassan/database';
import { redactCredentialText } from '@mohassan/cognitive';
import { sql } from 'kysely';
import { ensureChatConversationsTable } from '../../packages/database/src/chat-schema.js';
import {
  HISTORY_READ_BUDGET_MS, HISTORY_SCAN_LIMIT, readResponsePolicyHistory, responsePolicyEarlierContext,
} from '../../apps/server/src/assistant/response-policy-context.js';

const recentLimit = 7; // Command chat's recent history plus the current user message.
const warmups = 5;
const pairs = 40;
const owner = 'latency-owner';
const request = 'Recap this entire conversation, including decisions and unresolved questions.';
const envOff = { MOHASSAN_CONTEXT_POLICY_ENABLED: '0' };
const envOn = { MOHASSAN_CONTEXT_POLICY_ENABLED: '1' };
process.env.MOHASSAN_CONTEXT_POLICY_ENABLED = '1';

function latency(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (percentile: number) => Number(ordered[Math.ceil(ordered.length * percentile) - 1]!.toFixed(3));
  return { medianMs: at(0.5), p95Ms: at(0.95) };
}

const database = await createDatabase();
try {
  const { db } = database;
  await ensureChatConversationsTable(db);
  await sql`CREATE TABLE chat_messages (
    id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant')), text text NOT NULL, created_at timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX chat_messages_conversation_idx ON chat_messages(conversation_id, created_at, id)`.execute(db);
  const results = [];
  for (const olderMessages of [50, 500, HISTORY_SCAN_LIMIT, HISTORY_SCAN_LIMIT + 1]) {
    const conversationId = `latency-${olderMessages}`;
    await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: owner, title: 'Latency fixture' }).execute();
    await sql`INSERT INTO chat_messages (id, conversation_id, role, text, created_at)
      SELECT ${conversationId} || '-' || n, ${conversationId}, CASE WHEN n % 2 = 0 THEN 'assistant' ELSE 'user' END,
        'Decision and unresolved question for milestone ' || n || '. ' ||
          repeat('Workshop notes cover an estimate, its owner and the delivery date. ', 8),
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + n * INTERVAL '1 second'
      FROM generate_series(1, ${olderMessages + recentLimit}) AS n`.execute(db);

    async function run(enabled: boolean) {
      const state = {};
      const started = performance.now();
      const recent = await readResponsePolicyHistory({
        db, conversationId, ownerId: owner, state, recentLimit,
        policy: { text: request, previousTurns: Math.floor((olderMessages + recentLimit) / 2), language: 'en' },
        scrub: redactCredentialText, env: enabled ? envOn : envOff,
      });
      const duration = performance.now() - started;
      if (recent.length !== recentLimit) throw new Error('Expected the seven-message recent window');
      const context = responsePolicyEarlierContext(state);
      if (enabled && context?.trigger !== 'recap') throw new Error('The fixture did not exercise full history');
      if (!enabled && context) throw new Error('Flag-off request read older context');
      const coverage = context ? (JSON.parse(context.data) as { coverage: string }).coverage : null;
      return { duration, coverage };
    }

    const baseline: number[] = [];
    const candidate: number[] = [];
    const extra: number[] = [];
    let available = 0;
    for (let index = -warmups; index < pairs; index++) {
      // Alternate the order without running on and off paths concurrently.
      const firstEnabled = index % 2 === 0;
      const first = await run(firstEnabled);
      const second = await run(!firstEnabled);
      const [on, off] = firstEnabled ? [first, second] : [second, first];
      if (index < 0) continue;
      baseline.push(off.duration);
      candidate.push(on.duration);
      extra.push(on.duration - off.duration);
      if (on.coverage !== 'unavailable') available++;
    }
    if (olderMessages > HISTORY_SCAN_LIMIT && available) throw new Error('Over-limit scan returned older context');
    results.push({ olderMessages, available, unavailable: pairs - available,
      flagOff: latency(baseline), flagOn: latency(candidate), added: latency(extra) });
  }
  console.log(JSON.stringify({
    database: database.mode, recentLimit, warmups, measuredPairsPerSize: pairs, historyReadBudgetMs: HISTORY_READ_BUDGET_MS,
    results,
  }, null, 2));
} finally {
  await database.close();
}
