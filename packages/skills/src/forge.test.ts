import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { SkillContractSchema } from '@mohassan/contracts';
import { GroqProvider, ProviderError, type ModelRequest, type ModelResult } from '@mohassan/providers';
import { migrateAuth } from '../../../apps/server/src/auth.ts';
import { createSkillControl } from './index.ts';
import { createSkillForgeControl, type SkillForgeOptions } from './forge.ts';
import { skillsMigration } from './migration.ts';
import { sha256, skillContentHash } from './hash.ts';
import { storeImmutableSkill } from './import-store.ts';
import { SKILL_BENCHMARK_SUITES } from './benchmark-suites.ts';

let store: Awaited<ReturnType<typeof createDatabase>>;
const controls: ReturnType<typeof createSkillForgeControl>[] = [];
beforeAll(async () => { store = await createDatabase(); await migrateAuth(store.db); await migrate(store.db); await skillsMigration(store.db); });
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.shutdown())); });
afterAll(async () => { await store?.close(); });
const manifest = (slug: string, body = 'Improve the bounded instruction with explicit source verification.') => `---\nname: ${slug}\ndescription: Bounded generated guidance for controlled tests.\n---\n${body}\n`;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const controlFor = (generate: SkillForgeOptions['generate'], options: Partial<SkillForgeOptions> = {}) => { const control = createSkillForgeControl(store.db, { generate, ...options }); controls.push(control); return control; };
function reply(request: ModelRequest): ModelResult {
  const prompt = JSON.parse(request.goal);
  return { model: 'configured-fixture-model', usage: { inputTokens: 31, outputTokens: 19 }, text: JSON.stringify({ contract: { ...prompt.baseline.contract, slug: prompt.target.slug, version: prompt.target.version }, files: [{ path: 'SKILL.md', content: manifest(prompt.target.slug) }] }) };
}
async function fixture(body = 'Baseline instructions with source checking.') {
  const owner = randomUUID(), id = randomUUID(), familyId = randomUUID(), slug = 'forge-baseline';
  await store.db.insertInto('user').values({ id: owner, name: 'Forge fixture', email: `${owner}@example.test` }).execute();
  const skills = createSkillControl(store.db), contract = SkillContractSchema.parse({ slug, name: 'Forge baseline fixture', description: 'An explicitly owned version for generating a candidate.', category: 'research', version: '1.0.0', level: 'instruction' });
  const content = manifest(slug, body), contentHash = skillContentHash(contract, [{ path: 'SKILL.md', content }]);
  await store.db.insertInto('skill_families').values({ id: familyId, owner_id: owner, slug }).execute();
  await store.db.insertInto('skill_versions').values({ id, family_id: familyId, owner_id: owner, version: contract.version, sequence: 1, name: contract.name, description: contract.description, category: contract.category, level: contract.level, origin: 'local_import', status: 'quarantined', contract: JSON.stringify(contract), content_hash: contentHash }).execute();
  await store.db.insertInto('skill_files').values({ version_id: id, path: 'SKILL.md', kind: 'instructions', content, content_hash: sha256(content), size_bytes: Buffer.byteLength(content) }).execute();
  await store.db.insertInto('skill_sources').values({ version_id: id, kind: 'local_folder', locator: 'fixture-only', file_count: 1, total_bytes: Buffer.byteLength(content) }).execute();
  const inspected = (await skills.inspect(owner, id, { expectedRevision: 1 })).skill;
  return { owner, id, familyId, skills, contract, contentHash, revision: inspected.revision, request: { goal: 'Improve source verification within the bounded training scope.', baselineId: id, baselineRevision: inspected.revision, approve: true as const } };
}

