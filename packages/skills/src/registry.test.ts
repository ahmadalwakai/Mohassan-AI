import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillContractSchema, SkillExecutionReceiptSchema } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, exampleSkill, memoryMigration } from '@mohassan/memory';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { builtinSkills, createSkillControl, skillContentHash, sha256, skillsMigration } from './index.ts';

const tool = {
  slug: 'page-report', name: 'تقرير صفحة', description: 'يفتح صفحة ويكتب تقريراً عنها في ملف.', version: '1.0.0', category: 'research', level: 'tool',
  steps: [{ id: 'open', kind: 'tool', title: 'فتح الصفحة', tool: 'browser.open' }], requires: { tools: ['browser.open'] }, sideEffects: 'read', verification: 'تطابق المشاهدة مع الرابط المطلوب.',
};
const script = {
  slug: 'csv-profile', name: 'ملخص CSV', description: 'يلخص ملف CSV داخل حد معزول.', version: '1.0.0', category: 'analytics', level: 'executable',
  steps: [{ id: 'run', kind: 'script', title: 'تشغيل', entry: 'main.mjs' }], execution: { timeoutMs: 5000, memoryMb: 128, outputMaxBytes: 4096 }, verification: 'وجود ملف ملخص صالح.',
};

describe('skill contract rules', () => {
  it('accepts one valid contract per level', () => {
    expect(SkillContractSchema.parse(tool).level).toBe('tool');
    expect(SkillContractSchema.parse(script).level).toBe('executable');
    for (const { contract } of builtinSkills) expect(contract.level).toBe('instruction');
  });
  it.each([
    ['instruction with steps', { ...script, level: 'instruction', execution: undefined }],
    ['tool without a tool step', { ...tool, steps: [{ id: 'think', kind: 'model', title: 'تفكير' }] }],
    ['tool outside the declared list', { ...tool, requires: { tools: [] } }],
    ['script inside a tool skill', { ...tool, steps: [...tool.steps, ...script.steps] }],
    ['executable without limits', { ...script, execution: undefined }],
    ['execution over the sandbox cap', { ...script, execution: { ...script.execution, timeoutMs: 20001 } }],
    ['execution without verification', { ...tool, verification: undefined }],
    ['retry of a non-idempotent skill', { ...tool, retry: { maxAttempts: 2 } }],
    ['write without rollback', { ...tool, sideEffects: 'write_local' }],
    ['unknown tool', { ...tool, requires: { tools: ['shell.run'] } }],
    ['traversal in entry', { ...script, steps: [{ id: 'run', kind: 'script', title: 'x', entry: '../main.mjs' }] }],
    ['unknown extra field', { ...tool, trusted: true }],
    ['self conflict', { ...tool, conflicts: ['page-report'] }],
    ['missing dependency', { ...tool, steps: [{ ...tool.steps[0], dependsOn: ['ghost'] }] }],
  ])('rejects %s', (_name, value) => { expect(SkillContractSchema.safeParse(value).success).toBe(false); });
  it('does not let an instruction run carry execution proof', () => {
    const base = { runId: crypto.randomUUID(), skillVersionId: crypto.randomUUID(), contentHash: 'a'.repeat(64), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'succeeded', evidenceIds: [] };
    expect(SkillExecutionReceiptSchema.parse({ ...base, level: 'instruction', execution: 'model_guided' }).execution).toBe('model_guided');
    expect(SkillExecutionReceiptSchema.safeParse({ ...base, level: 'instruction', execution: 'isolated_script' }).success).toBe(false);
    expect(SkillExecutionReceiptSchema.safeParse({ ...base, level: 'executable', execution: 'isolated_script', isolation: { provider: 'x', verified: false, sharesHostKernel: true, network: 'denied' } }).success).toBe(false);
  });
  it.each(['inputs', 'outputs', 'step outputs'])('rejects ambiguous duplicate %s with conflicting types', (location) => {
    const fields = [{ name: 'value', type: 'string', description: 'First declared field.' }, { name: 'value', type: 'number', description: 'Conflicting declared field.' }];
    const contract = location === 'step outputs' ? { ...tool, steps: [{ ...tool.steps[0], outputs: fields }] } : { ...tool, [location]: fields };
    expect(SkillContractSchema.safeParse(contract).success).toBe(false);
  });
  it('changes the content hash when a file or the contract changes', () => {
    const contract = SkillContractSchema.parse(tool), files = [{ path: 'SKILL.md', content: 'a' }];
    const hash = skillContentHash(contract, files);
    expect(skillContentHash(contract, [...files])).toBe(hash);
    expect(skillContentHash(contract, [{ path: 'SKILL.md', content: 'b' }])).not.toBe(hash);
    expect(skillContentHash({ ...contract, version: '1.0.1' }, files)).not.toBe(hash);
  });
});

