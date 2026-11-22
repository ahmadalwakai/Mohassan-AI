import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { createSkillControl, skillsMigration } from './index.ts';

const manifest = (name: string) => `---\nname: ${name}\ndescription: يوضح هذا الوصف ما تفعله المهارة.\n---\n\nDo the task carefully.\n`;
const hash = () => randomUUID().replace(/-/g, '').padEnd(64, '0');

describe('032_skill_remote migration', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>, root: string;
  const owner = 'remote-migration-owner', other = 'remote-migration-other';
  async function source(slug: string, kind: string) {
    const familyId = randomUUID(), id = randomUUID();
    await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug }).execute();
    await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, version: '1.0.0', sequence: 1, name: 'Remote source fixture', description: 'Synthetic remote source fixture.', category: 'reasoning', level: 'instruction', origin: 'local_import', status: 'quarantined', contract: '{}', content_hash: hash() }).execute();
    await store.db.insertInto('skill_sources').values({ version_id: id, kind, locator: `github:owner/repo@${'a'.repeat(40)}:skills/${slug}`, file_count: 1, total_bytes: 10 }).execute();
    return id;
  }
  const sync = (ownerId: string, status = 'running', cause = 'manual') => store.db.insertInto('skill_remote_syncs').values({ id: randomUUID(), owner_id: ownerId, repo: 'owner/repo', ref: 'main', path: 'skills', cause, status }).execute();
  beforeAll(async () => {
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
    for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    root = await mkdtemp(join(tmpdir(), 'skill-remote-migration-'));
  });
  afterAll(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); });

  it('applies on a fresh database, accepts a github source and refuses an unknown kind', async () => {
    expect(await store.db.selectFrom('schema_migrations').select('version').where('version', '=', '032_skill_remote').executeTakeFirst()).toBeTruthy();
    const checks = await sql<{ conname: string; def: string }>`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='skill_sources'::regclass AND contype='c'`.execute(store.db);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]).toMatchObject({ conname: 'skill_sources_kind_check' });
    expect(checks.rows[0].def).toContain("'github'");
    const id = await source('remote-ok', 'github');
    expect(await store.db.selectFrom('skill_sources').select('kind').where('version_id', '=', id).executeTakeFirstOrThrow()).toEqual({ kind: 'github' });
    await expect(source('remote-bad', 'ftp')).rejects.toThrow(/skill_sources_kind_check/);
  });
  it('is idempotent', async () => {
    const before = await store.db.selectFrom('schema_migrations').select('version').execute();
    await skillsMigration(store.db);
    await skillsMigration(store.db);
    expect(await store.db.selectFrom('schema_migrations').select('version').execute()).toEqual(before);
  });
  it('leaves an existing local import and its local_folder source unchanged', async () => {
    const skills = createSkillControl(store.db, { allowedRoots: [root] });
    const folder = join(root, 'local-survivor'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'SKILL.md'), manifest('local-survivor'));
    const { skill } = await skills.importLocal(owner, { path: folder });
    const before = await skills.detail(owner, skill.id);
    await skillsMigration(store.db);
    const after = await skills.detail(owner, skill.id);
    expect(after.skill).toEqual(before.skill);
    expect(after.source).toEqual(before.source);
    expect(after.source).toMatchObject({ kind: 'local_folder' });
  });
  it('allows one running sync per owner and any number of finished ones', async () => {
    await sync(owner);
    await expect(sync(owner)).rejects.toThrow(/skill_remote_syncs_running_idx/);
    await sync(owner, 'succeeded'); await sync(owner, 'failed');
    await sync(other);
    await expect(sync(owner, 'succeeded', 'webhook')).rejects.toThrow(/skill_remote_syncs_cause_check/);
    expect(await store.db.selectFrom('skill_remote_syncs').select('id').where('owner_id', '=', owner).execute()).toHaveLength(3);
  });
});
