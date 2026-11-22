import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowser, AgentEffectHeld, BrowserError, type AgentAction, type AgentAuthority, type AgentPage, type AgentPostcondition, type AgentRequestPermit, type AgentSessionCheckpoint } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'browser-recovery-fixture-owner', ADDRESS = 'https://recovery-fixture.test/catalogue';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const fixtures: Array<{ control: Awaited<ReturnType<typeof createCommandChatControl>>; database: Awaited<ReturnType<typeof createDatabase>> }> = [];
async function fixture(options: { model?: boolean; modelType?: boolean; code?: string; alwaysFail?: boolean; failTimes?: number; losePage?: boolean; waits?: number; captcha?: boolean; cancelOnRecovery?: boolean; holdDuringRecovery?: boolean; initialReadFails?: boolean; checkpointStatus?: AgentSessionCheckpoint['status'] } = {}) {
  const database = await createDatabase({});await migrate(database.db);
  let live = true, observations = 0, restores = 0, modelCalls = 0, releases = 0;
  let store: ((checkpoint: AgentSessionCheckpoint) => Promise<void>) | undefined;
  const actions: AgentAction[] = [];
  const verificationRefs: Array<string | undefined> = [];
  const makePage = (fresh = false): AgentPage => ({ id: `recovery-page-${observations}-${actions.length}`, url: ADDRESS,
    title: 'Public catalogue', text: options.captcha && observations > 1 ? 'Verify you are human' : 'The public catalogue contains local fixture entries.',
    hash: 'a'.repeat(24), observedAt: new Date().toISOString(), documentStatus: 200,
    elements: options.modelType ? [{ ref: observations >= 3 ? 'e9' : fresh ? 'e8' : 'e1', role: 'textbox', label: 'Search', field: 'text', inViewport: true }]
      : [{ ref: fresh ? 'e8' : 'e1', role: 'link', label: 'Catalogue', href: `${ADDRESS}/list`, inViewport: true }],
    signals: { captcha: Boolean(options.captcha && observations > 1), password: false, otp: false, card: false },
    scroll: { top: 0, height: 200, viewport: 800 } });
  const checkpoint = (conversationId: string): AgentSessionCheckpoint => ({ version: 1, ownerId: OWNER, conversationId, accountId: null,
    savedAt: new Date().toISOString(), status: options.checkpointStatus ?? 'ready', actionKind: null, resumeUrl: ADDRESS, urlHash: 'b'.repeat(64),
    pageHash: 'a'.repeat(24), observedAt: new Date().toISOString(), documentStatus: 200, effect: null });
  const browser = {
    setCheckpointStore(next: typeof store) { store = next; }, async bindAccount() {}, async bindRecoveryCheckpoint() {}, async close() {}, async hasPage() { return live; },
    async screen() { return null; }, async prepareAction() { return null; },
    async acknowledgeRecovery(_owner: string, id: string, authority: AgentAuthority) { await authority.saveCheckpoint?.(checkpoint(id)); },
    async observe(_owner: string, id: string) {
      observations++;await store?.(checkpoint(id));
      if (options.initialReadFails && observations === 1) {
        if (options.losePage) live = false;
        throw new BrowserError(options.losePage ? 'AGENT_PAGE_CLOSED' : 'AGENT_PAGE_UNREADABLE', 'Synthetic initial read failure.', 502);
      }
      if (options.holdDuringRecovery && observations === 2) throw new AgentEffectHeld({ id: 'fixture-held-post', url: `${ADDRESS}/effect`, method: 'POST', bodyHash: 'c'.repeat(64), bodyPreview: 'fixture=value', expiresAt: Date.now() + 60_000 });
      if (options.cancelOnRecovery && observations === 2) await control.cancel(OWNER, id);
      return { page: makePage(observations > 1), changed: false };
    },
    async restoreSession(_owner: string, id: string, saved: AgentSessionCheckpoint, authority: AgentAuthority) {
      await authority.assertActive();expect(saved).toMatchObject({ status: 'ready', resumeUrl: ADDRESS });
      restores++;live = true;observations++;await store?.(checkpoint(id));
      return { status: 'readback', result: { page: makePage(true), changed: false }, sameUrl: true, sameContent: true, requiresReplan: true };
    },
    async releaseHeld() { releases++;return { page: makePage(true), changed: false }; },
    async act(_owner: string, id: string, action: AgentAction, authority: AgentAuthority, _permit?: AgentRequestPermit, expected?: readonly AgentPostcondition[]) {
      actions.push(action);await authority.assertActive();await authority.saveCheckpoint?.(checkpoint(id));
      if (action.kind === 'type') verificationRefs.push(expected?.find(condition => condition.kind === 'field')?.ref);
      if (action.kind !== 'wait' && (options.alwaysFail || actions.length <= (options.failTimes ?? 1))) {
        if (options.losePage) live = false;
        throw new BrowserError(options.code ?? 'AGENT_NAVIGATION_FAILED', 'Synthetic transient failure.', 409);
      }
      return { page: makePage(observations > 1), changed: false };
    },
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
    models: options.model ? { fast: ['recovery-script'], deep: ['recovery-script'], vision: '' } : { fast: [], deep: [], vision: '' },
    createProvider: model => ({ id: 'recovery-script', async generate() {
      modelCalls++;
      const decision = options.waits && modelCalls <= options.waits ? { tool: 'wait', text: '1' }
        : !options.waits && modelCalls === 1 ? options.modelType ? { tool: 'type', ref: 'e1', text: 'Fixture query', submit: false }
          : { tool: 'click', ref: observations > 1 ? 'e8' : 'e1' }
          : { tool: 'answer', text: 'The catalogue was read; further verification remains.', outcome: 'partial' };
      return { model, text: JSON.stringify({ ...BLANK, ...decision }), usage: { inputTokens: 1, outputTokens: 1 } };
    } }),
  });
  fixtures.push({ control, database });
  const run = async (goal = `افتح ${ADDRESS}`) => {
    const { id } = await control.create(OWNER, { goal });await control.settled(id);
    const stored = await database.db.selectFrom('chat_runs').select(['id', 'goal', 'state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { detail: await control.detail(OWNER, id), state: stored.state as BrainState, goal: stored.goal as string, runId: stored.id as string, status: stored.status as string };
  };
  return { control, database, actions, verificationRefs, run, observations: () => observations, restores: () => restores, releases: () => releases, nextClick: () => { modelCalls = 0; } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown();await f.database.close(); } });

