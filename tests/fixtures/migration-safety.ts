import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { vi } from 'vitest';
import { createApplication, type AppConfig } from '../../apps/server/src/app.js';

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@mohassan/database', async importOriginal => ({
  ...await importOriginal<typeof import('@mohassan/database')>(),
  createDatabase: open,
}));

export const ledgerNames = ['schema_migrations', 'auth_schema_migrations'] as const;
type LedgerName = typeof ledgerNames[number];
type LedgerRow = { version: string; applied_at: string };
type MigrationAppConfig = AppConfig & { dataDir: string };

export async function createMigrationDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-migrations-'));
  const inserts: { ledger: LedgerName; version: string }[] = [];
  const client = new PGlite();
  const db = new Kysely<any>({
    dialect: new PGliteDialect({ pglite: client }),
    log(event) {
      if (event.level !== 'query') return;
      const { sql, parameters } = event.query;
      const ledger = ledgerNames.find(name => sql.startsWith(`insert into "${name}" ("version")`));
      // Studio Live tries an ON CONFLICT DO NOTHING insert on every boot. The insert
      // trace is used with ledger row comparisons to distinguish retries from writes.
      if (ledger && typeof parameters[0] === 'string') inserts.push({ ledger, version: parameters[0] });
    },
  });
  const close = async () => {
    try { await db.destroy(); } finally { await rm(directory, { recursive: true, force: true }); }
  };
  try { await client.waitReady; } catch (error) {
    await close();
    throw error;
  }
  const appConfig: MigrationAppConfig = {
    authSecret: 'fixture-auth-for-migration-tests-only',
    internalSecret: 'fixture-internal-for-migration-tests-only',
    setupToken: 'fixture-migration-setup-token',
    webOrigin: 'http://localhost:3000',
    production: false,
    runWorker: false,
    skillEngineEnabled: true,
    v5Chat: 'owner',
    aiFetch: async () => { throw new Error('Migration startup cannot call an AI endpoint'); },
    dataDir: join(directory, 'data'),
    codingDataDir: join(directory, 'coding'),
    documentsDir: join(directory, 'documents'),
    browserProfileDir: join(directory, 'browser'),
  };
  return { client, db, close, appConfig, directory, inserts };
}

export async function runStartup(db: Kysely<any>, appConfig: MigrationAppConfig) {
  const previousCouncil = process.env.MOHASSAN_MODEL_COUNCIL;
  const previousOcr = process.env.MOHASSAN_OCR_MODEL_DIR;
  process.env.MOHASSAN_MODEL_COUNCIL = 'owner';
  process.env.MOHASSAN_OCR_MODEL_DIR = join(appConfig.dataDir, 'no-model-artifacts');
  open.mockResolvedValue({ db, mode: 'embedded', close: async () => {} });
  try {
    const { app } = await createApplication(appConfig);
    await app.close();
  } finally {
    open.mockReset();
    if (previousCouncil === undefined) delete process.env.MOHASSAN_MODEL_COUNCIL;
    else process.env.MOHASSAN_MODEL_COUNCIL = previousCouncil;
    if (previousOcr === undefined) delete process.env.MOHASSAN_OCR_MODEL_DIR;
    else process.env.MOHASSAN_OCR_MODEL_DIR = previousOcr;
  }
}

export async function readLedgers(db: Kysely<any>): Promise<Record<LedgerName, LedgerRow[]>> {
  const read = (ledger: LedgerName) => db.selectFrom(ledger)
    .select(['version', sql<string>`applied_at::text`.as('applied_at')]).orderBy('version').execute();
  return { schema_migrations: await read('schema_migrations'), auth_schema_migrations: await read('auth_schema_migrations') };
}

// Dump schema definitions through PostgreSQL's catalog. PGlite has no pg_dump
// executable, and catalog definitions avoid comparing file bytes, OIDs or data.
export async function dumpSchema(client: PGlite): Promise<string> {
  const { rows } = await client.query(`
    WITH relations AS (
      SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    )
    SELECT r.relname AS relation, r.relkind AS kind, r.relpersistence AS persistence,
      r.relrowsecurity AS row_security, r.relforcerowsecurity AS force_row_security,
      CASE WHEN r.relkind IN ('v', 'm') THEN pg_get_viewdef(r.oid) END AS view_definition,
      (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod),
        a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated, coll.collname)
        ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
        WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_object_agg(c.conname, pg_get_constraintdef(c.oid))
        FROM pg_constraint c WHERE c.conrelid = r.oid) AS constraints,
      (SELECT jsonb_object_agg(i.relname, pg_get_indexdef(i.oid))
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = r.oid) AS indexes,
      (SELECT jsonb_object_agg(t.tgname, pg_get_triggerdef(t.oid))
        FROM pg_trigger t WHERE t.tgrelid = r.oid AND NOT t.tgisinternal) AS triggers,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname)
        FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.relname) AS policies
    FROM relations r ORDER BY r.relname
  `);
  const { rows: routines } = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
  `);
  return JSON.stringify({ relations: rows, routines }, null, 2);
}
