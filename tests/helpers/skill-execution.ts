import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '@mohassan/database';
import { SkillContractSchema, SkillRunInputSchema, type SkillContract, type SkillNodeBinding } from '@mohassan/contracts';
import { createSkillControl, createSkillScheduler, hashSkillData, sha256, skillContentHash, skillsMigration } from '@mohassan/skills';
import { migrateAuth } from '../../apps/server/src/auth.ts';
import type { Kysely } from 'kysely';

export async function executionFixture() {
  const store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await skillsMigration(store.db);
  const owner = `execution-${randomUUID()}`;
  await store.db.insertInto('user').values({ id: owner, name: 'Execution fixture', email: `${owner}@example.test` }).execute();
  const skills = createSkillControl(store.db, { executableReady: async () => true, environment: () => ({ modelReady: true, visionReady: true, executableReady: true, capabilities: [{ id: 'browser.research', name: 'Fixture research', description: 'Fixture only', version: '1.0.0', risk: 'low', status: 'active', requiredScopes: ['research:read'] }] }) });
  // Scheduler-only fixtures use manual task rows; full Runtime tests exercise real approval SQL.
  const validateParentAuthority = async (_tx: Kysely<any>, parent: any) => parent.owner_id === owner && Boolean(parent.workflow_token);
  const scheduler = createSkillScheduler(store.db, { validateComposition: skills.validateComposition, validateParentAuthority });
  async function version(raw: unknown) {
    const contract = SkillContractSchema.parse(raw), id = randomUUID(), family = randomUUID(), instructions = 'Safe fixture guidance.';
    const hash = skillContentHash(contract, [{ path: 'SKILL.md', content: instructions }]);
    await store.db.insertInto('skill_families').values({ id: family, owner_id: owner, slug: contract.slug }).execute();
    await store.db.insertInto('skill_versions').values({ id, family_id: family, owner_id: owner, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'custom', status: 'quarantined', contract: JSON.stringify(contract), content_hash: hash }).execute();
    await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content: instructions, content_hash: sha256(instructions), size_bytes: Buffer.byteLength(instructions) }).execute();
    const inspected = await skills.inspect(owner, id, { expectedRevision: 1 });
    const active = await skills.activate(owner, id, { expectedRevision: inspected.skill.revision, approve: true, acknowledgeFindings: true });
    if (contract.requires.tools.length || contract.requires.scopes.length) await skills.createGrant(owner, id, { expectedRevision: active.skill.revision, approve: true, tools: contract.requires.tools, scopes: contract.requires.scopes, durationHours: 1 });
    return { id, contract, hash };
  }
  async function insertTask(tx: Kysely<any>, id: string, capability: string, status: string, extras: Record<string, unknown> = {}) {
    await tx.insertInto('tasks').values({ id, owner_id: owner, title: 'Fixture task', goal: 'Review bounded fixture evidence', capability_id: capability, capability_version: '1.0.0', autonomy: 'scoped', status, input_hash: sha256(id), idempotency_key: `fixture:${id}`, attempt: 1, max_attempts: 3, lease_token: null, lease_expires_at: null, cancellation_requested: false, approval_required: false, event_sequence: 0, result: null, error: null, ...extras }).execute();
  }
  async function parent(input: unknown) {
    const parsed = SkillRunInputSchema.parse(input), id = randomUUID(), leaseToken = randomUUID();
    await insertTask(store.db, id, 'skill.run', 'running', { skill_input: JSON.stringify(parsed), lease_token: leaseToken, lease_expires_at: new Date(Date.now() + 60000), workflow_token: randomUUID() });
    const context = { taskId: id, ownerId: owner, leaseToken, signal: new AbortController().signal, dispatchChild: async (tx: Kysely<any>, spec: any) => {
      const childId = randomUUID();
      await insertTask(tx, childId, 'skill.node', 'queued', { skill_binding: JSON.stringify(spec.binding), idempotency_key: spec.idempotencyKey, input_hash: hashSkillData(spec) });
      return { id: childId };
    } };
    return { id, input: parsed, context };
  }
  async function child(runId: string, nodeId: string) {
    const stored = await scheduler.readNode(store.db, owner, runId, nodeId);
    if (!stored?.binding) throw new Error('Missing fixture binding');
    const leaseToken = randomUUID();
    await store.db.updateTable('tasks').set({ status: 'running', lease_token: leaseToken, lease_expires_at: new Date(Date.now() + 60000) }).where('id', '=', stored.node.child_task_id).execute();
    return { binding: stored.binding as SkillNodeBinding, context: { ownerId: owner, taskId: stored.node.child_task_id as string, leaseToken } };
  }
  return { store, owner, skills, scheduler, version, parent, child, validateParentAuthority };
}
export const toolContract = (slug = `fixture-${randomUUID().slice(0, 8)}`): SkillContract => SkillContractSchema.parse({
  slug, name: 'Bounded research fixture', description: 'Read fixture evidence without a live external service.', category: 'research', version: '1.0.0', level: 'tool',
  inputs: [{ name: 'query', type: 'string', description: 'Requested evidence' }], outputs: [{ name: 'answer', type: 'string', description: 'Verified answer' }],
  requires: { tools: ['research.run'], scopes: ['research:read'] }, sideEffects: 'read', verification: 'Verify the local fixture receipt.',
  steps: [{ id: 'search', kind: 'tool', title: 'Read fixture', tool: 'research.run', inputs: { query: 'input.query' }, outputs: [{ name: 'answer', type: 'string', description: 'Verified answer' }] }],
});
export const singlePlan = (id: string) => ({ plan: { inputs: [{ name: 'query', type: 'string', description: 'Query' }], nodes: [{ id: 'main', skillId: id, inputs: { query: 'input.query' } }] }, values: { query: 'Owned fixture evidence' } });
