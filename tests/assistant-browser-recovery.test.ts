import { describe, expect, it } from 'vitest';
import { BrowserError, type AgentAction, type AgentPage } from '@mohassan/browser';
import { rebindBrowserAction, reserveBrowserRecovery, transientBrowserFailure } from '../apps/server/src/assistant/browser-recovery.js';
import { createProgressRecovery, resumeBrowserProgressAutomatically, reviewProgressRecovery } from '../apps/server/src/assistant/progress-recovery.js';
import { compileTaskSupervisor, observeTaskStep } from '../apps/server/src/assistant/task-supervisor.js';

const page = (ref = 'e1'): AgentPage => ({ id: 'page', url: 'https://recovery.test/catalogue', title: 'Catalogue', text: 'Open catalogue',
  hash: 'a'.repeat(24), observedAt: new Date().toISOString(), scroll: { top: 0, height: 100, viewport: 800 },
  signals: { captcha: false, password: false, otp: false, card: false },
  elements: [{ ref, label: 'Catalogue', role: 'link', href: 'https://recovery.test/catalogue/list', inViewport: true }] });

describe('bounded browser recovery before any effect', () => {
  it.each(['AGENT_EFFECT_UNKNOWN', 'AGENT_EFFECT_DENIED', 'AGENT_APPROVAL_STALE', 'AGENT_NETWORK_DENIED',
    'AGENT_RECOVERY_REVIEW_REQUIRED', 'CHAT_ACTION_REVIEW_REQUIRED', 'AGENT_FIELD_VALUE_PROTECTED'])('never retries %s', code => {
    expect(transientBrowserFailure(new BrowserError(code, 'blocked', 409), { kind: 'click', ref: 'e1' })).toBeNull();
  });
  it('does not infer a safe click from an untyped timeout or reuse an approval', () => {
    const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
    expect(transientBrowserFailure(timeout, { kind: 'click', ref: 'e1' })).toBeNull();
    expect(transientBrowserFailure(timeout, 'observe')).toBe('BROWSER_READ_TIMEOUT');
    expect(transientBrowserFailure(new BrowserError('AGENT_REF_STALE', 'stale'), { kind: 'click', ref: 'e1' }, true)).toBeNull();
  });
  it('rebinds a stale reference only to the same uniquely observed target', () => {
    const action: AgentAction = { kind: 'click', ref: 'e1' }, before = page(), fresh = page('e8');
    expect(rebindBrowserAction(action, before, fresh, 'AGENT_REF_STALE')).toEqual({ kind: 'click', ref: 'e8' });
    fresh.elements.push({ ...fresh.elements[0], ref: 'e9' });
    expect(rebindBrowserAction(action, before, fresh, 'AGENT_REF_STALE')).toBeNull();
    fresh.elements.pop();fresh.url += '/other';
    expect(rebindBrowserAction(action, before, fresh, 'AGENT_REF_STALE')).toBeNull();
  });
  it('retains an exact surviving host reference even when another field has the same identity', () => {
    const before = page(), fresh = page();
    fresh.elements.push({ ...fresh.elements[0], ref: 'e9', inViewport: false });
    expect(rebindBrowserAction({ kind: 'click', ref: 'e1' }, before, fresh, 'AGENT_REF_STALE')).toEqual({ kind: 'click', ref: 'e1' });
  });
  it('rejects a surviving reference whose identity changed instead of falling back to another lookalike', () => {
    const before = page(), fresh = page();
    fresh.elements.push({ ...fresh.elements[0], ref: 'e9' });
    fresh.elements[0].label = 'Delete account';
    expect(rebindBrowserAction({ kind: 'click', ref: 'e1' }, before, fresh, 'AGENT_REF_STALE')).toBeNull();
  });
  it('still rejects duplicate identities when the original host reference disappeared', () => {
    const before = page(), fresh = page('e8');
    fresh.elements.push({ ...fresh.elements[0], ref: 'e9' });
    expect(rebindBrowserAction({ kind: 'click', ref: 'e1' }, before, fresh, 'AGENT_REF_STALE')).toBeNull();
  });
  it('does not replay a timed-out click after the UI changed, a form or secret field', () => {
    const before = page(), fresh = page('e8');fresh.hash = 'b'.repeat(24);
    expect(rebindBrowserAction({ kind: 'click', ref: 'e1' }, before, fresh, 'AGENT_CLICK_FAILED')).toBeNull();
    expect(rebindBrowserAction({ kind: 'form', ref: 'e1' }, before, fresh, 'AGENT_REF_STALE')).toBeNull();
    before.elements[0].field = 'password';fresh.elements[0].field = 'password';
    expect(rebindBrowserAction({ kind: 'type', ref: 'e1', text: 'value' }, before, fresh, 'AGENT_REF_STALE')).toBeNull();
  });
  it.each(['AGENT_CLICK_FAILED', 'AGENT_PAGE_UNREADABLE', 'AGENT_PAGE_CLOSED'])('does not replay any gesture after %s even with the same DOM hash', reason => {
    for (const kind of ['click', 'type', 'select'] as const)
      expect(rebindBrowserAction({ kind, ref: 'e1', text: 'value' }, page(), page('e8'), reason)).toBeNull();
  });
  it('records at most three monotonic attempts and rejects malformed history', () => {
    let state = reserveBrowserRecovery(undefined, { reason: 'AGENT_REF_STALE', action: 'click', strategy: 'observe_and_retry', step: 1, sequence: 0 })!;
    state = reserveBrowserRecovery(state, { ...state.history[0], step: 2 })!;
    state = reserveBrowserRecovery(state, { ...state.history[0], step: 3 })!;
    expect(state.attempts).toBe(3);
    expect(reserveBrowserRecovery(state, { ...state.history[0], step: 4 })).toBeNull();
    expect(reserveBrowserRecovery({ attempts: 0, history: state.history }, state.history[0])).toBeNull();
  });
});