describe('skill registry', () => {
  let store: Awaited<ReturnType<typeof createDatabase>>, skills: ReturnType<typeof createSkillControl>;
  const owner = 'skills-owner-fixture', other = 'skills-other-fixture';
  beforeAll(async () => {
    store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await memoryMigration(store.db);
    for(const id of [owner,other])await store.db.insertInto('user').values({id,name:id,email:`${id}@example.test`}).execute();
    await skillsMigration(store.db); await skillsMigration(store.db);
    skills = createSkillControl(store.db);
  });
  afterAll(async () => { await store?.close(); });

  it('seeds custom skills once, unactivated, under concurrent reads', async () => {
    await Promise.all([skills.list(owner, {}), skills.list(owner, {}), skills.list(owner, {})]);
    const { items, total } = await skills.list(owner, {});
    expect(total).toBe(builtinSkills.length);
    for (const item of items) expect(item).toMatchObject({ origin: 'custom', level: 'instruction', status: 'quarantined', active: false, readOnly: false });
    const { rows } = await store.db.selectFrom('skill_versions').select(store.db.fn.countAll().as('n')).where('owner_id', '=', owner).execute().then((value) => ({ rows: value }));
    expect(Number(rows[0].n)).toBe(builtinSkills.length);
  });
  it('searches by text and filters by category, level and status', async () => {
    expect((await skills.list(owner, { q: 'النصوص العربية' })).items.map((item) => item.slug)).toEqual(['arabic-editing-review']);
    expect((await skills.list(owner, { category: 'browser' })).items.map((item) => item.slug)).toEqual(['careful-form-filling']);
    expect((await skills.list(owner, { level: 'executable' })).total).toBe(0);
    expect((await skills.list(owner, { status: 'active' })).total).toBe(0);
    const { counts } = await skills.list(owner, {});
    expect(counts.level).toEqual({ instruction: builtinSkills.length });
    await expect(skills.list(owner, { unknown: 1 })).rejects.toThrow();
    await expect(skills.list(owner, { category: 'magic' })).rejects.toThrow();
  });
  it('paginates without losing the total', async () => {
    const page = await skills.list(owner, { limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1); expect(page.total).toBe(builtinSkills.length);
  });
  it('returns verified plain source for review while leaving quarantine and permissions unchanged', async () => {
    const version = (await skills.list(owner, { q: 'النصوص العربية' })).items[0];
    const before = await skills.detail(owner, version.id), source = await skills.fileContent(owner, version.id, { path: 'SKILL.md' });
    expect(source).toMatchObject({ versionId: version.id, versionContentHash: version.contentHash, contentVerified: true, readOnly: true });
    expect(source.file.content).toBe(builtinSkills.find(skill => skill.contract.slug === version.slug)!.instructions);
    expect(sha256(source.file.content)).toBe(source.file.contentHash);
    expect(await skills.detail(owner, version.id)).toEqual(before);
    await expect(skills.fileContent(other, version.id, { path: 'SKILL.md' })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    await expect(skills.fileContent(owner, version.id, { path: '../SKILL.md' })).rejects.toThrow();
    await expect(skills.fileContent(owner, version.id, { path: 'SKILL.md', execute: true })).rejects.toThrow();
  });
  it('does not describe changed version contents as verified even if the selected file was untouched', async () => {
    const version = (await skills.list(owner, { q: 'النصوص العربية' })).items[0], content = 'Unpinned extra reference.';
    await store.db.insertInto('skill_files').values({ version_id: version.id, path: 'extra.md', kind: 'reference', content, content_hash: sha256(content), size_bytes: Buffer.byteLength(content) }).execute();
    try { await expect(skills.fileContent(owner, version.id, { path: 'SKILL.md' })).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' }); }
    finally { await store.db.deleteFrom('skill_files').where('version_id', '=', version.id).where('path', '=', 'extra.md').execute(); }
  });
  it('allows review of quarantined executable text without executing it', async () => {
    const familyId = crypto.randomUUID(), id = crypto.randomUUID(), contract = SkillContractSchema.parse(script);
    const files = [{ path: 'SKILL.md', kind: 'instructions', content: 'Review the quarantined source before any decision.' }, { path: 'main.mjs', kind: 'script', content: 'throw new Error("THIS_SOURCE_MUST_ONLY_BE_READ");' }];
    await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug: contract.slug }).execute();
    await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, version: contract.version, sequence: 1,
      name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'local_import', status: 'quarantined', contract: JSON.stringify(contract), content_hash: skillContentHash(contract, files) }).execute();
    await store.db.insertInto('skill_files').values(files.map(file => ({ version_id: id, ...file, content_hash: sha256(file.content), size_bytes: Buffer.byteLength(file.content) }))).execute();
    const source = await skills.fileContent(owner, id, { path: 'main.mjs' });
    expect(source.file.content).toBe(files[1].content); expect(source.file.kind).toBe('script');
    expect((await skills.detail(owner, id)).skill).toMatchObject({ status: 'quarantined', active: false });
    expect(await store.db.selectFrom('tasks').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
  });
  it('returns detail with contract, source, files and audit', async () => {
    const [first] = (await skills.list(owner, { q: 'النصوص العربية' })).items;
    const detail = await skills.detail(owner, first.id);
    expect(detail.contract.slug).toBe(first.slug);
    expect(detail.source).toMatchObject({ kind: 'builtin', fileCount: 1 });
    expect(detail.files).toMatchObject([{ path: 'SKILL.md', kind: 'instructions' }]);
    expect(detail.versions.map((version) => version.id)).toContain(first.id);
    expect(detail.audit.map((event) => event.event)).toContain('skill.seeded');
  });
  it('isolates owners', async () => {
    const [first] = (await skills.list(owner, {})).items;
    await expect(skills.detail(other, first.id)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
    expect((await skills.list(other, {})).items.map((item) => item.id)).not.toContain(first.id);
  });
  it('lists checklist skills read-only at the instruction level without changing them', async () => {
    const memory = createMemoryControl(store.db);
    const created = await memory.createSkill(owner, { name: 'مهارة قائمة فحص', description: 'تصنف الطلب وتقترح فحوصاً.', manifest: exampleSkill, evidenceIds: [] });
    const before = await store.db.selectFrom('memory_skill_versions').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const listed = (await skills.list(owner, { q: 'مهارة قائمة فحص' })).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, readOnly: true, level: 'instruction', status: 'quarantined' });
    expect((await skills.detail(owner, created.id)).source).toMatchObject({ kind: 'memory' });
    await expect(skills.detail(other, created.id)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    expect(await store.db.selectFrom('memory_skill_versions').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow()).toEqual(before);
  });
});
