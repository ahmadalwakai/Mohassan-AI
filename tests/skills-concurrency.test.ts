import { afterEach, describe, expect, it } from 'vitest';
import { createSkillScheduler, sha256 } from '@mohassan/skills';
import { executionFixture, singlePlan, toolContract } from './helpers/skill-execution.ts';

let fixture: Awaited<ReturnType<typeof executionFixture>> | undefined;
afterEach(async () => { await fixture?.store.close(); fixture = undefined; });
describe('skill scheduler concurrency on an isolated database', () => {
  it('two scheduler instances enqueue and claim exactly one task and receipt for one node', async () => {
    fixture = await executionFixture(); const f = fixture, second = createSkillScheduler(f.store.db, { validateComposition: f.skills.validateComposition, validateParentAuthority: f.validateParentAuthority });
    const version = await f.version(toolContract()), parent = await f.parent(singlePlan(version.id));
    const results = await Promise.all([f.scheduler, second].map(scheduler => scheduler.runSkillGraph(parent.input, parent.context)));
    expect(new Set(results.map(result => result.runId)).size).toBe(1);
    expect(await f.store.db.selectFrom('skill_run_nodes').select('child_task_id').execute()).toHaveLength(1);
    const child = await f.child(results[0].runId, 'main.search');
    const claimed = await Promise.allSettled([f.scheduler, second].map(scheduler => scheduler.claimNode(child.binding, child.context)));
    expect(claimed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.store.db.selectFrom('skill_evidence').select('id').execute()).toHaveLength(1);
  });
  it.each(['succeeded', 'unknown'] as const)('uses a database resource lock and %s releases only a successful owner', async outcome => {
    fixture = await executionFixture(); const f = fixture;
    const version = await f.version(toolContract());
    const parents = await Promise.all([1, 2].map(() => f.parent(singlePlan(version.id))));
    const runs = await Promise.all(parents.map(parent => f.scheduler.runSkillGraph(parent.input, parent.context)));
    const children = await Promise.all(runs.map(run => f.child(run.runId, 'main.search')));
    const claims = await Promise.all(children.map(child => f.scheduler.claimNode(child.binding, child.context)));
    const resource = sha256('same canonical fixture path');
    await f.scheduler.acquireNodeResource(claims[0], resource);
    await f.scheduler.acquireNodeResource(claims[0], resource);
    await expect(f.scheduler.acquireNodeResource(claims[1], resource)).rejects.toMatchObject({ code: 'SKILL_RESOURCE_BUSY' });
    await f.scheduler.recordNodeResult(claims[0], { outcome, ...(outcome === 'succeeded' ? { outputs: { answer: 'Verified' } } : {}) });
    if (outcome === 'succeeded') await expect(f.scheduler.acquireNodeResource(claims[1], resource)).resolves.toBeUndefined();
    else await expect(f.scheduler.acquireNodeResource(claims[1], resource)).rejects.toMatchObject({ code: 'SKILL_RESOURCE_BUSY' });
  });
});
