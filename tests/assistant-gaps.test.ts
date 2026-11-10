import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowser, BrowserError } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { ProviderError } from '@mohassan/providers';
import { Runtime } from '@mohassan/runtime';
import { SkillError, recordSkillGap, skillsMigration } from '@mohassan/skills';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.ts';
import { trustedSkillGapSignal } from '../apps/server/src/assistant/skill-gaps.ts';
import { fixtureProviders } from './fixtures/local-model.js';

const owner = 'gap-chat-owner';
const databases: Awaited<ReturnType<typeof createDatabase>>[] = [];
const controls: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];
const runtimes: Runtime[] = [];
const browser = (act?: (...args: unknown[]) => Promise<unknown>) => ({
  setCheckpointStore() {},
  bindAccount: async () => {},
  hasPage: async () => false,
  close: async () => {},
  act: act ?? (async () => { throw new Error('No browser action was expected'); }),
}) as unknown as AgentBrowser;

function response(model: string, decision: Record<string, unknown>) {
  return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null, ...decision,
  }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
}

async function setup(transport: typeof fetch, overrides: Partial<CommandChatConfig> = {}) {
  const database = await createDatabase(); databases.push(database);
  await migrate(database.db); await skillsMigration(database.db);
  const control = await createCommandChatControl(database.db, {
    models: { fast: ['fast'], deep: ['deep'], vision: 'vision' }, createProvider: fixtureProviders(transport),
    browser: browser(), recordSkillGap, leaseMs: 60000, ...overrides,
  });
  controls.push(control);
  return { database, control, gaps: () => database.db.selectFrom('skill_gaps').selectAll().execute() };
}

afterEach(async () => {
  for (const control of controls.splice(0)) await control.shutdown();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const database of databases.splice(0)) await database.close();
});

