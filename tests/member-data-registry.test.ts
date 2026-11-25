import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CompiledQuery, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { memberDataRegistry } from '../apps/server/src/member-data-registry.ts';

// Better Auth 1.7.17 keys database rate-limit rows by IP and path in createRateLimitKey.
// https://registry.npmjs.org/@better-auth/core/-/core-1.7.17.tgz (retrieved 2026-11-25).
const nonAccountTables = {
  ai_provider_health: 'Shared provider health, keyed by provider.',
  auth_schema_migrations: 'Auth migration versions.',
  conversation_share_settings: 'Workspace-wide policy for members creating share links.',
  rateLimit: 'Better Auth keys this by IP address and endpoint, including unauthenticated clients.',
  schema_migrations: 'Application migration versions.',
  search_provider_admission: 'Shared provider admission state.',
  search_provider_queries: 'Shared provider query-hash throttling, which expires independently of an account.',
  skill_benchmarks: 'Shared administrator-configured benchmark suite definitions. Runs are scoped by account.',
  smart_monitor_hosts: 'Shared, expiring public host limits keyed by host hash.',
  smart_monitor_visual_budget: 'Shared daily visual read budget with one global key.',
} as const;

const createTableDeclaration = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|\w+)\s*\.\s*)?(?:"([^"]+)"|(\w+))\s*\(|\.createTable\(\s*['"]([^'"]+)['"]/giu;

async function declaredTables(): Promise<string[]> {
  const packageDirs = await readdir('packages', { withFileTypes: true });
  const roots = ['apps/server/src', ...packageDirs.filter(dir => dir.isDirectory()).map(dir => join('packages', dir.name, 'src'))];
  const files = await Promise.all(roots.map(async root => {
    try {
      return await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }));
  const sources = await Promise.all(files.flat().filter(file => file.isFile()
    && /\.(?:[cm]?ts|sql)$/u.test(file.name) && !/\.(?:test|spec)\./u.test(file.name))
    .map(file => readFile(join(file.parentPath, file.name), 'utf8')));
  const tables = new Set<string>();
  for (const source of sources) {
    const declarations = source.matchAll(createTableDeclaration);
    for (const [, quoted, unquoted, built] of declarations) tables.add(quoted ?? unquoted?.toLowerCase() ?? built!);
  }
  return [...tables].sort();
}

const ownColumn = (column: string) => /(?:^|_)(?:user|owner|account)(?:_|$)|^(?:user|owner|account)(?:id|key|email)$|^(?:created|consumed|updated)_by$/iu.test(
  column.replace(/[a-z0-9][A-Z]/gu, pair => pair[0] + '_' + pair[1]),
);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const registryByTable = new Map(memberDataRegistry.map((entry, position) => [entry.table, { ...entry, position }]));

describe('member data schema registry', () => {
  it('classifies every table declared in server and package migrations exactly once', async () => {
    const classification = [...memberDataRegistry.map(entry => entry.table), ...Object.keys(nonAccountTables)];
    expect(classification.sort()).toEqual(await declaredTables());
  });

  it('covers account columns and dependent tables, and checks projections and purge order against the migrated schema', async () => {
    const { createApplication } = await import('../apps/server/src/app.ts');
    const application = await createApplication({
      authSecret: 'member-registry-fixture-auth-0000000000',
      internalSecret: 'member-registry-fixture-internal-0000000000',
      setupToken: 'member-registry-fixture-setup-0000000000',
      webOrigin: 'http://127.0.0.1:3000',
      production: false,
      runWorker: false,
    });
    try {
      const { db } = application.database;
      const columns = (await sql<{ table_name: string; column_name: string }>`
        SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
      `.execute(db)).rows;
      expect([...new Set(columns.map(({ table_name }) => table_name))].sort()).toEqual(await declaredTables());
      expect(columns.filter(row => ownColumn(row.column_name) && !registryByTable.has(row.table_name))).toEqual([]);

      const references = (await sql<{ child: string; parent: string }>`
        SELECT child.relname AS child, parent.relname AS parent
        FROM pg_constraint AS fk
        JOIN pg_class AS child ON child.oid = fk.conrelid
        JOIN pg_namespace AS ns ON ns.oid = child.relnamespace
        JOIN pg_class AS parent ON parent.oid = fk.confrelid
        WHERE fk.contype = 'f' AND ns.nspname = 'public'
      `.execute(db)).rows;
      for (const { child, parent } of references) {
        const parentTable = registryByTable.get(parent);
        if (!parentTable || child === parent) continue;
        const childTable = registryByTable.get(child);
        expect(childTable, `${child} references account data in ${parent}`).toBeDefined();
        if (parentTable.deletion.action === 'delete' && childTable?.deletion.action === 'delete') {
          expect(childTable.position, `${child} needs to be processed before ${parent}`).toBeLessThan(parentTable.position);
        }
      }

      for (const entry of memberDataRegistry) {
        const projection = entry.export ? entry.export.map(column => `data.${identifier(column)}`).join(', ') : '1';
        const from = `${identifier(entry.table)} AS data`;
        const predicate = entry.accountPredicate;
        const parameter = ['member-registry-fixture-account'];
        await db.executeQuery(CompiledQuery.raw(`EXPLAIN SELECT ${projection} FROM ${from} WHERE ${predicate}`, parameter));
        if (entry.deletion.action === 'anonymize') {
          await db.executeQuery(CompiledQuery.raw(`EXPLAIN UPDATE ${from} SET ${entry.deletion.set} WHERE ${predicate}`, parameter));
        }
        if (entry.deletion.action === 'keep') expect(entry.deletion.reason.trim()).not.toBe('');
      }
    } finally {
      await application.app.close();
    }
  });
});
