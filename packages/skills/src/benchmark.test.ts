import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { SkillContractSchema } from '@mohassan/contracts';
import { SkillBenchmarkCaseResultSchema, SkillBenchmarkRequestSchema, SkillBenchmarkSuiteSchema, type SkillBenchmarkCaseResult } from '../../contracts/src/skill-benchmarks.js';
import { createSkillBenchmarkControl, benchmarkPinsCurrent, type SkillBenchmarkOptions, type SkillBenchmarkRunner } from './benchmark.ts';
import { skillBenchmarkDefinition } from './benchmark-suites.ts';
import { skillsMigration } from './migration.ts';
import { createSkillControl } from './index.ts';
import { sha256, skillContentHash } from './hash.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
const controls: ReturnType<typeof createSkillBenchmarkControl>[] = [];
beforeAll(async () => { store = await createDatabase(); await migrate(store.db); await skillsMigration(store.db); });
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.shutdown())); });
afterAll(async () => { await store?.close(); });
const suite = SkillBenchmarkSuiteSchema.parse(skillBenchmarkDefinition('instruction-delivery-v1'));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const makeControl = (runner: SkillBenchmarkRunner, options: Partial<SkillBenchmarkOptions> = {}) => {
  const control = createSkillBenchmarkControl(store.db, { suite: () => suite, runner, ...options }); controls.push(control); return control;
};
async function fixture() {
  const owner = randomUUID(), skills = createSkillControl(store.db);
  const version = async (slug: string) => {
    const id = randomUUID(), familyId = randomUUID(), content = 'Controlled instruction fixture; no execution or model call.';
    const contract = SkillContractSchema.parse({ slug, name: slug, description: 'Measured controller fixture.', category: 'research', version: '1.0.0', level: 'instruction' });
    await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug }).execute();
    await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, version: contract.version, sequence: 1, name: slug, description: contract.description, category: contract.category, level: contract.level, origin: 'custom', status: 'quarantined', contract: JSON.stringify(contract), content_hash: skillContentHash(contract, [{ path: 'SKILL.md', content }]) }).execute();
    await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content, content_hash: sha256(content), size_bytes: Buffer.byteLength(content) }).execute();
    return (await skills.inspect(owner, id, { expectedRevision: 1 })).skill;
  };
  const baseline = await version('benchmark-baseline'), candidate = await version('benchmark-candidate');
  return { owner, skills, baseline, candidate, request: { baselineId: baseline.id, baselineRevision: baseline.revision, candidateId: candidate.id, candidateRevision: candidate.revision, suiteId: suite.id } };
}
// These are controlled controller-level measurements. Actual Runtime, file,
// rollback and killed-worker oracles are exercised by the server runner tests.
function result(input: Parameters<SkillBenchmarkRunner['execute']>[0], index = 0): SkillBenchmarkCaseResult {
  const item = input.suite.cases[index], now = new Date().toISOString(), outputHash = sha256(input.snapshot.files[0].content);
  return SkillBenchmarkCaseResultSchema.parse({ caseId: item.id, arm: input.arm, split: item.split, scope: input.suite.scope, status: 'passed', reasonCode: null,
    sourceVersionId: input.snapshot.pin.versionId, sourceContentHash: input.snapshot.pin.contentHash, suiteHash: input.suite.suiteHash, configHash: input.suite.configHash, verifierVersion: input.suite.verifierVersion,
    inputsHash: item.fixtureHash, outputHash, startedAt: now, finishedAt: now, durationMs: 0,
    metrics: { success: true, verification: true, safety: true, recovery: null, costUsd: 0 }, notApplicable: ['recovery'], usage: { inputTokens: 0, outputTokens: 0 }, evidenceScope: 'isolated_experiment',
    evidence: [{ kind: 'instruction_context', inputsHash: item.fixtureHash, outputHash, verifiedAt: now }] });
}
const complete = () => ({ execute: vi.fn<SkillBenchmarkRunner['execute']>(async (input, onCase) => { for (let i = 0; i < input.suite.cases.length; i++) await onCase(result(input, i)); }) });

