import { randomUUID } from 'node:crypto';
import { SafeNetwork, type AgentBrowser } from '@mohassan/browser';
import type { SiteDetail } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import Fastify from 'fastify';
import { completeBrief, siteSentence } from '@mohassan/sites';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandChatMigration, createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';
import { createRefusalAwareCommandChat } from '../apps/server/src/assistant/refusal/chat-control.js';
import { planLongRun } from '../apps/server/src/assistant/long-run/host.js';
import { createLongRunRuntime, LongRunTransientError, type LongRunPorts } from '../apps/server/src/assistant/long-run/runtime.js';
import { LONG_RUN_LIMITS, restoreLongRunState, type LongRunPlan } from '../apps/server/src/assistant/long-run/state.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateBackgroundResults } from '../apps/server/src/background-results-migration.js';
import { createSitesControl } from '../apps/server/src/sites.js';

const url = 'https://example.com/';
const found = { kind: 'observed', observation: { url, title: 'Example', quote: 'Verified excerpt', hash: 'a'.repeat(64) } } as const;
const research: LongRunPlan = { language: 'en', steps: [{ kind: 'search', query: 'tidal power' }, { kind: 'read_source', index: 0 }] };
const monitor: LongRunPlan = { language: 'en', steps: [{ kind: 'monitor', url, delayMs: 0 }, { kind: 'monitor', url, delayMs: 60_000 }] };
const draftTitle = 'Build a portfolio website called Ada. Contact ada@example.com.';
const draft = completeBrief(siteSentence(draftTitle)!, { requestText: draftTitle });
if ('missing' in draft) throw new Error('Test site brief is missing required facts.');
const building = (approval: boolean): LongRunPlan => ({ language: 'en', steps: [{ kind: 'prepare_site', brief: draft.brief }, { kind: 'build_site', approval }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
}

describe('response policy long-run admission', () => {
  const searchProvider = { name: 'fixture', search: async () => [] };
  const network = new SafeNetwork();

  it('binds public monitoring to its actual URL and requested duration', () => {
    expect(planLongRun('Monitor https://example.com/ for 20 minutes.', { searchProvider }, network)).toEqual({
      language: 'en', steps: [{ kind: 'monitor', url, delayMs: 0 }, { kind: 'monitor', url, delayMs: 20 * 60_000 }],
    });
    expect(planLongRun('راقب https://example.com/ لمدة ساعتين', { searchProvider }, network)?.steps).toHaveLength(5);
    expect(() => planLongRun('Monitor https://example.com/ for 12 hours.', { searchProvider }, network)).toThrow(/two hours/);
    expect(() => planLongRun('Monitor https://localhost/ for 20 minutes.', { searchProvider }, network)).toThrow(/public HTTPS/);
  });

  it('allows explicit deep public research and respects source restrictions', () => {
    expect(planLongRun('Research the history of tidal energy from multiple sources.', { searchProvider }, network)?.steps)
      .toEqual([{ kind: 'search', query: 'the history of tidal energy' }, ...[0, 1, 2, 3].map(index => ({ kind: 'read_source', index }))]);
    expect(planLongRun('Research my private documents from multiple sources.', { searchProvider }, network)).toBeNull();
    expect(planLongRun('What is tidal power?', { searchProvider }, network)).toBeNull();
    expect(planLongRun('Research tidal power deeply. Do not use the web.', { searchProvider }, network)).toBeNull();
  });

  it.each([
    ['Research tidal power in the background.', 'en', 'tidal power'],
    ['Work on this in the background: Research tidal power.', 'en', 'tidal power'],
    ['ابحث عن طاقة المد والجزر في الخلفية.', 'ar', 'طاقة المد والجزر'],
    ['اعمل في الخلفية: ابحث عن طاقة المد والجزر.', 'ar', 'طاقة المد والجزر'],
  ])('admits an explicit background request without including the direction in the query (%s)', (text, language, query) => {
    expect(planLongRun(text, { searchProvider }, network)).toBeNull();
    expect(planLongRun(text, { searchProvider }, network, true)).toMatchObject({
      language, background: { replyLength: 'long' }, steps: [{ kind: 'search', query }, ...[0, 1, 2, 3].map(index => ({ kind: 'read_source', index }))],
    });
  });

  it('uses the reply policy while retaining action restrictions and interactive choices', () => {
    expect(planLongRun('Research tidal power in the background. Reply briefly.', { searchProvider }, network, true))
      .toMatchObject({ language: 'en', background: { replyLength: 'short' } });
    expect(planLongRun('Research tidal power in the background. Do not use the web.', { searchProvider }, network, true)).toBeNull();
    expect(planLongRun("Research tidal power in depth. Don't work in the background.", { searchProvider }, network, true)).toBeNull();
    expect(planLongRun('Translate: Research tidal power in the background.', { searchProvider }, network, true)).toBeNull();
  });
});

describe('durable long-running response policy work', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  let time = Date.now();
  const runners: ReturnType<typeof createLongRunRuntime>[] = [];

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    await migrateAuth(database.db);
    await commandChatMigration(database.db);
    await migrateBackgroundResults(database.db);
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    chat = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
  });

  afterAll(async () => {
    await Promise.all(runners.map(runner => runner.shutdown()));
    await chat?.shutdown();
    await database?.close();
  });

  async function open(plan: LongRunPlan, execute: LongRunPorts['execute']) {
    const ownerId = randomUUID();
    const { id: conversationId } = await chat.create(ownerId);
    const runner = launch(execute);
    const id = await runner.admission(ownerId, conversationId, 'Test long-running task.', plan);
    return { id, ownerId, conversationId, runner };
  }

  function launch(execute: LongRunPorts['execute']) {
    const runtime = createLongRunRuntime(database.db, { execute }, { now: () => time, onError: () => { throw new Error('Unexpected scheduler failure.'); } });
    runners.push(runtime);
    return runtime;
  }

  async function row(id: string) {
    return database.db.selectFrom('chat_runs').select(['status', 'state', 'steps']).where('id', '=', id).executeTakeFirstOrThrow();
  }

  async function notices(id: string) {
    return (await database.db.selectFrom('chat_notifications').select('kind').where('conversation_id', '=', id).execute()).map(item => item.kind);
  }

  async function backgroundNotices(id: string) {
    return database.db.selectFrom('chat_notifications').select(['task_id', 'background_outcome', 'result_preview'])
      .where('run_id', '=', id).execute();
  }

  it('resumes from the most recent step checkpoint after replacing the worker', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async input => input.operation.kind === 'search' ? { kind: 'searched', urls: [url] } : found);
    const run = await open(research, execute);
    await run.runner.runOnce();
    expect(await row(run.id)).toMatchObject({ status: 'running', steps: 1 });
    expect(await notices(run.conversationId)).toEqual(['task_progress']);
    await run.runner.shutdown();

    // Ordinary chat expiry recovery must leave this scheduler's lease alone.
    await chat.recoverExpired();
    const restarted = launch(execute);
    time += 1_000;
    await restarted.runOnce();
    expect(execute.mock.calls.map(([input]) => input.operation.kind)).toEqual(['search', 'read_source']);
    expect(await row(run.id)).toMatchObject({ status: 'completed', steps: 2 });
    expect(await notices(run.conversationId)).toEqual(['task_progress', 'task_completed']);
    const detail = await chat.detail(run.ownerId, run.conversationId);
    expect(detail.messages.at(-1)?.text).toContain('Verified excerpt');
    expect(detail.run?.phase).toBe('completed');
  });

  it('commits one finished background reply and completion event after a worker restart', async () => {
    const quote = `Verified excerpt ${'independent evidence '.repeat(20)}and the final detail.`;
    const execute = vi.fn<LongRunPorts['execute']>(async input => input.operation.kind === 'search' ? { kind: 'searched', urls: [url] }
      : { ...found, observation: { ...found.observation, quote } });
    const run = await open({ ...research, background: { replyLength: 'long' } }, execute);
    const runningDetail = await chat.detail(run.ownerId, run.conversationId);
    expect(runningDetail.backgroundRun).toMatchObject({ id: run.id, language: research.language });
    expect(runningDetail.run?.engine).toEqual({ kind: 'rules', modelCalls: 0 });
    expect((await chat.detail(run.ownerId, run.conversationId)).messages.map(item => item.role)).toEqual(['user', 'assistant']);
    await run.runner.runOnce();
    await run.runner.shutdown();
    expect(await backgroundNotices(run.id)).toEqual([]);
    time += 1_000;
    const restarted = launch(execute);
    await restarted.runOnce();
    await restarted.shutdown();
    await launch(execute).runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await row(run.id)).toMatchObject({ status: 'completed', steps: 2 });
    const detail = await chat.detail(run.ownerId, run.conversationId);
    expect(detail.backgroundRun).toBeUndefined();
    expect(detail.messages.map(item => item.role)).toEqual(['user', 'assistant', 'assistant']);
    const final = detail.messages.at(-1)?.text;
    expect(final).toContain('### Sources');
    expect(final).toContain(quote);
    expect(await backgroundNotices(run.id)).toEqual([{ task_id: run.id, background_outcome: 'completed', result_preview: 'I read 1 public sources.' }]);
    expect(await notices(run.conversationId)).toEqual(['task_completed']);
  });

  it('records approval, sign-in and failure as distinct background outcomes', async () => {
    const approval = await open({ ...building(true), background: { replyLength: 'long' } }, async () => ({ kind: 'verified' }));
    await approval.runner.runOnce();
    await approval.runner.runOnce();
    expect((await chat.detail(approval.ownerId, approval.conversationId)).backgroundRun?.step).toBe('Build the draft site');
    expect(await backgroundNotices(approval.id)).toMatchObject([{ background_outcome: 'approval', result_preview: null }]);
    await chat.cancel(approval.ownerId, approval.conversationId);

    const signIn = await open({ language: 'en', background: { replyLength: 'long' }, steps: [
      { kind: 'search', query: 'public references' }, { kind: 'read_source', index: 0 }, { kind: 'read_source', index: 1 },
    ] }, async ({ operation }) => operation.kind === 'search' ? { kind: 'searched', urls: [url, 'https://second.example.test/'] }
      : { kind: 'input', reason: 'sign_in', site: url });
    await signIn.runner.runOnce();
    await signIn.runner.runOnce();
    expect(await backgroundNotices(signIn.id)).toMatchObject([{ background_outcome: 'sign-in', result_preview: null }]);
    const firstPrompt = (await chat.detail(signIn.ownerId, signIn.conversationId)).secure!;
    await signIn.runner.respondToInput(signIn.ownerId, signIn.conversationId, { action: 'done', requestId: firstPrompt.id });
    await signIn.runner.runOnce();
    expect(await backgroundNotices(signIn.id)).toHaveLength(1);
    const retriedPrompt = (await chat.detail(signIn.ownerId, signIn.conversationId)).secure!;
    await signIn.runner.respondToInput(signIn.ownerId, signIn.conversationId, { action: 'skip', requestId: retriedPrompt.id });
    await signIn.runner.runOnce();
    expect(await backgroundNotices(signIn.id)).toMatchObject([
      { background_outcome: 'sign-in', result_preview: null }, { background_outcome: 'sign-in', result_preview: null },
    ]);
    await chat.cancel(signIn.ownerId, signIn.conversationId);

    const failed = await open({ ...monitor, background: { replyLength: 'long' } }, async () => ({ kind: 'unavailable' }));
    await failed.runner.runOnce();
    expect(await backgroundNotices(failed.id)).toEqual([{ task_id: failed.id, background_outcome: 'failed', result_preview: null }]);
    expect((await chat.detail(failed.ownerId, failed.conversationId)).messages.at(-1)?.text).toBe('A required step could not be completed.');
  });

  it('stops via existing chat cancellation without another step or notification', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => found);
    const run = await open(monitor, execute);
    await run.runner.runOnce();
    expect((await row(run.id)).steps).toBe(1);
    await chat.cancel(run.ownerId, run.conversationId);
    time += 120_000;
    await launch(execute).runOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await row(run.id)).status).toBe('cancelled');
    expect(await notices(run.conversationId)).toEqual(['task_progress']);
  });

  it('expires sleeping monitoring work at its wall deadline', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => found);
    const startedAt = time;
    const run = await open(monitor, execute);
    time = startedAt + LONG_RUN_LIMITS.wallMs - 1_000;
    await run.runner.runOnce();
    expect(await row(run.id)).toMatchObject({ status: 'running', steps: 1 });

    time = startedAt + LONG_RUN_LIMITS.wallMs;
    await run.runner.runOnce();
    expect(await row(run.id)).toMatchObject({ status: 'blocked', steps: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(await notices(run.conversationId)).toContain('task_failed');
  });

  it('retries a transient error from its durable backoff after restart', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => found).mockRejectedValueOnce(new LongRunTransientError('temporary'));
    const run = await open(monitor, execute);
    await run.runner.runOnce();
    expect((await row(run.id)).steps).toBe(0);
    await run.runner.shutdown();
    const restarted = launch(execute);
    await restarted.runOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    time += 1_000;
    await restarted.runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    const stored = await row(run.id);
    expect(stored.steps).toBe(1);
    expect(restoreLongRunState(stored.state, run.id)?.longRun.resources).toBe(2);
    await chat.cancel(run.ownerId, run.conversationId);
  });

  it('persists an approval pause and consumes the matching account consent exactly once', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async input => input.operation.kind === 'prepare_site'
      ? { kind: 'verified' }
      : { kind: 'site', id: randomUUID(), partial: false, text: 'Draft built.' });
    const run = await open(building(true), execute);
    await run.runner.runOnce();
    await run.runner.runOnce();
    const waiting = await chat.detail(run.ownerId, run.conversationId);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval?.target).toBe(draft.brief.name);
    expect(await notices(run.conversationId)).toEqual(['task_progress', 'needs_you']);
    expect(execute).toHaveBeenCalledTimes(1);
    await run.runner.shutdown();

    const restarted = launch(execute);
    await restarted.runOnce();
    const approvalId = waiting.approval!.id;
    await expect(restarted.approve('other-account', run.conversationId, { approvalId, approved: true })).rejects.toThrow(/no longer pending/);
    await restarted.approve(run.ownerId, run.conversationId, { approvalId, approved: true });
    await restarted.runOnce();
    await restarted.runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    const stored = await row(run.id);
    expect(stored.status).toBe('completed');
    expect(restoreLongRunState(stored.state, run.id)?.agentRun.permissions[0]?.decision).toBe('consumed');
    expect(await notices(run.conversationId)).toEqual(['task_progress', 'needs_you', 'task_completed']);
  });

  it('rejects an expired approval without dispatching the protected step', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => ({ kind: 'verified' }));
    const run = await open(building(true), execute);
    await run.runner.runOnce();
    await run.runner.runOnce();
    const stuck = await chat.detail(run.ownerId, run.conversationId);
    time += LONG_RUN_LIMITS.wallMs;
    await expect(run.runner.approve(run.ownerId, run.conversationId, { approvalId: stuck.approval!.id, approved: true }))
      .rejects.toThrow(/no longer pending/);
    await run.runner.runOnce();
    expect((await row(run.id)).status).toBe('blocked');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never replays an in-flight site write after restart', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async ({ operation, signal }) => {
      if (operation.kind === 'prepare_site') return { kind: 'verified' };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const run = await open(building(false), execute);
    await run.runner.runOnce();
    await run.runner.runOnce(false);
    expect(execute).toHaveBeenCalledTimes(2);
    await run.runner.shutdown();
    time += LONG_RUN_LIMITS.leaseMs;
    await launch(execute).runOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await row(run.id)).status).toBe('blocked');
    expect(await notices(run.conversationId)).toContain('task_failed');
  });

  it('stops an in-flight adapter that ignores cancellation without holding the worker', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => new Promise(() => {}));
    const run = await open(monitor, execute);
    await run.runner.runOnce(false);
    expect(execute).toHaveBeenCalledTimes(1);
    await chat.cancel(run.ownerId, run.conversationId);
    run.runner.stopWork(run.id);
    await run.runner.shutdown();
    expect((await row(run.id)).status).toBe('cancelled');
  });

  it('admits only one active long run per account across conversations', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => found);
    const run = await open(monitor, execute);
    const second = await chat.create(run.ownerId);
    const worker = launch(execute);
    await expect(worker.admission(run.ownerId, second.id, 'Second run', monitor)).rejects.toThrow(/active long-running task/);
    await chat.cancel(run.ownerId, run.conversationId);
    await expect(worker.admission(run.ownerId, second.id, 'Second run', monitor)).resolves.toMatch(/^[a-f0-9-]{36}$/);
    await chat.cancel(run.ownerId, second.id);
  });

  it('pauses for payment without entering credentials or issuing a retry', async () => {
    const execute = vi.fn<LongRunPorts['execute']>(async () => ({ kind: 'input', reason: 'payment', site: url }));
    const run = await open(monitor, execute);
    await run.runner.runOnce();
    const current = await chat.detail(run.ownerId, run.conversationId);
    expect(current.secure).toMatchObject({ kind: 'hands_on', fields: [], prompt: expect.stringContaining('payment') });
    await run.runner.runOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(run.runner.respondToInput(run.ownerId, run.conversationId, { requestId: current.secure!.id, action: 'submit', values: { code: 'never store me' } }))
      .rejects.toThrow(/directly on the site/);
    await run.runner.respondToInput(run.ownerId, run.conversationId, { requestId: current.secure!.id, action: 'skip' });
    expect((await row(run.id)).status).toBe('blocked');
    expect(await notices(run.conversationId)).toEqual(['needs_you', 'task_failed']);
  });


  it('selects the durable scheduler through the normal chat API and accepts the existing stop endpoint', async () => {
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '1');
    vi.stubEnv('MOHASSAN_BACKGROUND_RESULTS_ENABLED', '1');
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    const aborted = vi.fn();
    const search = vi.fn(async (_query: string, _limit: number, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
    }));
    const ownerId = randomUUID();
    const app = Fastify();
    const control = await createRefusalAwareCommandChat(database.db, { browser, searchProvider: { name: 'fixture', search },
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
    try {
      await registerCommandChatRoutes(app, { control, owner: async () => ({ id: ownerId }) });
      const goal = 'Research tidal power in the background.';
      const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: { goal } });
      expect(created.statusCode).toBe(200);
      const started = created.json();
      expect(started.status).toBe('running');
      expect(started.run.plan.steps[0].capability).toBe('web.search');
      expect(started.messages.at(-1)).toMatchObject({ role: 'assistant', text: "I'll work on this in the background and notify you when it's done." });
      expect(started.backgroundRun).toMatchObject({ id: started.run.id, task: goal, step: 'Find public sources', language: 'en' });
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(search.mock.calls[0]?.[0]).toBe('tidal power');
      const stopped = await app.inject({ method: 'POST', url: `/api/chat/conversations/${started.id}/cancel`, payload: {} });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().run.phase).toBe('cancelled');
      expect(stopped.json().backgroundRun).toBeUndefined();
      expect(aborted).toHaveBeenCalledOnce();
      expect(await notices(started.id)).toEqual([]);
    } finally {
      await app.close();
      await control.shutdown();
      vi.unstubAllEnvs();
    }
  });

  it('fences a draft persistence attempt after the stop endpoint returns', { timeout: 12_000 }, async () => {
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '1');
    vi.stubEnv('MOHASSAN_BACKGROUND_RESULTS_ENABLED', '1');
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    const ownerId = randomUUID();
    const app = Fastify();
    const enteringSite = deferred<void>();
    const allowPersistence = deferred<void>();
    const persisted = deferred<boolean>();
    const sites = await createSitesControl(database.db, { tokenSecret: 'fixture-key' });
    const control = await createRefusalAwareCommandChat(database.db, { browser,
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      sites: {
        async createFromBrief(id, brief, options) {
          enteringSite.resolve();
          await allowPersistence.promise;
          try {
            const saved = await sites.create(id, { brief, ...options });
            persisted.resolve(true);
            return saved;
          } catch (error) {
            persisted.resolve(false);
            throw error;
          }
        },
        command: sites.command, detail: sites.detail,
      },
    });
    try {
      // Handle stop with a different control so the scheduler cannot rely on a local abort.
      await registerCommandChatRoutes(app, { control: { ...control, cancel: chat.cancel }, owner: async () => ({ id: ownerId }) });
      const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: { goal: draftTitle } });
      expect(created.statusCode).toBe(200);
      const start = created.json();
      await enteringSite.promise;

      const stopped = await app.inject({ method: 'POST', url: `/api/chat/conversations/${start.id}/cancel`, payload: {} });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().run.phase).toBe('cancelled');
      allowPersistence.resolve();

      expect(await persisted.promise).toBe(false);
      expect(await sites.list(ownerId)).toEqual([]);
      expect(await backgroundNotices(start.run.id)).toEqual([]);
    } finally {
      allowPersistence.resolve();
      await app.close();
      await control.shutdown();
      vi.unstubAllEnvs();
    }
  });

  it('rolls back durable admission when the account has reached its daily limit', async () => {
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '1');
    vi.stubEnv('MOHASSAN_BACKGROUND_RESULTS_ENABLED', '1');
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    const ownerId = randomUUID();
    const search = vi.fn(async () => []);
    const reserveMemberRun = vi.fn(async () => { throw Object.assign(new Error('Daily limit reached.'), { code: 'MEMBER_DAILY_LIMIT' }); });
    const control = await createRefusalAwareCommandChat(database.db, { browser, searchProvider: { name: 'fixture', search },
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false, reserveMemberRun });
    try {
      await expect(control.create(ownerId, { goal: 'Research tidal power in the background.' }))
        .rejects.toMatchObject({ code: 'MEMBER_DAILY_LIMIT' });
      expect(reserveMemberRun).toHaveBeenCalledOnce();
      expect(search).not.toHaveBeenCalled();
      expect(await database.db.selectFrom('chat_runs').select('id').where('owner_id', '=', ownerId).execute()).toEqual([]);
      expect(await database.db.selectFrom('chat_conversations').select('id').where('owner_id', '=', ownerId).execute()).toEqual([]);
    } finally {
      await control.shutdown();
      vi.unstubAllEnvs();
    }
  });

  it('continues a durable task when the real HTTP client disconnects', { timeout: 12_000 }, async () => {
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '1');
    vi.stubEnv('MOHASSAN_BACKGROUND_RESULTS_ENABLED', '1');
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    const ownerId = randomUUID();
    const app = Fastify();
    const buildingSite = deferred<void>();
    const finishSite = deferred<SiteDetail>();
    const holding = deferred<void>();
    app.addHook('onRequest', async request => { if (request.url.includes('?since=')) holding.resolve(); });
    const control = await createRefusalAwareCommandChat(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      sites: { createFromBrief: async () => { buildingSite.resolve(); return finishSite.promise; }, command: vi.fn(), detail: vi.fn() } });
    const stamp = new Date().toISOString();
    const site: SiteDetail = {
      id: randomUUID(), name: 'Ada', slug: 'ada', kind: 'portfolio', lang: 'en', status: 'draft', revision: 1,
      publishedUrl: null, createdAt: stamp, updatedAt: stamp, brief: draft.brief, pages: [{ path: '/', title: 'Ada' }],
      checks: { passed: true, checks: [], bytes: 0, pages: 1 }, previewPath: '/', canUndo: false, images: [],
    };
    const client = new AbortController();
    try {
      await registerCommandChatRoutes(app, { control, owner: async () => ({ id: ownerId }) });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: { goal: draftTitle } });
      expect(created.statusCode).toBe(200);
      const path = `/api/chat/conversations/${created.json().id}`;
      expect(created.json().backgroundRun?.step).toBe('Validate the site brief');
      await buildingSite.promise;
      const active = (await app.inject({ method: 'GET', url: path })).json();
      expect(active.backgroundRun?.step).toBe('Build the draft site');
      const polling = fetch(`${origin}${path}?since=${active.version}&wait=8000`, { signal: client.signal });
      const disconnected = expect(polling).rejects.toMatchObject({ name: 'AbortError' });
      await holding.promise;
      client.abort();
      await disconnected;
      finishSite.resolve(site);
      await vi.waitFor(async () => expect((await row(active.run.id)).status).toBe('completed'), { timeout: 5_000 });
      expect(await backgroundNotices(active.run.id)).toMatchObject([{ background_outcome: 'completed' }]);
      const reopened = (await app.inject({ method: 'GET', url: path })).json();
      expect(reopened.messages.at(-1)?.text).toBe('I built the “Ada” draft website.');
      expect(reopened.backgroundRun).toBeUndefined();
    } finally {
      client.abort();
      finishSite.resolve(site);
      await app.close();
      await control.shutdown();
      vi.unstubAllEnvs();
    }
  });
});