describe('quarantined skill forge and durable model receipt', () => {
  it('persists a receipt before the one model call and stores a same-family immutable quarantined candidate', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => {
      const pending = await store.db.selectFrom('skill_forge_generations').selectAll().where('owner_id', '=', f.owner).execute();
      expect(pending).toHaveLength(1); expect(pending[0].status).toBe('running'); expect(pending[0].candidate_id).toBeNull();
      return reply(request);
    });
    const value = await controlFor(generate).execute(f.owner, f.request, randomUUID());
    expect(value).toMatchObject({ status: 'succeeded', targetFamilyId: f.familyId, targetVersion: '1.0.1', automaticActivation: false, usage: { inputTokens: 31, outputTokens: 19 } });
    const candidate = await f.skills.detail(f.owner, value.candidateId!);
    expect(candidate.skill).toMatchObject({ origin: 'forge', status: 'quarantined', active: false, familyId: f.familyId, version: '1.0.1' });
    expect(candidate.inspection).toBeNull(); expect(candidate.grants).toEqual([]); expect(candidate.source).toMatchObject({ kind: 'forge', locator: `forge:${value.id}` });
    expect((await f.skills.detail(f.owner, f.id)).skill.contentHash).toBe(f.contentHash); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('sends only trusted training metadata and keeps response/prompt text out of the receipt', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => reply(request)), control = controlFor(generate);
    const value = await control.execute(f.owner, f.request, randomUUID()), prompt = JSON.parse(generate.mock.calls[0][0].goal);
    expect(prompt.trainingContext).toMatchObject({ supported: true, trainingOnly: true });
    const serialized = JSON.stringify(prompt.trainingContext);
    for (const suite of SKILL_BENCHMARK_SUITES) for (const item of suite.cases.filter(item => item.split === 'holdout')) { expect(serialized).not.toContain(item.id); expect(serialized).not.toContain(item.fixtureHash); }
    expect(serialized).not.toContain('oracle'); expect(JSON.stringify(value)).not.toContain('Baseline instructions');
    const analysis = await control.analyze(f.owner, value.id); expect(analysis.actions).toEqual(['inspect_candidate', 'run_benchmark']); expect(analysis.trainingOnly).toBe(true);
  });
  it('uses the existing provider request limits through its actual local mocked transport', async () => {
    const f = await fixture();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)), request = { goal: body.messages.find((message: any) => message.role === 'user').content };
      expect(body.max_completion_tokens).toBeLessThanOrEqual(4096);
      const generated = reply(request);
      return new Response(JSON.stringify({ model: 'configured-fixture-model', choices: [{ message: { content: generated.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 19 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new GroqProvider({ apiKey: 'test-key', model: 'configured-fixture-model', fetch });
    const value = await controlFor(request => provider.generate(request)).execute(f.owner, f.request, randomUUID());
    expect(value.status).toBe('succeeded'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds long escaped instruction context inside valid JSON to the real provider goal limit', async () => {
    const f = await fixture('Review "quoted" evidence and emoji 🧪.\n'.repeat(600));
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)), goal = body.messages.find((message: any) => message.role === 'user').content, prompt = JSON.parse(goal);
      expect(goal.length).toBeLessThanOrEqual(16000); expect(prompt.baseline.instructions.truncated).toBe(true); expect(prompt.baseline.instructions.text.length).toBeGreaterThan(0);
      const generated = reply({ goal });
      return new Response(JSON.stringify({ model: 'configured-fixture-model', choices: [{ message: { content: generated.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 19 } }), { status: 200 });
    });
    const provider = new GroqProvider({ apiKey: 'test-key', model: 'configured-fixture-model', fetch });
    expect((await controlFor(request => provider.generate(request)).execute(f.owner, { ...f.request, goal: 'Improve bounded source provenance. '.repeat(100) }, randomUUID())).status).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('deduplicates concurrent requests and preserves paid-call idempotency after the baseline changes', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => reply(request)), control = controlFor(generate), key = randomUUID();
    const [first, second] = await Promise.all([control.execute(f.owner, f.request, key), control.execute(f.owner, f.request, key)]);
    expect(first.id).toBe(second.id); expect(generate).toHaveBeenCalledTimes(1);
    await store.db.updateTable('skill_versions').set({ status: 'revoked', revision: f.revision + 1 }).where('id', '=', f.id).execute();
    expect((await control.execute(f.owner, f.request, key)).candidateId).toBe(first.candidateId); expect(generate).toHaveBeenCalledTimes(1);
    await expect(control.start(f.owner, { ...f.request, goal: 'A different explicitly approved generation request.' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('requires explicit approval and rejects foreign, stale or damaged baselines before spending', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => reply(request)), control = controlFor(generate);
    await expect(control.start(f.owner, { ...f.request, approve: false }, randomUUID())).rejects.toThrow();
    await expect(control.start(f.owner, { ...f.request, baselineId: randomUUID() }, randomUUID())).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    await expect(control.start(f.owner, { ...f.request, baselineRevision: f.revision + 1 }, randomUUID())).rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT' });
    await store.db.updateTable('skill_files').set({ content: 'tampered' }).where('version_id', '=', f.id).execute();
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_INTEGRITY_FAILED' }); expect(generate).not.toHaveBeenCalled();
  });
  it('forks a built-in source only under an explicit unused slug despite its legacy custom origin', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => reply(request)), control = controlFor(generate);
    await store.db.updateTable('skill_versions').set({ origin: 'custom' }).where('id', '=', f.id).execute();
    await store.db.updateTable('skill_sources').set({ kind: 'builtin' }).where('version_id', '=', f.id).execute();
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_READ_ONLY' });
    await expect(control.start(f.owner, { ...f.request, targetSlug: f.contract.slug }, randomUUID())).rejects.toMatchObject({ code: 'SKILL_SLUG_TAKEN' });
    const value = await control.execute(f.owner, { ...f.request, targetSlug: 'explicit-fork' }, randomUUID());
    expect(value.status).toBe('succeeded'); expect(value.mode).toBe('fork'); expect(value.targetVersion).toBe('1.0.0'); expect(value.targetFamilyId).not.toBe(f.familyId);
    expect((await f.skills.detail(f.owner, value.candidateId!)).skill).toMatchObject({ slug: 'explicit-fork', origin: 'forge', status: 'quarantined' });
  });
  it.each(['json', 'extra', 'slug', 'version', 'path', 'duplicate_path', 'credential', 'manifest', 'surrogate'] as const)('retains actual usage but rejects generated %s without a candidate', async kind => {
    const f = await fixture(), control = controlFor(async request => {
      const generated = reply(request), value = JSON.parse(generated.text);
      if (kind === 'json') generated.text = 'not JSON';
      else {
        if (kind === 'extra') value.activate = true;
        if (kind === 'slug') value.contract.slug = 'hijack-existing-family';
        if (kind === 'version') value.contract.version = '0.0.1';
        if (kind === 'path') value.files.push({ path: '../escape.txt', content: 'untrusted text only' });
        if (kind === 'duplicate_path') value.files.push({ path: 'skill.MD', content: 'collision' });
        if (kind === 'credential') value.files[0].content += '\napi_key="abcdefghijklmnop123456"';
        if (kind === 'manifest') value.files[0].content = 'Body without required frontmatter';
        if (kind === 'surrogate') value.files[0].content += '\ud800';
        generated.text = JSON.stringify(value);
      }
      return generated;
    });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('failed'); expect(value.candidateId).toBeNull();
    expect(value.usage).toEqual({ inputTokens: 31, outputTokens: 19 }); expect(value.responseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.db.selectFrom('skill_versions').select('id').where('owner_id', '=', f.owner).where('origin', '=', 'forge').execute()).toEqual([]);
  });
  it('stores script text without running it or enabling its execution level', async () => {
    const f = await fixture(), control = controlFor(async request => {
      const generated = reply(request), value = JSON.parse(generated.text); value.files.push({ path: 'review.mjs', content: 'throw new Error("UNTRUSTED_SCRIPT_MUST_NEVER_RUN");' }); generated.text = JSON.stringify(value); return generated;
    });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('succeeded');
    const detail = await f.skills.detail(f.owner, value.candidateId!); expect(detail.skill.level).toBe('instruction'); expect(detail.files.some(file => file.kind === 'script')).toBe(true); expect(detail.skill.active).toBe(false);
  });
  it('preserves paid provider failure usage and original Retry-After without automatic retry', async () => {
    const f = await fixture(), error = new ProviderError('UPSTREAM_ERROR', 'PRIVATE_PROVIDER_MESSAGE', true, 503); error.usage = { inputTokens: 41, outputTokens: 2 }; error.retryAfterMs = 600000; Object.assign(error, { model: 'configured-fixture-model' });
    const generate = vi.fn(async () => { throw error; }), control = controlFor(generate), key = randomUUID();
    const value = await control.execute(f.owner, f.request, key);
    expect(value).toMatchObject({ status: 'unknown', usage: { inputTokens: 41, outputTokens: 2 }, httpStatus: 503, retryAfterMs: 600000, errorCode: 'UPSTREAM_ERROR' });
    expect(JSON.stringify(value)).not.toContain('PRIVATE_PROVIDER_MESSAGE'); await control.execute(f.owner, f.request, key); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('does not trust arbitrary error metadata as a billing receipt', async () => {
    const f = await fixture(), control = controlFor(async () => { throw { code: 'RATE_LIMITED', usage: { inputTokens: 0, outputTokens: 0 }, model: 'spoofed' }; });
    expect(await control.execute(f.owner, f.request, randomUUID())).toMatchObject({ status: 'unknown', usage: null, model: null, errorCode: 'SKILL_FORGE_INTERRUPTED' });
  });
  it('allows only one active generation and fences a late paid response after lease recovery', async () => {
    const f = await fixture(), entered = deferred<ModelRequest>(), response = deferred<ModelResult>();
    const generate = vi.fn(async (request: ModelRequest) => { entered.resolve(request); return response.promise; }), control = controlFor(generate), key = randomUUID();
    const value = await control.start(f.owner, f.request, key), request = await entered.promise;
    await expect(control.start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_FORGE_BUSY' });
    await store.db.updateTable('skill_forge_generations').set({ lease_expires_at: new Date(0) }).where('id', '=', value.id).execute();
    expect((await control.get(f.owner, value.id)).status).toBe('unknown'); expect(await control.recoverExpired()).toBe(1);
    response.resolve(reply(request)); await control.shutdown();
    expect(await control.get(f.owner, value.id)).toMatchObject({ status: 'unknown', candidateId: null, usage: { inputTokens: 31, outputTokens: 19 } });
    const resumed = controlFor(generate); await resumed.execute(f.owner, f.request, key); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('preserves billing but creates no candidate if cancelled while the provider is pending', async () => {
    const f = await fixture(), entered = deferred<ModelRequest>(), response = deferred<ModelResult>();
    const control = controlFor(async request => { entered.resolve(request); return response.promise; }), running = control.execute(f.owner, f.request, randomUUID());
    const request = await entered.promise, stopping = control.shutdown(); response.resolve(reply(request)); const value = await running; await stopping;
    expect(value).toMatchObject({ status: 'unknown', candidateId: null, usage: { inputTokens: 31, outputTokens: 19 }, errorCode: 'SKILL_FORGE_ABORTED' });
  });
  it('rolls back a candidate if its lease expires while its graph hook owns the transaction', async () => {
    const f = await fixture(), hook = vi.fn(async () => { await new Promise(done => setTimeout(done, 450)); });
    const control = controlFor(async request => reply(request), { leaseMs: 300, timeoutMs: 3000, rebuildGraph: hook });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(hook).toHaveBeenCalledTimes(1);
    expect(value.status).not.toBe('succeeded'); expect(value.candidateId).toBeNull(); expect(value.usage?.inputTokens).toBe(31);
    expect(await store.db.selectFrom('skill_versions').select('id').where('owner_id', '=', f.owner).where('origin', '=', 'forge').execute()).toEqual([]);
    expect(await store.db.selectFrom('skill_audit').select('id').where('owner_id', '=', f.owner).where('event', 'in', ['skill.forge_candidate', 'skill.forge_succeeded']).execute()).toEqual([]);
  });
  it('rejects a parent revision change during the paid call', async () => {
    const f = await fixture(), control = controlFor(async request => { await store.db.updateTable('skill_versions').set({ revision: f.revision + 1 }).where('id', '=', f.id).execute(); return reply(request); });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('failed'); expect(value.errorCode).toBe('SKILL_FORGE_PARENT_CHANGED'); expect(value.usage?.inputTokens).toBe(31);
  });
  it('refuses to overwrite a competing immutable version imported during generation', async () => {
    const f = await fixture(), control = controlFor(async request => {
      const content = manifest(f.contract.slug, 'A separate explicitly imported version wins the available version number.');
      await store.db.transaction().execute(tx => storeImmutableSkill(tx, f.owner, { contract: { ...f.contract, version: '1.0.1' }, explicitVersion: true, files: [{ path: 'SKILL.md', kind: 'instructions', content }], totalBytes: Buffer.byteLength(content), root: 'fixture' }, { origin: 'local_import', audit: async () => {} }));
      return reply(request);
    });
    const value = await control.execute(f.owner, f.request, randomUUID()); expect(value.status).toBe('failed'); expect(value.errorCode).toBe('SKILL_FORGE_VERSION_CHANGED'); expect(value.usage?.inputTokens).toBe(31);
    const rows = await store.db.selectFrom('skill_versions').select(['version', 'origin']).where('family_id', '=', f.familyId).orderBy('sequence').execute();
    expect(rows).toEqual([{ version: '1.0.0', origin: 'local_import' }, { version: '1.0.1', origin: 'local_import' }]);
  });
  it('counts forged and imported versions in the same owner quota before a model call', async () => {
    const f = await fixture();
    const base = await store.db.selectFrom('skill_versions').selectAll().where('id', '=', f.id).executeTakeFirstOrThrow();
    const families = Array.from({ length: 199 }, (_, i) => ({ id: randomUUID(), owner_id: f.owner, slug: `quota-${i}` }));
    await store.db.insertInto('skill_families').values(families).execute();
    await store.db.insertInto('skill_versions').values(families.map((family, i) => ({ ...base, id: randomUUID(), family_id: family.id, origin: i % 2 ? 'forge' : 'local_import', content_hash: sha256(family.id) }))).execute();
    const generate = vi.fn(async (request: ModelRequest) => reply(request));
    await expect(controlFor(generate).start(f.owner, f.request, randomUUID())).rejects.toMatchObject({ code: 'SKILL_QUOTA_EXCEEDED' }); expect(generate).not.toHaveBeenCalled();
    await expect(store.db.transaction().execute(tx => storeImmutableSkill(tx, f.owner, { contract: { ...f.contract, slug: 'last-import' }, explicitVersion: true, files: [{ path: 'SKILL.md', kind: 'instructions', content: manifest('last-import') }], totalBytes: Buffer.byteLength(manifest('last-import')), root: 'fixture' }, { origin: 'local_import', audit: async () => {} }))).rejects.toMatchObject({ code: 'SKILL_QUOTA_EXCEEDED' });
  });
  it('keeps reads owner-scoped and detects corrupted immutable generation linkage', async () => {
    const f = await fixture(), control = controlFor(async request => reply(request)), value = await control.execute(f.owner, f.request, randomUUID());
    await expect(control.get(randomUUID(), value.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_NOT_FOUND' }); expect((await control.list(randomUUID())).items).toEqual([]);
    await store.db.updateTable('skill_forge_generations').set({ candidate_content_hash: sha256('corrupted') }).where('id', '=', value.id).execute();
    await expect(control.get(f.owner, value.id)).rejects.toMatchObject({ code: 'SKILL_FORGE_INTEGRITY_FAILED' });
  });
  it('rejects failure-run context that cannot prove the owned pinned baseline version', async () => {
    const f = await fixture(), generate = vi.fn(async (request: ModelRequest) => reply(request));
    await expect(controlFor(generate).start(f.owner, { ...f.request, failureRunId: randomUUID() }, randomUUID())).rejects.toMatchObject({ code: 'SKILL_FORGE_FAILURE_SOURCE_INVALID' }); expect(generate).not.toHaveBeenCalled();
  });
  it('uses only known bounded failure codes from the owned matching baseline run', async () => {
    const f = await fixture(), taskId = randomUUID(), runId = randomUUID();
    await store.db.insertInto('tasks').values({ id: taskId, owner_id: f.owner, title: 'Failure-context fixture', goal: 'Private raw request MUST_NOT_ENTER_FORGE', capability_id: 'skill.run', capability_version: '1.0.0', autonomy: 'assisted', status: 'failed', input_hash: sha256(taskId), idempotency_key: taskId, attempt: 1, max_attempts: 1, cancellation_requested: false, approval_required: true, event_sequence: 0 }).execute();
    await store.db.insertInto('skill_runs').values({ id: runId, owner_id: f.owner, parent_task_id: taskId, input_hash: sha256(runId), plan: '{}', input_values: JSON.stringify({ private: 'MUST_NOT_ENTER_FORGE' }), pinned_versions: '[]', status: 'failed' }).execute();
    await store.db.insertInto('skill_run_nodes').values(['SKILL_TOOL_PERMISSION_REQUIRED', 'MUST_NOT_ENTER_FORGE'].map((errorCode, index) => ({ run_id: runId, node_id: `main.step${index}`, owner_id: f.owner, version_id: f.id, content_hash: f.contentHash,
      composition_node_id: 'main', step_id: `step${index}`, kind: 'tool', tool: 'file.read', contract: JSON.stringify(f.contract), step: '{}', dependencies: '[]', input_bindings: '{}', inputs: JSON.stringify({ private: 'MUST_NOT_ENTER_FORGE' }), output_schema: '[]', idempotency_key: `${runId}:${index}`, status: 'failed', error_code: errorCode }))).execute();
    const generate = vi.fn(async (request: ModelRequest) => reply(request)), control = controlFor(generate), value = await control.execute(f.owner, { ...f.request, failureRunId: runId }, randomUUID());
    expect(value.status).toBe('succeeded'); expect(value.failureAnalysis?.issues.map(issue => issue.code)).toEqual(['SKILL_TOOL_PERMISSION_REQUIRED', null]);
    expect(generate.mock.calls[0][0].goal).not.toContain('MUST_NOT_ENTER_FORGE');
    await store.db.updateTable('skill_run_nodes').set({ content_hash: sha256('different pinned content') }).where('run_id', '=', runId).execute();
    await expect(control.start(f.owner, { ...f.request, failureRunId: runId }, randomUUID())).rejects.toMatchObject({ code: 'SKILL_FORGE_FAILURE_SOURCE_INVALID' });
  });
  it('chooses a monotonic semantic version even when imported versions were added out of order', async () => {
    const f = await fixture();
    for (const version of ['2.0.0', '0.9.0']) {
      const content = manifest(f.contract.slug, `Explicit import ${version}.`);
      await store.db.transaction().execute(tx => storeImmutableSkill(tx, f.owner, { contract: { ...f.contract, version }, explicitVersion: true, files: [{ path: 'SKILL.md', kind: 'instructions', content }], totalBytes: Buffer.byteLength(content), root: 'fixture' }, { origin: 'local_import', audit: async () => {} }));
    }
    const value = await controlFor(async request => reply(request)).execute(f.owner, f.request, randomUUID());
    expect(value.status).toBe('succeeded'); expect(value.targetVersion).toBe('2.0.1');
    expect((await store.db.selectFrom('skill_versions').select('sequence').where('id', '=', value.candidateId!).executeTakeFirstOrThrow()).sequence).toBe(4);
  });
});
