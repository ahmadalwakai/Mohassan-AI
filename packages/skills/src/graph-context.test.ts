import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { createSkillControl, sha256, skillContentHash, skillsMigration } from './index.ts';
import { rebuildSkillGraph, readSkillGraph, relatedSkills } from './graph.ts';
import { createSkillLifecycle } from './lifecycle.ts';
import { createSkillRegistry } from './registry.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase(); await migrate(store.db); await skillsMigration(store.db); });
afterAll(async () => { await store?.close(); });

function fixture(owner = randomUUID()) {
  const skills = createSkillControl(store.db, { enabled: true });
  async function insert(slug: string, options: Partial<SkillContract> & { text?: string; familyId?: string } = {}) {
    const { text = `Verified guidance for ${slug}.`, familyId: existingFamily, ...overrides } = options;
    const contract = SkillContractSchema.parse({ slug, name: slug, description: 'Independent bounded instruction guidance.', category: 'documents', version: '1.0.0', level: 'instruction', ...overrides });
    const familyId = existingFamily ?? randomUUID(), id = randomUUID(), files = [{ path: 'SKILL.md', content: text }];
    if (!existingFamily) await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug }).execute();
    const previous = await store.db.selectFrom('skill_versions').select('sequence').where('family_id', '=', familyId).orderBy('sequence', 'desc').executeTakeFirst();
    await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, sequence: (previous?.sequence ?? 0) + 1,
      version: contract.version, name: contract.name, description: contract.description, category: contract.category, level: contract.level,
      origin: 'custom', status: 'quarantined', contract: JSON.stringify(contract), content_hash: skillContentHash(contract, files) }).execute();
    await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content: text, content_hash: sha256(text), size_bytes: Buffer.byteLength(text) }).execute();
    return { id, familyId, contract, text };
  }
  async function activate(id: string) {
    const current = await skills.detail(owner, id);
    const inspected = await skills.inspect(owner, id, { expectedRevision: current.skill.revision });
    return (await skills.activate(owner, id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true })).skill;
  }
  return { owner, skills, insert, activate };
}

