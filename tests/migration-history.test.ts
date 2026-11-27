import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { sql } from '@mohassan/database';
import { expect, it } from 'vitest';
import {
  createMigrationDatabase, dumpSchema, readLedgers, runStartup,
} from './fixtures/migration-safety.js';
import { startupOrder } from './fixtures/migration-startup-order.js';

// The recorded/legacy pairs come from the migration ledger and the 036 migrator, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/MIGRATION-LEDGER-2026-11-25.md
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/structured-memory-migration.ts
const platformAliases = new Map([
  ['035_structured_memory', '036_structured_memory'],
  ['035_notifications', '037_notifications'],
  ['036_reminders', '038_reminders'],
  ['038_conversation_shares', '039_conversation_shares'],
  ['037_member_data_rights', '040_member_data_rights'],
]);

const monitorAliases = new Map([
  ['044_monitor_alert_feedback', '047_monitor_alert_feedback'],
  ['046_smart_monitor_decisions', '048_smart_monitor_decisions'],
]);

const historySql = (filename: string) => readFile(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8');

// These rows use columns and constraints from migration-c2a0ff7.sql. Pre-upgrade SELECTs supply the expected values.
const baseRows = `
  INSERT INTO "user" (id, name, email) VALUES
    ('history-owner', 'Owner', 'owner@example.invalid'),
    ('history-member', 'Member', 'member@example.invalid');
  INSERT INTO workspace_owner (id, owner_id) VALUES (1, 'history-owner');
  INSERT INTO workspace_members (user_id, role) VALUES ('history-member', 'member');
  INSERT INTO session (id, "expiresAt", token, "userId")
    VALUES ('history-session', now() + interval '1 day', 'history-session-token', 'history-member');
  INSERT INTO tasks (id, owner_id, title, goal, capability_id, autonomy, status, input_hash, idempotency_key)
    VALUES ('history-task', 'history-member', 'Task', 'Goal', 'assistant', 'assisted', 'completed', 'history-hash', 'history-key');
  INSERT INTO task_events (id, task_id, sequence, type, message)
    VALUES ('history-event', 'history-task', 1, 'completed', 'Complete');
  INSERT INTO chat_conversations (id, owner_id, title)
    VALUES ('history-chat', 'history-member', 'Conversation');
  INSERT INTO chat_runs (id, conversation_id, owner_id, status, goal, lease_token, lease_expires_at)
    VALUES ('history-run', 'history-chat', 'history-member', 'completed', 'Goal', 'history-lease', now());
  INSERT INTO chat_messages (id, conversation_id, role, text) VALUES
    ('history-question', 'history-chat', 'user', 'Question'),
    ('history-answer', 'history-chat', 'assistant', 'Answer');
  INSERT INTO memory_items (id, root_id, owner_id, version, layer, title, content, status, confidence, confidence_kind, expires_at)
    VALUES ('history-memory', 'history-memory', 'history-member', 1, 'semantic', 'Fact', 'Value', 'active', 1, 'user_asserted',
      now() + interval '1 day');
`;

// These rows use the original standalone schema in migration-legacy-platform.sql.
const platformRows = `
  INSERT INTO memory_structured_versions (item_id, owner_id, conversation_id, subject, property, value)
    VALUES ('history-memory', 'history-member', 'history-chat', 'Fact', 'Property', 'Value');
  INSERT INTO memory_structured_operations (owner_id, run_id, conversation_id, intent_hash, outcome, item_id)
    VALUES ('history-member', 'history-run', 'history-chat', repeat('a', 64), 'saved', 'history-memory');
  INSERT INTO notification_preferences (user_id, hide_title) VALUES ('history-member', true);
  INSERT INTO chat_notifications (task_id, user_id, conversation_id, kind, started_at, happened_at, available_at, delivery)
    VALUES ('history-task', 'history-member', 'history-chat', 'task_completed', now(), now(), now(), 'pending');
  INSERT INTO reminders (id, user_id, conversation_id, text, due_at, time_zone, delivery_key)
    VALUES ('00000000-0000-4000-8000-000000000001', 'history-member', 'history-chat', 'Reminder', now() + interval '1 day', 'Etc/UTC',
      '00000000-0000-4000-8000-000000000002');
  INSERT INTO conversation_shares (id, sharer_id, conversation_id, token_hash, snapshot, shared_at)
    VALUES ('history-share', 'history-member', 'history-chat', repeat('b', 64), '{}', now());
  INSERT INTO member_deletion_requests (user_id, requested_at, purge_after)
    VALUES ('history-member', now(), now() + interval '1 day');
  INSERT INTO member_data_exports (user_id, requested_at) VALUES ('history-member', now());
  INSERT INTO workspace_invites (id, token_hash, email, name, created_by, expires_at)
    VALUES ('history-invite', 'history-invite-hash', 'invite@example.invalid', 'Invite', 'history-owner', now() + interval '1 day');
`;

// These rows use the standalone writer's `alert:<notice id>` key, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/6e68bdac9e23e34636d80f8612f8c9295752c580/apps/server/src/monitors/decision/records.ts
const monitorRows = `
  INSERT INTO smart_monitors (id, user_id, conversation_id, spec, spec_key, status, interval_ms, expires_at, created_at)
    VALUES ('00000000-0000-4000-8000-000000000003', 'history-member', 'history-chat', '{}', 'history-spec', 'paused', 60000,
      now() + interval '1 day', now());
  INSERT INTO chat_notifications (
    task_id, user_id, conversation_id, kind, started_at, happened_at, available_at, delivery, monitor_id, background_outcome)
    VALUES ('history-alert', 'history-member', 'history-chat', 'task_completed', now(), now(), now(), 'pending',
      '00000000-0000-4000-8000-000000000003', 'completed');
  INSERT INTO monitor_alert_feedback (user_id, alert_id, rating)
    VALUES ('history-member', 'history-alert', 'helpful');
  INSERT INTO smart_monitor_v2_preferences (user_id, proactive_offers, decision_recording)
    VALUES ('history-member', false, true);
  INSERT INTO smart_monitor_decisions (user_id, monitor_id, event_key, decision, features, happened_at) VALUES
    ('history-member', '00000000-0000-4000-8000-000000000003', 'proposal', 'proposal', '{}', now()),
    ('history-member', '00000000-0000-4000-8000-000000000003', 'alert:history-alert', 'alert_helpful', NULL, now());
`;

async function readHistoricalColumns(db: Kysely<any>) {
  const { rows } = await sql<{ table: string; columns: string[] }>`
    SELECT table_name AS "table", array_agg(column_name::text ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    JOIN information_schema.tables USING (table_catalog, table_schema, table_name)
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('schema_migrations', 'auth_schema_migrations')
    GROUP BY table_name ORDER BY table_name
  `.execute(db);
  return rows;
}

async function snapshotRows(db: Kysely<any>, tables: Awaited<ReturnType<typeof readHistoricalColumns>>) {
  const snapshots = [];
  for (const { table, columns } of tables) {
    // Read every original column. New columns can be added without changing the historical values.
    const { rows } = await sql<{ row: unknown }>`
      SELECT to_jsonb(original) AS row
      FROM (SELECT ${sql.join(columns.map(column => sql.id(column)))} FROM ${sql.id('public', table)}) AS original
      ORDER BY to_jsonb(original)
    `.execute(db);
    snapshots.push({ table, rows: rows.map(({ row }) => row) });
  }
  return snapshots;
}

// 003 backfills the usage of recent member runs. Retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/member-run-quota.ts
async function expectedQuotaRow(db: Kysely<any>) {
  const runId = 'history-run';
  const { rows } = await sql<{ row: unknown }>`
    SELECT to_jsonb(quota) AS row FROM (
      SELECT owner_id, ${`member-run:${runId}`}::text AS request_key, 'member-run' AS scope,
        ${createHash('sha256').update(runId).digest('hex')}::text AS body_hash, 'done' AS status,
        NULL::jsonb AS response, created_at
      FROM chat_runs WHERE id = ${runId}
    ) AS quota
  `.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0].row;
}

