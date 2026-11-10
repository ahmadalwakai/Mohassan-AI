import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillBenchmarkEvaluationSchema, SkillContractSchema, type SkillContract } from '@mohassan/contracts';
import { SkillForgeGenerationSchema, SkillForgePageSchema, type SkillForgeGeneration } from '../packages/contracts/src/skill-forge.ts';
import { createApplication } from '../apps/server/src/app.ts';
import { SKILL_BENCHMARK_SUITES } from '../packages/skills/src/benchmark-suites.ts';
import { fixtureLocalModel } from './fixtures/local-model.js';

describe('actual authenticated Forge with mocked model transport and real isolated benchmarks', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined, directory = '', base = '', cookie = '', otherCookie = '', ownerId = '', fixtureAddress = 10;
  const origin = 'http://127.0.0.1:3000', secret = 'forge-api-fixture-internal-secret-00001', setupToken = 'forge-api-fixture-setup-token-00000001';
  const headers = (session = cookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  type Version = Awaited<ReturnType<NonNullable<typeof application>['skills']['detail']>>['skill'];
  type Reply = { contract: SkillContract; files: { path: string; content: string }[] };
  const replies: { promise: Promise<Reply>; resolve: (reply: Reply) => void }[] = [], pendingReplies = new Set<{ promise: Promise<Reply>; resolve: (reply: Reply) => void }>(), prompts: unknown[] = [];
  const modelFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')); prompts.push(body);
    const pending = replies.shift(); if (!pending) throw new Error('Unexpected unconfigured model fixture call');
    const payload = await pending.promise;
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 23 } });
  });
  function responseSlot() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(done => { resolve = done; }); const slot = { promise, resolve: (reply: Reply) => { pendingReplies.delete(slot); resolve(reply); } }; replies.push(slot); pendingReplies.add(slot); return slot; }
  // Independent injected fixture cases have independent local peer addresses.
  // This suite tests owner/lineage semantics, not the production IP rate limit.
  const peer = () => `127.0.0.${fixtureAddress++}`;
  const post = (url: string, payload: unknown, session = cookie, key = randomUUID()) => application!.app.inject({ method: 'POST', url, headers: { ...headers(session), 'idempotency-key': key }, remoteAddress: peer(), payload: payload as any });
  async function detail(id: string) { const response = await application!.app.inject({ url: `/api/skills/${id}`, headers: headers() }); expect(response.statusCode, response.body).toBe(200); return response.json().skill as Version; }
  async function imported(slug: string, version: string, active = true) {
    const folder = join(directory, randomUUID()); await mkdir(folder);
    const contract = SkillContractSchema.parse({ slug, name: slug.replace(/-/g, ' '), description: 'Preserve independently observed evidence and its original source identifiers.', category: 'documents', version, level: 'instruction' });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${contract.description}\nversion: ${version}\n---\nUse only observed evidence and preserve its exact source identity.\n`);
    await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
    const loaded = await post('/api/skills/import', { path: folder }); expect(loaded.statusCode, loaded.body).toBe(200);
    let skill = loaded.json().skill as Version;
    const inspected = await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision }); expect(inspected.statusCode, inspected.body).toBe(200); skill = inspected.json().skill;
    if (active) { const activated = await post(`/api/skills/${skill.id}/activate`, { expectedRevision: skill.revision, approve: true, acknowledgeFindings: true }); expect(activated.statusCode, activated.body).toBe(200); skill = activated.json().skill; }
    return skill;
  }
  function generated(generation: SkillForgeGeneration): Reply {
    const contract = SkillContractSchema.parse({ slug: generation.targetSlug, name: 'Independently generated guidance', description: 'Retain original evidence identifiers and explain uncertainty without claiming unverified effects.', category: 'documents', version: generation.targetVersion, level: 'instruction' });
    return { contract, files: [{ path: 'SKILL.md', content: `---\nname: ${contract.slug}\ndescription: ${contract.description}\nversion: ${contract.version}\n---\nPreserve source identifiers. Explain uncertainty and verify each claim against the observed evidence.\n` }] };
  }
  async function terminal(id: string) {
    let result: SkillForgeGeneration | undefined;
    const deadline = Date.now() + 60000;
    do { const response = await application!.app.inject({ url: `/api/skills/forge/generations/${id}`, headers: headers() }); expect(response.statusCode, response.body).toBe(200); result = SkillForgeGenerationSchema.parse(response.json()); if (result.status !== 'running') return result; await delay(30); } while (Date.now() < deadline);
    throw new Error(`Forge fixture did not finish: ${JSON.stringify(result)}`);
  }
  async function begin(baseline: Version, extra: Record<string, unknown> = {}) {
    const slot = responseSlot(), before = await detail(baseline.id), key = randomUUID(), request = { goal: 'Improve attributable instruction delivery without changing its intended scope.', baselineId: baseline.id, baselineRevision: before.revision, approve: true, ...extra };
    const response = await post('/api/skills/forge/generations', request, cookie, key); expect(response.statusCode, response.body).toBe(200);
    const generation = SkillForgeGenerationSchema.parse(response.json()); return { generation, slot, request, key };
  }
  async function forge(baseline: Version, extra: Record<string, unknown> = {}, change?: (reply: Reply) => Reply) {
    const pending = await begin(baseline, extra), reply = generated(pending.generation); pending.slot.resolve(change ? change(reply) : reply); return terminal(pending.generation.id);
  }
  async function inspectCandidate(generation: SkillForgeGeneration) {
    expect(generation.status, JSON.stringify(generation)).toBe('succeeded'); expect(generation.candidateId).not.toBeNull(); let skill = await detail(generation.candidateId!);
    const response = await post(`/api/skills/${skill.id}/inspect`, { expectedRevision: skill.revision }); expect(response.statusCode, response.body).toBe(200); return response.json().skill as Version;
  }
  async function benchmark(baseline: Version, candidate: Version) {
    const currentBaseline = await detail(baseline.id), currentCandidate = await detail(candidate.id);
    const response = await post('/api/skills/benchmarks', { baselineId: baseline.id, baselineRevision: currentBaseline.revision, candidateId: candidate.id, candidateRevision: currentCandidate.revision, suiteId: 'instruction-delivery-v1' }); expect(response.statusCode, response.body).toBe(200);
    let evaluation = SkillBenchmarkEvaluationSchema.parse(response.json()); const deadline = Date.now() + 60000;
    while (evaluation.status === 'running' && Date.now() < deadline) { await delay(100); const read = await application!.app.inject({ url: `/api/skills/benchmarks/${evaluation.id}`, headers: headers() }); expect(read.statusCode, read.body).toBe(200); evaluation = SkillBenchmarkEvaluationSchema.parse(read.json()); }
    expect(evaluation.status, JSON.stringify(evaluation)).toBe('completed'); expect(evaluation.cases).toHaveLength(8); expect(evaluation.cases.every(item => item.status === 'passed')).toBe(true); return evaluation;
  }
  let baseline: Version, first: SkillForgeGeneration, firstCandidate: Version, firstEvaluationId = '';
  beforeAll(async () => {
    base = await realpath(tmpdir()); directory = await realpath(await mkdtemp(join(base, 'mohassan-forge-api-')));
    application = await createApplication({ authSecret: 'forge-api-fixture-auth-secret-000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false,
      skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), testRequestLimit: 1000, ...fixtureLocalModel(modelFetch) });
    const account = { name: 'Forge fixture owner', email: 'forge-owner@example.test', password: 'Forge-Owner-Fixture-Password-42' }, other = { name: 'Other Forge owner', email: 'forge-other@example.test', password: 'Forge-Other-Fixture-Password-42' };
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { ...account, setupToken } }); expect(setup.statusCode, setup.body).toBe(200); await application.database.db.insertInto('workspace_members').values({ user_id: (await application.auth.api.signUpEmail({ body: other })).user.id, role: 'owner' }).execute();
    async function login(credentials: typeof account) { const response = await application!.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: credentials.email, password: credentials.password } }); expect(response.statusCode, response.body).toBe(200); return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; '); }
    cookie = await login(account); otherCookie = await login(other); ownerId = (await application.database.db.selectFrom('user').select('id').where('email', '=', account.email).executeTakeFirstOrThrow()).id;
    baseline = await imported('forge-owned-guidance', '1.0.0');
  }, 60000);
  afterAll(async () => {
    for (const pending of [...pendingReplies]) pending.resolve({ contract: SkillContractSchema.parse({ slug: 'cancelled-fixture', name: 'Cancelled fixture', description: 'Cancelled fixture should never become an active candidate.', category: 'documents', version: '1.0.0', level: 'instruction' }), files: [{ path: 'SKILL.md', content: 'Cancelled fixture.' }] });
    replies.splice(0);
    await application?.app.close(); if (directory) { const target = await realpath(directory), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-forge-api-')) throw new Error('Unsafe Forge fixture cleanup'); await rm(target, { recursive: true, force: true }); }
  });

  it('requires authentication and rejects client evidence, model authority and foreign baselines before a model call', async () => {
    const app = application!.app;
    for (const url of ['/api/skills/forge/status', '/api/skills/forge/generations']) expect((await app.inject({ url, headers: headers('') })).statusCode).toBe(401);
    const status = await app.inject({ url: '/api/skills/forge/status', headers: headers() }); expect(status.statusCode, status.body).toBe(200); expect(status.json()).toMatchObject({ enabled: true, modelConfigured: true, executablePromotionAllowed: false });
    const request = { goal: 'Improve bounded attributable instruction delivery.', baselineId: baseline.id, baselineRevision: baseline.revision, approve: true };
    for (const payload of [{ ...request, approve: false }, { ...request, metrics: { safety: 1 } }, { ...request, lineage: { origin: 'custom' } }, { ...request, targetVersion: '99.0.0' }, { ...request, contract: {} }]) expect((await post('/api/skills/forge/generations', payload)).statusCode).toBe(400);
    expect((await post('/api/skills/forge/generations', request, otherCookie)).statusCode).toBe(404); expect(modelFetch).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent generation requests and stores only a quarantined candidate with actual model accounting', async () => {
    const slot = responseSlot(), key = randomUUID(), request = { goal: 'Improve bounded attributable instruction delivery without expanding authority.', baselineId: baseline.id, baselineRevision: baseline.revision, approve: true };
    const calls = modelFetch.mock.calls.length, responses = await Promise.all([post('/api/skills/forge/generations', request, cookie, key), post('/api/skills/forge/generations', request, cookie, key)]);
    responses.forEach(response => expect(response.statusCode, response.body).toBe(200)); const pending = SkillForgeGenerationSchema.parse(responses[0].json()); expect(SkillForgeGenerationSchema.parse(responses[1].json()).id).toBe(pending.id); expect(pending.status).toBe('running');
    slot.resolve(generated(pending)); first = await terminal(pending.id); expect(modelFetch.mock.calls.length - calls).toBe(1);
    expect(first).toMatchObject({ status: 'succeeded', targetSlug: baseline.slug, automaticActivation: false, usage: { inputTokens: 17, outputTokens: 23 } }); expect(first.responseHash).toMatch(/^[a-f0-9]{64}$/);
    firstCandidate = await detail(first.candidateId!); expect(firstCandidate).toMatchObject({ origin: 'forge', status: 'quarantined', active: false }); expect((await detail(baseline.id)).active).toBe(true);
    expect(await application!.database.db.selectFrom('skill_grants').select('id').execute()).toEqual([]); expect(await application!.database.db.selectFrom('tasks').select('id').execute()).toEqual([]);
    const prompt = JSON.stringify(prompts.at(-1)); expect(prompt).toContain('trainingOnly'); for (const suite of SKILL_BENCHMARK_SUITES) for (const holdout of suite.cases.filter(item => item.split === 'holdout')) expect(prompt).not.toContain(holdout.id);
    const repeated = await post('/api/skills/forge/generations', request, cookie, key); expect(SkillForgeGenerationSchema.parse(repeated.json()).id).toBe(first.id); expect(modelFetch.mock.calls.length - calls).toBe(1);
  }, 60000);

  it('isolates generation reads and promotion authority by owner', async () => {
    const foreign = await application!.app.inject({ url: `/api/skills/forge/generations/${first.id}`, headers: headers(otherCookie) }); expect(foreign.statusCode).toBe(404);
    const page = await application!.app.inject({ url: '/api/skills/forge/generations', headers: headers(otherCookie) }); expect(SkillForgePageSchema.parse(page.json()).items).toEqual([]);
    expect((await post(`/api/skills/forge/generations/${first.id}/promote`, { expectedRevision: firstCandidate.revision, evaluationId: randomUUID(), approve: true }, otherCookie)).statusCode).toBe(404);
    expect((await application!.app.inject({ url: '/api/skills/forge/generations?ownerId=other', headers: headers() })).statusCode).toBe(400);
  });

  it('reads a quarantined generated source as verified plain text without activating or executing it', async () => {
    const before = await detail(firstCandidate.id), app = application!.app;
    const response = await app.inject({ url: `/api/skills/${firstCandidate.id}/file?path=SKILL.md`, headers: headers() }); expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.json()).toMatchObject({ versionId: firstCandidate.id, versionContentHash: firstCandidate.contentHash, contentVerified: true, readOnly: true, file: { path: 'SKILL.md', kind: 'instructions' } });
    expect(response.json().file.content).toContain('Preserve source identifiers.'); expect((await detail(firstCandidate.id))).toEqual(before);
    expect((await app.inject({ url: `/api/skills/${firstCandidate.id}/file?path=SKILL.md`, headers: headers(otherCookie) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/skills/${firstCandidate.id}/file?path=..%2Fescape.md`, headers: headers() })).statusCode).toBe(400);
    expect(await application!.database.db.selectFrom('tasks').select('id').execute()).toEqual([]); expect(await application!.database.db.selectFrom('skill_grants').select('id').execute()).toEqual([]);
  });

  it('cannot activate a Forge candidate through the generic lifecycle without an actual linked benchmark', async () => {
    firstCandidate = await inspectCandidate(first);
    const denied = await post(`/api/skills/${firstCandidate.id}/activate`, { expectedRevision: firstCandidate.revision, approve: true, acknowledgeFindings: true }); expect([403, 409]).toContain(denied.statusCode);
    const forged = await post(`/api/skills/forge/generations/${first.id}/promote`, { expectedRevision: firstCandidate.revision, evaluationId: randomUUID(), approve: true, metrics: { safety: 1 } }); expect(forged.statusCode).toBe(400);
    expect((await detail(firstCandidate.id)).active).toBe(false); expect((await detail(baseline.id)).active).toBe(true);
  });

  it('promotes only with a real paired benchmark and explicit approval, fencing concurrent promotions', async () => {
    const evaluation = await benchmark(baseline, firstCandidate); firstEvaluationId = evaluation.id; firstCandidate = await detail(firstCandidate.id);
    expect((await post(`/api/skills/forge/generations/${first.id}/promote`, { expectedRevision: firstCandidate.revision, evaluationId: evaluation.id, approve: false })).statusCode).toBe(400);
    const request = { expectedRevision: firstCandidate.revision, evaluationId: evaluation.id, approve: true, acknowledgeFindings: true };
    const results = await Promise.all([post(`/api/skills/forge/generations/${first.id}/promote`, request), post(`/api/skills/forge/generations/${first.id}/promote`, request)]);
    expect(results.map(response => response.statusCode).sort()).toEqual([200, 409]); firstCandidate = await detail(firstCandidate.id); expect(firstCandidate).toMatchObject({ active: true, status: 'active' }); expect((await detail(baseline.id)).active).toBe(false);
  }, 90000);

  it('rejects model-selected identity and unsafe paths while keeping executable source behind closed activation gates', async () => {
    const invalidIdentity = await forge(firstCandidate, {}, reply => ({ ...reply, contract: { ...reply.contract, slug: 'model-selected-unauthorized-target' } })); expect(invalidIdentity.status).toBe('failed'); expect(invalidIdentity.candidateId).toBeNull(); expect(invalidIdentity.usage).toEqual({ inputTokens: 17, outputTokens: 23 });
    const invalidPath = await forge(firstCandidate, {}, reply => ({ ...reply, files: [...reply.files, { path: '../escape.md', content: 'Must remain uncommitted data.' }] })); expect(invalidPath.status).toBe('failed'); expect(invalidPath.candidateId).toBeNull();
    const executable = await forge(firstCandidate, {}, reply => ({ contract: SkillContractSchema.parse({ ...reply.contract, level: 'executable', verification: 'Check the bounded script output.', execution: { timeoutMs: 1000, memoryMb: 32, outputMaxBytes: 1024 }, steps: [{ id: 'script', title: 'Unsupported script', kind: 'script', entry: 'scripts/main.mjs' }] }), files: [...reply.files, { path: 'scripts/main.mjs', content: 'throw new Error("This fixture must never execute");' }] }));
    expect(executable.status, JSON.stringify(executable)).toBe('succeeded'); expect((await detail(executable.candidateId!))).toMatchObject({ level: 'executable', status: 'quarantined', active: false });
    const inspected = await inspectCandidate(executable);
    for (const url of [`/api/skills/${inspected.id}/activate`, `/api/skills/forge/generations/${executable.id}/promote`]) {
      const denied = await post(url, { expectedRevision: inspected.revision, evaluationId: firstEvaluationId, approve: true, acknowledgeFindings: true }); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SKILL_EXECUTABLE_GATES_CLOSED');
    }
    expect((await detail(firstCandidate.id)).active).toBe(true); expect((await detail(inspected.id)).active).toBe(false); expect(await application!.database.db.selectFrom('tasks').select('id').execute()).toEqual([]);
  }, 90000);

  it('restores a previously measured Forge version through the existing explicit rollback path', async () => {
    const second = await forge(firstCandidate), next = await inspectCandidate(second), evaluation = await benchmark(firstCandidate, next);
    const promoted = await post(`/api/skills/forge/generations/${second.id}/promote`, { expectedRevision: next.revision, evaluationId: evaluation.id, approve: true, acknowledgeFindings: true }); expect(promoted.statusCode, promoted.body).toBe(200);
    const previous = await detail(firstCandidate.id); expect(previous.status).toBe('deprecated');
    const denied = await post(`/api/skills/${previous.id}/rollback`, { expectedRevision: previous.revision, approve: true, reason: 'Restore the earlier independently measured guidance.' }); expect([403, 409]).toContain(denied.statusCode);
    const restored = await post(`/api/skills/${previous.id}/rollback`, { expectedRevision: previous.revision, evaluationId: firstEvaluationId, approve: true, reason: 'Restore the earlier independently measured guidance.' }); expect(restored.statusCode, restored.body).toBe(200);
    firstCandidate = await detail(previous.id); expect(firstCandidate.active).toBe(true); expect((await detail(next.id)).active).toBe(false);
  }, 90000);

  it('retains late model accounting after real lease recovery without storing a late candidate or replaying the paid call', async () => {
    const calls = modelFetch.mock.calls.length, pending = await begin(firstCandidate);
    await application!.database.db.updateTable('skill_forge_generations').set({ lease_expires_at: new Date(Date.now() - 1000) }).where('id', '=', pending.generation.id).where('owner_id', '=', ownerId).execute();
    const recovered = await post('/api/skills/forge/generations', pending.request, cookie, pending.key); expect(recovered.statusCode, recovered.body).toBe(200); expect(SkillForgeGenerationSchema.parse(recovered.json()).status).toBe('unknown');
    pending.slot.resolve(generated(pending.generation));
    let result: SkillForgeGeneration | undefined; const deadline = Date.now() + 10000;
    do { result = await terminal(pending.generation.id); if (result.usage) break; await delay(20); } while (Date.now() < deadline);
    expect(result).toMatchObject({ status: 'unknown', candidateId: null, candidateContentHash: null, usage: { inputTokens: 17, outputTokens: 23 } }); expect(result!.responseHash).toMatch(/^[a-f0-9]{64}$/);
    const repeated = await post('/api/skills/forge/generations', pending.request, cookie, pending.key); expect(SkillForgeGenerationSchema.parse(repeated.json()).status).toBe('unknown'); expect(modelFetch.mock.calls.length - calls).toBe(1);
    expect((await detail(firstCandidate.id)).active).toBe(true);
  }, 60000);

  it('rejects promotion if another approved version became current after the candidate baseline was pinned', async () => {
    const initial = await imported('forge-race-guidance', '1.0.0'), replacement = await imported('forge-race-guidance', '2.0.0', false);
    const generation = await forge(initial), candidate = await inspectCandidate(generation), evaluation = await benchmark(initial, candidate);
    const changed = await post(`/api/skills/${replacement.id}/activate`, { expectedRevision: replacement.revision, approve: true, acknowledgeFindings: true }); expect(changed.statusCode, changed.body).toBe(200);
    const promote = await post(`/api/skills/forge/generations/${generation.id}/promote`, { expectedRevision: candidate.revision, evaluationId: evaluation.id, approve: true, acknowledgeFindings: true }); expect(promote.statusCode, promote.body).toBe(409);
    expect((await detail(replacement.id)).active).toBe(true); expect((await detail(candidate.id)).active).toBe(false);
  }, 90000);

  it('forks a builtin only to an explicit new owner-selected slug', async () => {
    const list = await application!.app.inject({ url: '/api/skills', headers: headers() }); expect(list.statusCode, list.body).toBe(200);
    let builtin = list.json().items.find((item: Version) => item.slug === 'arabic-editing-review') as Version; expect(builtin).toBeDefined();
    const original = await application!.app.inject({ url: `/api/skills/${builtin.id}`, headers: headers() }); expect(original.json().source.kind).toBe('builtin');
    const inspected = await post(`/api/skills/${builtin.id}/inspect`, { expectedRevision: builtin.revision }); expect(inspected.statusCode, inspected.body).toBe(200); builtin = inspected.json().skill;
    const rejected = await post('/api/skills/forge/generations', { goal: 'Refine builtin guidance while preserving source evidence.', baselineId: builtin.id, baselineRevision: builtin.revision, approve: true }); expect([403, 409]).toContain(rejected.statusCode);
    const forked = await forge(builtin, { targetSlug: 'forge-owner-selected-fork' }); expect(forked).toMatchObject({ status: 'succeeded', mode: 'fork', targetSlug: 'forge-owner-selected-fork' });
    const candidate = await detail(forked.candidateId!); expect(candidate).toMatchObject({ slug: 'forge-owner-selected-fork', origin: 'forge', status: 'quarantined', active: false }); expect(candidate.familyId).not.toBe(builtin.familyId); expect(await detail(builtin.id)).toEqual(builtin);
  }, 60000);
});
