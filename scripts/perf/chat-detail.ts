/**
 * Usage: DATABASE_URL=<empty disposable PostgreSQL database> npx tsx scripts/perf/chat-detail.ts
 * Run this same script from each revision against a fresh database to compare controller latency.
 */
import { tmpdir } from 'node:os';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { sql } from 'kysely';
import { migrateAuth } from '../../apps/server/src/auth.js';
import { migrateMembers, roleOf } from '../../apps/server/src/members.js';
import { migrateRemindersInTransaction } from '../../apps/server/src/reminders/migration.js';
import { stats } from './fixture.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL to an empty disposable PostgreSQL database.');

// Keep the seed turn rules-only, including the shadow observers.
process.env.VITEST = '1';
process.env.MOHASSAN_SCRATCH_CLASSIFIERS = '0';
process.env.MOHASSAN_MODEL_RELATIONS = 'off';
process.env.MOHASSAN_MONITORS_ENABLED = 'owner';
const { commandChatMigration, createCommandChatControl } = await import('../../apps/server/src/command-chat.js');
const { monitorChat } = await import('../../apps/server/src/monitors/chat.js');

const conversations = 5_000;
const warmup = 100;
const samples = 1_000;
const owner = 'benchmark-owner';
const other = 'benchmark-member';
const { db, close } = await createDatabase({ connectionString });
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
try {
  const { rows: [schema] } = await sql<{ populated: boolean; version: string }>`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema()) AS populated,
           current_setting('server_version') AS version
  `.execute(db);
  if (schema?.populated) throw new Error('Chat detail benchmark requires an empty PostgreSQL database.');

  await migrate(db);
  await migrateAuth(db);
  await migrateMembers(db);
  await commandChatMigration(db, migrateRemindersInTransaction);
  await db.insertInto('user').values([owner, other].map(id => ({ id, name: id, email: `${id}@example.test` }))).execute();
  await db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();
  await db.insertInto('workspace_members').values({ user_id: other, role: 'member' }).execute();

  control = await createCommandChatControl(db, {
    models: { fast: [], deep: [], vision: '' },
    browser: new AgentBrowser({ profileDir: tmpdir(), idlePageMs: null, allowedOrigins: [] }),
    fullAccess: async id => await roleOf(db, id) === 'owner',
  });
  await monitorChat(db)?.initialize();
  const { id } = await control.create(owner, { goal: 'Calculate 2 + 2' });
  await control.settled(id);
  const example = await control.detail(owner, id);
  if (example.status !== 'idle' || example.run?.phase !== 'completed') throw new Error('The model-free seed turn failed.');

  // Copy the real completed run shape. Two of every twenty generated conversations are running
  // across the two accounts, with unexpired leases so read-time recovery never writes during measurement.
  await sql`
    WITH seed AS MATERIALIZED (
      SELECT gen_random_uuid()::text AS id, gen_random_uuid()::text AS run_id,
             CASE WHEN n % 2 = 0 THEN ${owner} ELSE ${other} END AS owner_id, n % 20 IN (0, 1) AS active
      FROM generate_series(1, ${conversations - 1}) AS n
    ), copied AS (
      INSERT INTO chat_conversations (id, owner_id, title, status, active_run_id)
      SELECT id, owner_id, ${example.title}, CASE WHEN active THEN 'running' ELSE 'idle' END,
             CASE WHEN active THEN run_id END
      FROM seed RETURNING id
    )
    INSERT INTO chat_runs (id, conversation_id, owner_id, status, goal, steps, lease_token, lease_expires_at, worker_id, state)
    SELECT seed.run_id, seed.id, seed.owner_id, CASE WHEN seed.active THEN 'running' ELSE template.status END,
           template.goal, template.steps, gen_random_uuid()::text, CURRENT_TIMESTAMP + interval '1 day',
           CASE WHEN seed.active THEN 'benchmark-worker' END,
           jsonb_set(template.state, '{agentRun,runId}', to_jsonb(seed.run_id), false)
    FROM seed JOIN copied USING (id) CROSS JOIN chat_runs AS template WHERE template.conversation_id = ${id}
  `.execute(db);
  await sql`
    INSERT INTO chat_messages (id, conversation_id, role, text, created_at)
    SELECT gen_random_uuid()::text, c.id, m.role, m.text, m.created_at
    FROM chat_conversations AS c CROSS JOIN chat_messages AS m
    WHERE m.conversation_id = ${id} AND c.id <> ${id}
  `.execute(db);
  await sql`
    INSERT INTO chat_events (id, conversation_id, run_id, kind, message, data, created_at)
    SELECT gen_random_uuid()::text, r.conversation_id, r.id, e.kind, e.message, e.data, e.created_at
    FROM chat_runs AS r CROSS JOIN chat_events AS e
    WHERE e.conversation_id = ${id} AND e.kind = 'step' AND r.conversation_id <> ${id}
  `.execute(db);
  await sql`ANALYZE`.execute(db);

  const targets = await db.selectFrom('chat_conversations').select('id').where('owner_id', '=', owner)
    .where('status', '=', 'idle').where('id', '!=', id).orderBy('id').limit(warmup + samples).execute();
  if (targets.length !== warmup + samples) throw new Error('The benchmark did not seed enough idle conversations.');
  const activeCount = async () => Number((await db.selectFrom('chat_conversations').select(eb => eb.fn.countAll().as('n'))
    .where('status', '=', 'running').executeTakeFirstOrThrow()).n);
  const running = await activeCount();
  const timings = [];
  for (const target of targets) {
    const started = performance.now();
    const detail = await control.detail(owner, target.id);
    timings.push(performance.now() - started);
    if (detail.status !== 'idle' || detail.run?.phase !== 'completed') throw new Error('Unexpected detail response.');
  }
  if (running === 0 || await activeCount() !== running) throw new Error('The active conversation count changed during measurement.');
  console.log(JSON.stringify({ postgres: schema?.version, node: process.version, conversations, running, warmup, detailMs: stats(timings.slice(warmup)) }, null, 2));
} finally {
  try { await control?.shutdown(); } finally { await close(); }
}
