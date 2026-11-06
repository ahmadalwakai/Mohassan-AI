import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { SkillBenchmarkCaseResultSchema, SkillBenchmarkSuiteSchema, type SkillBenchmarkSuite } from '../../contracts/src/skill-benchmarks.ts';
import { createSkillControl } from './index.ts';
import { createSkillLifecycle } from './lifecycle.ts';
import { createSkillRegistry } from './registry.ts';
import { createSkillBenchmarkControl, type SkillBenchmarkRunner } from './benchmark.ts';
import { skillBenchmarkDefinition } from './benchmark-suites.ts';
import { canonicalSkillEvidenceJson } from './evidence.ts';
import { sha256, skillContentHash } from './hash.ts';
import { skillsMigration } from './migration.ts';
import { createSkillBenchmarkRunner } from '../../../apps/server/src/skill-benchmark-runner.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
const controls: ReturnType<typeof createSkillBenchmarkControl>[] = [];
beforeAll(async () => { store = await createDatabase(); await migrate(store.db); await skillsMigration(store.db); });
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.shutdown())); });
afterAll(async () => { await store?.close(); });
const definition = () => SkillBenchmarkSuiteSchema.parse(skillBenchmarkDefinition('instruction-delivery-v1'));
const digest = (value: unknown) => sha256(canonicalSkillEvidenceJson(value));

