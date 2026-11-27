/**
 * Run with `npx tsx scripts/perf/chat-data-hygiene.ts`.
 * For the baseline, copy this script into the same path in a checkout of 29448ae
 * with dependencies installed and run the same command. Each invocation uses
 * fresh, in-memory PGlite with the checkout's own migrations and deletion code.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';

const members = 40;
const conversationsPerMember = 10;
const runsPerConversation = 50;
const eventsPerRun = 10;
const messagesPerRun = 2;
const runs = members * conversationsPerMember * runsPerConversation;
const removeOwner = 'perf-member-1';
const removeConversation = 'perf-conversation-1';
const purgeMember = 'perf-member-2';

async function seed(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`
      INSERT INTO "user" (id, name, email)
      SELECT 'perf-member-' || n, 'Perf member ' || n, 'member-' || n || '@example.test'
      FROM generate_series(1, ${members}) AS n
    `.execute(tx);
    await sql`
      INSERT INTO workspace_members (user_id, role)
      SELECT id, 'member' FROM "user"
    `.execute(tx);
    await sql`
      INSERT INTO chat_conversations (id, owner_id, title)
      SELECT 'perf-conversation-' || ((n - 1) * ${conversationsPerMember} + c),
             'perf-member-' || n, 'Benchmark conversation'
      FROM generate_series(1, ${members}) AS n
      CROSS JOIN generate_series(1, ${conversationsPerMember}) AS c
    `.execute(tx);
    await sql`
      INSERT INTO chat_runs (id, conversation_id, owner_id, status, goal, lease_token, lease_expires_at)
      SELECT 'perf-run-' || n, c.id, c.owner_id, 'completed', 'Benchmark run', 'perf-lease', now()
      FROM generate_series(1, ${runs}) AS n
      JOIN chat_conversations AS c ON c.id = 'perf-conversation-' || (((n - 1) / ${runsPerConversation}) + 1)
    `.execute(tx);
    await sql`
      INSERT INTO chat_events (id, conversation_id, run_id, kind, message)
      SELECT r.id || '-event-' || n, r.conversation_id, r.id, 'step', 'Benchmark event'
      FROM chat_runs AS r CROSS JOIN generate_series(1, ${eventsPerRun}) AS n
    `.execute(tx);
    await sql`
      INSERT INTO chat_messages (id, conversation_id, run_id, role, text)
      SELECT r.id || '-message-' || n, r.conversation_id, r.id,
             CASE WHEN n = 1 THEN 'user' ELSE 'assistant' END, 'Benchmark message'
      FROM chat_runs AS r CROSS JOIN generate_series(1, ${messagesPerRun}) AS n
    `.execute(tx);
    await sql`
      INSERT INTO chat_model_receipts (id, run_id, step, model, status)
      SELECT id, id, 1, 'fixture-model', 'completed' FROM chat_runs
    `.execute(tx);
    await sql`
      INSERT INTO chat_effect_receipts (id, run_id, lease_token, method, target_hash, body_hash, status)
      SELECT id, id, lease_token, 'POST', md5(id), md5(goal), 'responded' FROM chat_runs
    `.execute(tx);
    await sql`
      INSERT INTO chat_notifications (task_id, user_id, conversation_id, run_id,
        kind, started_at, happened_at, available_at, delivery)
      SELECT id, owner_id, conversation_id, id, 'task_completed', now(), now(), now(), 'suppressed'
      FROM chat_runs
    `.execute(tx);
  });
  await sql`ANALYZE`.execute(db);
}

async function countRuns(db: Kysely<any>, key: 'conversation_id' | 'owner_id', id: string) {
  const { count } = await db.selectFrom('chat_runs').where(key, '=', id)
    .select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow();
  return Number(count);
}

const directory = await mkdtemp(join(tmpdir(), 'mohassan-chat-data-hygiene-'));
const cwd = process.cwd();
try {
  // Keep application files in the temporary fixture, including any default relative paths.
  process.chdir(directory);
  const { createApplication } = await import('../../apps/server/src/app.js');
  const { purgeMemberAccount } = await import('../../apps/server/src/member-deletion.js');
  const documentsDir = join(directory, 'documents');
  const { app, database, chat } = await createApplication({
    authSecret: 'chat-data-hygiene-benchmark-auth-fixture',
    internalSecret: 'chat-data-hygiene-benchmark-internal-fixture',
    setupToken: 'chat-data-hygiene-benchmark-setup-fixture',
    webOrigin: 'http://localhost:3000',
    production: false,
    runWorker: false,
    codingDataDir: join(directory, 'coding'),
    browserProfileDir: join(directory, 'browser'),
    documentsDir,
  });
  try {
    assert.equal(database.mode, 'embedded');
    const { db } = database;
    await seed(db);
    const { rows: [counts] } = await sql`
      SELECT (SELECT count(*) FROM chat_runs)::int AS runs,
             (SELECT count(*) FROM chat_events)::int AS events,
             (SELECT count(*) FROM chat_messages)::int AS messages
    `.execute(db);
    assert.deepEqual(counts, { runs, events: runs * eventsPerRun, messages: runs * messagesPerRun });

    assert.equal(await countRuns(db, 'conversation_id', removeConversation), runsPerConversation);
    let started = performance.now();
    assert.deepEqual(await chat.remove(removeOwner, removeConversation), { ok: true });
    const removeConversationMs = performance.now() - started;
    assert.equal(await countRuns(db, 'conversation_id', removeConversation), 0);

    const purgeRuns = conversationsPerMember * runsPerConversation;
    assert.equal(await countRuns(db, 'owner_id', purgeMember), purgeRuns);
    await sql`
      INSERT INTO member_deletion_requests (user_id, requested_at, purge_after)
      VALUES (${purgeMember}, now() - interval '8 days', now() - interval '1 day')
    `.execute(db);
    started = performance.now();
    assert.equal(await purgeMemberAccount(db, purgeMember, { documentsDir, purgeBrowserProfiles: async () => {} }), true);
    const purgeMemberMs = performance.now() - started;
    assert.equal(await countRuns(db, 'owner_id', purgeMember), 0);
    assert.equal(await countRuns(db, 'owner_id', removeOwner), purgeRuns - runsPerConversation);

    console.log(JSON.stringify({
      engine: 'PGlite (in-memory)', counts, removeRuns: runsPerConversation, purgeRuns,
      removeConversationMs: Number(removeConversationMs.toFixed(2)),
      purgeMemberMs: Number(purgeMemberMs.toFixed(2)),
    }, null, 2));
  } finally {
    await app.close();
  }
} finally {
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
}