describe('durable trusted skill benchmark controller', () => {
  it('pins paired sources, saves bounded isolated evidence, and leaves lifecycle and grants unchanged', async () => {
    const f = await fixture(), runner = complete(), control = makeControl(runner);
    const evaluation = await control.execute(f.owner, f.request, randomUUID());
    expect(evaluation.status).toBe('completed'); expect(evaluation.cases).toHaveLength(suite.cases.length * 2); expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(evaluation).toMatchObject({ evidenceScope: 'isolated_experiment', baseline: { versionId: f.baseline.id, revision: f.baseline.revision }, candidate: { versionId: f.candidate.id } });
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.status).toBe('inspected');
    expect(await store.db.selectFrom('skill_grants').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('tasks').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
    expect(JSON.stringify(evaluation)).not.toContain('Controlled instruction fixture');
    expect(await benchmarkPinsCurrent(store.db, f.owner, evaluation)).toBe(true);
  });
  it('deduplicates concurrent identical requests and retains historical idempotency after revocation', async () => {
    const f = await fixture(), runner = complete(), control = makeControl(runner), key = randomUUID();
    const [a, b] = await Promise.all([control.execute(f.owner, f.request, key), control.execute(f.owner, f.request, key)]);
    expect(a.id).toBe(b.id); expect(runner.execute).toHaveBeenCalledTimes(2);
    await store.db.updateTable('skill_versions').set({ status: 'revoked', revision: f.candidate.revision + 1 }).where('id', '=', f.candidate.id).execute();
    expect((await control.execute(f.owner, f.request, key)).status).toBe('completed'); expect(runner.execute).toHaveBeenCalledTimes(2);
    await expect(control.start(f.owner, { ...f.request, candidateRevision: f.candidate.revision + 1 }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('enforces one active experiment per owner without silently retrying unknown work', async () => {
    const f = await fixture(), entered = deferred();
    const runner = { execute: vi.fn<SkillBenchmarkRunner['execute']>(async input => { entered.resolve(); await new Promise<void>((_done, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); }) };
    const control = makeControl(runner), key = randomUUID(), first = await control.start(f.owner, f.request, key); await entered.promise;
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_BENCHMARK_BUSY' });
    expect((await control.start(f.owner, f.request, key)).id).toBe(first.id);
    await control.shutdown(); expect((await control.get(f.owner, first.id)).status).toBe('unknown'); expect(runner.execute).toHaveBeenCalledTimes(1);
    const next = makeControl(runner); expect((await next.execute(f.owner, f.request, key)).status).toBe('unknown'); expect(runner.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign', 'revision', 'inspection', 'tamper', 'revoked'] as const)('rejects %s source before calling the runner', async change => {
    const f = await fixture(), runner = complete(), control = makeControl(runner), request = { ...f.request };
    if (change === 'foreign') await store.db.updateTable('skill_versions').set({ owner_id: randomUUID() }).where('id', '=', f.candidate.id).execute();
    if (change === 'revision') request.candidateRevision++;
    if (change === 'inspection') await store.db.updateTable('skill_inspections').set({ inspector_version: 'obsolete-test-inspector' }).where('version_id', '=', f.candidate.id).execute();
    if (change === 'tamper') await store.db.updateTable('skill_files').set({ content: 'changed bytes' }).where('version_id', '=', f.candidate.id).execute();
    if (change === 'revoked') await store.db.updateTable('skill_versions').set({ status: 'revoked' }).where('id', '=', f.candidate.id).execute();
    await expect(control.start(f.owner, request, randomUUID())).rejects.toThrow(); expect(runner.execute).not.toHaveBeenCalled();
    expect(await store.db.selectFrom('skill_benchmark_runs').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
  });
  it('rejects client metrics and unbounded query data', async () => {
    const f = await fixture(), control = makeControl(complete());
    expect(SkillBenchmarkRequestSchema.safeParse({ ...f.request, results: [], approved: true }).success).toBe(false);
    await expect(control.list(f.owner, { limit: 51 })).rejects.toThrow(); await expect(control.list(f.owner, { ownerId: 'other' })).rejects.toThrow();
  });
  it.each(['wrong_source', 'wrong_proof', 'wrong_proof_hash', 'incomplete', 'conflicting_duplicate'] as const)('fails closed for %s result evidence', async change => {
    const f = await fixture();
    const runner: SkillBenchmarkRunner = { execute: async (input, onCase) => {
      const value = result(input);
      if (change === 'wrong_source') value.sourceContentHash = sha256('different source');
      if (change === 'wrong_proof') value.evidence[0].kind = 'file_observation';
      if (change === 'wrong_proof_hash') value.evidence[0].outputHash = sha256('different output');
      await onCase(value);
      if (change === 'conflicting_duplicate') await onCase({ ...value, durationMs: 1 });
    } };
    const value = await makeControl(runner).execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('unknown');
    expect(value.cases.length).toBe(change === 'incomplete' ? 2 : change === 'conflicting_duplicate' ? 1 : 0);
  });
  it('keeps accepted partial evidence when a trusted runner fails and does not expose its raw error', async () => {
    const f = await fixture(), runner = { execute: vi.fn<SkillBenchmarkRunner['execute']>(async (input, onCase) => { await onCase(result(input)); throw new Error('PRIVATE_ERROR_CONTENT'); }) };
    const control = makeControl(runner), key = randomUUID(), value = await control.execute(f.owner, f.request, key);
    expect(value).toMatchObject({ status: 'unknown', errorCode: 'SKILL_BENCHMARK_INTERRUPTED' }); expect(value.cases).toHaveLength(1);
    expect(JSON.stringify(value)).not.toContain('PRIVATE_ERROR_CONTENT'); await control.execute(f.owner, f.request, key); expect(runner.execute).toHaveBeenCalledTimes(1);
  });
  it('fences late results after durable lease recovery without dispatching another attempt', async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const runner = { execute: vi.fn<SkillBenchmarkRunner['execute']>(async (input, onCase) => { entered.resolve(); await release.promise; await onCase(result(input)); }) };
    const control = makeControl(runner), key = randomUUID(), first = await control.start(f.owner, f.request, key); await entered.promise;
    await store.db.updateTable('skill_benchmark_runs').set({ lease_expires_at: new Date(0) }).where('id', '=', first.id).execute();
    expect((await control.get(f.owner, first.id)).status).toBe('unknown');
    expect((await store.db.selectFrom('skill_benchmark_runs').select('status').where('id', '=', first.id).executeTakeFirstOrThrow()).status).toBe('running');
    expect(await control.recoverExpired()).toBe(1); release.resolve(); await control.shutdown();
    const value = await control.get(f.owner, first.id); expect(value.status).toBe('unknown'); expect(value.cases).toEqual([]); expect(runner.execute).toHaveBeenCalledTimes(1);
  });
  it('rolls back completion and its callback writes when shutdown arrives during finalization', async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    const control = makeControl(complete(), { onCompleted: async (tx, owner, evaluation) => {
      await tx.insertInto('skill_audit').values({ id: randomUUID(), owner_id: owner, target_id: evaluation.id, event: 'fixture.must_rollback', detail: '{}' }).execute(); entered.resolve(); await release.promise;
    } });
    const running = control.execute(f.owner, f.request, randomUUID()); await entered.promise;
    const stopping = control.shutdown(); release.resolve(); const value = await running; await stopping;
    expect(value.status).toBe('unknown'); expect(value.errorCode).toBe('SKILL_BENCHMARK_ABORTED');
    expect(await store.db.selectFrom('skill_audit').select('id').where('target_id', '=', value.id).where('event', 'in', ['fixture.must_rollback', 'skill.benchmark_completed']).execute()).toEqual([]);
  });
  it('does not launch a runner when shutdown begins before the start transaction commits', async () => {
    const f = await fixture(), runner = complete(); let stopping: Promise<void> | undefined;
    const control = makeControl(runner, { suite: () => { stopping = control.shutdown(); return suite; } });
    const value = await control.start(f.owner, f.request, randomUUID()); await stopping;
    expect(value.status).toBe('unknown'); expect(value.errorCode).toBe('SKILL_BENCHMARK_ABORTED'); expect(runner.execute).not.toHaveBeenCalled();
  });
  it('does not publish a completion whose lease expired during the final callback', async () => {
    const f = await fixture();
    const control = makeControl(complete(), { onCompleted: async (tx, _owner, evaluation) => {
      await tx.updateTable('skill_benchmark_runs').set({ lease_expires_at: new Date(0) }).where('id', '=', evaluation.id).execute();
    } });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('unknown');
    expect(await store.db.selectFrom('skill_audit').select('id').where('target_id', '=', value.id).where('event', '=', 'skill.benchmark_completed').execute()).toEqual([]);
  });
  it('uses wall-clock lease validity while a long transaction blocks heartbeat renewal', async () => {
    const f = await fixture(), finalized = vi.fn(async () => { await new Promise(done => setTimeout(done, 450)); });
    const control = makeControl(complete(), { leaseMs: 300, timeoutMs: 3000, onCompleted: finalized });
    const value = await control.execute(f.owner, f.request, randomUUID());
    expect(finalized).toHaveBeenCalledTimes(1); expect(value.status).toBe('unknown');
    expect(await store.db.selectFrom('skill_audit').select('id').where('target_id', '=', value.id).where('event', '=', 'skill.benchmark_completed').execute()).toEqual([]);
  });
  it('bounds retained experiments without deleting history', async () => {
    const f = await fixture(), control = makeControl(complete()), first = await control.execute(f.owner, f.request, randomUUID());
    const original = await store.db.selectFrom('skill_benchmark_runs').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow();
    await store.db.insertInto('skill_benchmark_runs').values(Array.from({ length: 499 }, () => ({ ...original, id: randomUUID(), idempotency_key: randomUUID() }))).execute();
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_BENCHMARK_QUOTA' });
    expect((await control.list(f.owner, { limit: 1 })).total).toBe(500);
  });
  it('checks owned immutable history and never repairs damaged saved evidence during reads', async () => {
    const f = await fixture(), control = makeControl(complete()), value = await control.execute(f.owner, f.request, randomUUID());
    await expect(control.get(randomUUID(), value.id)).rejects.toMatchObject({ code: 'SKILL_BENCHMARK_NOT_FOUND' });
    expect((await control.list(randomUUID())).items).toEqual([]); expect((await control.list(f.owner, { versionId: f.candidate.id })).total).toBe(1);
    await store.db.updateTable('skill_benchmark_runs').set({ results: '[]' }).where('id', '=', value.id).execute();
    await expect(control.get(f.owner, value.id)).rejects.toMatchObject({ code: 'SKILL_BENCHMARK_INTEGRITY_FAILED' });
    expect((await store.db.selectFrom('skill_benchmark_runs').select('results').where('id', '=', value.id).executeTakeFirstOrThrow()).results).toEqual([]);
  });
  it('separates mutable lifecycle revisions from current immutable promotion evidence', async () => {
    const f = await fixture(), control = makeControl(complete()), value = await control.execute(f.owner, f.request, randomUUID());
    await store.db.updateTable('skill_versions').set({ status: 'deprecated', revision: f.candidate.revision + 2 }).where('id', '=', f.candidate.id).execute();
    expect(await benchmarkPinsCurrent(store.db, f.owner, value)).toBe(true);
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT' });
    expect((await control.execute(f.owner, { ...f.request, candidateRevision: f.candidate.revision + 2 }, randomUUID())).status).toBe('completed');
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.status).toBe('deprecated');
    await store.db.updateTable('skill_versions').set({ status: 'revoked' }).where('id', '=', f.candidate.id).execute();
    expect(await benchmarkPinsCurrent(store.db, f.owner, value)).toBe(false); expect((await control.get(f.owner, value.id)).status).toBe('completed');
  });
});