// Controller-level proof fixtures exercise the activation policy. One acceptance
// test below uses the real isolated instruction runner instead of this double.
function measuredRunner(failure = false): SkillBenchmarkRunner {
  return { async execute(input, onCase) {
    for (const item of input.suite.cases) {
      const failed = failure && input.arm === 'candidate' && item.split === 'holdout', now = new Date().toISOString(), outputHash = sha256(input.snapshot.files[0].content);
      await onCase(SkillBenchmarkCaseResultSchema.parse({ caseId: item.id, arm: input.arm, split: item.split, scope: input.suite.scope, status: failed ? 'failed' : 'passed', reasonCode: failed ? 'CONTROLLED_REGRESSION' : null,
        sourceVersionId: input.snapshot.pin.versionId, sourceContentHash: input.snapshot.pin.contentHash, suiteHash: input.suite.suiteHash, configHash: input.suite.configHash, verifierVersion: input.suite.verifierVersion,
        inputsHash: item.fixtureHash, outputHash, startedAt: now, finishedAt: now, durationMs: 1, evidenceScope: 'isolated_experiment',
        metrics: { success: !failed, verification: !failed, safety: true, recovery: null, costUsd: null }, notApplicable: ['recovery'], usage: { inputTokens: 0, outputTokens: 0 },
        evidence: [{ kind: 'instruction_context', inputsHash: item.fixtureHash, outputHash, verifiedAt: now }] }));
    }
  } };
}
async function fixture(options: { fork?: boolean; builtin?: boolean; lineage?: boolean } = {}) {
  const owner = randomUUID(), skills = createSkillControl(store.db);
  async function insert(slug: string, options: { familyId?: string; origin?: 'custom' | 'forge'; version?: string; overrides?: Partial<SkillContract>; extraFiles?: { path: string; kind: string; content: string }[] } = {}) {
    const id = randomUUID(), familyId = options.familyId ?? randomUUID(), text = `Bounded instruction source for ${slug}, version ${options.version ?? '1.0.0'}.`;
    const contract = SkillContractSchema.parse({ slug, name: slug, description: 'Pinned source for independent promotion checks.', category: 'research', level: 'instruction', version: options.version ?? '1.0.0', ...options.overrides });
    if (!options.familyId) await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug }).execute();
    const previous = await store.db.selectFrom('skill_versions').select('sequence').where('family_id', '=', familyId).orderBy('sequence', 'desc').executeTakeFirst();
    const files = [{ path: 'SKILL.md', kind: 'instructions', content: text }, ...options.extraFiles ?? []];
    const contentHash = skillContentHash(contract, files);
    await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, sequence: (previous?.sequence ?? 0) + 1, version: contract.version,
      name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: options.origin ?? 'custom', status: 'quarantined', contract: JSON.stringify(contract), content_hash: contentHash }).execute();
    await store.db.insertInto('skill_files').values(files.map(file => ({ version_id: id, ...file, content_hash: sha256(file.content), size_bytes: Buffer.byteLength(file.content) }))).execute();
    return { ...(await skills.inspect(owner, id, { expectedRevision: 1 })).skill, contract };
  }
  const baseline = await insert('promotion-base');
  if (options.builtin) await store.db.insertInto('skill_sources').values({ version_id: baseline.id, kind: 'builtin', locator: 'builtin:controlled-fixture', file_count: 1, total_bytes: 1 }).execute();
  await skills.activate(owner, baseline.id, { expectedRevision: baseline.revision, approve: true, acknowledgeFindings: true });
  const currentBase = (await skills.detail(owner, baseline.id)).skill;
  const candidate = await insert(options.fork ? 'promotion-fork' : baseline.slug, { familyId: options.fork ? undefined : baseline.familyId, version: options.fork ? '1.0.0' : '1.0.1', origin: 'forge' });
  const generationId = randomUUID(), inspection = await store.db.selectFrom('skill_inspections').selectAll().where('version_id', '=', baseline.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  const baselinePin = { versionId: baseline.id, revision: currentBase.revision, contentHash: baseline.contentHash, inspectionId: inspection.id, inspectorVersion: inspection.inspector_version };
  if (options.lineage !== false) await store.db.insertInto('skill_forge_generations').values({ id: generationId, owner_id: owner, baseline_id: baseline.id, baseline_pin: JSON.stringify(baselinePin), candidate_id: candidate.id, candidate_content_hash: candidate.contentHash,
    status: 'succeeded', mode: options.fork ? 'fork' : 'mutate', target_slug: candidate.slug, target_version: candidate.version, target_family_id: candidate.familyId,
    pins_hash: digest({ baseline: baselinePin, mode: options.fork ? 'fork' : 'mutate', targetSlug: candidate.slug, targetVersion: candidate.version, failureAnalysis: null }),
    lineage_hash: digest({ candidateId: candidate.id, candidateContentHash: candidate.contentHash, targetFamilyId: candidate.familyId }),
    request_hash: sha256(generationId), prompt_hash: sha256('controlled-fixture'), response_hash: sha256('controlled-output'), model: 'fixture-only', usage: null,
    run_token: randomUUID(), call_token: randomUUID(), lease_expires_at: new Date(), finished_at: new Date(), idempotency_key: generationId }).execute();
  async function evaluate(runner: SkillBenchmarkRunner = measuredRunner(), suite: SkillBenchmarkSuite = definition(), baselineId = baseline.id, candidateId = candidate.id) {
    const b = (await skills.detail(owner, baselineId)).skill, c = (await skills.detail(owner, candidateId)).skill;
    const control = createSkillBenchmarkControl(store.db, { runner, suite: () => suite }); controls.push(control);
    const result = await control.execute(owner, { baselineId, baselineRevision: b.revision, candidateId, candidateRevision: c.revision, suiteId: suite.id }, randomUUID());
    expect(result.status).toBe('completed'); return result;
  }
  async function activate(evaluationId?: string) {
    const current = (await skills.detail(owner, candidate.id)).skill;
    return skills.activate(owner, candidate.id, { expectedRevision: current.revision, approve: true, acknowledgeFindings: true, ...(evaluationId ? { evaluationId } : {}) });
  }
  return { owner, skills, baseline: currentBase, candidate, generationId, baselinePin, insert, evaluate, activate };
}

