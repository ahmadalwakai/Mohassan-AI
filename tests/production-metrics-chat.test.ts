import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_HISTORY, appendStep, createRunLedger, decideVerdict, enterPhase, planStep, settleStep, startStep } from '../apps/server/src/assistant/agent-run.js';
import { newBrainState } from '../apps/server/src/assistant/brain.js';
import { planWebSequence } from '../apps/server/src/assistant/web-sequence.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { chatPhaseDurations, recordChatAnswer, recordChatEnd, recordChatProgress, type ChatMetricsSink } from '../apps/server/src/ops/metrics/chat.js';

const start = Date.UTC(2026, 10, 25);
const run = () => createRunLedger({ runId: 'metrics-test-run', at: start });

afterEach(() => { vi.restoreAllMocks(); });

describe('production chat metrics', () => {
  it('sums repeated ledger phases and includes waits and simultaneous transitions', () => {
    const ledger = run();
    enterPhase(ledger, 'understanding', start + 10);
    enterPhase(ledger, 'planning', start + 20);
    enterPhase(ledger, 'executing', start + 35);
    enterPhase(ledger, 'awaiting_approval', start + 70);
    enterPhase(ledger, 'understanding', start + 90);
    enterPhase(ledger, 'executing', start + 110);
    enterPhase(ledger, 'verifying', start + 145);
    enterPhase(ledger, 'completed', start + 145);

    expect(chatPhaseDurations(ledger.history, start)).toEqual({
      received: 10, understanding: 30, planning: 15, executing: 70, awaiting_approval: 20, verifying: 0,
    });
  });

  it('omits incomplete intervals from ledger rollover, old runs and a reversed clock', () => {
    const ledger = run();
    enterPhase(ledger, 'understanding', start + 1);
    enterPhase(ledger, 'planning', start);
    enterPhase(ledger, 'executing', start + 2);
    expect(chatPhaseDurations(ledger.history, start - 1)).toEqual({ planning: 2 });

    for (let i = 0; i < MAX_HISTORY; i++) {
      enterPhase(ledger, 'awaiting_input', start + 3 * i + 3);
      enterPhase(ledger, 'understanding', start + 3 * i + 4);
      enterPhase(ledger, 'executing', start + 3 * i + 5);
    }
    expect(ledger.history[0]?.phase).toBe('received');
    expect(ledger.history).toHaveLength(MAX_HISTORY);
    const durations = chatPhaseDurations(ledger.history, start);
    expect(durations.received).toBeUndefined();
    expect(Object.values(durations).reduce((sum, duration) => sum + duration, 0)).toBe(ledger.history.length - 2);
  });

  it('projects only aggregate tags and timings from the host signals and deduplicates paths', () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 42);
    const sink = vi.fn<ChatMetricsSink>();
    const state = newBrainState();
    const privateValue = 'private-email@example.test';
    state.agentRun = run();
    enterPhase(state.agentRun, 'understanding', start + 10);
    state.trail = ['calculate', 'calculation_memory', 'skill_read', `search ${privateValue}`, `open https://example.test/?value=${privateValue}`]
      .map((action, step) => ({ action, step, changed: true, result: action.startsWith('open ') ? `opened ${privateValue}` : privateValue }));
    recordChatAnswer(sink, { full: false, metricsStartedAt: start }, state, false, {
      localParts: [{ source: 'computation' }],
      webParts: [{ source: 'computation', withheld: true }],
      mindEvidence: [{ source: 'site' }, { source: 'computed' }, { source: 'memory' }],
    });
    expect(sink).toHaveBeenCalledWith('member', {
      finalAnswerMs: 42, phases: { received: 10 },
      paths: ['web', 'local_computation', 'memory', 'skill_reader', 'browser', 'refusal'],
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(privateValue);
  });

  it('does not tag an unexecuted browser guess or a rejected search as tool evidence', () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 42);
    const sink = vi.fn<ChatMetricsSink>();
    const state = newBrainState();
    state.trail = [
      { action: 'open https://rejected.test', step: 0, changed: false, result: 'not opened: the address was a guess' },
      { action: 'search private phrase', step: 1, changed: false, result: 'failed: source not allowed' },
      { action: 'search unavailable phrase', step: 2, changed: false, result: 'no results; provider failures: unavailable' },
      { action: 'read https://rejected.test', step: 3, changed: false, result: 'robots.txt disallows this page' },
      { action: 'click rejected action', step: 4, changed: false, result: 'the user refused this action; do not try it again' },
    ];
    recordChatAnswer(sink, { full: true, metricsStartedAt: start }, state, true);
    expect(sink).toHaveBeenCalledWith('owner', { finalAnswerMs: 42, phases: {}, paths: ['refusal'] });
  });

  it('retains a mixed sequence calculation source only when collection is on', () => {
    const deps = { now: new Date(start), self: { chatModel: false, web: true, browser: true, computation: true, memory: true, knowledge: true,
      documents: true, sites: true, skills: true, ads: false, imageReading: false, pc: false, planner: true, letters: true } };
    const request = 'كم حاصل 2 + 2؟ ثم ما عاصمة فرنسا؟';
    expect(planWebSequence(request, deps)?.[0]?.local?.source).toBeUndefined();
    expect(planWebSequence(request, deps, true)?.[0]?.local?.source).toBe('computation');
  });

  it('keeps a blocked required tool failure separate from a refusal', () => {
    vi.spyOn(Date, 'now').mockReturnValue(start + 42);
    const sink = vi.fn<ChatMetricsSink>();
    const state = newBrainState();
    const ledger = state.agentRun = run();
    enterPhase(ledger, 'understanding', start + 10);
    enterPhase(ledger, 'executing', start + 11);
    appendStep(ledger, planStep({ id: 'read', capability: 'web.read', outcome: 'Read source', input: null, acceptance: ['Source was read.'] }), start + 12);
    startStep(ledger, 'read', start + 12);
    settleStep(ledger, 'read', 'failed', start + 20);
    expect(decideVerdict(ledger, { hostStatus: 'blocked', at: start + 22 }).verdict.reason).toBe('step_failed');
    recordChatAnswer(sink, { full: true, metricsStartedAt: start }, state, true);
    expect(sink.mock.calls[0]?.[1].paths).toEqual([]);
    recordChatAnswer(sink, { full: true, metricsStartedAt: start }, state, true, undefined, true);
    expect(sink.mock.calls[1]?.[1].paths).toEqual(['refusal']);
  });

  it('uses a recorded settlement to close a phase when a run publishes no answer', async () => {
    const sink = vi.fn<ChatMetricsSink>();
    const ledger = run();
    enterPhase(ledger, 'understanding', start + 10);
    await recordChatEnd(sink, async () => false, ledger.history, new Date(start + 42));
    expect(sink).toHaveBeenCalledWith('member', { phases: { received: 10, understanding: 32 } });
    await recordChatEnd(sink, async () => { throw new Error('role lookup failed'); }, ledger.history);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('swallows observer failures and handles disabled collection', () => {
    const failing: ChatMetricsSink = () => { throw new Error('unwritable metrics store'); };
    for (const sink of [undefined, failing]) {
      expect(() => recordChatProgress(sink, true, new Date(start))).not.toThrow();
      expect(() => recordChatAnswer(sink, { full: true, metricsStartedAt: start }, newBrainState(), false)).not.toThrow();
    }
  });

  it('observes the initial visible progress and the final committed reply through the run controller', async () => {
    const database = await createDatabase({});
    let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
    try {
      await migrateAuth(database.db);
      await migrate(database.db);
      await database.db.insertInto('user').values([
        { id: 'test-owner', name: 'Owner', email: 'metrics-owner@example.test' },
        { id: 'test-member', name: 'Member', email: 'metrics-member@example.test' },
      ]).execute();
      const sink = vi.fn<ChatMetricsSink>();
      let browserFailure = false;
      const browser = {
        setCheckpointStore() {},
        async bindAccount() { if (browserFailure) throw new Error('isolated infrastructure failure'); },
        async hasPage() { return false; }, async close() {},
      } as unknown as AgentBrowser;
      const search = vi.fn(async () => { throw new Error('The calculation should remain local.'); });
      control = await createCommandChatControl(database.db, {
        browser, fullAccess: async id => id === 'test-owner', models: { fast: [], deep: [], vision: '' },
        recordExperiences: false, chatMetrics: sink, searchProvider: { name: 'no-network', search },
      });
      for (const [id, role] of [['test-owner', 'owner'], ['test-member', 'member']] as const) {
        const created = await control.create(id, { goal: 'احسب 248 + 19' });
        await control.settled(created.id);
        const detail = await control.detail(id, created.id);
        expect(detail.run?.phase).toBe('completed');
        expect(detail.messages.some(message => message.role === 'assistant' && message.text.includes(String(248 + 19)))).toBe(true);
        const calls = sink.mock.calls.filter(([seenRole]) => seenRole === role);
        expect(calls).toHaveLength(2);
        const progress = calls[0]![1];
        const answer = calls[1]![1];
        expect(progress).toEqual({ started: true, firstProgressMs: expect.any(Number) });
        expect(progress.firstProgressMs).toBeGreaterThanOrEqual(0);
        expect(answer.finalAnswerMs).toBeGreaterThanOrEqual(progress.firstProgressMs!);
        expect(answer.phases?.understanding).toBeGreaterThanOrEqual(0);
        expect(answer.paths).toEqual(['local_computation']);
      }
      const aggregate = JSON.stringify(sink.mock.calls);
      expect(aggregate).not.toMatch(/test-owner|test-member|@example\.test/);
      expect(aggregate).not.toContain('احسب 248 + 19');

      sink.mockClear();
      const paused = await control.create('test-member', { goal: 'Add 12 to your previous result.' });
      await control.settled(paused.id);
      expect((await control.detail('test-member', paused.id)).status).toBe('waiting_user');
      await control.cancel('test-member', paused.id);
      expect(sink.mock.calls).toHaveLength(2);
      expect(sink.mock.calls[1]).toEqual(['member', { phases: {
        received: expect.any(Number), understanding: expect.any(Number), awaiting_input: expect.any(Number),
      } }]);

      sink.mockClear();
      browserFailure = true;
      const failed = await control.create('test-owner', { goal: 'احسب 248 + 19' });
      await control.settled(failed.id);
      expect((await control.detail('test-owner', failed.id)).status).toBe('failed');
      expect(sink.mock.calls).toHaveLength(2);
      expect(sink.mock.calls[1]).toEqual(['owner', { phases: { received: expect.any(Number), understanding: expect.any(Number) } }]);
      expect(search).not.toHaveBeenCalled();
    } finally {
      await control?.shutdown();
      await database.close();
    }
  });
});