describe('graph metadata through the existing instruction lifecycle', () => {
  it('loads a positive dependency without granting its declared tools and keeps reads mutation-free', async () => {
    const f = fixture(), helper = await f.insert('quiet-helper', { text: 'RELATED_INSTRUCTION_MARKER', requires: { tools: ['file.write'], scopes: ['file:write'], paths: [] },
      sideEffects: 'write_local', rollback: { mode: 'manual', note: 'Review and undo any separately authorized edit.' } });
    const anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper'], text: 'ANCHOR_INSTRUCTION_MARKER' });
    await f.activate(helper.id); await f.activate(anchor.id);
    const before = await store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', f.owner).orderBy('edge_key').execute();
    const auditBefore = await store.db.selectFrom('skill_audit').select('id').where('owner_id', '=', f.owner).execute();
    const result = await f.skills.context(f.owner, 'anchorneedle', { budgetChars: 4000 });
    expect(result.skills.map(skill => skill.id)).toEqual([anchor.id, helper.id]);
    expect(result.text).toContain('RELATED_INSTRUCTION_MARKER'); expect(JSON.parse(result.text).permissionsGranted).toBe(false);
    expect(await store.db.selectFrom('skill_grants').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('tasks').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', f.owner).orderBy('edge_key').execute()).toEqual(before);
    expect(await store.db.selectFrom('skill_audit').select('id').where('owner_id', '=', f.owner).execute()).toEqual(auditBefore);
  });

  it('never uses conflict-only or conflicting positive edges as recommendations', async () => {
    const f = fixture(), good = await f.insert('quiet-helper'), enemy = await f.insert('hostile-helper');
    const anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper', 'hostile-helper'], conflicts: ['hostile-helper'] });
    for (const item of [good, enemy, anchor]) await f.activate(item.id);
    const related = await relatedSkills(store.db, f.owner, [anchor.id], { depth: 2, limit: 12 });
    expect(related.skillIds).toEqual([good.id]);
    const context = await f.skills.context(f.owner, 'anchorneedle');
    expect(context.skills.map(skill => skill.id)).toEqual([anchor.id, good.id]); expect(context.text).not.toContain('hostile-helper');
    expect((await readSkillGraph(store.db, f.owner)).edges.some(edge => edge.relation === 'conflicts_with')).toBe(true);
  });

  it('revalidates dependency file contents and current inspection before putting text in a prompt', async () => {
    const f = fixture(), helper = await f.insert('quiet-helper'), anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper'] });
    await f.activate(helper.id); await f.activate(anchor.id);
    expect((await f.skills.context(f.owner, 'anchorneedle')).skills).toHaveLength(2);
    await store.db.updateTable('skill_files').set({ content: 'UNVERIFIED_CHANGED_CONTENT' }).where('version_id', '=', helper.id).execute();
    const changed = await f.skills.context(f.owner, 'anchorneedle'); expect(changed.skills.map(skill => skill.id)).toEqual([anchor.id]); expect(changed.text).not.toContain('UNVERIFIED_CHANGED_CONTENT');
    await store.db.updateTable('skill_files').set({ content: helper.text }).where('version_id', '=', helper.id).execute();
    await store.db.updateTable('skill_inspections').set({ inspector_version: 'expired-fixture-inspector' }).where('version_id', '=', helper.id).execute();
    expect((await f.skills.context(f.owner, 'anchorneedle')).skills.map(skill => skill.id)).toEqual([anchor.id]);
    expect((await f.skills.detail(f.owner, helper.id)).skill.status).toBe('active');
  });

  it('never turns a related tool-level skill into instruction context', async () => {
    const f = fixture(), tool = await f.insert('quiet-reader', { level: 'tool', text: 'TOOL_INSTRUCTION_MUST_NOT_LOAD',
      steps: [{ id: 'read', kind: 'tool', title: 'Read a file', tool: 'file.read', inputs: {}, outputs: [], dependsOn: [] }],
      requires: { tools: ['file.read'], scopes: ['file:read'], paths: [] }, sideEffects: 'read', verification: 'Independently confirm the file observation.' });
    const anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-reader'] }); await f.activate(tool.id); await f.activate(anchor.id);
    expect((await relatedSkills(store.db, f.owner, [anchor.id])).skillIds).toContain(tool.id);
    const context = await f.skills.context(f.owner, 'anchorneedle'); expect(context.skills.map(skill => skill.id)).toEqual([anchor.id]); expect(context.text).not.toContain('TOOL_INSTRUCTION_MUST_NOT_LOAD');
  });

  it('skips missing and foreign loaded IDs without losing valid lexical graph relations', async () => {
    const f = fixture(), foreign = fixture(), helper = await f.insert('quiet-helper'), anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper'] });
    const other = await foreign.insert('foreign-secret', { text: 'OTHER_OWNER_INSTRUCTIONS' });
    await f.activate(helper.id); await f.activate(anchor.id); await foreign.activate(other.id);
    const result = await f.skills.context(f.owner, 'anchorneedle', { loadedIds: [randomUUID(), other.id] });
    expect(result.skills.map(skill => skill.id)).toEqual([anchor.id, helper.id]); expect(result.text).not.toContain('OTHER_OWNER_INSTRUCTIONS');
    expect((await f.skills.context(f.owner, 'unmatched', { loadedIds: [randomUUID(), other.id] })).text).toBe('');
  });

  it('follows current versions after replacement, rollback and revocation', async () => {
    const f = fixture(), first = await f.insert('quiet-helper', { text: 'FIRST_ACTIVE_VERSION' }), anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper'] });
    await f.activate(first.id); await f.activate(anchor.id);
    const second = await f.insert('quiet-helper', { familyId: first.familyId, version: '1.0.1', text: 'SECOND_ACTIVE_VERSION' }); await f.activate(second.id);
    expect((await f.skills.context(f.owner, 'anchorneedle')).skills.map(skill => skill.id)).toEqual([anchor.id, second.id]);
    const previous = (await f.skills.detail(f.owner, first.id)).skill;
    await f.skills.rollback(f.owner, first.id, { expectedRevision: previous.revision, approve: true, reason: 'Return to the verified fixture version.' });
    const rolledBack = await f.skills.context(f.owner, 'anchorneedle'); expect(rolledBack.skills.map(skill => skill.id)).toEqual([anchor.id, first.id]); expect(rolledBack.text).not.toContain('SECOND_ACTIVE_VERSION');
    const current = (await f.skills.detail(f.owner, first.id)).skill;
    await f.skills.revoke(f.owner, first.id, { expectedRevision: current.revision, reason: 'Controlled revocation.' });
    expect((await f.skills.context(f.owner, 'anchorneedle')).skills.map(skill => skill.id)).toEqual([anchor.id]);
  });

  it('rolls back the lifecycle mutation and graph together if refreshing metadata fails', async () => {
    const f = fixture(), helper = await f.insert('quiet-helper'), anchor = await f.insert('anchorneedle', { dependsOn: ['quiet-helper'] });
    await f.activate(helper.id); const active = await f.activate(anchor.id);
    const before = await store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', f.owner).orderBy('edge_key').execute();
    const registry = createSkillRegistry(store.db);
    const lifecycle = createSkillLifecycle(store.db, { audit: registry.audit, executableReady: async () => false, rebuildGraph: async (tx, ownerId) => {
      await rebuildSkillGraph(tx, ownerId); throw new Error('Synthetic graph write failure');
    } });
    await expect(lifecycle.revoke(f.owner, anchor.id, { expectedRevision: active.revision, reason: 'Must roll back as a unit.' })).rejects.toThrow('Synthetic graph write failure');
    expect((await f.skills.detail(f.owner, anchor.id)).skill).toMatchObject({ status: 'active', revision: active.revision });
    expect(await store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', f.owner).orderBy('edge_key').execute()).toEqual(before);
    expect(await store.db.selectFrom('skill_audit').select('id').where('owner_id', '=', f.owner).where('event', '=', 'skill.revoked').execute()).toEqual([]);
  });

  it('does no SQL when disabled and never seeds or rebuilds on an empty context read', async () => {
    const disabled = createSkillControl({} as any), owner = randomUUID();
    expect(await disabled.context(owner, 'anchorneedle')).toEqual({ text: '', skills: [], sources: [] });
    expect(await disabled.loadInstruction(owner, 'anchorneedle')).toEqual({ text: '', skills: [], sources: [] });
    expect(await createSkillControl(store.db, { enabled: true }).context(owner, 'anchorneedle')).toEqual({ text: '', skills: [], sources: [] });
    expect(await store.db.selectFrom('skill_families').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_edges').select('edge_key').where('owner_id', '=', owner).execute()).toEqual([]);
  });
});
