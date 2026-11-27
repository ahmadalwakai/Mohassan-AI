import { RawNode, sql, type KyselyPlugin } from 'kysely';
import { migrate } from '@mohassan/database';
import { googleAdsMigration } from '@mohassan/google-ads';
import { windowsMigration } from '@mohassan/windows';
import { expect, it } from 'vitest';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateBackgroundResults } from '../apps/server/src/background-results-migration.js';
import { createChromeExtensionControl } from '../apps/server/src/chrome-extension.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { migrateMonitors } from '../apps/server/src/monitors/migration.js';
import { migrateRemindersInTransaction } from '../apps/server/src/reminders/migration.js';
import { createMigrationDatabase, dumpSchema, readLedgers, runStartup } from './fixtures/migration-safety.js';
import { startupOrder } from './fixtures/migration-startup-order.js';

function failAt(statementStart: string): KyselyPlugin {
  return {
    transformQuery({ node }) {
      if (RawNode.is(node) && node.sqlFragments[0]?.startsWith(statementStart)) {
        return sql`SELECT * FROM migration_safety_missing_relation`.toOperationNode();
      }
      return node;
    },
    async transformResult({ result }) { return result; },
  };
}

const injectedFailure = { code: '42P01', message: expect.stringContaining('migration_safety_missing_relation') };

it('applies the production startup migrations to an empty database and restarts unchanged', async () => {
  const { appConfig, client, db, close, inserts } = await createMigrationDatabase();
  try {
    await runStartup(db, appConfig);
    const schema = await dumpSchema(client);
    const ledgers = await readLedgers(db);
    expect(inserts.map(({ ledger, version }) => ledger === 'auth_schema_migrations' ? `auth:${version}` : version))
      .toEqual(startupOrder);
    expect(ledgers.schema_migrations.map(row => row.version))
      .toEqual(startupOrder.filter(id => !id.startsWith('auth:')).sort());
    expect(ledgers.auth_schema_migrations.map(row => row.version))
      .toEqual(startupOrder.filter(id => id.startsWith('auth:')).map(id => id.slice('auth:'.length)).sort());

    inserts.length = 0;
    await runStartup(db, appConfig);
    expect(await dumpSchema(client)).toEqual(schema);
    expect(await readLedgers(db)).toEqual(ledgers);
    expect(inserts.filter(entry => entry.version !== '010_studio_live')).toEqual([]);
  } finally {
    await close();
  }
});

it('rolls back the monitor transaction after 048 has created its table and succeeds on retry', async () => {
  const { client, db, close, inserts } = await createMigrationDatabase();
  try {
    await migrateAuth(db);
    await migrate(db);
    await commandChatMigration(db, migrateRemindersInTransaction);
    await migrateBackgroundResults(db);
    const schema = await dumpSchema(client);
    const ledgers = await readLedgers(db);
    inserts.length = 0;

    const failure = failAt('CREATE INDEX smart_monitor_decisions_user_idx ');
    await expect(migrateMonitors(db.withPlugin(failure))).rejects.toMatchObject(injectedFailure);
    expect(inserts.map(entry => entry.version)).toContain('047_monitor_alert_feedback');
    expect(await dumpSchema(client)).toEqual(schema);
    expect(await readLedgers(db)).toEqual(ledgers);

    inserts.length = 0;
    await migrateMonitors(db);
    const monitorVersions = [
      '043_smart_monitors', '044_smart_monitors_v2', '045_smart_monitor_conversation_controls',
      '046_smart_monitor_visual_budget', '047_monitor_alert_feedback', '048_smart_monitor_decisions',
    ];
    expect(inserts.map(entry => entry.version)).toEqual(monitorVersions);
    const migrated = await readLedgers(db);
    expect(migrated.schema_migrations.slice(-monitorVersions.length).map(row => row.version)).toEqual(monitorVersions);
    expect(await db.selectFrom('smart_monitor_decisions').select('event_key').execute()).toEqual([]);
  } finally {
    await close();
  }
});

const startupHelpers = [
  { name: 'Windows', setup: windowsMigration, statement: 'CREATE INDEX IF NOT EXISTS windows_devices_owner_idx ',
    table: 'windows_pairings' },
  { name: 'Google Ads', setup: googleAdsMigration, statement: 'CREATE INDEX IF NOT EXISTS google_ads_drafts_owner_idx ',
    table: 'google_ads_connections' },
  { name: 'Chrome extension', setup: createChromeExtensionControl, statement: 'ALTER TABLE chrome_extension_jobs ',
    table: 'chrome_extension_bindings' },
];

it.each(startupHelpers)('rolls back $name schema setup on failure and succeeds on retry', async ({ setup, statement, table }) => {
  const { client, db, close } = await createMigrationDatabase();
  try {
    await migrateAuth(db);
    const before = await dumpSchema(client);

    await expect(setup(db.withPlugin(failAt(statement)))).rejects.toMatchObject(injectedFailure);
    expect(await dumpSchema(client)).toEqual(before);

    await setup(db);
    expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
  } finally {
    await close();
  }
});