describe('automatic recovery through deterministic hands and model browser dispatch', () => {
  it('reobserves and resumes a direct open inside the same goal and run', async () => {
    const f = await fixture(), result = await f.run();
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(result.goal).toBe(`افتح ${ADDRESS}`);expect(result.state.hands).toBeFalsy();
    expect(f.actions).toEqual([{ kind: 'open', text: ADDRESS }, { kind: 'open', text: ADDRESS }]);
    expect(result.state.progressRecovery?.browser).toMatchObject({ attempts: 1, history: [{ reason: 'AGENT_NAVIGATION_FAILED' }] });
    expect(result.state.steps).toBe(1);expect(result.detail.question).toBeNull();
  });
  it('also recovers deterministic hands outside the model decision loop', async () => {
    const f = await fixture({ code: 'AGENT_PAGE_UNREADABLE' }), result = await f.run('انزل');
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(f.actions).toEqual([{ kind: 'scroll', text: 'down' }, { kind: 'scroll', text: 'down' }]);
    expect(result.state.hands).toBeNull();expect(result.state.progressRecovery?.browser?.attempts).toBe(1);
    expect(result.state.steps).toBe(2);
  });
  it('rebinds a model stale reference after reading the same uniquely identified target', async () => {
    const f = await fixture({ model: true, code: 'AGENT_REF_STALE' }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(result.detail.status, JSON.stringify({ error: result.detail.error, trail: result.state.trail, recovery: result.state.progressRecovery })).toBe('idle');expect(result.detail.question).toBeNull();
    expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }, { kind: 'click', ref: 'e8' }]);
    expect(result.state.progressRecovery?.browser?.attempts).toBe(1);
    expect(result.state.supervision?.steps.some(step => step.tool === 'browser_recovery_read')).toBe(true);
  });
  it('uses the newly observed reference again after a second transient stale failure', async () => {
    const f = await fixture({ model: true, code: 'AGENT_REF_STALE', failTimes: 2 }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(f.actions.map(action => action.ref)).toEqual(['e1', 'e8', 'e8']);
    expect(result.state.progressRecovery?.browser?.attempts).toBe(2);
  });
  it('remaps field verification from each preceding reference when a type action becomes stale twice', async () => {
    const f = await fixture({ model: true, modelType: true, code: 'AGENT_REF_STALE', failTimes: 2 }), result = await f.run('اكتب Fixture query في حقل Search في الصفحة الحالية');
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');
    expect(f.actions.map(action => action.ref)).toEqual(['e1', 'e8', 'e9']);
    expect(f.verificationRefs).toEqual(['e1', 'e8', 'e9']);
  });
  it('does not retry after the owner cancels while the recovery read is in progress', async () => {
    const f = await fixture({ model: true, code: 'AGENT_REF_STALE', cancelOnRecovery: true }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(result.status).toBe('cancelled');expect(f.actions).toHaveLength(1);
    expect(result.state.progressRecovery?.browser?.attempts).toBe(1);
  });
  it('restores only the ready same-account page and reads it before retrying', async () => {
    const f = await fixture({ code: 'AGENT_PAGE_CLOSED', losePage: true }), result = await f.run();
    expect(result.detail.status).toBe('idle');expect(f.restores()).toBe(1);
    expect(f.actions).toHaveLength(2);
    expect(result.state.progressRecovery?.browser?.history[0].strategy).toBe('restore_and_read');
  });
  it('recovers an initial transient observation before continuing deterministic hands', async () => {
    const f = await fixture({ initialReadFails: true, failTimes: 0 }), result = await f.run('انزل');
    expect(result.detail.status, result.detail.error ?? '').toBe('idle');expect(f.observations()).toBe(2);
    expect(f.actions).toHaveLength(1);expect(result.state.progressRecovery?.browser?.history[0]).toMatchObject({ action: 'observe', reason: 'AGENT_PAGE_UNREADABLE' });
  });
  it('checks a restored CAPTCHA before deterministic hands can dispatch another gesture', async () => {
    const f = await fixture({ initialReadFails: true, losePage: true, failTimes: 0, captcha: true }), result = await f.run('انزل');
    expect(f.restores()).toBe(1);expect(result.detail.status).toBe('waiting_input');
    expect(result.detail.secure?.kind).toBe('hands_on');expect(f.actions).toEqual([]);
  });
  it('does not restore a lost page from an explicitly closed checkpoint', async () => {
    const f = await fixture({ code: 'AGENT_PAGE_CLOSED', losePage: true, checkpointStatus: 'closed' }), result = await f.run();
    expect(result.detail.status).toBe('failed');expect(f.restores()).toBe(0);expect(f.actions).toHaveLength(1);
    expect(result.state.progressRecovery?.browser).toBeUndefined();
  });
  it('stops after three automatic reads when navigation keeps failing', async () => {
    const f = await fixture({ alwaysFail: true }), result = await f.run();
    expect(result.detail.status).toBe('failed');expect(f.actions).toHaveLength(4);
    expect(result.state.progressRecovery?.browser?.attempts).toBe(3);expect(result.state.steps).toBe(3);
    expect(result.detail.question).toBeNull();
  });
  it.each(['AGENT_EFFECT_UNKNOWN', 'AGENT_NETWORK_DENIED', 'AGENT_APPROVAL_STALE'])('never automatically replays %s', async code => {
    const f = await fixture({ code }), result = await f.run();
    expect(f.actions).toHaveLength(1);expect(f.observations()).toBe(1);expect(f.restores()).toBe(0);
    expect(result.state.progressRecovery?.browser).toBeUndefined();expect(result.detail.status).toBe('failed');
  });
  it('pauses at a newly observed CAPTCHA without retrying the click', async () => {
    const f = await fixture({ model: true, code: 'AGENT_REF_STALE', captcha: true }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(f.actions).toHaveLength(1);expect(result.detail.status, result.detail.error ?? '').toBe('waiting_input');
    expect(result.detail.secure?.kind).toBe('hands_on');
  });
  it.each(['AGENT_CLICK_FAILED', 'AGENT_PAGE_UNREADABLE', 'AGENT_PAGE_CLOSED'])('reads but fences an uncertain %s gesture even when DOM and network appear unchanged', async code => {
    const f = await fixture({ model: true, code }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(f.actions).toEqual([{ kind: 'click', ref: 'e1' }]);expect(f.observations()).toBe(2);
    expect(result.detail.status).toBe('failed');expect(result.state.progressRecovery?.browser?.uncertain).toBe(true);
    const row = await f.database.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id', '=', result.detail.id).executeTakeFirstOrThrow();
    expect(row.browser_checkpoint.status).toBe('review_required');
    expect(await f.database.db.selectFrom('chat_effect_receipts').selectAll().execute()).toEqual([]);
  });
  it('keeps the uncertainty fence across a new request and clears it only after explicit owner review', async () => {
    const f = await fixture({ model: true, code: 'AGENT_CLICK_FAILED' }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    f.nextClick();await f.control.send(OWNER, result.detail.id, { text: 'اضغط رابط Catalogue في الصفحة الحالية' });await f.control.settled(result.detail.id);
    expect(f.actions).toHaveLength(1);
    const blocked = await f.control.detail(OWNER, result.detail.id);
    expect(['idle', 'failed']).toContain(blocked.status);expect(blocked.browser?.recoveryToken).toBeTruthy();
    const stillFenced = await f.database.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id', '=', result.detail.id).executeTakeFirstOrThrow();
    expect(stillFenced.browser_checkpoint.status).toBe('review_required');
    await f.control.reviewBrowser(OWNER, result.detail.id, { reviewed: true, checkpointToken: blocked.browser!.recoveryToken! });
    await f.control.settled(result.detail.id);
    const reviewedDetail = await f.control.detail(OWNER, result.detail.id);
    expect(reviewedDetail.status, reviewedDetail.error ?? '').toBe('idle');
    const reviewed = await f.database.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id', '=', result.detail.id).executeTakeFirstOrThrow();
    expect(reviewed.browser_checkpoint.status).toBe('ready');expect(f.actions).toHaveLength(1);
    f.nextClick();await f.control.send(OWNER, result.detail.id, { text: 'اضغط رابط Catalogue في الصفحة الحالية' });await f.control.settled(result.detail.id);
    expect(f.actions).toHaveLength(2);
  });
  it('does not release a subsequently approved held POST before the earlier uncertain gesture is reviewed', async () => {
    const f = await fixture({ model: true, code: 'AGENT_CLICK_FAILED', holdDuringRecovery: true }), result = await f.run('اضغط رابط Catalogue في الصفحة الحالية');
    expect(result.detail.status).toBe('waiting_approval');expect(result.state.progressRecovery?.browser?.uncertain).toBe(true);
    await f.control.approve(OWNER, result.detail.id, { approvalId: result.detail.approval!.id, approved: true });
    await f.control.settled(result.detail.id);
    expect(f.releases()).toBe(0);expect(f.actions).toHaveLength(1);
    const row = await f.database.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id', '=', result.detail.id).executeTakeFirstOrThrow();
    expect(row.browser_checkpoint.status).toBe('review_required');
  });
  it('automatically rereads a stalled browser task before publishing a retry card', async () => {
    const f = await fixture({ model: true, waits: 6 }), result = await f.run(`افتح ${ADDRESS} واقرأ محتوى الصفحة`);
    expect(result.detail.status).toBe('idle');expect(result.detail.question).toBeNull();
    expect(result.state.progressRecovery?.browser?.history.some(entry => entry.strategy === 'observe_and_replan')).toBe(true);
    expect(result.state.progressRecovery?.retries).toBe(0);expect(result.state.steps).toBeGreaterThan(6);
    expect(result.state.supervision?.steps.length).toBeGreaterThan(6);
  });
});