describe('mandatory Forge lifecycle promotion policy', () => {
  it('denies ordinary activate without an explicit evaluation and without lifecycle side effects', async () => {
    const f = await fixture(); const before = await f.skills.detail(f.owner, f.candidate.id);
    await expect(f.activate()).rejects.toMatchObject({ code: 'SKILL_FORGE_EVALUATION_REQUIRED' });
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill).toEqual(before.skill);
    expect((await f.skills.detail(f.owner, f.baseline.id)).skill.active).toBe(true);
  });
  it('requires approve:true even with a passing saved evaluation', async () => {
    const f = await fixture(), evaluation = await f.evaluate();
    await expect(f.skills.activate(f.owner, f.candidate.id, { expectedRevision: f.candidate.revision, evaluationId: evaluation.id, acknowledgeFindings: true })).rejects.toThrow();
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.active).toBe(false);
  });
  it('cannot bypass the gate by constructing lifecycle directly without optional callbacks', async () => {
    const f = await fixture(), registry = createSkillRegistry(store.db), lifecycle = createSkillLifecycle(store.db, { audit: registry.audit, executableReady: async () => true });
    await expect(lifecycle.activate(f.owner, f.candidate.id, { expectedRevision: f.candidate.revision, approve: true })).rejects.toMatchObject({ code: 'SKILL_FORGE_EVALUATION_REQUIRED' });
  });
  it.each(['missing', 'unfinished', 'wrong_hash', 'wrong_family', 'wrong_baseline'] as const)('rejects %s lineage despite a passing benchmark', async change => {
    const f = await fixture({ lineage: change !== 'missing' }), evaluation = await f.evaluate();
    if (change === 'unfinished') await store.db.updateTable('skill_forge_generations').set({ status: 'unknown' }).where('id', '=', f.generationId).execute();
    if (change === 'wrong_hash') await store.db.updateTable('skill_forge_generations').set({ candidate_content_hash: sha256('different') }).where('id', '=', f.generationId).execute();
    if (change === 'wrong_family') { const unrelated = await f.insert('unrelated-family'); await store.db.updateTable('skill_forge_generations').set({ target_family_id: unrelated.familyId }).where('id', '=', f.generationId).execute(); }
    if (change === 'wrong_baseline') await store.db.updateTable('skill_forge_generations').set({ baseline_pin: JSON.stringify({ ...f.baselinePin, contentHash: sha256('different') }) }).where('id', '=', f.generationId).execute();
    await expect(f.activate(evaluation.id)).rejects.toBeInstanceOf(Error);
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.active).toBe(false);
  });
  it.each(['foreign', 'other_candidate', 'unrelated_baseline', 'corrupt_results'] as const)('rejects a %s evaluation', async change => {
    const f = await fixture(); let evaluation;
    if (change === 'foreign') { const other = await fixture(); evaluation = await other.evaluate(); }
    else if (change === 'other_candidate') { const other = await f.insert('other-candidate'); evaluation = await f.evaluate(measuredRunner(), definition(), f.baseline.id, other.id); }
    else if (change === 'unrelated_baseline') { const other = await f.insert('weak-unrelated-baseline'); evaluation = await f.evaluate(measuredRunner(), definition(), other.id); }
    else { evaluation = await f.evaluate(); await store.db.updateTable('skill_benchmark_runs').set({ results: '[]' }).where('id', '=', evaluation.id).execute(); }
    await expect(f.activate(evaluation.id)).rejects.toBeInstanceOf(Error);
  });
  it.each(['configHash', 'suiteHash', 'verifierVersion'] as const)('rejects a saved benchmark with an obsolete %s', async key => {
    const f = await fixture(), suite = definition(); suite[key] = key === 'verifierVersion' ? 'historical-verifier' : sha256(key);
    const evaluation = await f.evaluate(measuredRunner(), suite);
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_BENCHMARK_STALE' });
  });
  it('rejects measured holdout regressions rather than trusting a completed label', async () => {
    const f = await fixture(), evaluation = await f.evaluate(measuredRunner(true));
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_QUALITY_REJECTED' });
  });
  it('rechecks the baseline and current inspection after measurement', async () => {
    const f = await fixture(), evaluation = await f.evaluate();
    await store.db.updateTable('skill_inspections').set({ inspector_version: 'old-inspector' }).where('version_id', '=', f.baseline.id).execute();
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_PINS_STALE' });
  });
  it('rejects an intervening active version that was not the measured baseline', async () => {
    const f = await fixture(), evaluation = await f.evaluate(), intervening = await f.insert(f.baseline.slug, { familyId: f.baseline.familyId, version: '1.0.2' });
    await f.skills.activate(f.owner, intervening.id, { expectedRevision: intervening.revision, approve: true });
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_ACTIVE_CHANGED' });
    expect((await f.skills.detail(f.owner, intervening.id)).skill.active).toBe(true);
  });
  it('activates using real isolated instruction evidence and persists the reviewed scope without grants', async () => {
    const f = await fixture(), evaluation = await f.evaluate(createSkillBenchmarkRunner());
    const result = await f.activate(evaluation.id); expect(result.skill.active).toBe(true); expect((await f.skills.detail(f.owner, f.baseline.id)).skill.status).toBe('deprecated');
    const audit = await store.db.selectFrom('skill_audit').select('detail').where('owner_id', '=', f.owner).where('target_id', '=', f.candidate.id).where('event', '=', 'skill.forge_promoted').executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ evaluationId: evaluation.id, generationId: f.generationId, scope: 'instruction_delivery', approved: true, automaticPromotion: false, action: 'activate' });
    expect(await store.db.selectFrom('skill_grants').select('id').where('owner_id', '=', f.owner).execute()).toEqual([]);
  }, 60000);
  it('rechecks the same mandatory gate on rollback while allowing harmless lifecycle revision changes', async () => {
    const f = await fixture(), evaluation = await f.evaluate(); await f.activate(evaluation.id);
    const newer = await f.insert(f.baseline.slug, { familyId: f.baseline.familyId, version: '1.0.2' });
    await f.skills.activate(f.owner, newer.id, { expectedRevision: newer.revision, approve: true });
    const target = (await f.skills.detail(f.owner, f.candidate.id)).skill;
    await expect(f.skills.rollback(f.owner, target.id, { expectedRevision: target.revision, approve: true, reason: 'Explicit reviewed rollback.' })).rejects.toMatchObject({ code: 'SKILL_FORGE_EVALUATION_REQUIRED' });
    const restored = await f.skills.rollback(f.owner, target.id, { expectedRevision: target.revision, approve: true, reason: 'Explicit reviewed rollback.', evaluationId: evaluation.id });
    expect(restored.skill.active).toBe(true); expect(restored.skill.revision).toBeGreaterThan(evaluation.candidate.revision);
  });
  it('permits a new-family fork and never overwrites an existing active target', async () => {
    const f = await fixture({ fork: true, builtin: true }), evaluation = await f.evaluate(); await f.activate(evaluation.id);
    expect((await f.skills.detail(f.owner, f.baseline.id)).skill.active).toBe(true);
    const other = await fixture({ fork: true }), otherEvaluation = await other.evaluate();
    const existing = await other.insert(other.candidate.slug, { familyId: other.candidate.familyId, version: '1.0.1' });
    await other.skills.activate(other.owner, existing.id, { expectedRevision: existing.revision, approve: true });
    await expect(other.activate(otherEvaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_ACTIVE_CHANGED' });
  });
  it('does not permit a builtin mutation even with fabricated successful lineage', async () => {
    const f = await fixture({ builtin: true }), evaluation = await f.evaluate();
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_LINEAGE_INVALID' });
  });
  it('blocks a fork when its cross-family baseline was revoked before activation', async () => {
    const f = await fixture({ fork: true }), evaluation = await f.evaluate();
    const b = (await f.skills.detail(f.owner, f.baseline.id)).skill;
    await f.skills.revoke(f.owner, b.id, { expectedRevision: b.revision, reason: 'Revoked baseline before promotion.' });
    await expect(f.activate(evaluation.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_PINS_STALE' });
  });
  it('allows an explicit new-family fork of a non-builtin owned baseline', async () => {
    const f = await fixture({ fork: true }), evaluation = await f.evaluate();
    expect((await f.activate(evaluation.id)).skill.active).toBe(true);
    expect((await f.skills.detail(f.owner, f.baseline.id)).skill.active).toBe(true);
  });
  it('keeps generated executable activation blocked even if a caller supplies executableReady=true', async () => {
    const f = await fixture(), executable = await f.insert('generated-script', { origin: 'forge', overrides: { level: 'executable', steps: [{ id: 'run', kind: 'script', title: 'Isolated script', entry: 'main.mjs', inputs: {}, outputs: [], dependsOn: [] }],
      execution: { timeoutMs: 1000, memoryMb: 32, outputMaxBytes: 1024 }, verification: 'Read the independently verified output.' }, extraFiles: [{ path: 'main.mjs', kind: 'script', content: 'export const value = 1;\n' }] });
    expect(executable.status).toBe('inspected');
    const registry = createSkillRegistry(store.db), lifecycle = createSkillLifecycle(store.db, { audit: registry.audit, executableReady: async () => true });
    await expect(lifecycle.activate(f.owner, executable.id, { expectedRevision: executable.revision, approve: true, evaluationId: randomUUID(), acknowledgeFindings: true })).rejects.toMatchObject({ code: 'SKILL_FORGE_EXECUTABLE_BLOCKED' });
    expect((await f.skills.detail(f.owner, executable.id)).skill.active).toBe(false);
  });
  it('rolls back activation, replacement and proof audit together if the audit fails', async () => {
    const f = await fixture(), evaluation = await f.evaluate(), registry = createSkillRegistry(store.db);
    const lifecycle = createSkillLifecycle(store.db, { executableReady: async () => false, audit: async (...args) => {
      await registry.audit(...args); if (args[3] === 'skill.forge_promoted') throw new Error('CONTROLLED_AUDIT_FAILURE');
    } });
    await expect(lifecycle.activate(f.owner, f.candidate.id, { expectedRevision: f.candidate.revision, approve: true, evaluationId: evaluation.id })).rejects.toThrow('CONTROLLED_AUDIT_FAILURE');
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.status).toBe('inspected');
    expect((await f.skills.detail(f.owner, f.baseline.id)).skill.active).toBe(true);
    expect(await store.db.selectFrom('skill_audit').select('id').where('target_id', '=', f.candidate.id).where('event', '=', 'skill.forge_promoted').execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_activations').select('id').where('version_id', '=', f.candidate.id).execute()).toEqual([]);
  });
  it('serializes cross-family revocation before a queued promotion and refuses its stale baseline', async () => {
    const f = await fixture({ fork: true }), evaluation = await f.evaluate(), registry = createSkillRegistry(store.db);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const lifecycle = createSkillLifecycle(store.db, { executableReady: async () => false, audit: async (...args) => {
      await registry.audit(...args); if (args[3] === 'skill.revoked') { entered(); await held; }
    } });
    const b = (await f.skills.detail(f.owner, f.baseline.id)).skill;
    const revoke = lifecycle.revoke(f.owner, b.id, { expectedRevision: b.revision, reason: 'Controlled concurrent revocation.' });
    await started;
    let settled = false;
    const activation = f.activate(evaluation.id).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false); }
    finally { release(); }
    await revoke; expect(await activation).toMatchObject({ error: { code: 'SKILL_FORGE_PINS_STALE' } });
    expect((await f.skills.detail(f.owner, f.candidate.id)).skill.active).toBe(false);
  });
});
