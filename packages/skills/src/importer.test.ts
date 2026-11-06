import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { createSkillControl, parseSkillManifest, sha256, skillsMigration } from './index.ts';

const manifest = (name: string, body = 'Do the task carefully.', extra = '') => `---\nname: ${name}\ndescription: يوضح هذا الوصف ما تفعله المهارة.\n${extra}---\n\n${body}\n`;

describe('SKILL.md manifest reader', () => {
  it('reads plain, quoted and folded values and skips nested blocks', () => {
    const { fields, body } = parseSkillManifest('---\r\nname: "my-skill"\r\ndescription: >\r\n  first line\r\n  second line\r\nmetadata:\r\n  owner: me\r\nlicense: MIT\r\n---\r\nBody text\r\n');
    expect(fields).toMatchObject({ name: 'my-skill', description: 'first line second line', license: 'MIT' });
    expect(fields.owner).toBeUndefined();
    expect(body).toBe('Body text');
  });
  it('does not pollute objects through a crafted key', () => {
    const { fields } = parseSkillManifest('---\n__proto__: x\nconstructor: y\n---\nbody\n'.replace('__proto__', 'proto'));
    expect(({} as Record<string, unknown>).proto).toBeUndefined();
    expect(fields.constructor).toBe('y');
  });
  it.each([
    ['no header', 'body only'], ['unterminated', '---\nname: x\nbody'], ['duplicate key', '---\nname: a\nname: b\n---\nbody'],
    ['empty body', '---\nname: a\n---\n'], ['unknown line', '---\n!!python/object: x\n---\nbody'], ['oversized header', `---\na: ${'x'.repeat(5000)}\n---\nbody`],
  ])('rejects %s', (_name, source) => { expect(() => parseSkillManifest(source)).toThrow(expect.objectContaining({ code: 'SKILL_MANIFEST_INVALID' })); });
});

