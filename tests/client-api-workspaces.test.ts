import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AIProviderSettingsInputSchema, AIProvidersStatusSchema, CodingWorkspaceSchema, CreateTaskSchema,
  PhoneServerErrorReplySchema, ProjectSchema, RegisterProjectSchema,
  SkillBenchmarkPageSchema, SkillForgePageSchema, SkillForgeStatusSchema,
  SkillGapPageSchema, SkillGraphSnapshotSchema, SkillPortfolioSchema, SkillRegistryResultSchema,
  SkillRemoteStatusSchema, SkillSandboxDiagnosticSchema, StudioPreviewSchema, StudioSessionSchema,
  TaskDetailSchema, TaskSchema, WorkspaceSnapshotSchema,
} from '@mohassan/contracts';
import { BrowserActionSchema, BrowserCreateSchema, BrowserPrepareSchema, ResearchCreateSchema } from '@mohassan/browser';
import { TRAINING_MINIMUM_UNIQUE_EXPERIENCES } from '@mohassan/learning';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';
import { validateContract } from './support/client-api-contract.js';

vi.mock('../apps/server/src/training-monitor/gpu.js', () => ({ createGpuSampler: () => async () => null }));

// Wire wrappers without shared schemas follow the 29448ae handlers and web consumers.
// Sources retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/tree/29448ae/apps/server/src
// https://github.com/ahmadalwakai/Mohassan-AI/tree/29448ae/apps/web/components
const items = <T>(schema: z.ZodType<T>) => z.object({ items: z.array(schema) });
const browserWorkspace = z.object({
  sessions: z.array(z.object({
    id: z.uuid(), title: z.string(), status: z.string(), expires_at: z.string(), updated_at: z.string(), sequence: z.number(),
  })),
  research: z.array(z.object({
    id: z.uuid(), question: z.string(), status: z.string(), created_at: z.string(), error: z.string().nullable(),
  })),
});
const desktopDisabled = z.object({
  enabled: z.literal(false), platform: z.string(), native: z.literal(false), projects: z.literal(0),
  templates: z.tuple([]), apps: z.tuple([]), recent: z.tuple([]),
});
const learningEntry = z.object({ id: z.string(), status: z.string(), version: z.number().int(), title: z.string().optional(), text: z.string().optional() });
const experience = z.object({ sourceKind: z.string(), sourceId: z.string(), attempt: z.number().int(), goal: z.string(), category: z.string(), outcome: z.string() });
const learningReadiness = z.object({
  requiredUnique: z.literal(TRAINING_MINIMUM_UNIQUE_EXPERIENCES), complete: z.boolean(),
  roles: z.object({ routing: z.object({ eligibleUnique: z.number().int(), ready: z.boolean() }) }),
});
const unconfiguredLive = z.object({ available: z.literal(false), status: z.literal('unconfigured'), message: z.string() });
const emptyBrowserSession = z.object({
  id: z.uuid(), title: z.string(), allowedOrigins: z.array(z.url()), status: z.enum(['open', 'closed']),
  live: z.literal(false), expired: z.boolean(), expiresAt: z.iso.datetime(), sequence: z.number().int(),
  observation: z.null(), events: z.array(z.object({
    id: z.string(), kind: z.string(), message: z.string(), createdAt: z.iso.datetime(),
  })), approvals: z.tuple([]),
});
const researchRun = z.object({
  id: z.uuid(), question: z.string(), status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: z.iso.datetime(), error: z.string().nullable(), report: z.object({
    id: z.uuid(), question: z.string(), provider: z.string(), createdAt: z.iso.datetime(), plan: z.array(z.string()),
    sources: z.array(z.object({ id: z.uuid(), title: z.string(), url: z.url(), accessedAt: z.iso.datetime(),
      contentHash: z.string(), quote: z.string(), text: z.string() })),
    claims: z.array(z.object({ text: z.string(), sourceIds: z.array(z.uuid()) })),
    conflicts: z.array(z.object({ sourceIds: z.array(z.uuid()), description: z.string(), status: z.literal('needs_review') })),
    coverage: z.object({ requested: z.number(), read: z.number(), failed: z.array(z.object({ url: z.string(), reason: z.string() })),
      limitations: z.array(z.string()) }),
  }).nullable(),
});
const workspaceReads: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['/api/workspace', WorkspaceSnapshotSchema],
  ['/api/coding/projects', CodingWorkspaceSchema],
  ['/api/studio/ai/status', z.object({ available: z.boolean(), visionAvailable: z.boolean(), model: z.string(), visionModel: z.string().nullable(), message: z.string() })],
  ['/api/desktop', desktopDisabled],
  ['/api/learning/content', z.object({
    lessons: z.array(learningEntry), documents: z.array(learningEntry),
    evaluations: z.array(z.object({ subject_id: z.string(), status: z.string(), report: z.unknown() })),
    evaluationAvailable: z.boolean(), importsAvailable: z.boolean(),
  })],
  ['/api/learning/experiences', items(experience)],
  ['/api/learning/training-readiness', learningReadiness],
  ['/api/ai/providers', AIProvidersStatusSchema],
  ['/api/skills', SkillRegistryResultSchema],
  ['/api/skills/portfolio', SkillPortfolioSchema],
  ['/api/skills/graph', SkillGraphSnapshotSchema],
  ['/api/skills/gaps', SkillGapPageSchema],
  ['/api/skills/sandbox', SkillSandboxDiagnosticSchema],
  ['/api/skills/forge/status', SkillForgeStatusSchema],
  ['/api/skills/forge/generations', SkillForgePageSchema],
  ['/api/skills/benchmarks', SkillBenchmarkPageSchema],
  ['/api/skills/remote', SkillRemoteStatusSchema],
];

