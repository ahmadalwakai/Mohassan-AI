import type { Route } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAuthority, AgentPage } from '../packages/browser/src/agent-browser.js';
import {
  assertBrowserHandsEffect, assertBrowserHandsOwnerFree, assertBrowserHandsReady, browserHandsActionHash,
  finishBrowserHandsHandover, observeBrowserHandsPage,
} from '../packages/browser/src/browser-hands-agent.js';
import { BrowserHumanStepError } from '../packages/browser/src/browser-hands-human.js';

const readyPage: AgentPage = {
  id: 'observation', url: 'https://example.com/', title: 'Page', text: 'Page content', elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 100, viewport: 100 }, hash: 'current-content', observedAt: '2026-11-25T00:00:00Z',
};
const authority: AgentAuthority = {
  signal: new AbortController().signal, assertActive: async () => {}, dispatched: async () => 'receipt', completed: async () => {},
};
const ownerSession = () => ({
  page: { isClosed: () => false }, readers: 0, mutations: 0, captureEpoch: 0,
  recovery: { status: 'review_required', reviewRequired: false, actionKind: null },
});
const routeFor = (method: string, contentType = '', data: string | null = null) => ({
  request: () => ({ method: () => method, headers: () => ({ 'content-type': contentType }), postData: () => data }),
}) as unknown as Route;

describe('browser hands action fences', () => {
  it('keeps the original permit hash input when the feature is disabled', () => {
    const action = { kind: 'click' as const, ref: 'e1', browserHands: { url: readyPage.url, irreversible: true } };
    expect(browserHandsActionHash(action)).toEqual(['click', 'e1', null, false]);
    expect(browserHandsActionHash(action, true)).toContain(readyPage.url);
    expect(() => assertBrowserHandsReady(readyPage, action, true)).toThrow(expect.objectContaining({ code: 'AGENT_REF_STALE' }));
    const page = { ...readyPage, elements: [{ ref: 'e1', role: 'button', label: 'Confirm', inViewport: true }] };
    expect(() => assertBrowserHandsReady(page, action, false)).toThrow(expect.objectContaining({ code: 'AGENT_APPROVAL_REQUIRED' }));
  });

  it('blocks a sensitive agent request before a held preview while allowing authenticated owner gestures', () => {
    const form = routeFor('POST', 'application/x-www-form-urlencoded', 'national_id=fixture-value');
    const hold = { kind: 'hold', reason: 'write' } as const;
    expect(() => assertBrowserHandsEffect(form, readyPage.url, 'agent', hold)).toThrow(BrowserHumanStepError);
    expect(() => assertBrowserHandsEffect(form, readyPage.url, 'owner', hold)).not.toThrow();
    expect(() => assertBrowserHandsEffect(routeFor('GET'), `${readyPage.url}?verification_code=fixture`, 'agent', hold))
      .toThrow(expect.objectContaining({ step: expect.objectContaining({ reason: 'code' }) }));
    expect(() => assertBrowserHandsEffect(routeFor('POST', 'application/json', '{"country":"fixture"}'), readyPage.url, 'agent', hold)).not.toThrow();
  });

  it('blocks opaque script writes while an identifying field is exposed', () => {
    const page = { ...readyPage, elements: [{ ref: 'e1', role: 'textbox', label: 'National ID', inViewport: true,
      match: { name: 'National ID', label: 'National ID', nearby: '', placeholder: '', text: '', control: 'text' as const, humanOnly: 'identity' as const, exposed: true } }] };
    const operation = {};
    assertBrowserHandsReady(page, { kind: 'click' }, undefined, operation);
    expect(() => assertBrowserHandsEffect(routeFor('POST'), readyPage.url, 'agent', { kind: 'hold', reason: 'write' }, operation))
      .toThrow(expect.objectContaining({ step: expect.objectContaining({ reason: 'identity' }) }));
  });
});

describe('browser hands manual resume fence', () => {
  const result = async () => ({ page: readyPage, changed: true });

  it('polls read-only and avoids an in-progress manual gesture', async () => {
    const session = ownerSession();
    const observe = vi.fn(async () => readyPage);
    session.mutations = 1;
    expect(await observeBrowserHandsPage(session, observe)).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    session.mutations = 0;
    expect(await observeBrowserHandsPage(session, observe)).toBe(readyPage);
    expect(session.readers).toBe(0);
    expect(session.recovery.status).toBe('review_required');
  });

  it('clears only a matching manual checkpoint and releases its mutation reservation', async () => {
    const session = ownerSession();
    const save = vi.fn(async () => {});
    const observe = async () => {
      expect(() => assertBrowserHandsOwnerFree(session)).toThrow(expect.objectContaining({ code: 'AGENT_ACTION_BUSY' }));
      return result();
    };
    expect(await finishBrowserHandsHandover(session, { ...readyPage, hash: 'changed' }, authority, observe, save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(await finishBrowserHandsHandover(session, readyPage, authority, observe, save)).toBe(readyPage);
    expect(save).toHaveBeenCalledOnce();
    expect(session.recovery.status).toBe('ready');
    expect(() => assertBrowserHandsOwnerFree(session)).not.toThrow();
  });

  it('preserves an earlier unknown effect and restores the marker after a failed checkpoint save', async () => {
    const session = ownerSession();
    const save = vi.fn(async () => { throw new Error('checkpoint lease lost'); });
    session.recovery.reviewRequired = true;
    expect(await finishBrowserHandsHandover(session, readyPage, authority, result, save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    session.recovery.reviewRequired = false;
    await expect(finishBrowserHandsHandover(session, readyPage, authority, result, save)).rejects.toThrow('checkpoint lease lost');
    expect(session.recovery.status).toBe('review_required');
    expect(session.readers).toBe(0);
  });
});
