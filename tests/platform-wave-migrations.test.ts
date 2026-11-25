import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsertQueryNode, PrimitiveValueListNode, ValuesNode, type Kysely } from 'kysely';
import { sql, type DatabaseHandle, type DatabaseOptions } from '@mohassan/database';
import { expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

const trace = vi.hoisted(() => ({
  inserts: [] as string[],
  handles: new Set<DatabaseHandle>(),
}));

vi.mock('@mohassan/database', async importOriginal => {
  const original = await importOriginal<typeof import('@mohassan/database')>();
  return {
    ...original,
    async createDatabase(options?: DatabaseOptions) {
      const handle = await original.createDatabase(options);
      trace.handles.add(handle);
      const db = handle.db.withPlugin({
        transformQuery({ node }) {
          if (InsertQueryNode.is(node) && node.into?.table.identifier.name === 'schema_migrations'
            && node.values && ValuesNode.is(node.values)) {
            for (const row of node.values.values) {
              if (PrimitiveValueListNode.is(row) && typeof row.values[0] === 'string') {
                trace.inserts.push(row.values[0]);
              }
            }
          }
          return node;
        },
        async transformResult({ result }) { return result; },
      });
      return {
        ...handle,
        db,
        async close() {
          await handle.close();
          trace.handles.delete(handle);
        },
      };
    },
  };
});

const platformIds = [
  ['037_notifications', '035_notifications'],
  ['038_reminders', '036_reminders'],
  ['039_conversation_shares', '038_conversation_shares'],
  ['040_member_data_rights', '037_member_data_rights'],
] as const;
const currentIds = [...platformIds.map(([current]) => current), '041_long_run_checkpoints', '042_background_results', '043_smart_monitors'];
const agentIds = ['035_chat_conversation_review', '036_structured_memory'];

// Ledger registrations in the base startup migrators, retrieved 2026-11-25.
// https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff765071657cf200b5ee7d12fabaad738c0b
const baseIds = [
  '001_runtime', '002_approval_attempt', '003_cognitive_planning', '004_coding_engine',
  '005_visual_studio', '006_react_studio', '007_memory_learning_v1', '007_studio_ai_input',
  '008_studio_ai_proposals', '009_studio_visual_reviews', '010_studio_live', '011_browser_task_input',
  '012_browser_task_receipts', '013_command_chat', '014_assistant', '015_skill_registry',
  '016_skill_security', '017_skill_execution', '018_skill_gaps', '019_skill_graph', '020_skill_eval',
  '021_skill_forge', '022_chat_execution_safety', '023_runtime_skills', '024_skill_recovery',
  '025_runtime_recovery', '026_experiences', '027_chat_browser_recovery', '028_chat_recovery_review',
  '029_chat_campaign_events', '029_chat_images', '030_sites', '032_skill_remote',
  '033_chat_request_keys', '033_skill_retention', '034_skill_catalogue', 'memory_exact_writes_v1',
];

it('records platform migrations in startup order, restarts unchanged, and adopts legacy IDs', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'mohassan-platform-migration-'));
  const databaseName = `platform_test_${randomUUID().replaceAll('-', '')}`;
  const localPostgres = process.env.PLATFORM_MIGRATION_TEST_DATABASE_URL?.trim();
  let maintenance: DatabaseHandle | undefined;
  let created = false;
  let databaseUrl: string | undefined;

  async function boot(beforeClose?: (db: Kysely<any>) => Promise<void>) {
    trace.inserts.length = 0;
    const { app, database } = await createApplication({
      databaseUrl, dataDir: join(fixtureDir, 'database'),
      authSecret: 'test-platform-migration-auth-fixture',
      internalSecret: 'test-platform-migration-internal-fixture',
      setupToken: 'test-platform-migration-fixture',
      webOrigin: 'http://localhost:3000',
      production: false, runWorker: false, skillEngineEnabled: true,
      codingDataDir: join(fixtureDir, 'coding'),
      documentsDir: join(fixtureDir, 'documents'),
      browserProfileDir: join(fixtureDir, 'browser'),
    });
    try {
      const appLedger = await database.db.selectFrom('schema_migrations')
        .select(['version', 'applied_at']).orderBy('version').execute();
      const authLedger = await database.db.selectFrom('auth_schema_migrations')
        .select(['version', 'applied_at']).orderBy('version').execute();
      const platformInserts = trace.inserts.filter(id => currentIds.includes(id));
      await beforeClose?.(database.db);
      return { appLedger, authLedger, platformInserts };
    } finally {
      await app.close();
    }
  }

  try {
    if (localPostgres) {
      const target = new URL(localPostgres);
      if (target.hostname !== '127.0.0.1' || target.pathname !== '/postgres') {
        throw new Error('Use the dedicated loopback PostgreSQL instance and its postgres maintenance database.');
      }
      const { createDatabase } = await vi.importActual<typeof import('@mohassan/database')>('@mohassan/database');
      maintenance = await createDatabase({ connectionString: target.href });
      await sql`CREATE DATABASE ${sql.id(databaseName)} TEMPLATE template0`.execute(maintenance.db);
      created = true;
      target.pathname = `/${databaseName}`;
      databaseUrl = target.href;
    }

    const first = await boot();
    expect(first.platformInserts).toEqual(currentIds);
    expect(first.appLedger.map(row => row.version)).toEqual([...baseIds, ...agentIds, ...currentIds].sort());
    expect(first.authLedger.map(row => row.version)).toEqual(['001_auth', '002_members', '003_member_run_quota']);

    const second = await boot(async db => {
      await db.transaction().execute(async tx => {
        for (const [version, legacy] of platformIds) {
          await tx.updateTable('schema_migrations').set({ version: legacy }).where('version', '=', version).execute();
        }
        // Recreate the standalone push schema before checking the legacy upgrade.
        await sql`ALTER TABLE chat_notifications DROP CONSTRAINT chat_notifications_kind_check,
          ADD CONSTRAINT chat_notifications_kind_check
          CHECK (kind IN ('task_completed', 'needs_you', 'task_failed'))`.execute(tx);
      });
    });
    expect(second).toEqual({ ...first, platformInserts: [] });

    const adopted = await boot(async db => {
      const { rows } = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'chat_notifications'::regclass AND conname = 'chat_notifications_kind_check'
      `.execute(db);
      expect(rows[0]?.definition).toContain('reminder_due');
    });
    expect(adopted).toEqual(second);
  } finally {
    try {
      await Promise.all([...trace.handles].map(handle => handle.close()));
      if (maintenance && created) await sql`DROP DATABASE ${sql.id(databaseName)}`.execute(maintenance.db);
    } finally {
      await maintenance?.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }
}, 60_000);
