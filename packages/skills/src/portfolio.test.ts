import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { memoryMigration, evaluateChecklist, manifestHash, DeclarativeSkillSchema } from '@mohassan/memory';
import { SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { skillsMigration } from './migration.ts';
import { sha256, skillContentHash } from './hash.ts';
import { readSkillPortfolio, readSkillQuality } from './portfolio.ts';
import { createSkillControl } from './index.ts';
import { createSkillBenchmarkControl } from './benchmark.ts';
import { skillBenchmarkDefinition } from './benchmark-suites.ts';
import { SkillBenchmarkSuiteSchema } from '../../contracts/src/skill-benchmarks.ts';
import { createSkillBenchmarkRunner } from '../../../apps/server/src/skill-benchmark-runner.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async () => { store = await createDatabase(); await migrate(store.db); await memoryMigration(store.db); await skillsMigration(store.db); });
afterAll(async () => { await store?.close(); });

async function version(ownerId: string, slug: string, options: Partial<SkillContract> & { text?: string; updatedAt?: Date } = {}) {
  const { text = 'Bounded synthetic portfolio guidance.', updatedAt = new Date(), ...changes } = options;
  const id = randomUUID(), familyId = randomUUID(), contract = SkillContractSchema.parse({ slug, name: slug, description: 'Controlled metadata for portfolio tests.', version: '1.0.0', category: 'research', level: 'instruction', ...changes });
  const contentHash = skillContentHash(contract, [{ path: 'SKILL.md', content: text }]);
  await store.db.insertInto('skill_families').values({ id: familyId, owner_id: ownerId, slug }).execute();
  await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: ownerId, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category,
    level: contract.level, origin: 'custom', status: 'quarantined', contract: JSON.stringify(contract), content_hash: contentHash, updated_at: updatedAt }).execute();
  await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content: text, content_hash: sha256(text), size_bytes: Buffer.byteLength(text) }).execute();
  return { id, familyId, contract, contentHash };
}
async function task(ownerId: string) {
  const id = randomUUID();
  await store.db.insertInto('tasks').values({ id, owner_id: ownerId, title: 'Synthetic portfolio history', goal: 'No operation is executed by this fixture.', capability_id: 'skill.run', capability_version: '1.0.0',
    autonomy: 'assisted', status: 'completed', input_hash: sha256(id), idempotency_key: id, attempt: 1, max_attempts: 1, cancellation_requested: false, approval_required: true, event_sequence: 0 }).execute();
  return id;
}
async function run(ownerId: string, skill: Awaited<ReturnType<typeof version>>, count = 1) {
  const id = randomUUID(), parentId = await task(ownerId);
  await store.db.insertInto('skill_runs').values({ id, owner_id: ownerId, parent_task_id: parentId, input_hash: sha256(id), plan: '{}', input_values: JSON.stringify({ private: 'INPUT_MUST_NOT_APPEAR' }), pinned_versions: '[]', status: 'succeeded', finished_at: new Date() }).execute();
  const nodes = Array.from({ length: count }, (_, index) => ({ run_id: id, node_id: `main.read${index}`, owner_id: ownerId, version_id: skill.id, content_hash: skill.contentHash,
    composition_node_id: 'main', step_id: `read${index}`, kind: 'tool', tool: 'file.read', contract: JSON.stringify(skill.contract), step: '{}', dependencies: '[]', input_bindings: '{}',
    output_schema: '[]', outputs: JSON.stringify({ private: 'OUTPUT_MUST_NOT_APPEAR' }), idempotency_key: `${id}:${index}`, status: 'succeeded', attempt: 1 }));
  await store.db.insertInto('skill_run_nodes').values(nodes).execute();
  const receiptId = randomUUID();
  await store.db.insertInto('skill_evidence').values({ id: receiptId, owner_id: ownerId, run_id: id, node_id: 'main.read0', task_id: parentId, version_id: skill.id, content_hash: skill.contentHash,
    inputs_hash: sha256('input'), lease_token: randomUUID(), node_lease_token: randomUUID(), workflow_token: randomUUID(), status: 'unknown', error_code: 'FIXTURE_METADATA_ONLY' }).execute();
  return { id, parentId, receiptId };
}

