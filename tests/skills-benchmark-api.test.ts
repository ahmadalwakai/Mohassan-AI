import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillBenchmarkCatalogSchema, SkillBenchmarkEvaluationSchema, SkillBenchmarkPageSchema, SkillContractSchema, SkillPortfolioSchema, SkillQualityDetailSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.ts';

describe('authenticated isolated skill benchmark API and measured portfolio', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory = '', tempBase = '', cookie = '', otherCookie = '', ownerId = '';
  const origin = 'http://127.0.0.1:3000', secret = 'benchmark-api-internal-fixture-secret-00001', setupToken = 'benchmark-api-setup-fixture-token-00001';
  const headers = (session = cookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  type Version = Awaited<ReturnType<NonNullable<typeof application>['skills']['detail']>>['skill'];
  let baseline: Version, candidate: Version;
  beforeAll(async () => {
    tempBase = await realpath(tmpdir()); directory = await realpath(await mkdtemp(join(tempBase, 'mohassan-benchmark-api-')));
    application = await createApplication({ authSecret: 'benchmark-api-auth-fixture-secret-00000001', internalSecret: secret, setupToken, webOrigin: origin,
      production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), testRequestLimit: 1000 });
    const account = { name: 'Benchmark fixture owner', email: 'benchmark-owner@example.test', password: 'Benchmark-Fixture-Password-42' };
    const other = { name: 'Other benchmark fixture', email: 'benchmark-other@example.test', password: 'Benchmark-Other-Fixture-Password-42' };
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { ...account, setupToken } }); expect(setup.statusCode, setup.body).toBe(200);
    await application.auth.api.signUpEmail({ body: other });
    async function login(credentials: typeof account) {
      const response = await application!.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: credentials.email, password: credentials.password } });
      expect(response.statusCode, response.body).toBe(200);
      return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    }
    cookie = await login(account); otherCookie = await login(other);
    ownerId = (await application.database.db.selectFrom('user').select('id').where('email', '=', account.email).executeTakeFirstOrThrow()).id;
    async function imported(version: string, text: string) {
      const folder = join(directory, version); await mkdir(folder);
      const contract = SkillContractSchema.parse({ slug: 'measured-context-guide', name: 'Measured context guide', description: 'Bounded instructions with attributable source evidence.', category: 'documents', version, level: 'instruction' });
      await writeFile(join(folder, 'SKILL.md'), `---\nname: measured-context-guide\ndescription: Bounded instructions with attributable source evidence.\nversion: ${version}\n---\n${text}\n`);
      await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
      const imported = await application!.app.inject({ method: 'POST', url: '/api/skills/import', headers: headers(), payload: { path: folder } });
      expect(imported.statusCode, imported.body).toBe(200);
      const skill = imported.json().skill;
      const inspected = await application!.app.inject({ method: 'POST', url: `/api/skills/${skill.id}/inspect`, headers: headers(), payload: { expectedRevision: skill.revision } });
      expect(inspected.statusCode, inspected.body).toBe(200); return inspected.json().skill as Version;
    }
    baseline = await imported('1.0.0', 'Keep the original meaning and identify the sources you used.');
    candidate = await imported('1.0.1', 'Keep the original meaning, identify the sources you used, and state uncertainty.');
  }, 60000);
  afterAll(async () => {
    await application?.app.close();
    if (directory) { const target = await realpath(directory), inside = relative(tempBase, target);
      if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-benchmark-api-')) throw new Error('Unsafe benchmark API fixture cleanup');
      await rm(target, { recursive: true, force: true });
    }
  });
  const request = () => ({ baselineId: baseline.id, baselineRevision: baseline.revision, candidateId: candidate.id, candidateRevision: candidate.revision, suiteId: 'instruction-delivery-v1' });
  let evaluationId = '';

  it('protects measured reads and exposes only trusted suite metadata', async () => {
    const app = application!.app;
    for (const url of ['/api/skills/benchmarks/suites', '/api/skills/benchmarks', '/api/skills/portfolio', `/api/skills/${candidate.id}/quality`]) {
      expect((await app.inject({ url, headers: headers('') })).statusCode).toBe(401);
    }
    const response = await app.inject({ url: '/api/skills/benchmarks/suites', headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    const catalog = SkillBenchmarkCatalogSchema.parse(response.json()); expect(catalog.enabled).toBe(true); expect(catalog.suites).toHaveLength(3);
    expect(catalog.suites.every(suite => suite.trainingCases > 0 && suite.holdoutCases > 0)).toBe(true);
    for (const suite of catalog.suites) for (const field of ['expectedOutput', 'oracle', 'fixtures', 'cases']) expect(suite).not.toHaveProperty(field);
    expect((await app.inject({ url: '/api/skills/benchmarks/suites?ownerId=other', headers: headers() })).statusCode).toBe(400);
    const initial = await app.inject({ url: `/api/skills/${candidate.id}/quality`, headers: headers() });
    expect(SkillQualityDetailSchema.parse(initial.json()).coverage).toBe('none');
  });

  it('rejects forged metrics, foreign pins and unknown cases before any experiment dispatch', async () => {
    const app = application!.app;
    for (const payload of [{ ...request(), cases: [{ status: 'passed' }] }, { ...request(), metrics: { safety: 1 } }, { ...request(), suiteId: 'client-defined-suite' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/skills/benchmarks', headers: { ...headers(), 'idempotency-key': randomUUID() }, payload });
      expect(response.statusCode, response.body).toBe(400);
    }
    const foreign = await app.inject({ method: 'POST', url: '/api/skills/benchmarks', headers: { ...headers(otherCookie), 'idempotency-key': randomUUID() }, payload: request() });
    expect(foreign.statusCode).toBe(404);
    const empty = await app.inject({ url: '/api/skills/benchmarks', headers: headers() }); expect(SkillBenchmarkPageSchema.parse(empty.json()).total).toBe(0);
  });

  it('runs one real isolated pair for concurrent duplicate requests and preserves actual candidate authority', async () => {
    const app = application!.app, key = randomUUID(), before = await application!.skills.detail(ownerId, candidate.id);
    const start = () => app.inject({ method: 'POST', url: '/api/skills/benchmarks', headers: { ...headers(), 'idempotency-key': key }, payload: request() });
    const responses = await Promise.all([start(), start()]);
    responses.forEach(response => expect(response.statusCode, response.body).toBe(200));
    const first = SkillBenchmarkEvaluationSchema.parse(responses[0].json()), second = SkillBenchmarkEvaluationSchema.parse(responses[1].json());
    expect(second.id).toBe(first.id); evaluationId = first.id;
    let result = first;
    const deadline = Date.now() + 60000;
    while (result.status === 'running' && Date.now() < deadline) {
      await delay(100);
      const response = await app.inject({ url: `/api/skills/benchmarks/${result.id}`, headers: headers() }); expect(response.statusCode, response.body).toBe(200);
      result = SkillBenchmarkEvaluationSchema.parse(response.json());
    }
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.cases).toHaveLength(result.suite.cases.length * 2);
    expect(result.cases.every(item => item.status === 'passed')).toBe(true);
    expect(result.cases.every(item => item.scope === 'instruction_delivery' && item.metrics.costUsd === null && item.outputHash && item.evidence.length > 0)).toBe(true);
    expect(result.baseline.contentHash).toBe(baseline.contentHash); expect(result.candidate.contentHash).toBe(candidate.contentHash);
    const after = await application!.skills.detail(ownerId, candidate.id);
    expect(after.skill).toEqual(before.skill); expect(after.grants).toEqual(before.grants);
    expect(await application!.database.db.selectFrom('tasks').select('id').execute()).toEqual([]);
    const repeated = SkillBenchmarkEvaluationSchema.parse((await start()).json()); expect(repeated.id).toBe(result.id); expect(repeated.cases).toEqual(result.cases);
    const listed = SkillBenchmarkPageSchema.parse((await app.inject({ url: `/api/skills/benchmarks?versionId=${candidate.id}`, headers: headers() })).json());
    expect(listed.total).toBe(1); expect(listed.items[0].id).toBe(result.id);
  }, 90000);

  it('reports measured coverage without semantic or price claims and isolates every owner read', async () => {
    const app = application!.app;
    const detail = SkillQualityDetailSchema.parse((await app.inject({ url: `/api/skills/${candidate.id}/quality`, headers: headers() })).json());
    expect(detail.coverage).toBe('measured'); expect(detail.evaluations[0].evaluationId).toBe(evaluationId);
    expect(detail.evaluations[0].semanticQuality).toBeNull(); expect(detail.evaluations[0].automaticPromotion).toBe(false);
    expect(detail.evaluations[0].candidate.usage.monetaryCost).toBeNull();
    const portfolio = SkillPortfolioSchema.parse((await app.inject({ url: '/api/skills/portfolio', headers: headers() })).json());
    expect(portfolio.items.some(item => item.id === candidate.id)).toBe(true); expect(portfolio.permissionsGranted).toBe(false);
    const foreign = SkillBenchmarkPageSchema.parse((await app.inject({ url: '/api/skills/benchmarks', headers: headers(otherCookie) })).json()); expect(foreign.items).toEqual([]);
    expect((await app.inject({ url: `/api/skills/benchmarks/${evaluationId}`, headers: headers(otherCookie) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/skills/${candidate.id}/quality`, headers: headers(otherCookie) })).statusCode).toBe(404);
    for (const url of ['/api/skills/benchmarks?limit=51', '/api/skills/portfolio?limit=51', `/api/skills/${candidate.id}/quality?score=100`]) expect((await app.inject({ url, headers: headers() })).statusCode).toBe(400);
  });

  it('keeps diagnostics readable while refusing experiment dispatch when the engine is disabled', async () => {
    const disabled = await createApplication({ authSecret: 'benchmark-api-disabled-auth-secret-00001', internalSecret: secret, setupToken, webOrigin: origin,
      production: false, runWorker: false, skillEngineEnabled: false, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'disabled-browser') });
    try {
      const account = { name: 'Disabled benchmark fixture', email: 'disabled-benchmark@example.test', password: 'Disabled-Benchmark-Fixture-42' };
      await disabled.auth.api.signUpEmail({ body: account });
      const login = await disabled.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: account.email, password: account.password } });
      expect(login.statusCode, login.body).toBe(200);
      const session = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
      const catalog = await disabled.app.inject({ url: '/api/skills/benchmarks/suites', headers: headers(session) });
      expect(SkillBenchmarkCatalogSchema.parse(catalog.json()).enabled).toBe(false);
      const response = await disabled.app.inject({ method: 'POST', url: '/api/skills/benchmarks', headers: { ...headers(session), 'idempotency-key': randomUUID() }, payload: request() });
      expect(response.statusCode, response.body).toBe(403); expect(response.json().error.code).toBe('SKILL_ENGINE_DISABLED');
      expect(SkillBenchmarkPageSchema.parse((await disabled.app.inject({ url: '/api/skills/benchmarks', headers: headers(session) })).json()).total).toBe(0);
    } finally { await disabled.app.close(); }
  }, 60000);
});
