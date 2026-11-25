import { describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentActionResult, type AgentAuthority } from './agent-browser.js';

// These tests exercise reservations and native-input exclusion without launching
// Chromium, so they can run while the owner's GPU training remains active.
const authority = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const deferred = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
function fixture() {
  const browser = new AgentBrowser({ profileDir: 'unused-boundary-unit-fixture', idlePageMs: null });
  const entry = {
    ownerId: 'boundary-owner', conversationId: 'boundary-task', page: { isClosed: () => false }, pages: new Set(),
    readers: 0, mutations: 0, captureEpoch: 0, shot: null, lastHash: null, lastUsed: Date.now(), redactions: new Map(),
    history: [], historyIndex: -1, targets: new Map(),
    recovery: { status: 'ready', actionKind: null, effect: null, reviewRequired: false }, checkpointWrite: Promise.resolve(),
    activity: { sequence: 0, cursor: null, events: [] },
  } as unknown as Parameters<AgentBrowser['withMutation']>[0];
  const owner = { conversations: new Map([[entry.conversationId, entry]]), allocation: Promise.resolve() } as Awaited<ReturnType<AgentBrowser['owner']>>;
  vi.spyOn(browser as unknown as { owner: AgentBrowser['owner'] }, 'owner').mockResolvedValue(owner);
  const result = { page: { id: 'unit-observation', hash: 'unit-hash' }, changed: false } as AgentActionResult;
  return { browser, entry, result };
}

describe('browser session action boundaries without a browser process', () => {
  it('attributes select-triggered autosave to the active action for the same write policy as click and Enter', () => {
    const { browser, entry } = fixture();
    for (const kind of ['select', 'click', 'type', 'press', 'form'] as const) {
      const operation = { kind, authority: authority(), used: false, pending: new AbortController() };
      expect(browser['actor'](entry, operation, false, 'https://ads.google.com/autosave')).toBe('agent');
    }
  });

  it('refuses concurrent native inputs and releases the reservation after completion', async () => {
    const { browser, entry } = fixture(), gate = deferred(), events: string[] = [];
    const first = browser['withMutation'](entry, async () => { events.push('first'); await gate.promise; });
    await expect(browser['withMutation'](entry, async () => { events.push('unexpected'); })).rejects.toMatchObject({ code: 'AGENT_ACTION_BUSY' });
    expect(events).toEqual(['first']);
    gate.release(); await first;
    await browser['withMutation'](entry, async () => { events.push('after'); });
    expect(events).toEqual(['first', 'after']);
    expect(entry.mutations).toBe(0);
  });

  it('cannot reserve an authorized action while legacy input is in flight', async () => {
    const { browser, entry } = fixture(), gate = deferred();
    const first = browser['withMutation'](entry, () => gate.promise);
    await expect(browser.act(entry.ownerId, entry.conversationId, { kind: 'click', ref: 'e1' }, authority())).rejects.toMatchObject({ code: 'AGENT_ACTION_BUSY' });
    expect(entry.operation).toBeUndefined();
    gate.release(); await first;
  });

  it('cannot release a held request while native input is changing the same session', async () => {
    const { browser, entry } = fixture(), gate = deferred();
    entry.held = { effect: { id: 'held-effect', url: 'https://fixture.example/save', method: 'POST', bodyHash: 'body', bodyPreview: '', expiresAt: Date.now() + 60000 } } as NonNullable<typeof entry.held>;
    const first = browser['withMutation'](entry, () => gate.promise);
    await expect(browser.releaseHeld(entry.ownerId, entry.conversationId, 'held-effect', authority())).rejects.toMatchObject({ code: 'AGENT_ACTION_BUSY' });
    expect(entry.held.effect.id).toBe('held-effect'); expect(entry.operation).toBeUndefined();
    gate.release(); await first;
  });

  it('keeps native input reserved to its active execution even before its first gesture', async () => {
    const { browser, entry, result } = fixture(), entered = deferred(), gate = deferred(), events: string[] = [];
    const auth = authority(); auth.assertActive = async () => { entered.release(); await gate.promise; };
    vi.spyOn(browser, 'click').mockImplementation(async () => browser['withMutation'](entry, async () => { events.push('authorized'); return result; }));
    const action = browser.act(entry.ownerId, entry.conversationId, { kind: 'click', ref: 'e1' }, auth);
    await entered.promise;
    await expect(browser['withMutation'](entry, async () => { events.push('outside-execution'); })).rejects.toMatchObject({ code: 'AGENT_ACTION_BUSY' });
    await expect(browser.act(entry.ownerId, entry.conversationId, { kind: 'click', ref: 'e1' }, authority())).rejects.toMatchObject({ code: 'AGENT_ACTION_BUSY' });
    gate.release(); expect(await action).toBe(result);
    expect(events).toEqual(['authorized']);
    expect(entry.operation).toBeUndefined();
    expect(entry.mutations).toBe(0);
  });

  it('releases the reservation on cancelled authority without making native input', async () => {
    const { browser, entry } = fixture(), controller = new AbortController(), auth = authority();
    controller.abort(new Error('task cancelled')); auth.signal = controller.signal;
    const click = vi.spyOn(browser, 'click');
    await expect(browser.act(entry.ownerId, entry.conversationId, { kind: 'click', ref: 'e1' }, auth)).rejects.toThrow('task cancelled');
    expect(click).not.toHaveBeenCalled();
    expect(entry.operation).toBeUndefined();
    await expect(browser['withMutation'](entry, async () => 'released')).resolves.toBe('released');
  });

  it('releases native input and execution reservations after a failed gesture', async () => {
    const { browser, entry } = fixture();
    vi.spyOn(browser, 'click').mockImplementation(async () => browser['withMutation'](entry, async () => { throw new Error('stale target'); }));
    await expect(browser.act(entry.ownerId, entry.conversationId, { kind: 'click', ref: 'e1' }, authority())).rejects.toThrow('stale target');
    expect(entry.mutations).toBe(0); expect(entry.operation).toBeUndefined();
    await expect(browser['withMutation'](entry, async () => 'released')).resolves.toBe('released');
  });
});