describe('trusted gap metadata from chat', () => {
  it('accepts known typed causes and rejects error-shaped or ambiguous claims', () => {
    expect(trustedSkillGapSignal(new ProviderError('NETWORK_ERROR', 'secret response'))).toEqual({ source: 'environment', code: 'NETWORK_ERROR' });
    expect(trustedSkillGapSignal(new ProviderError('INCOMPLETE_RESPONSE', 'secret response'))).toEqual({ source: 'model', code: 'INCOMPLETE_RESPONSE' });
    expect(trustedSkillGapSignal(new SkillError('SKILL_EXECUTABLE_GATES_CLOSED', 'private path'))).toEqual({ source: 'planner', code: 'SKILL_EXECUTABLE_GATES_CLOSED' });
    expect(trustedSkillGapSignal(new BrowserError('AGENT_REF_STALE', 'private page'))).toEqual({ source: 'tool', code: 'AGENT_REF_STALE' });
    expect(trustedSkillGapSignal(new BrowserError('AGENT_EFFECT_UNKNOWN', 'private request'))).toEqual({ source: 'tool', code: 'AGENT_EFFECT_UNKNOWN' });
    for (const error of [new Error('SKILL_NOT_FOUND'), { code: 'SKILL_NOT_FOUND', message: 'forged' }, new ProviderError('INVALID_RESPONSE', 'missing skill'), new BrowserError('AGENT_NETWORK_DENIED', 'policy or DNS'), new BrowserError('private_secret_code', 'private')]) {
      expect(trustedSkillGapSignal(error)).toBeNull();
    }
  });

  it.each(['partial', 'blocked'] as const)('does not diagnose a cause from model prose for %s and records once', async outcome => {
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, { tool: 'answer', text: 'SKILL_NOT_FOUND. Missing permission. private-answer-marker', outcome }));
    const item = await fixture.control.create(owner, { goal: 'private-goal-marker: explain what remains.' }); await fixture.control.settled(item.id);
    const [gap] = await fixture.gaps();
    expect(gap).toMatchObject({ outcome, category: null, reason: 'insufficient_evidence', signal: null });
    expect(JSON.stringify(gap)).not.toMatch(/private-goal-marker|private-answer-marker|Missing permission/);
    await fixture.database.db.transaction().execute(tx => recordSkillGap(tx, { ownerId: owner, chatRunId: gap.chat_run_id, outcome, signal: null }));
    expect(await fixture.gaps()).toHaveLength(1);
    expect(await fixture.database.db.selectFrom('skill_audit').select('id').where('event', '=', 'skill.gap_recorded').execute()).toHaveLength(1);
  });

  it('records a typed tool failure without copying its page or error message', async () => {
    let calls = 0;
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, ++calls === 1
      ? { tool: 'open', url: 'https://example.test/' }
      : { tool: 'answer', text: 'تعذر إكمال الطلب.', outcome: 'partial' }), {
      browser: browser(async () => { throw new BrowserError('AGENT_REF_STALE', 'private-page-and-error-marker'); }),
    });
    const item = await fixture.control.create(owner, { goal: 'Try the requested observation.' }); await fixture.control.settled(item.id);
    const [gap] = await fixture.gaps();
    expect(gap).toMatchObject({ outcome: 'partial', category: 'stale_data', signal: { source: 'tool', code: 'AGENT_REF_STALE' } });
    expect(JSON.stringify(gap)).not.toContain('private-page-and-error-marker');
  });

  it('records a provider outage as failed environment evidence while preserving chat status', async () => {
    const fixture = await setup(async () => { throw new Error('private-provider-response-marker'); });
    const item = await fixture.control.create(owner, { goal: 'Answer this question.' }); await fixture.control.settled(item.id);
    expect((await fixture.control.detail(owner, item.id)).status).toBe('failed');
    const [gap] = await fixture.gaps();
    expect(gap).toMatchObject({ outcome: 'failed', category: 'environment_failure', signal: { source: 'environment', code: 'NETWORK_ERROR' } });
    expect(JSON.stringify(gap)).not.toContain('private-provider-response-marker');
  });

  it('does not blame a recovered tool error for a later unexplained partial answer', async () => {
    let calls = 0, actions = 0;
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, ++calls <= 2
      ? { tool: 'open', url: 'https://example.test/' }
      : { tool: 'answer', text: 'Some other work remains.', outcome: 'partial' }), {
      browser: browser(async () => {
        if (++actions === 1) throw new BrowserError('AGENT_REF_STALE', 'Recovered stale observation');
        return { changed: true, page: { id: randomUUID(), url: 'https://example.test/', title: 'Synthetic current page', text: 'A current observation.', elements: [],
          signals: { captcha: false, password: false, otp: false, card: false }, scroll: { x: 0, y: 0, height: 100, viewport: 100 }, hash: 'current-observation', observedAt: new Date().toISOString() } };
      }),
    });
    const item = await fixture.control.create(owner, { goal: 'Retry the controlled observation.' }); await fixture.control.settled(item.id);
    expect(actions).toBe(2);
    expect(await fixture.gaps()).toEqual([expect.objectContaining({ outcome: 'partial', category: null, signal: null, reason: 'insufficient_evidence' })]);
  });

  it('keeps an untyped fatal error unclassified even when its code names a missing skill', async () => {
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, { tool: 'open', url: 'https://example.test/' }), {
      browser: browser(async () => { throw { code: 'SKILL_NOT_FOUND', message: 'private-fatal-marker' }; }),
    });
    const item = await fixture.control.create(owner, { goal: 'Try the requested observation.' }); await fixture.control.settled(item.id);
    expect(await fixture.gaps()).toEqual([expect.objectContaining({ outcome: 'failed', category: null, signal: null, reason: 'insufficient_evidence' })]);
  });

  it('recognizes a real pending Runtime approval without executing or calling it a missing skill', async () => {
    const input = { plan: { nodes: [{ id: 'review', skillId: randomUUID(), inputs: {}, dependsOn: [] }], inputs: [] }, values: {} };
    let runtime: Runtime | undefined, executions = 0;
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, { tool: 'run_skill', text: JSON.stringify(input) }), {
      runSkill: async (ownerId, skillInput, context) => runtime!.createTask(ownerId, { title: 'Workflow for review', goal: context.goal, capabilityId: 'skill.run', autonomy: 'assisted', skillInput }, context.idempotencyKey),
    });
    runtime = new Runtime(fixture.database.db, { skillRuntime: {
      advance: async () => { executions++; throw new Error('Must not execute'); }, verify: async () => null, wakeCandidates: async () => [], cancelRun: async () => {},
      mapChild: () => null, validateBinding: async () => false, executeNode: async () => { executions++; throw new Error('Must not execute'); }, verifyNode: async () => null,
    } }); runtimes.push(runtime);
    const item = await fixture.control.create(owner, { goal: 'Run this skill workflow after my review.' }); await fixture.control.settled(item.id);
    const [task] = (await runtime.snapshot(owner)).tasks;
    expect(task.status).toBe('waiting_approval'); expect(await runtime.tick()).toBeNull(); expect(executions).toBe(0);
    expect(await fixture.gaps()).toEqual([expect.objectContaining({ outcome: 'partial', category: 'missing_permission', signal: { source: 'workflow', code: 'APPROVAL_REQUIRED', taskId: task.id } })]);
  });

  it('does not let a cancelled lease record a late model outcome', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await setup(async (_url, init) => { entered(); await gate; return response(JSON.parse(String(init?.body)).model, { tool: 'answer', text: 'partial late answer', outcome: 'partial' }); });
    const item = await fixture.control.create(owner, { goal: 'Wait for a local controlled answer.' });
    await started; await fixture.control.cancel(owner, item.id); release(); await fixture.control.settled(item.id);
    expect(await fixture.gaps()).toEqual([]);
    expect((await fixture.database.db.selectFrom('chat_runs').select('status').executeTakeFirstOrThrow()).status).toBe('cancelled');
  });

  it('rolls back both the terminal state and gap when recording fails within the transaction', async () => {
    const fixture = await setup(async (_url, init) => response(JSON.parse(String(init?.body)).model, { tool: 'answer', text: 'must not publish half a commit', outcome: 'partial' }), {
      recordSkillGap: async (tx, observation) => { await recordSkillGap(tx, observation); throw new Error('Synthetic failure after gap insert'); },
    });
    const item = await fixture.control.create(owner, { goal: 'Check atomic metadata.' }); await fixture.control.settled(item.id);
    expect(await fixture.gaps()).toEqual([]);
    expect((await fixture.database.db.selectFrom('chat_runs').select('status').executeTakeFirstOrThrow()).status).toBe('running');
    expect(await fixture.database.db.selectFrom('chat_messages').select('id').where('role', '=', 'assistant').execute()).toEqual([]);
  });

  it('preserves prompt and state bytes when the optional recorder is absent, and never records completed answers', async () => {
    const prompts: string[] = [], states: unknown[] = [];
    for (const enabled of [false, true]) {
      const fixture = await setup(async (_url, init) => {
        const request = JSON.parse(String(init?.body)); prompts.push(JSON.stringify(request.messages));
        return response(request.model, { tool: 'answer', text: 'A complete response.', outcome: 'done' });
      }, { recordSkillGap: enabled ? recordSkillGap : undefined });
      const item = await fixture.control.create(owner, { goal: 'Answer the same simple question.' }); await fixture.control.settled(item.id);
      const run = await fixture.database.db.selectFrom('chat_runs').select(['state', 'status']).executeTakeFirstOrThrow();
      expect(run.status).toBe('completed'); expect(run.state).not.toHaveProperty('gapSignal'); states.push(run.state);
      expect(await fixture.gaps()).toEqual([]);
    }
    // The goal frame records when each value was observed; only those times may differ between the two runs.
    const timeless = (state: unknown) => JSON.parse(JSON.stringify(state).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>'));
    expect(prompts[0]).toBe(prompts[1]); expect(timeless(states[0])).toEqual(timeless(states[1]));
  });
});