describe('read-only owned skill portfolio', () => {
  it('returns an empty view without seeding builtins or creating evaluations', async () => {
    const owner = randomUUID(), result = await readSkillPortfolio(store.db, owner);
    expect(result).toMatchObject({ items: [], total: 0, suggestions: [], recentRuns: [], readOnly: true, permissionsGranted: false });
    expect(await store.db.selectFrom('skill_versions').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_quality_snapshots').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
  });
  it('finds duplicate file metadata only as a review suggestion and never changes lifecycle or grants', async () => {
    const owner = randomUUID(), first = await version(owner, 'same-first'), second = await version(owner, 'same-second');
    const result = await readSkillPortfolio(store.db, owner), duplicate = result.suggestions.find(item => item.kind === 'duplicate_file_set');
    expect(duplicate).toMatchObject({ versionIds: expect.arrayContaining([first.id, second.id]), reviewOnly: true, proofOfUnnecessaryDependency: false });
    expect(result.items.every(item => item.status === 'quarantined' && item.quality.coverage === 'none')).toBe(true);
    expect(await store.db.selectFrom('skill_grants').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_audit').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
  });
  it('isolates foreign versions, runs and file fingerprints and returns the same 404 for unowned and missing quality', async () => {
    const owner = randomUUID(), foreignOwner = randomUUID(), own = await version(owner, 'owned-only'), foreign = await version(foreignOwner, 'foreign-private');
    const foreignRun = await run(foreignOwner, foreign); const result = await readSkillPortfolio(store.db, owner);
    expect(result.items.map(item => item.id)).toEqual([own.id]); expect(result.suggestions).toEqual([]); expect(result.recentRuns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(foreignRun.receiptId);
    await expect(readSkillQuality(store.db, owner, foreign.id)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
    await expect(readSkillQuality(store.db, owner, randomUUID())).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
  });
  it('reports declared tools and dependencies absent from a bounded observed window as review-only', async () => {
    const owner = randomUUID(), skill = await version(owner, 'declared-review', { requires: { tools: ['file.read', 'file.write'], scopes: [], paths: [] }, dependsOn: ['unseen-helper'] });
    const history = await run(owner, skill); const result = await readSkillPortfolio(store.db, owner);
    expect(result.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'declared_tools_not_observed', tools: ['file.write'], sampleRuns: 1, reviewOnly: true, proofOfUnnecessaryDependency: false }),
      expect.objectContaining({ kind: 'declared_dependencies_not_observed', dependencies: ['unseen-helper'], sampleRuns: 1, reviewOnly: true }),
    ]));
    expect(result.recentRuns[0]).toMatchObject({ id: history.id, parentTaskId: history.parentId, versionIds: [skill.id], evidenceIds: [history.receiptId] });
    expect(JSON.stringify(result)).not.toMatch(/INPUT_MUST_NOT_APPEAR|OUTPUT_MUST_NOT_APPEAR/);
  });
  it('does not infer unused declarations when there is no run or when nodes were capped', async () => {
    const owner = randomUUID(), skill = await version(owner, 'empty-history', { requires: { tools: ['file.write'], scopes: [], paths: [] } });
    expect((await readSkillPortfolio(store.db, owner)).suggestions).toEqual([]);
    await run(owner, skill, 145); const result = await readSkillPortfolio(store.db, owner);
    expect(result.analysisWindow.runsTruncated).toBe(true); expect(result.truncated).toBe(true); expect(result.suggestions).toEqual([]);
  });
  it('keeps legacy checklist measurements separate and read-only', async () => {
    const owner = randomUUID(), familyId = randomUUID(), versionId = randomUUID(), evaluationId = randomUUID();
    const manifest = DeclarativeSkillSchema.parse({ kind: 'checklist-router', rules: [{ terms: ['تشخيص'], category: 'diagnostic', checks: ['scope', 'evidence', 'verification'] }], fallback: { category: 'plan', checks: ['scope', 'evidence', 'verification'] } }), hash = manifestHash(manifest);
    await store.db.insertInto('memory_skill_families').values({ id: familyId, owner_id: owner, name: 'Legacy fixture' }).execute();
    await store.db.insertInto('memory_skill_versions').values({ id: versionId, owner_id: owner, family_id: familyId, version: 1, revision: 1, name: 'Legacy fixture', description: 'Legacy checklist fixture.', manifest: JSON.stringify(manifest), manifest_hash: hash, status: 'candidate', evidence_ids: '[]' }).execute();
    const result = evaluateChecklist(manifest, 'benchmark');
    await store.db.insertInto('memory_skill_evaluations').values({ id: evaluationId, owner_id: owner, skill_id: versionId, kind: 'benchmark', manifest_hash: hash, result: JSON.stringify(result) }).execute();
    const portfolio = await readSkillPortfolio(store.db, owner);
    expect(portfolio.items).toEqual([]); expect(portfolio.legacyChecklist).toMatchObject({ scope: 'checklist_structure', readOnly: true,
      items: [expect.objectContaining({ versionId, evaluationId, caseCount: 8, candidateScore: result.candidateScore, passed: result.passed })] });
    expect((await store.db.selectFrom('memory_skill_versions').select('status').where('id', '=', versionId).executeTakeFirstOrThrow()).status).toBe('candidate');
  });
  it('supports a direct quality lookup and pagination beyond the newest 200 versions', async () => {
    const owner = randomUUID(), old = await version(owner, 'oldest-visible', { updatedAt: new Date('2020-01-01T00:00:00Z') });
    await store.db.transaction().execute(async tx => {
      const families = [], rows = [];
      for (let index = 0; index < 201; index++) {
        const id = randomUUID(), familyId = randomUUID(), slug = `bounded-${index}`;
        const contract = SkillContractSchema.parse({ ...old.contract, slug, name: slug });
        families.push({ id: familyId, owner_id: owner, slug });
        rows.push({ id, family_id: familyId, owner_id: owner, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category, level: contract.level,
          origin: 'custom', status: 'quarantined', content_hash: sha256(slug), contract: JSON.stringify(contract), updated_at: new Date('2026-01-01T00:00:00Z') });
      }
      await tx.insertInto('skill_families').values(families).execute(); await tx.insertInto('skill_versions').values(rows).execute();
    });
    const first = await readSkillPortfolio(store.db, owner, { limit: 1 }); expect(first.total).toBe(202); expect(first.truncated).toBe(true); expect(first.analysisWindow.versions).toBe(200);
    const last = await readSkillPortfolio(store.db, owner, { limit: 1, offset: 201 }); expect(last.items.map(item => item.id)).toEqual([old.id]);
    expect(await readSkillQuality(store.db, owner, old.id)).toMatchObject({ versionId: old.id, contentHash: old.contentHash, coverage: 'none' });
  });
  it('rejects unbounded or unrecognized query fields', async () => {
    await expect(readSkillPortfolio(store.db, randomUUID(), { limit: 1000 })).rejects.toThrow();
    await expect(readSkillPortfolio(store.db, randomUUID(), { ownerId: randomUUID() })).rejects.toThrow();
  });
  it('reads real saved isolated instruction experiments, detects corrupt history, and keeps old hashes historical', async () => {
    const owner = randomUUID(), baseline = await version(owner, 'measured-baseline'), candidate = await version(owner, 'measured-candidate', { text: 'Deliver this independently pinned instruction with clear sources.' });
    const skills = createSkillControl(store.db);
    const b = (await skills.inspect(owner, baseline.id, { expectedRevision: 1 })).skill;
    const c = (await skills.inspect(owner, candidate.id, { expectedRevision: 1 })).skill;
    const control = createSkillBenchmarkControl(store.db, { suite: id => SkillBenchmarkSuiteSchema.parse(skillBenchmarkDefinition(id)), runner: createSkillBenchmarkRunner() });
    try {
      const request = { baselineId: baseline.id, baselineRevision: b.revision, candidateId: candidate.id, candidateRevision: c.revision, suiteId: 'instruction-delivery-v1' };
      const first = await control.execute(owner, request, randomUUID()); expect(first.status).toBe('completed');
      const second = await control.execute(owner, request, randomUUID()); expect(second.status).toBe('completed');
      const detail = await readSkillQuality(store.db, owner, candidate.id);
      expect(detail.coverage).toBe('measured'); expect(detail.evaluations).toHaveLength(2); expect(detail.invalidEvaluations).toBe(0);
      expect(detail.evaluations.every(item => item.reviewReady && item.scope === 'instruction_delivery' && item.evidenceScope === 'isolated_experiment')).toBe(true);
      expect(detail.drift).toMatchObject({ comparable: true, status: 'no_regression_observed', successDelta: 0 });
      expect((await readSkillPortfolio(store.db, owner)).recentRuns).toEqual([]);
      expect((await skills.detail(owner, candidate.id)).skill.status).toBe('inspected');
      await store.db.updateTable('skill_benchmark_runs').set({ results: '[]' }).where('id', '=', second.id).execute();
      const corrupted = await readSkillQuality(store.db, owner, candidate.id);
      expect(corrupted.invalidEvaluations).toBe(1); expect(corrupted.evaluations.map(item => item.evaluationId)).toEqual([first.id]);
      await store.db.updateTable('skill_versions').set({ content_hash: sha256('changed-only-in-disposable-test') }).where('id', '=', candidate.id).execute();
      const historical = await readSkillQuality(store.db, owner, candidate.id);
      expect(historical.coverage).toBe('historical_only'); expect(historical.evaluations[0].candidateContentHash).toBe(candidate.contentHash);
      expect(await store.db.selectFrom('tasks').select('id').where('owner_id', '=', owner).execute()).toEqual([]);
    } finally { await control.shutdown(); }
  }, 60000);
  it('retains empty running and all-blocked history without claiming measured coverage', async () => {
    const owner = randomUUID(), requirements = { tools: ['file.read' as const], scopes: [], paths: [] };
    const baseline = await version(owner, 'unsupported-base', { requires: requirements, sideEffects: 'read' }), candidate = await version(owner, 'unsupported-candidate', { requires: requirements, sideEffects: 'read' });
    const skills = createSkillControl(store.db), b = (await skills.inspect(owner, baseline.id, { expectedRevision: 1 })).skill, c = (await skills.inspect(owner, candidate.id, { expectedRevision: 1 })).skill;
    const suite = (id: Parameters<typeof skillBenchmarkDefinition>[0]) => SkillBenchmarkSuiteSchema.parse(skillBenchmarkDefinition(id));
    const request = { baselineId: baseline.id, baselineRevision: b.revision, candidateId: candidate.id, candidateRevision: c.revision, suiteId: 'instruction-delivery-v1' };
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    const pending = createSkillBenchmarkControl(store.db, { suite, runner: { async execute() { await paused; } } });
    try {
      await pending.start(owner, request, randomUUID());
      const detail = await readSkillQuality(store.db, owner, candidate.id);
      expect(detail.coverage).toBe('none'); expect(detail.evaluations).toHaveLength(1);
      expect(detail.evaluations[0]).toMatchObject({ evaluationStatus: 'running', reviewReady: false, candidate: { measuredCases: 0 } });
    } finally { release(); await pending.shutdown(); }
    const control = createSkillBenchmarkControl(store.db, { suite, runner: createSkillBenchmarkRunner() });
    try {
      const blocked = await control.execute(owner, request, randomUUID()); expect(blocked.status).toBe('completed');
      expect(blocked.cases.every(item => item.status === 'blocked')).toBe(true);
      const detail = await readSkillQuality(store.db, owner, candidate.id);
      expect(detail.coverage).toBe('none'); expect(detail.evaluations).toHaveLength(2);
      expect(detail.evaluations[0].candidate).toMatchObject({ measuredCases: 0, blockedCases: blocked.suite.cases.length });
      expect(detail.evaluations[0].reviewReady).toBe(false);
    } finally { await control.shutdown(); }
  }, 60000);
});