describe('automatic browser strategy changes preserve host budgets and evidence', () => {
  function fixture() {
    const ledger = compileTaskSupervisor({ id: 'recovery-run', objective: 'Read the requested browser catalogue', now: 1000, operation: { kind: 'conversation' } });
    for (let index = 0; index < 6; index++) observeTaskStep(ledger, { stepId: `step-${index}`, sequence: index + 1,
      tool: 'wait', startedAt: 1000 + index * 2, finishedAt: 1001 + index * 2, result: 'succeeded', observations: [] });
    const context = { runId: 'recovery-run', contractHash: ledger.contract.hash, totalSteps: 6, failures: 0, unchanged: 6,
      supervision: ledger, effectStatus: 'clear' as const };
    return { ledger, context, state: createProgressRecovery(context) };
  }
  it('continues the same task without resetting its lifetime count, signatures, ledger or manual retries', () => {
    const { context, state, ledger } = fixture(), before = JSON.stringify(ledger);
    expect(reviewProgressRecovery(state, context).action).toBe('pause_for_retry');
    const resumed = resumeBrowserProgressAutomatically(state, context)!;
    expect(resumed).toMatchObject({ runId: state.runId, contractHash: state.contractHash, retries: 0,
      checkpoint: { totalSteps: 0 }, browser: { attempts: 1 }, automaticCheckpoint: { totalSteps: 6 } });
    expect(reviewProgressRecovery(resumed, context)).toMatchObject({ action: 'continue', remainingDecisions: 54 });
    expect(JSON.stringify(ledger)).toBe(before);
  });
  it('does not bypass unresolved effects, window or lifetime boundaries', () => {
    const { context, state } = fixture();
    for (const effectStatus of ['pending', 'unknown'] as const)
      expect(resumeBrowserProgressAutomatically(state, { ...context, effectStatus })).toBeNull();
    expect(resumeBrowserProgressAutomatically(state, { ...context, totalSteps: 60 })).toBeNull();
    expect(resumeBrowserProgressAutomatically(state, { ...context, totalSteps: 40, unchanged: 0, supervision: undefined })).toBeNull();
  });
  it('exhausts the shared automatic budget and then preserves the existing manual pause', () => {
    const { context, state } = fixture();let current = state;
    for (let index = 0; index < 3; index++) {
      const next = { ...context, totalSteps: 6 + index * 6, unchanged: 6 + index * 6 };
      current = resumeBrowserProgressAutomatically(current, next)!;
      expect(current.browser?.attempts).toBe(index + 1);
    }
    const stalled = { ...context, totalSteps: 24, unchanged: 24 };
    expect(resumeBrowserProgressAutomatically(current, stalled)).toBeNull();
    expect(reviewProgressRecovery(current, stalled).action).toBe('pause_for_retry');
  });
});
