import { randomUUID } from 'node:crypto';
import { SafeNetwork, type AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import Fastify from 'fastify';
import { completeBrief, siteSentence } from '@mohassan/sites';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandChatMigration, createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';
import { createRefusalAwareCommandChat } from '../apps/server/src/assistant/refusal/chat-control.js';
import { planLongRun } from '../apps/server/src/assistant/long-run/host.js';
import { migrateLongRuns } from '../apps/server/src/assistant/long-run/migration.js';
import { createLongRunRuntime, LongRunTransientError, type LongRunPorts } from '../apps/server/src/assistant/long-run/runtime.js';
import { LONG_RUN_LIMITS, restoreLongRunState, type LongRunPlan } from '../apps/server/src/assistant/long-run/state.js';

const url = 'https://example.com/';
const found = { kind: 'observed', observation: { url, title: 'Example', quote: 'Verified excerpt', hash: 'a'.repeat(64) } } as const;
const research: LongRunPlan = { language: 'en', steps: [{ kind: 'search', query: 'tidal power' }, { kind: 'read_source', index: 0 }] };
const monitor: LongRunPlan = { language: 'en', steps: [{ kind: 'monitor', url, delayMs: 0 }, { kind: 'monitor', url, delayMs: 60_000 }] };
const draftTitle = 'Build a portfolio website called Ada. Contact ada@example.com.';
const draft = completeBrief(siteSentence(draftTitle)!, { requestText: draftTitle });
if ('missing' in draft) throw new Error('Test site brief is missing required facts.');
const building = (approval: boolean): LongRunPlan => ({ language: 'en', steps: [{ kind: 'prepare_site', brief: draft.brief }, { kind: 'build_site', approval }] });

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
});

describe('durable long-running response policy work', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  let time = Date.now();
  const runners: ReturnType<typeof createLongRunRuntime>[] = [];

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    await commandChatMigration(database.db);
    await migrateLongRuns(database.db);
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
    const browser = { setCheckpointStore() {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser;
    const search = vi.fn(async (_query: string, _limit: number, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const ownerId = randomUUID();
    const app = Fastify();
    const control = await createRefusalAwareCommandChat(database.db, { browser, searchProvider: { name: 'fixture', search },
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
    try {
      await registerCommandChatRoutes(app, { control, owner: async () => ({ id: ownerId }) });
      const created = await app.inject({ method: 'POST', url: '/api/chat/conversations', payload: { goal: 'Research tidal power from multiple sources.' } });
      expect(created.statusCode).toBe(200);
      const started = created.json();
      expect(started.status).toBe('running');
      expect(started.run.plan.steps[0].capability).toBe('web.search');
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      const stopped = await app.inject({ method: 'POST', url: `/api/chat/conversations/${started.id}/cancel`, payload: {} });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().run.phase).toBe('cancelled');
    } finally {
      await app.close();
      await control.shutdown();
      vi.unstubAllEnvs();
    }
  });
});