const histories = [
  { path: 'upgrades the c2a0ff7 database', aliases: new Map<string, string>() },
  { path: 'adopts the standalone platform and structured-memory migrations',
    fixture: 'migration-legacy-platform.sql', seed: platformRows, aliases: platformAliases },
  { path: 'adopts the standalone monitor migrations',
    fixture: 'migration-legacy-monitors.sql', seed: monitorRows, aliases: monitorAliases },
];

it.each(histories)('$path and preserves old data across two starts', async ({ fixture, seed, aliases }) => {
  const { client, db, close, appConfig, inserts } = await createMigrationDatabase();
  try {
    await client.exec(await historySql('migration-c2a0ff7.sql'));
    await client.exec(baseRows);
    if (fixture && seed) {
      await client.exec(await historySql(fixture));
      await client.exec(seed);
    }

    const historicalTables = await readHistoricalColumns(db);
    const beforeRows = await snapshotRows(db, historicalTables);
    const quotaRow = await expectedQuotaRow(db);
    const expectedRows = beforeRows.map(({ table, rows }) => ({
      table, rows: table === 'chat_request_keys' ? [...rows, quotaRow] : rows,
    }));
    const beforeLedgers = await readLedgers(db);
    const oldIds = beforeLedgers.schema_migrations.map(row => row.version);
    for (const [legacy, recorded] of aliases) {
      expect(oldIds).toContain(legacy);
      expect(oldIds).not.toContain(recorded);
    }

    inserts.length = 0;
    await runStartup(appConfig);

    const afterLedgers = await readLedgers(db);
    const recognisedRows = beforeLedgers.schema_migrations.map(row => ({ ...row, version: aliases.get(row.version) ?? row.version }));
    expect(afterLedgers.schema_migrations).toEqual(expect.arrayContaining(recognisedRows));
    expect(afterLedgers.auth_schema_migrations).toEqual(expect.arrayContaining(beforeLedgers.auth_schema_migrations));
    const recognisedIds = new Set([
      ...recognisedRows.map(row => row.version),
      ...beforeLedgers.auth_schema_migrations.map(row => `auth:${row.version}`),
    ]);
    const finalIds = [
      ...afterLedgers.schema_migrations.map(row => row.version),
      ...afterLedgers.auth_schema_migrations.map(row => `auth:${row.version}`),
    ];
    expect(finalIds.sort()).toEqual([...startupOrder].sort());
    // Studio Live still attempts its ON CONFLICT DO NOTHING insert on a restart.
    const upgradeInserts = inserts.filter(({ version }) => version !== '010_studio_live')
      .map(({ ledger, version }) => ledger === 'auth_schema_migrations' ? `auth:${version}` : version);
    expect(upgradeInserts).toEqual(startupOrder.filter(version => !recognisedIds.has(version)));
    expect(await snapshotRows(db, historicalTables)).toEqual(expectedRows);

    const afterSchema = await dumpSchema(client);
    await runStartup(appConfig);
    expect(await dumpSchema(client)).toEqual(afterSchema);
    expect(await readLedgers(db)).toEqual(afterLedgers);
    expect(await snapshotRows(db, historicalTables)).toEqual(expectedRows);
  } finally {
    await close();
  }
}, 240_000);
