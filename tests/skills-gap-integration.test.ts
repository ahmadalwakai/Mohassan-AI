import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { SkillGapPageSchema, type SkillGapSignal } from '../packages/contracts/src/skill-gaps.ts';
import { SkillContractSchema, SkillRunGapReportSchema } from '@mohassan/contracts';
import { recordSkillGap } from '../packages/skills/src/gaps.ts';
import { fixtureLocalModel } from './fixtures/local-model.js';

describe('actual authenticated capability gap API over disposable local state', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined, directory = '', base = '', cookie = '', otherCookie = '', ownerId = '', otherId = '', foreignRunId = '';
  const origin = 'http://127.0.0.1:3000', secret = 'gap-api-fixture-internal-secret-0000001', setupToken = 'gap-api-fixture-setup-token-000000001';
  const sensitiveMarker = 'SYNTHETIC_GAP_PRIVATE_TEXT_83fb9c';
  const headers = (session = cookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  const modelFetch = vi.fn<typeof fetch>(async (_input, init) => Response.json({
    model: JSON.parse(String(init?.body ?? '{}')).model ?? 'openai/gpt-oss-20b', choices: [{ message: { content: JSON.stringify({ thought: null, plan: null, note: null, tool: 'answer', url: null, ref: null, text: `${sensitiveMarker}: missing_tool sandbox unavailable; these are model words only.`, submit: null, options: null, sensitive: null, outcome: 'blocked' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 12 },
  }));
  const ownedRuns: string[] = [];
  let pendingRun: { id: string; nodeId: string; childId: string } | undefined;
  async function runFixture() {
    if (pendingRun) return pendingRun;
    const f = application!, folder = join(directory, 'skill'), files = join(directory, 'files'); await mkdir(folder); await mkdir(join(files, 'reports'), { recursive: true });
    const field = (name: string, type: string) => ({ name, type, description: `Fixture ${name}` });
    const contract = SkillContractSchema.parse({ slug: 'gap-pending-writer', name: 'Gap pending writer', description: 'A file write fixture that remains behind child approval.', category: 'documents', version: '1.0.0', level: 'tool', inputs: [field('root', 'file'), field('path', 'file'), field('content', 'string'), field('expectedHash', 'json')], outputs: [field('hash', 'string')], requires: { tools: ['file.write'], paths: ['reports'] }, sideEffects: 'write_local', rollback: { mode: 'restore_preimage' }, idempotent: true, verification: 'Verify bounded file output with its persisted hash.', steps: [{ id: 'write', kind: 'tool', tool: 'file.write', title: 'Pending controlled write', inputs: { root: 'input.root', path: 'input.path', content: 'input.content', expectedHash: 'input.expectedHash' }, outputs: [field('hash', 'string')] }] });
    await writeFile(join(folder, 'SKILL.md'), '---\nname: gap-pending-writer\ndescription: A file write fixture that remains behind child approval.\n---\nWrite only after explicit independent approval.'); await writeFile(join(folder, 'skill.contract.json'), JSON.stringify(contract));
    let version = (await f.skills.importLocal(ownerId, { path: folder })).skill;
    version = (await f.skills.inspect(ownerId, version.id, { expectedRevision: version.revision })).skill;
    version = (await f.skills.activate(ownerId, version.id, { expectedRevision: version.revision, approve: true, acknowledgeFindings: true })).skill;
    await f.skills.createGrant(ownerId, version.id, { expectedRevision: version.revision, approve: true, tools: ['file.write'], roots: [files], durationHours: 1 });
    version = (await f.skills.detail(ownerId, version.id)).skill;
    const created = await f.app.inject({ method: 'POST', url: `/api/skills/${version.id}/run`, headers: { ...headers(), 'idempotency-key': randomUUID() }, payload: { expectedRevision: version.revision, values: { root: files, path: 'reports/not-written.txt', content: sensitiveMarker, expectedHash: null } } }); expect(created.statusCode, created.body).toBe(200);
    const parentId = created.json().task.id;
    expect((await f.app.inject({ method: 'POST', url: `/api/tasks/${parentId}/approve`, headers: headers(), payload: {} })).statusCode).toBe(200);
    await f.runtime.tick();
    const run = await f.database.db.selectFrom('skill_runs').select('id').where('parent_task_id', '=', parentId).executeTakeFirstOrThrow();
    const node = await f.database.db.selectFrom('skill_run_nodes').select(['node_id', 'child_task_id']).where('run_id', '=', run.id).executeTakeFirstOrThrow();
    expect((await f.database.db.selectFrom('tasks').select('status').where('id', '=', node.child_task_id).executeTakeFirstOrThrow()).status).toBe('waiting_approval');
    pendingRun = { id: run.id, nodeId: node.node_id, childId: node.child_task_id }; return pendingRun;
  }
  async function seedGap(owner: string, signal: SkillGapSignal | null) {
    const db = application!.database.db, conversationId = randomUUID(), chatRunId = randomUUID();
    // Persisted diagnostic fixture only; these rows do not represent tool effects.
    await db.transaction().execute(async tx => {
      await tx.insertInto('chat_conversations').values({ id: conversationId, owner_id: owner, title: sensitiveMarker, status: 'idle' }).execute();
      await tx.insertInto('chat_runs').values({ id: chatRunId, conversation_id: conversationId, owner_id: owner, status: 'blocked', goal: sensitiveMarker, lease_token: randomUUID(), lease_expires_at: new Date(Date.now() - 1000) }).execute();
      await recordSkillGap(tx, { ownerId: owner, chatRunId, outcome: 'blocked', signal });
    });
    return chatRunId;
  }
  beforeAll(async () => {
    base = await realpath(tmpdir()); directory = await realpath(await mkdtemp(join(base, 'mohassan-gap-api-')));
    application = await createApplication({ authSecret: 'gap-api-fixture-auth-secret-000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, skillEngineEnabled: true, codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), ...fixtureLocalModel(modelFetch) });
    const account = { name: 'Gap owner fixture', email: 'gap-owner@example.test', password: 'Gap-Owner-Fixture-Password-42' };
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { ...account, setupToken } }); expect(setup.statusCode, setup.body).toBe(200);
    const other = { name: 'Other gap fixture', email: 'gap-other@example.test', password: 'Gap-Other-Fixture-Password-42' };
    // The second account exists only in this in-memory DB. Public registration stays disabled.
    await application.database.db.insertInto('workspace_members').values({ user_id: (await application.auth.api.signUpEmail({ body: other })).user.id, role: 'owner' }).execute();
    async function login(credentials: typeof account) {
      const response = await application!.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: credentials.email, password: credentials.password } }); expect(response.statusCode, response.body).toBe(200);
      return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    }
    cookie = await login(account); otherCookie = await login(other);
    ownerId = (await application.database.db.selectFrom('user').select('id').where('email', '=', account.email).executeTakeFirstOrThrow()).id;
    otherId = (await application.database.db.selectFrom('user').select('id').where('email', '=', other.email).executeTakeFirstOrThrow()).id;
    for (const signal of [
      { source: 'planner', code: 'SKILL_NOT_FOUND' }, { source: 'tool', code: 'TOOL_NOT_CONFIGURED', tool: 'coding.change' },
      { source: 'tool', code: 'SKILL_TOOL_PERMISSION_REQUIRED', tool: 'browser.open' }, { source: 'model', code: 'INCOMPLETE_RESPONSE' },
      { source: 'planner', code: 'SKILL_GRAPH_INVALID' }, { source: 'tool', code: 'AGENT_REF_STALE' },
      { source: 'environment', code: 'NOT_CONFIGURED' }, { source: 'environment', code: 'SANDBOX_UNAVAILABLE' },
      { source: 'tool', code: sensitiveMarker },
    ] satisfies SkillGapSignal[]) ownedRuns.push(await seedGap(ownerId, signal));
    foreignRunId = await seedGap(otherId, { source: 'tool', code: 'TOOL_NOT_CONFIGURED', tool: 'coding.change' });
  }, 60000);
  afterAll(async () => {
    await application?.app.close();
    if (directory) { const target = await realpath(directory), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-gap-api-')) throw new Error('Unsafe gap fixture cleanup'); await rm(target, { recursive: true, force: true }); }
  });

  it('requires real authentication and exposes no client mutation or owner override', async () => {
    const app = application!.app;
    expect((await app.inject({ url: '/api/skills/gaps' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/skills/gaps', headers: headers('') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/skills/gaps', headers: headers(), payload: { category: 'missing_tool', ownerId: otherId, automatic: true } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/skills/gaps?ownerId=${otherId}`, headers: headers() })).statusCode).toBe(400);
  });

  it('paginates only the signed-in owner, including counts and category filters', async () => {
    const app = application!.app;
    const firstResponse = await app.inject({ url: '/api/skills/gaps?limit=2&offset=0', headers: headers() }); expect(firstResponse.statusCode, firstResponse.body).toBe(200); expect(firstResponse.headers['cache-control']).toBe('private, no-store');
    const first = SkillGapPageSchema.parse(firstResponse.json()), next = SkillGapPageSchema.parse((await app.inject({ url: '/api/skills/gaps?limit=2&offset=2', headers: headers() })).json());
    expect(first.total).toBe(ownedRuns.length); expect(next.total).toBe(first.total); expect(first.items).toHaveLength(2); expect(next.items).toHaveLength(2); expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(4);
    expect([...first.items, ...next.items].every(item => ownedRuns.includes(item.chatRunId))).toBe(true);
    const foreign = SkillGapPageSchema.parse((await app.inject({ url: '/api/skills/gaps', headers: headers(otherCookie) })).json()); expect(foreign.total).toBe(1); expect(foreign.items.map(item => item.chatRunId)).toEqual([foreignRunId]);
    const filtered = SkillGapPageSchema.parse((await app.inject({ url: '/api/skills/gaps?category=sandbox_restriction', headers: headers() })).json()); expect(filtered.total).toBe(1); expect(filtered.items[0]?.category).toBe('sandbox_restriction');
    expect(SkillGapPageSchema.parse((await app.inject({ url: '/api/skills/gaps?offset=100000', headers: headers() })).json()).items).toEqual([]);
  });

  it('rejects invalid pagination and unknown fields instead of broadening the query', async () => {
    for (const query of ['limit=51', 'limit=0', 'offset=-1', 'offset=100001', 'limit=1.5', 'category=imagined', 'reason=SKILL_NOT_FOUND']) expect((await application!.app.inject({ url: `/api/skills/gaps?${query}`, headers: headers() })).statusCode).toBe(400);
  });

  it('distinguishes unavailable configuration, permission, model limits and sandbox restrictions without dispatch', async () => {
    const f = application!, response = await f.app.inject({ url: '/api/skills/gaps?limit=50', headers: headers() }), items = SkillGapPageSchema.parse(response.json()).items;
    expect(f.coding.available).toBe(false);
    expect(items.find(item => item.reason === 'TOOL_NOT_CONFIGURED')).toMatchObject({ category: 'missing_tool', signal: { tool: 'coding.change' }, action: { kind: 'configure_tool', automatic: false, requiresApproval: true } });
    expect(items.find(item => item.reason === 'SKILL_TOOL_PERMISSION_REQUIRED')).toMatchObject({ category: 'missing_permission', signal: { tool: 'browser.open' }, action: { kind: 'review_permission', automatic: false } });
    expect(items.find(item => item.reason === 'NOT_CONFIGURED')?.category).toBe('environment_failure'); expect(items.find(item => item.reason === 'INCOMPLETE_RESPONSE')?.category).toBe('model_limitation');
    expect(items.find(item => item.reason === 'SANDBOX_UNAVAILABLE')).toMatchObject({ category: 'sandbox_restriction', action: { kind: 'review_sandbox', automatic: false } });
    expect(items.find(item => item.chatRunId === ownedRuns[8])).toMatchObject({ category: null, reason: 'insufficient_evidence', signal: null });
    expect(modelFetch).not.toHaveBeenCalled(); expect(await f.database.db.selectFrom('tasks').select('id').execute()).toEqual([]); expect(await f.database.db.selectFrom('skill_grants').select('id').execute()).toEqual([]);
  });

  it('keeps diagnostic GETs read-only and never returns raw chat text or unknown codes', async () => {
    const db = application!.database.db;
    const before = await db.selectFrom('skill_gaps').selectAll().orderBy('id').execute(), auditBefore = await db.selectFrom('skill_audit').selectAll().orderBy('id').execute();
    const response = await application!.app.inject({ url: '/api/skills/gaps?limit=50', headers: headers() }); expect(response.statusCode).toBe(200); expect(response.body).not.toContain(sensitiveMarker); expect(response.body).not.toContain('owner_id'); expect(response.body).not.toContain('lease_token');
    expect(await db.selectFrom('skill_gaps').selectAll().orderBy('id').execute()).toEqual(before); expect(await db.selectFrom('skill_audit').selectAll().orderBy('id').execute()).toEqual(auditBefore);
    expect(JSON.stringify(before)).not.toContain(sensitiveMarker); expect(JSON.stringify(auditBefore.filter(row => row.event === 'skill.gap_recorded'))).not.toContain(sensitiveMarker);
  });

  it('records an actual blocked Chat outcome as insufficient evidence rather than trusting model prose', async () => {
    const f = application!, created = await f.app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(), payload: { goal: `${sensitiveMarker}: The words missing_tool and sandbox_restriction are not trusted evidence.` } }); expect(created.statusCode, created.body).toBe(200);
    await f.chat.settled(created.json().id); expect(modelFetch).toHaveBeenCalled();
    const run = await f.database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', created.json().id).executeTakeFirstOrThrow();
    const diagnostic = { conversation: await f.database.db.selectFrom('chat_conversations').select('error').where('id', '=', created.json().id).executeTakeFirstOrThrow(), receipts: await f.database.db.selectFrom('chat_model_receipts').select(['status', 'error_code']).where('run_id', '=', run.id).execute() };
    expect(run.status, JSON.stringify(diagnostic)).toBe('blocked');
    const gap = await f.database.db.selectFrom('skill_gaps').selectAll().where('chat_run_id', '=', run.id).executeTakeFirstOrThrow(); expect(gap).toMatchObject({ owner_id: ownerId, category: null, reason: 'insufficient_evidence', signal: null });
    expect(JSON.stringify(gap)).not.toContain(sensitiveMarker); const page = SkillGapPageSchema.parse((await f.app.inject({ url: '/api/skills/gaps?limit=50', headers: headers() })).json()); expect(page.items.find(item => item.chatRunId === run.id)).toMatchObject({ category: null, signal: null, action: { kind: 'inspect_evidence', automatic: false } });
  });

  it('reads an actual waiting-approval child as pending permission without granting or dispatching it', async () => {
    const f = application!, run = await runFixture(), db = f.database.db, before = await db.selectFrom('tasks').selectAll().orderBy('id').execute();
    const response = await f.app.inject({ url: `/api/skills/runs/${run.id}/gaps`, headers: headers() }); expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
    const report = SkillRunGapReportSchema.parse(response.json()); expect(report).toMatchObject({ runId: run.id, truncated: false, items: [{ nodeId: run.nodeId, childTaskId: run.childId, classification: { category: 'missing_permission', reason: 'APPROVAL_PENDING', action: { automatic: false, requiresApproval: true } } }] });
    expect(response.body).not.toContain(sensitiveMarker); expect(await db.selectFrom('tasks').selectAll().orderBy('id').execute()).toEqual(before); expect(await db.selectFrom('skill_evidence').select('id').execute()).toEqual([]); expect(await db.selectFrom('skill_preimages').select('id').execute()).toEqual([]);
    expect((await f.app.inject({ url: `/api/skills/runs/${run.id}/gaps`, headers: headers(otherCookie) })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/skills/runs/${randomUUID()}/gaps`, headers: headers() })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/skills/runs/${run.id}/gaps?category=missing_permission`, headers: headers() })).statusCode).toBe(400);
  });

  it('uses persisted node codes for known failures and leaves an unknown cause unclassified', async () => {
    const f = application!, run = await runFixture(), db = f.database.db, original = await db.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', run.id).executeTakeFirstOrThrow();
    try {
      await db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', run.childId).execute();
      for (const [code, category] of [['SKILL_TOOL_UNAVAILABLE', 'missing_tool'], ['SKILL_EXECUTABLE_GATES_CLOSED', 'sandbox_restriction'], [sensitiveMarker, null]] as const) {
        await db.updateTable('skill_run_nodes').set({ status: 'failed', error_code: code }).where('run_id', '=', run.id).where('node_id', '=', run.nodeId).execute();
        const response = await f.app.inject({ url: `/api/skills/runs/${run.id}/gaps`, headers: headers() }); expect(response.statusCode, response.body).toBe(200);
        const classification = SkillRunGapReportSchema.parse(response.json()).items[0]?.classification; expect(classification?.category).toBe(category); expect(classification?.reason).toBe(category ? code : 'insufficient_evidence'); expect(response.body).not.toContain(sensitiveMarker);
      }
    } finally { await db.updateTable('skill_run_nodes').set({ status: original.status, error_code: original.error_code }).where('run_id', '=', run.id).where('node_id', '=', run.nodeId).execute(); await db.updateTable('tasks').set({ status: 'waiting_approval' }).where('id', '=', run.childId).execute(); }
  });

  it('keeps unknown effect evidence distinct from a guessed failure cause, even when node status says failed', async () => {
    const f = application!, run = await runFixture(), db = f.database.db, node = await db.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', run.id).executeTakeFirstOrThrow(), receiptId = randomUUID();
    try {
      await db.updateTable('tasks').set({ status: 'failed' }).where('id', '=', run.childId).execute();
      await db.updateTable('skill_run_nodes').set({ status: 'failed', error_code: 'SKILL_ROOT_GRANT_REVOKED' }).where('run_id', '=', run.id).where('node_id', '=', run.nodeId).execute();
      // Artificial journal states test the diagnostic projection; no write was dispatched.
      await db.insertInto('skill_evidence').values({ id: receiptId, owner_id: ownerId, run_id: run.id, node_id: run.nodeId, task_id: run.childId, version_id: node.version_id, content_hash: node.content_hash, inputs_hash: node.inputs_hash, lease_token: randomUUID(), node_lease_token: randomUUID(), workflow_token: randomUUID(), status: 'unknown', attempt: node.execution_attempt, details: '[]' }).execute();
      for (const status of ['unknown', 'started', 'failed'] as const) {
        await db.updateTable('skill_evidence').set({ status, details: status === 'failed' ? JSON.stringify([{ kind: 'gateway.failure', data: { source: 'adapter', effect: 'unknown', retryable: false, errorCode: 'SKILL_ROOT_GRANT_REVOKED', tool: 'file.write' } }]) : '[]' }).where('id', '=', receiptId).execute();
        const response = await f.app.inject({ url: `/api/skills/runs/${run.id}/gaps`, headers: headers() }); expect(response.statusCode, response.body).toBe(200);
        expect(SkillRunGapReportSchema.parse(response.json()).items[0]?.classification).toMatchObject({ category: null, reason: 'EFFECT_UNKNOWN', action: { kind: 'inspect_evidence', automatic: false } });
        expect((await db.selectFrom('skill_evidence').select('status').where('id', '=', receiptId).executeTakeFirstOrThrow()).status).toBe(status);
      }
    } finally { await db.deleteFrom('skill_evidence').where('id', '=', receiptId).execute(); await db.updateTable('skill_run_nodes').set({ status: node.status, error_code: node.error_code }).where('run_id', '=', run.id).where('node_id', '=', run.nodeId).execute(); await db.updateTable('tasks').set({ status: 'waiting_approval' }).where('id', '=', run.childId).execute(); }
  });
});
