import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillContractSchema } from '@mohassan/contracts';
import { SkillGraphQuerySchema, SkillGraphRelatedQuerySchema, SkillGraphSnapshotSchema } from '../../contracts/src/skill-graph.ts';
import { executionFixture, singlePlan, toolContract } from '../../../tests/helpers/skill-execution.ts';
import { skillContentHash, sha256 } from './hash.ts';
import { INSPECTOR_VERSION, inspectSkill } from './inspector.ts';
import { rebuildSkillGraph, readSkillGraph, relatedSkills } from './graph.ts';
import { skillToolCapabilities } from './permissions.ts';
import { canonicalSkillEvidenceJson } from './evidence.ts';

describe('bounded explicit skill knowledge graph', () => {
  let f: Awaited<ReturnType<typeof executionFixture>>;
  beforeAll(async () => { f = await executionFixture(); });
  afterAll(async () => { await f?.store.close(); });
  const owner = () => `graph-${randomUUID()}`;
  async function version(ownerId: string, slug: string, extra: Record<string, unknown> = {}) {
    const contract = SkillContractSchema.parse({ slug, name: `Skill ${slug}`, description: 'Explicit metadata fixture without script execution.', version: '1.0.0', category: 'research', level: 'instruction', ...extra });
    const id = randomUUID(), familyId = randomUUID(), files = [{ path: 'SKILL.md', kind: 'instructions' as const, content: 'Use verified evidence carefully.' }], contentHash = skillContentHash(contract, files);
    const inspection = inspectSkill(contract, files); expect(['pass', 'review']).toContain(inspection.verdict);
    // Direct fixture setup isolates graph behavior. Lifecycle/API integration
    // tests cover actual import, approval and activation separately.
    await f.store.db.insertInto('skill_families').values({ id: familyId, owner_id: ownerId, slug, active_version_id: id }).execute();
    await f.store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: ownerId, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'custom', status: 'active', contract: JSON.stringify(contract), content_hash: contentHash }).execute();
    await f.store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content: files[0].content, content_hash: sha256(files[0].content), size_bytes: Buffer.byteLength(files[0].content) }).execute();
    await f.store.db.insertInto('skill_inspections').values({ id: randomUUID(), version_id: id, owner_id: ownerId, content_hash: contentHash, inspector_version: INSPECTOR_VERSION, verdict: inspection.verdict, findings: JSON.stringify(inspection.findings) }).execute();
    return { id, familyId, contentHash, contract };
  }

  it('reads an empty graph without seeding or rebuilding and exposes an isolated skill without invented edges', async () => {
    const owned = owner();
    expect(await readSkillGraph(f.store.db, owned)).toMatchObject({ nodes: [], edges: [], rebuilt: false, truncated: false, permissionsGranted: false });
    expect(await f.store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', owned).execute()).toEqual([]);
    const alone = await version(owned, 'single-guidance');
    const graph = await rebuildSkillGraph(f.store.db, owned);
    expect(graph.nodes).toEqual([expect.objectContaining({ key: `skill:${alone.id}`, kind: 'skill', active: true, routingEligible: true, verification: 'current_metadata' })]);
    expect(graph.edges).toEqual([]);
  });

  it('stores only explicit dependency/conflict/tool/capability relationships with deterministic provenance', async () => {
    const owned = owner(), target = await version(owned, 'target-notes'), rival = await version(owned, 'rival-notes');
    const source = await version(owned, 'source-notes', { dependsOn: ['target-notes'], conflicts: ['rival-notes'], requires: { tools: ['browser.open', 'file.read'] }, sideEffects: 'read' });
    const first = await rebuildSkillGraph(f.store.db, owned), second = await rebuildSkillGraph(f.store.db, owned);
    expect(second).toEqual(first); expect(await readSkillGraph(f.store.db, owned)).toEqual(first);
    expect(first.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: `skill:${source.id}`, to: `skill:${target.id}`, relation: 'depends_on', provenance: 'declared_contract', sourceContentHash: source.contentHash, targetContentHash: target.contentHash }),
      expect.objectContaining({ from: `skill:${source.id}`, to: `skill:${rival.id}`, relation: 'conflicts_with' }),
      expect.objectContaining({ from: `skill:${source.id}`, to: 'tool:browser.open', relation: 'requires_tool' }),
      expect.objectContaining({ from: 'tool:browser.open', to: `capability:${skillToolCapabilities['browser.open']}`, relation: 'implemented_by', provenance: 'trusted_tool_mapping' }),
    ]));
    expect(first.nodes).toContainEqual(expect.objectContaining({ key: 'tool:file.read', kind: 'tool' }));
    expect(first.edges.some(edge => edge.from === 'tool:file.read' && edge.relation === 'implemented_by')).toBe(false);
    expect(first.permissionsGranted).toBe(false); expect(first.nodes.some(node => node.kind === 'outcome')).toBe(false);
  });

  it('bounds dependency traversal by depth and visits each version once despite a cycle', async () => {
    const owned = owner(), a = await version(owned, 'cycle-alpha', { dependsOn: ['cycle-beta'] }), b = await version(owned, 'cycle-beta', { dependsOn: ['cycle-gamma'] }), c = await version(owned, 'cycle-gamma', { dependsOn: ['cycle-alpha'] });
    await rebuildSkillGraph(f.store.db, owned);
    expect((await relatedSkills(f.store.db, owned, [a.id], { depth: 0 })).skillIds).toEqual([]);
    expect((await relatedSkills(f.store.db, owned, [a.id], { depth: 1 })).skillIds).toEqual([b.id]);
    expect((await relatedSkills(f.store.db, owned, [a.id], { depth: 2 })).skillIds).toEqual([b.id, c.id]);
    expect(await relatedSkills(f.store.db, owned, [a.id], { depth: 2, limit: 1 })).toMatchObject({ skillIds: [b.id], truncated: true, permissionsGranted: false });
  });

  it('vetoes conflicting dependencies in either direction, including indirect conflicts with a seed', async () => {
    const owned = owner(), a = await version(owned, 'veto-alpha', { dependsOn: ['veto-beta'], conflicts: ['veto-gamma'] }), b = await version(owned, 'veto-beta', { dependsOn: ['veto-gamma'] });
    await version(owned, 'veto-gamma'); await rebuildSkillGraph(f.store.db, owned);
    expect((await relatedSkills(f.store.db, owned, [a.id], { depth: 2 })).skillIds).toEqual([b.id]);
    const reverseOwner = owner(), x = await version(reverseOwner, 'reverse-alpha', { dependsOn: ['reverse-beta'] });
    await version(reverseOwner, 'reverse-beta', { conflicts: ['reverse-alpha'] }); await rebuildSkillGraph(f.store.db, reverseOwner);
    expect((await relatedSkills(f.store.db, reverseOwner, [x.id])).skillIds).toEqual([]);
  });

  it('never crosses owners even when slugs match and rejects unowned seed IDs', async () => {
    const one = owner(), two = owner(), a = await version(one, 'owner-alpha', { dependsOn: ['owner-beta'] }), b = await version(two, 'owner-beta');
    await Promise.all([rebuildSkillGraph(f.store.db, one), rebuildSkillGraph(f.store.db, two)]);
    const graph = await readSkillGraph(f.store.db, one); expect(graph.edges).toEqual([]); expect(graph.nodes.some(node => node.key === `skill:${b.id}`)).toBe(false);
    await expect(relatedSkills(f.store.db, one, [b.id])).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
    expect((await relatedSkills(f.store.db, one, [a.id])).skillIds).toEqual([]);
  });

  it('filters revoked pointers, changed hashes and expired inspector metadata without writing on GET', async () => {
    const owned = owner(), a = await version(owned, 'fresh-alpha', { dependsOn: ['fresh-beta'] }), b = await version(owned, 'fresh-beta');
    await rebuildSkillGraph(f.store.db, owned);
    const persisted = await f.store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', owned).orderBy('edge_key').execute();
    await f.store.db.updateTable('skill_families').set({ active_version_id: null }).where('id', '=', b.familyId).execute();
    expect((await relatedSkills(f.store.db, owned, [a.id])).skillIds).toEqual([]);
    await f.store.db.updateTable('skill_families').set({ active_version_id: b.id }).where('id', '=', b.familyId).execute();
    await f.store.db.updateTable('skill_versions').set({ content_hash: sha256('changed metadata') }).where('id', '=', b.id).execute();
    expect((await relatedSkills(f.store.db, owned, [a.id])).skillIds).toEqual([]);
    await f.store.db.updateTable('skill_versions').set({ content_hash: b.contentHash }).where('id', '=', b.id).execute();
    await f.store.db.updateTable('skill_inspections').set({ inspector_version: 'expired-inspector-fixture' }).where('version_id', '=', b.id).execute();
    expect((await relatedSkills(f.store.db, owned, [a.id])).skillIds).toEqual([]);
    expect(await f.store.db.selectFrom('skill_edges').selectAll().where('owner_id', '=', owned).orderBy('edge_key').execute()).toEqual(persisted);
  });

  it('uses the caller transaction without nesting and atomically rolls back a rebuild', async () => {
    const owned = owner(), a = await version(owned, 'atomic-alpha', { dependsOn: ['atomic-beta'] }), b = await version(owned, 'atomic-beta');
    const original = await rebuildSkillGraph(f.store.db, owned);
    await expect(f.store.db.transaction().execute(async tx => {
      await tx.updateTable('skill_families').set({ active_version_id: null }).where('id', '=', b.familyId).execute();
      expect((await rebuildSkillGraph(tx, owned)).edges).toEqual([]);
      throw new Error('Controlled graph rollback');
    })).rejects.toThrow('Controlled graph rollback');
    expect(await readSkillGraph(f.store.db, owned)).toEqual(original);
    expect((await relatedSkills(f.store.db, owned, [a.id])).skillIds).toEqual([b.id]);
  });

  it('serializes concurrent owner rebuilds and preserves a distinct owner snapshot', async () => {
    const owned = owner(), other = owner(); await version(owned, 'race-alpha'); await version(other, 'race-other');
    const otherGraph = await rebuildSkillGraph(f.store.db, other);
    const builds = await Promise.all(Array.from({ length: 4 }, () => rebuildSkillGraph(f.store.db, owned)));
    expect(builds.every(result => result.snapshotHash === builds[0].snapshotHash)).toBe(true);
    expect(await f.store.db.selectFrom('skill_edges').select('edge_key').where('owner_id', '=', owned).execute()).toEqual([{ edge_key: '@snapshot' }]);
    expect(await readSkillGraph(f.store.db, other)).toEqual(otherGraph);
  });

  it('marks discovery truncation durably and provides no recommendation from an incomplete graph', async () => {
    const owned = owner(); let first = '';
    for (let index = 0; index < 201; index++) { const item = await version(owned, `bounded-${String(index).padStart(3, '0')}`); if (!index) first = item.id; }
    const graph = await rebuildSkillGraph(f.store.db, owned);
    expect(graph.nodes).toHaveLength(200); expect(graph.truncated).toBe(true);
    expect((await readSkillGraph(f.store.db, owned)).truncated).toBe(true);
    expect(await relatedSkills(f.store.db, owned, [first])).toEqual({ skillIds: [], truncated: true, permissionsGranted: false });
  });

  it('fails closed when an edge cap could have hidden an explicitly declared conflict', async () => {
    const owned = owner(), targets = Array.from({ length: 12 }, (_, index) => `target-${index}`);
    for (const slug of targets) await version(owned, slug);
    let first = '';
    for (let index = 0; index < 52; index++) { const item = await version(owned, `dense-${index}`, { dependsOn: targets, conflicts: targets }); if (!index) first = item.id; }
    const graph = await rebuildSkillGraph(f.store.db, owned);
    expect(graph.edges).toHaveLength(1200); expect(graph.truncated).toBe(true);
    expect((await readSkillGraph(f.store.db, owned)).truncated).toBe(true);
    expect(await relatedSkills(f.store.db, owned, [first])).toEqual({ skillIds: [], truncated: true, permissionsGranted: false });
  });

  it('requires completed child evidence, retains historical provenance and caps total versions including history', async () => {
    // Controlled scheduler fixture: a stored result is not graph evidence until
    // the separate task completion and scheduler reconciliation both agree.
    const skill = await f.version(toolContract('historic-outcome-fixture')), parent = await f.parent(singlePlan(skill.id));
    const pending = await f.scheduler.runSkillGraph(parent.input, parent.context);
    const child = await f.child(pending.runId, 'main.search'), claim = await f.scheduler.claimNode(child.binding, child.context);
    const result = await f.scheduler.recordNodeResult(claim, { outcome: 'succeeded', outputs: { answer: 'Controlled outcome fixture.' } });
    expect((await rebuildSkillGraph(f.store.db, f.owner)).nodes.some(node => node.kind === 'outcome')).toBe(false);
    await f.store.db.updateTable('tasks').set({ status: 'completed', result: JSON.stringify(result) }).where('id', '=', child.context.taskId).execute();
    await f.scheduler.runSkillGraph(parent.input, parent.context);
    const proven = await rebuildSkillGraph(f.store.db, f.owner);
    expect(proven.nodes).toContainEqual(expect.objectContaining({ kind: 'outcome', receiptId: claim.evidenceId, scope: 'step' }));
    expect(proven.edges).toContainEqual(expect.objectContaining({ relation: 'verified_outcome', provenance: 'verified_receipt' }));
    await f.store.db.updateTable('skill_run_nodes').set({ lease_token: randomUUID() }).where('run_id', '=', pending.runId).where('node_id', '=', 'main.search').execute();
    expect((await readSkillGraph(f.store.db, f.owner)).nodes.some(node => node.kind === 'outcome')).toBe(false);
    await f.store.db.updateTable('skill_run_nodes').set({ lease_token: claim.nodeLeaseToken }).where('run_id', '=', pending.runId).where('node_id', '=', 'main.search').execute();
    expect((await readSkillGraph(f.store.db, f.owner)).nodes.some(node => node.kind === 'outcome')).toBe(true);
    const originalEvidence = await f.store.db.selectFrom('skill_evidence').select('details').where('id', '=', claim.evidenceId).executeTakeFirstOrThrow();
    // A forged mapped wrapper cannot relabel research.run as browser.open,
    // even when its raw-result and projection hashes are internally consistent.
    await f.store.db.updateTable('tasks').set({ capability_id: 'browser.open' }).where('id', '=', child.context.taskId).execute();
    await f.store.db.updateTable('skill_evidence').set({ details: JSON.stringify([{ kind: 'runtime.verified', data: { taskId: child.context.taskId, tool: 'research.run', rawResult: result, resultHash: sha256(canonicalSkillEvidenceJson(result)), projectionHash: result!.outputHash } }]) }).where('id', '=', claim.evidenceId).execute();
    expect((await readSkillGraph(f.store.db, f.owner)).nodes.some(node => node.kind === 'outcome')).toBe(false);
    await f.store.db.updateTable('tasks').set({ capability_id: 'skill.node' }).where('id', '=', child.context.taskId).execute();
    await f.store.db.updateTable('skill_evidence').set({ details: JSON.stringify(originalEvidence.details) }).where('id', '=', claim.evidenceId).execute();
    expect((await readSkillGraph(f.store.db, f.owner)).nodes.some(node => node.kind === 'outcome')).toBe(true);
    await f.store.db.updateTable('skill_versions').set({ status: 'revoked' }).where('id', '=', skill.id).execute();
    await f.store.db.updateTable('skill_families').set({ active_version_id: null }).where('active_version_id', '=', skill.id).execute();
    const historical = await rebuildSkillGraph(f.store.db, f.owner);
    expect(historical.nodes).toContainEqual(expect.objectContaining({ key: `skill:${skill.id}`, kind: 'skill', active: false, routingEligible: false }));
    expect(historical.nodes.some(node => node.kind === 'outcome')).toBe(true);
    expect((await relatedSkills(f.store.db, f.owner, [skill.id])).skillIds).toEqual([]);
    for (let index = 0; index < 200; index++) await version(f.owner, `history-cap-${String(index).padStart(3, '0')}`);
    const capped = await rebuildSkillGraph(f.store.db, f.owner);
    expect(capped.nodes.filter(node => node.kind === 'skill')).toHaveLength(200);
    expect(capped.nodes.some(node => node.kind === 'outcome')).toBe(false);
    expect(capped.truncated).toBe(true);
    expect((await readSkillGraph(f.store.db, f.owner)).truncated).toBe(true);
  });

  it('accepts no client evidence, grant flags or oversized traversal parameters', () => {
    expect(SkillGraphQuerySchema.safeParse({ enabled: true }).success).toBe(false);
    for (const raw of [{ depth: 3 }, { depth: -1 }, { limit: 25 }, { limit: 0 }, { evidence: 'verified' }]) expect(SkillGraphRelatedQuerySchema.safeParse(raw).success).toBe(false);
    expect(SkillGraphSnapshotSchema.safeParse({ nodes: [], edges: [], permissionsGranted: true }).success).toBe(false);
  });
});