let fixture: Awaited<ReturnType<typeof openClientApiApp>> | undefined;
let owner: ClientApiAccount;
let member: ClientApiAccount;
let statusDirectory: string | undefined;
let source: Server | undefined;
let browserOrigin: string;

beforeAll(async () => {
  source = createServer((request, response) => {
    if (request.url === '/slow') return;
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(
      '<!doctype html><title>Contract source</title><main>The production contract checks response fields from a local fixture.</main>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    source!.once('error', reject);
    source!.listen(0, '127.0.0.1', resolve);
  });
  const address = source.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture source address');
  browserOrigin = `http://127.0.0.1:${address.port}`;
  statusDirectory = await mkdtemp(join(tmpdir(), 'mohassan-client-training-status-'));
  // Exercise the existing status reader with metadata only, following tests/training-monitor-route.test.ts.
  const status = join(statusDirectory, 'artifacts/execution-model-runs/fixture-run/85m');
  await mkdir(status, { recursive: true });
  await writeFile(join(status, 'status.json'), JSON.stringify({ status: 'running', updated_at: new Date().toISOString() }));
  fixture = await openClientApiApp({ trainingMonitorRoot: statusDirectory, browser: { testOrigins: [browserOrigin] } });
  owner = await fixture.setupOwner();
  member = await fixture.inviteMember(owner);
});

afterAll(async () => {
  try { await fixture?.close(); }
  finally {
    source?.closeAllConnections();
    if (source?.listening) await new Promise<void>(resolve => source!.close(() => resolve()));
    if (statusDirectory) await rm(statusDirectory, { recursive: true, force: true });
  }
});

describe('client API workspace contracts', () => {
  it.each(workspaceReads)('validates GET %s from the real app', async (url, schema) => {
    checkJson(await fixture!.send('GET', url, owner), 200, schema);
  });

  it('validates the owner training-status snapshot against its shared TypeScript interface', async () => {
    const response = await fixture!.send('GET', '/api/training-monitor', owner);
    expect(response.statusCode).toBe(200);
    validateContract('TrainingMonitorSnapshot', response.json());
    expect(response.json()).toMatchObject({ active: { run: 'fixture-run' }, gpu: null });
  });

  it('validates the disabled executor and its Ads status without a model or network', async () => {
    // The executor status probes an optional local Ollama inventory. Simulate an unavailable process.
    vi.stubGlobal('fetch', async () => { throw new Error('unavailable in the client contract test'); });
    try {
      checkJson(await fixture!.send('GET', '/api/executor/status', owner), 200, z.object({
        experiment: z.object({ enabled: z.literal(false), mode: z.null(), contained: z.literal(false) }),
        executor: z.object({ state: z.literal('disabled'), message: z.string(), load: z.null(), busy: z.boolean() }),
        reasoning: z.object({ provider: z.string(), configured: z.literal(false), available: z.literal(false), model: z.null(), message: z.string() }),
        ollama: z.object({ status: z.literal('unreachable'), origin: z.string() }),
        sandbox: z.object({ available: z.boolean(), provider: z.string().nullable(), message: z.string() }),
        tasks: z.array(z.object({ capability: z.string(), family: z.string(), output: z.string(), required: z.array(z.string()) })),
      }));
      checkJson(await fixture!.send('GET', '/api/executor/ads/status', owner), 200, z.object({
        enabled: z.literal(false), available: z.literal(false), message: z.string(), run: z.null(), device: z.string(),
        worker: z.object({ state: z.literal('stopped'), error: z.null(), model: z.null() }),
        trained: z.tuple([]), heldOut: z.tuple([]),
      }));
    } finally { vi.unstubAllGlobals(); }
    const runId = randomUUID();
    checkError(await fixture!.send('POST', '/api/executor/check', owner, {}), 409, 'DISABLED');
    checkJson(await fixture!.send('POST', '/api/executor/runs', owner, {
      runId, mode: 'direct', capability: 'json.transform.v1:integers-to-strings', fields: {},
    }), 200, z.object({
      runId: z.literal(runId), mode: z.literal('direct'), capability: z.string(), status: z.literal('disabled'), message: z.string(),
      submitted: z.object({ capability: z.string(), fields: z.null() }),
      executor: z.object({ kind: z.string(), transport: z.string(), contained: z.literal(false), modelVersion: z.null(),
        checkpointId: z.null(), tokenizerId: z.null(), device: z.string(), called: z.literal(false) }),
      external: z.tuple([]), candidate: z.null(), verification: z.null(),
      timing: z.object({ totalMs: z.number(), executorMs: z.null() }), startedAt: z.iso.datetime(),
    }));
    checkJson(await fixture!.send('DELETE', `/api/executor/runs/${runId}`, owner), 200, z.object({ cancelled: z.literal(false) }));
    checkError(await fixture!.send('POST', '/api/executor/ads/runs', owner, {}), 404, 'DISABLED');
    checkJson(await fixture!.send('POST', '/api/executor/ads/stop', owner, {}), 200, z.object({ stopped: z.literal(true) }));
  });

  it('validates provider settings and refusal when no provider is configured', async () => {
    const settings = AIProviderSettingsInputSchema.parse({
      enabled: false, models: ['contract-test/disabled-provider'], automaticFallback: false, freeOnly: true,
    });
    const response = checkJson(await fixture!.send('POST', '/api/ai/providers/freellmapi/settings', owner, settings), 200, AIProvidersStatusSchema);
    expect(response.freellmapi.settings).toEqual(settings);
    checkError(await fixture!.send('POST', '/api/ai/providers/freellmapi/settings', owner, { ...settings, enabled: true }), 409, 'FREELLMAPI_NOT_CONFIGURED');
    checkError(await fixture!.send('POST', '/api/ai/providers/freellmapi/check', owner, {}), 409, 'NOT_CONFIGURED');
    checkError(await fixture!.send('POST', '/api/ai/verify', owner, {}), 409, 'NOT_CONFIGURED');
  });

  it('validates the training export refusal on an empty learning database', async () => {
    const response = checkJson(await fixture!.send('POST', '/api/learning/training-export', owner, {}), 409,
      PhoneServerErrorReplySchema.extend({ status: z.literal('blocked'), dataset: z.null(), readiness: learningReadiness }));
    expect(response.error.code).toBe('TRAINING_DATA_NOT_READY');
    expect(response.readiness.roles.routing.ready).toBe(false);
  });

  it('validates task creation, detail, cancellation and the missing-task error', async () => {
    const input = CreateTaskSchema.parse({ title: 'System diagnostic', goal: 'Check the local environment.', capabilityId: 'system.diagnostic', autonomy: 'assisted' });
    const task = checkJson(await fixture!.send('POST', '/api/tasks', owner, input, { 'idempotency-key': 'client-contract-task' }), 200, TaskSchema);
    const detail = checkJson(await fixture!.send('GET', `/api/tasks/${task.id}`, owner), 200, TaskDetailSchema);
    expect(detail.task.id).toBe(task.id);
    expect(detail.events.length).toBeGreaterThan(0);
    checkJson(await fixture!.send('POST', `/api/tasks/${task.id}/cancel`, owner), 200, TaskSchema);
    checkError(await fixture!.send('POST', `/api/tasks/${task.id}/approve`, owner), 409, 'APPROVAL_STATE_CONFLICT');
    checkError(await fixture!.send('GET', `/api/tasks/${randomUUID()}`, owner), 404, 'TASK_NOT_FOUND');
    checkError(await fixture!.send('GET', `/api/tasks/${task.id}`, member), 403, 'MEMBER_FORBIDDEN');
  });

  it('validates a browser session lifecycle before any navigation', async () => {
    const input = BrowserCreateSchema.parse({ title: 'Contract test session', allowedOrigins: [browserOrigin] });
    const session = checkJson(await fixture!.send('POST', '/api/browser/sessions', owner, input), 200, emptyBrowserSession);
    const root = '/api/browser/sessions';
    const path = `${root}/${session.id}`;
    expect(checkJson(await fixture!.send('GET', path, owner), 200, emptyBrowserSession).status).toBe('open');
    const workspace = checkJson(await fixture!.send('GET', '/api/browser/workspace', owner), 200, browserWorkspace);
    expect(workspace.sessions[0]?.id).toBe(session.id);
    checkJson(await fixture!.send('GET', `${path}/observations?limit=50`, owner), 200, z.object({ observations: z.tuple([]) }));
    const stale = randomUUID();
    const action = BrowserActionSchema.parse({ action: 'read', expectedObservationId: stale });
    checkError(await fixture!.send('POST', `${path}/actions`, owner, action), 409, 'BROWSER_OBSERVATION_CHANGED');
    const prepare = BrowserPrepareSchema.parse({ observationId: stale, formId: 'f0', values: {} });
    checkError(await fixture!.send('POST', `${path}/prepare-submit`, owner, prepare), 409, 'BROWSER_OBSERVATION_CHANGED');
    checkError(await fixture!.send('POST', `${path}/approvals/${stale}/approve`, owner, {}), 409, 'BROWSER_APPROVAL_INVALID');
    checkError(await fixture!.send('POST', `${path}/approvals/${stale}/revoke`, owner, {}), 409, 'BROWSER_APPROVAL_INVALID');
    expect(checkJson(await fixture!.send('POST', `${path}/close`, owner, {}), 200, emptyBrowserSession).status).toBe('closed');
  });

  it('validates a completed and a cancelled research run on a loopback source', async () => {
    const url = '/api/research/runs';
    const input = ResearchCreateSchema.parse({ question: 'What does the contract check?', sourceUrls: [browserOrigin], sourceBudget: 1 });
    const run = checkJson(await fixture!.send('POST', url, owner, input), 200, researchRun);
    const read = async () => checkJson(await fixture!.send('GET', `${url}/${run.id}`, owner), 200, researchRun);
    await expect.poll(async () => (await read()).status).toBe('completed');
    const completed = await read();
    expect(completed.report?.sources[0]?.title).toBe('Contract source');

    const pending = checkJson(await fixture!.send('POST', url, owner, { ...input, sourceUrls: [`${browserOrigin}/slow`] }), 200, researchRun);
    const stopped = checkJson(await fixture!.send('POST', `${url}/${pending.id}/cancel`, owner, {}), 200, researchRun);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.report).toBeNull();
  });

  it('validates a static studio session and its local previews', async () => {
    const session = checkJson(await fixture!.send('POST', '/api/studio/sessions/demo', owner, { framework: 'static' }), 200, StudioSessionSchema);
    const path = `/api/studio/sessions/${session.id}`;
    expect(checkJson(await fixture!.send('GET', path, owner), 200, StudioSessionSchema).revision).toBe(session.revision);
    checkJson(await fixture!.send('GET', `${path}/baseline`, owner), 200, StudioPreviewSchema);
    checkJson(await fixture!.send('GET', `${path}/live`, owner), 200, unconfiguredLive);
    checkJson(await fixture!.send('POST', `${path}/live/stop`, owner, {}), 200, unconfiguredLive);

  });

  it('validates coding demo registration using the built-in local fixture', async () => {
    const demo = checkJson(await fixture!.send('POST', '/api/coding/projects/demo', owner, {}), 200, ProjectSchema);
    const input = RegisterProjectSchema.parse({ name: demo.name, path: demo.path, allowedPaths: demo.allowedPaths });
    const registered = checkJson(await fixture!.send('POST', '/api/coding/projects', owner, input), 200, ProjectSchema);
    expect(registered.id).toBe(demo.id);
  });
});
