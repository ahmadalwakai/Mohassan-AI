import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The installed, dependency-free Node module has no TypeScript declarations.
import { compareMetadata, isDrillDatabaseName } from '../scripts/cloud-linux/backup-metadata.mjs';

const helper = fileURLToPath(new URL('../scripts/cloud-linux/backup-metadata.mjs', import.meta.url));
const expected = {
  tables: { 'public.schema_migrations': '2', 'public.auth_schema_migrations': '1', 'public.workspace_members': '0' },
  migrations: {
    'public.schema_migrations': ['fixture_001', 'fixture_002'],
    'public.auth_schema_migrations': ['fixture_auth'],
  },
};

describe('backup manifest comparison', () => {
  it('accepts equivalent versions and exact counts independently of ordering', () => {
    const restored = {
      tables: Object.fromEntries(Object.entries(expected.tables).reverse()),
      migrations: { ...expected.migrations, 'public.schema_migrations': [...expected.migrations['public.schema_migrations']].reverse() },
    };
    expect(compareMetadata(expected, restored)).toEqual({
      verdict: 'passed',
      tables: { expected: 3, restored: 3, missing: 0, unexpected: 0, changed: 0 },
      migrations: { expected: 2, restored: 2, missing: 0, unexpected: 0, changed: 0 },
    });
  });

  it('counts a missing empty table as a mismatch', () => {
    const restored = structuredClone(expected);
    delete (restored.tables as Partial<typeof expected.tables>)['public.workspace_members'];
    expect(compareMetadata(expected, restored)).toMatchObject({
      verdict: 'failed', tables: { missing: 1, changed: 0 },
    });
  });

  it('compares large counts exactly without converting them to JS numbers', () => {
    const original = { ...expected, tables: { ...expected.tables, 'public.workspace_members': String(2n ** 53n) } };
    const restored = { ...expected, tables: { ...expected.tables, 'public.workspace_members': String(2n ** 53n + 1n) } };
    expect(compareMetadata(original, restored)).toMatchObject({
      verdict: 'failed', tables: { missing: 0, changed: 1 },
    });
  });

  it('rejects a replaced version even if the migration table row count matches', () => {
    const restored = { ...expected, migrations: { ...expected.migrations, 'public.auth_schema_migrations': ['other_fixture_auth'] } };
    expect(compareMetadata(expected, restored)).toMatchObject({
      verdict: 'failed', tables: { changed: 0 }, migrations: { changed: 1 },
    });
  });

  it('reports unexpected migration ledgers and tables', () => {
    const restored = {
      tables: { ...expected.tables, 'public.fixture_other_migrations': '0' },
      migrations: { ...expected.migrations, 'public.fixture_other_migrations': [] },
    };
    expect(compareMetadata(expected, restored)).toMatchObject({
      verdict: 'failed', tables: { unexpected: 1 }, migrations: { unexpected: 1 },
    });
  });

  it('checks both the byte size and the SHA-256 before accepting the archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-backup-test-'));
    try {
      const dump = join(directory, 'fixture.dump');
      const manifest = join(directory, 'fixture.json');
      const bytes = Buffer.from('fixture archive');
      const run = () => spawnSync(process.execPath, [helper, 'check-archive', dump, manifest], { encoding: 'utf8' });
      await writeFile(dump, bytes);
      await writeFile(manifest, JSON.stringify({
        ...expected, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
        snapshotAt: '2026-11-25T03:15:00.000Z', finishedAt: '2026-11-25T03:16:00.000Z',
      }));
      const verified = run();
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({ verdict: 'passed', sizeBytes: bytes.length });
      await writeFile(dump, Buffer.alloc(bytes.length, 1));
      expect(run()).toMatchObject({ status: 1, stderr: 'Backup archive integrity check failed.\n' });
      await writeFile(dump, Buffer.concat([bytes, Buffer.from('extra')]));
      expect(run()).toMatchObject({ status: 1, stderr: 'Backup archive integrity check failed.\n' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('restore drill database names', () => {
  it('accepts exactly the reserved prefix and a valid compact UTC date', () => {
    expect(isDrillDatabaseName('mohassan_restore_drill_20261125')).toBe(true);
    expect(isDrillDatabaseName('mohassan_restore_drill_20280229')).toBe(true);
  });

  it.each([
    'mohassan',
    'postgres',
    'postgresql://localhost/mohassan',
    '--dbname=mohassan',
    'mohassan_restore_drill_20260229',
    'mohassan_restore_drill_20261125\n',
    'mohassan_restore_drill_20261125;DROP DATABASE mohassan',
  ])('refuses %j before reading files or connecting', name => {
    const result = spawnSync(process.execPath, [helper, 'drill', name], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Restore drill database must be named mohassan_restore_drill_YYYYMMDD with a valid UTC date.\n');
  });
});