describe('local skill import', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>, skills: ReturnType<typeof createSkillControl>, root: string, outside: string;
  const owner = 'import-owner-fixture', other = 'import-other-fixture';
  async function folder(files: Record<string, string>, name = randomUUID()) {
    const directory = join(root, name);
    for (const [path, content] of Object.entries(files)) { const target = join(directory, ...path.split('/')); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); }
    return directory;
  }
  beforeAll(async () => {
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db);
    for (const id of [owner, other]) await store.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
    root = await mkdtemp(join(tmpdir(), 'skill-import-')); outside = await mkdtemp(join(tmpdir(), 'skill-outside-'));
    skills = createSkillControl(store.db, { allowedRoots: [root] });
  });
  afterAll(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

  it('quarantines an instruction skill with provenance and the most restricted contract', async () => {
    const path = await folder({ 'SKILL.md': manifest('plain-notes'), 'references/guide.md': 'more', 'data/table.csv': 'a,b' });
    const { skill, deduplicated } = await skills.importLocal(owner, { path });
    expect(deduplicated).toBe(false);
    expect(skill).toMatchObject({ slug: 'plain-notes', status: 'quarantined', origin: 'local_import', level: 'instruction', active: false, version: '1.0.0' });
    const detail = await skills.detail(owner, skill.id);
    expect(detail.contract).toMatchObject({ sideEffects: 'none', steps: [], requires: { tools: [] } });
    expect(Object.fromEntries(detail.files.map((file) => [file.path, file.kind]))).toEqual({ 'data/table.csv': 'data', 'references/guide.md': 'reference', 'SKILL.md': 'instructions' });
    expect(detail.source).toMatchObject({ kind: 'local_folder', fileCount: 3 });
    expect(detail.audit.map((event) => event.event)).toContain('skill.imported');
  });
  it('stores a script without running it, and a skill with no contract stays at the instruction level', async () => {
    const marker = join(outside, 'ran.txt');
    const path = await folder({ 'SKILL.md': manifest('script-carrier'), 'main.mjs': `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');` });
    const { skill } = await skills.importLocal(owner, { path });
    expect(skill.level).toBe('instruction');
    await expect(import('node:fs/promises').then((fs) => fs.stat(marker))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await skills.detail(owner, skill.id)).files.find((file) => file.path === 'main.mjs')?.kind).toBe('script');
  });
  it('reads a sidecar contract as data and validates it', async () => {
    const contract = { slug: 'with-contract', name: 'مهارة بعقد', description: 'تعتمد على عقد صريح مع المهارة.', version: '2.1.0', category: 'research', level: 'tool', requires: { tools: ['browser.open'] }, sideEffects: 'read', steps: [{ id: 'open', kind: 'tool', title: 'فتح', tool: 'browser.open' }], verification: 'تطابق المشاهدة.' };
    const { skill } = await skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('ignored-name'), 'skill.contract.json': JSON.stringify(contract) }) });
    expect(skill).toMatchObject({ slug: 'with-contract', level: 'tool', version: '2.1.0', category: 'research' });
    await expect(skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('x-y'), 'skill.contract.json': '{not json' }) })).rejects.toMatchObject({ code: 'SKILL_CONTRACT_INVALID' });
    await expect(skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('x-y'), 'skill.contract.json': JSON.stringify({ ...contract, trusted: true }) }) })).rejects.toMatchObject({ code: 'SKILL_CONTRACT_INVALID' });
  });
  it('deduplicates identical content, bumps a changed version and keeps old versions untouched', async () => {
    const first = await folder({ 'SKILL.md': manifest('versioned', 'one') }), again = await folder({ 'SKILL.md': manifest('versioned', 'one') }), changed = await folder({ 'SKILL.md': manifest('versioned', 'two') });
    const a = await skills.importLocal(owner, { path: first });
    expect(await skills.importLocal(owner, { path: again })).toMatchObject({ deduplicated: true, skill: { id: a.skill.id } });
    const b = await skills.importLocal(owner, { path: changed });
    expect(b).toMatchObject({ deduplicated: false, skill: { version: '1.0.1', familyId: a.skill.familyId } });
    expect((await skills.detail(owner, a.skill.id)).skill.contentHash).toBe(a.skill.contentHash);
    expect((await skills.detail(owner, b.skill.id)).versions.map((version) => version.version)).toEqual(['1.0.1', '1.0.0']);
  });
  it('inspects and activates multi-input contracts after their real JSONB round trip', async () => {
    const contract = { slug: 'jsonb-input-order', name: 'JSONB order fixture', description: 'Stable nested input records across persistence.', version: '1.0.0', category: 'research', level: 'tool', sideEffects: 'read', requires: { tools: ['research.run'] }, verification: 'Verify fixture evidence.', steps: [{ id: 'search', kind: 'tool', title: 'Read fixture', tool: 'research.run', inputs: { longerKey: 'input.query', a: 'input.path' } }] };
    const path = await folder({ 'SKILL.md': manifest(contract.slug), 'skill.contract.json': JSON.stringify(contract) });
    const imported = await skills.importLocal(owner, { path });
    const inspected = await skills.inspect(owner, imported.skill.id, { expectedRevision: imported.skill.revision });
    const active = await skills.activate(owner, imported.skill.id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true });
    expect(active.skill.active).toBe(true);
    const reorderedPath = await folder({ 'SKILL.md': manifest(contract.slug), 'skill.contract.json': JSON.stringify({ ...contract, steps: [{ ...contract.steps[0], inputs: { a: 'input.path', longerKey: 'input.query' } }] }) });
    expect(await skills.importLocal(owner, { path: reorderedPath })).toMatchObject({ deduplicated: true, skill: { id: imported.skill.id, contentHash: imported.skill.contentHash } });
  });
  it('deduplicates valid legacy content without rewriting active inspection or grants', async () => {
    const contract = { slug: 'legacy-active-import', name: 'Legacy import fixture', description: 'Previously valid legacy hashes remain immutable.', version: '1.0.0', category: 'research', level: 'tool', sideEffects: 'read', requires: { tools: ['research.run'] }, verification: 'Verify fixture evidence.', steps: [{ id: 'search', kind: 'tool', title: 'Read fixture', tool: 'research.run' }] };
    const path = await folder({ 'SKILL.md': manifest(contract.slug), 'skill.contract.json': JSON.stringify(contract) });
    const imported = await skills.importLocal(owner, { path });
    const detail = await skills.detail(owner, imported.skill.id);
    const files = await store.db.selectFrom('skill_files').select(['path', 'content']).where('version_id', '=', imported.skill.id).execute();
    const legacyHash = sha256(JSON.stringify({ contract: detail.contract, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')).map(file => ({ path: file.path, hash: sha256(file.content) })) }));
    await store.db.updateTable('skill_versions').set({ content_hash: legacyHash }).where('id', '=', imported.skill.id).execute();
    const inspected = await skills.inspect(owner, imported.skill.id, { expectedRevision: imported.skill.revision });
    const active = await skills.activate(owner, imported.skill.id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true });
    await skills.createGrant(owner, imported.skill.id, { expectedRevision: active.skill.revision, approve: true, tools: ['research.run'], durationHours: 1 });
    const before = await skills.detail(owner, imported.skill.id);
    expect(await skills.importLocal(owner, { path })).toMatchObject({ deduplicated: true, skill: { id: imported.skill.id, contentHash: legacyHash, active: true } });
    const after = await skills.detail(owner, imported.skill.id);
    expect(after.skill).toEqual(before.skill); expect(after.inspection).toEqual(before.inspection); expect(after.grants).toEqual(before.grants);
  });
  it('refuses a changed skill that reuses an explicit version', async () => {
    await skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('pinned', 'one', 'version: 3.0.0\n') }) });
    await expect(skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('pinned', 'two', 'version: 3.0.0\n') }) })).rejects.toMatchObject({ code: 'SKILL_VERSION_EXISTS', statusCode: 409 });
  });
  it('cannot take over a custom skill by reusing its slug', async () => {
    await skills.list(owner, {});
    await expect(skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('verified-web-research', 'hijack') }) })).rejects.toMatchObject({ code: 'SKILL_SLUG_TAKEN', statusCode: 409 });
  });
  it('produces one version from concurrent imports of the same folder', async () => {
    const path = await folder({ 'SKILL.md': manifest('racing-import') });
    const results = await Promise.all([1, 2, 3].map(() => skills.importLocal(owner, { path })));
    expect(new Set(results.map((result) => result.skill.id)).size).toBe(1);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
  });
  it('serializes the owner quota across concurrent imports of different slugs', async () => {
    const quotaOwner = 'quota-owner-fixture', familyId = randomUUID();
    await store.db.insertInto('user').values({ id: quotaOwner, name: 'Quota fixture', email: 'quota@example.test' }).execute();
    const builtins = await skills.list(quotaOwner, {});
    await store.db.insertInto('skill_families').values({ id: familyId, owner_id: quotaOwner, slug: 'quota-seed' }).execute();
    await store.db.insertInto('skill_versions').values(Array.from({ length: 199 }, (_, index) => ({
      id: randomUUID(), family_id: familyId, owner_id: quotaOwner, version: `1.0.${index}`, sequence: index + 1,
      name: 'Quota fixture', description: 'Synthetic storage quota fixture.', category: 'reasoning', level: 'instruction',
      origin: 'local_import', status: 'quarantined', contract: '{}', content_hash: index.toString(16).padStart(64, '0'),
    }))).execute();
    const paths = await Promise.all(['quota-a', 'quota-b', 'quota-c'].map(name => folder({ 'SKILL.md': manifest(name) })));
    const outcomes = await Promise.allSettled(paths.map(path => skills.importLocal(quotaOwner, { path })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of outcomes) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'SKILL_QUOTA_EXCEEDED' });
    const rows = await store.db.selectFrom('skill_versions').select('id').where('owner_id', '=', quotaOwner).where('origin', '=', 'local_import').execute();
    expect(rows).toHaveLength(200);
    expect(await store.db.selectFrom('skill_families').select('id').where('owner_id', '=', quotaOwner).execute()).toHaveLength(2 + builtins.total);
  });
  it('refuses an automatic version bump outside the contract bounds without storing invalid content', async () => {
    const first = await skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('max-patch', 'First version.', 'version: 1.0.99999\n') }) });
    await expect(skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('max-patch', 'Changed version.') }) })).rejects.toMatchObject({ code: 'SKILL_VERSION_LIMIT', statusCode: 409 });
    const detail = await skills.detail(owner, first.skill.id);
    expect(detail.versions.map(version => version.version)).toEqual(['1.0.99999']);
    expect(detail.skill.contentHash).toBe(first.skill.contentHash);
  });
  it('keeps imports of different owners apart', async () => {
    const path = await folder({ 'SKILL.md': manifest('shared-folder') });
    const mine = await skills.importLocal(owner, { path }), theirs = await skills.importLocal(other, { path });
    expect(theirs.deduplicated).toBe(false); expect(theirs.skill.id).not.toBe(mine.skill.id);
  });
  it('rejects folders outside the allowed roots and non-absolute paths', async () => {
    await writeFile(join(outside, 'SKILL.md'), manifest('outside'));
    await expect(skills.importLocal(owner, { path: outside })).rejects.toMatchObject({ code: 'PROJECT_OUTSIDE_ROOTS' });
    await expect(skills.importLocal(owner, { path: 'relative/skill' })).rejects.toMatchObject({ code: 'LOCAL_PROJECT_REQUIRED' });
    await expect(skills.importLocal(owner, { path: '\\\\server\\share\\skill' })).rejects.toMatchObject({ code: 'LOCAL_PROJECT_REQUIRED' });
    await expect(createSkillControl(store.db).importLocal(owner, { path: root })).rejects.toMatchObject({ code: 'LOCAL_PROJECT_REQUIRED' });
  });
  it('rejects a junction inside the skill folder', async () => {
    const path = await folder({ 'SKILL.md': manifest('linked') });
    await symlink(outside, join(path, 'link'), 'junction');
    await expect(skills.importLocal(owner, { path })).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' });
  });
  it.each([
    ['a missing manifest', { 'README.md': 'x' }, 'SKILL_MANIFEST_MISSING'],
    ['a sensitive file', { 'SKILL.md': manifest('s-a'), '.env': 'A=1' }, 'SENSITIVE_PROJECT_PATH'],
    ['bundled packages', { 'SKILL.md': manifest('s-b'), 'node_modules/a/index.js': 'x' }, 'SENSITIVE_PROJECT_PATH'],
    ['a credential in a file', { 'SKILL.md': manifest('s-c', 'token gsk_abcdefghijklmnopqrstuvwxyz123456') }, 'SENSITIVE_SOURCE_REJECTED'],
    ['an unsupported file type', { 'SKILL.md': manifest('s-d'), 'tool.exe': 'MZ' }, 'SKILL_FILE_UNSUPPORTED'],
    ['a file over the limit', { 'SKILL.md': manifest('s-e'), 'big.txt': 'x'.repeat(70_000) }, 'UNSUPPORTED_FILE'],
    ['a total over the limit', Object.fromEntries([['SKILL.md', manifest('s-f')], ...Array.from({ length: 6 }, (_, index) => [`part${index}.txt`, 'x'.repeat(60_000)])]), 'SKILL_TOO_LARGE'],
    ['a binary file', { 'SKILL.md': manifest('s-g'), 'data.txt': 'a\0b' }, 'UNSUPPORTED_FILE'],
    ['too many files', Object.fromEntries([['SKILL.md', manifest('s-h')], ...Array.from({ length: 45 }, (_, index) => [`n${index}.txt`, 'x'])]), 'PROJECT_TOO_LARGE'],
    ['a description that is too short', { 'SKILL.md': '---\nname: s-i\ndescription: short\n---\nbody' }, 'SKILL_MANIFEST_INVALID'],
  ])('rejects %s and stores nothing', async (_name, files, code) => {
    const before = await store.db.selectFrom('skill_versions').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    await expect(skills.importLocal(owner, { path: await folder(files) })).rejects.toMatchObject({ code });
    expect(await store.db.selectFrom('skill_versions').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).toEqual(before);
  });
  it('derives a usable slug from a non-latin name', async () => {
    const { skill } = await skills.importLocal(owner, { path: await folder({ 'SKILL.md': manifest('مهارة عربية') }) });
    expect(skill.slug).toMatch(/^skill-[a-f0-9]{12}$/);
    expect(skill.name).toBe('مهارة عربية');
  });
});
