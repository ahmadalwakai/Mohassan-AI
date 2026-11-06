import { describe, expect, it } from 'vitest';
import { decideEffect, type EffectRequest } from './effect-policy.ts';

const page = 'https://shop.example';
const request = (change: Partial<EffectRequest> = {}): EffectRequest => ({
  url: `${page}/api/items`, method: 'GET', bodyHash: 'none', pageOrigin: page,
  topLevelNavigation: false, actor: 'agent', now: 1000, ...change,
});
const permit = { url: `${page}/save`, method: 'POST', bodyHash: 'body', used: false, expiresAt: 2000 };
const write = request({ url: permit.url, method: 'POST', bodyHash: 'body' });

describe('browser effect policy (owner option A)', () => {
  it('lets a page read its own origin with cookies, in and between actions', () => {
    for (const actor of ['agent', 'page'] as const) expect(decideEffect(request({ actor }))).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: false });
  });

  it('strips cookies from cross-origin reads', () => {
    expect(decideEffect(request({ url: 'https://cdn.example/app.js' }))).toEqual({ kind: 'allow', credentials: 'omit', consumesPermit: false });
  });

  it('holds an unapproved write from an action and sends nothing', () => {
    expect(decideEffect(write)).toEqual({ kind: 'hold', reason: 'write' });
  });

  it('drops a background write without failing the next action', () => {
    expect(decideEffect({ ...write, actor: 'page' })).toEqual({ kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction: false });
  });

  it('spends a matching permit once and refuses its replay', () => {
    expect(decideEffect({ ...write, permit })).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: true });
    expect(decideEffect({ ...write, actor: 'page', permit: { ...permit, used: true } })).toEqual({ kind: 'deny', code: 'AGENT_EFFECT_UNKNOWN', failsAction: true });
  });

  it('treats a changed body, target or method as a different effect', () => {
    for (const change of [{ bodyHash: 'other' }, { url: `${page}/delete` }, { method: 'PUT' }]) {
      expect(decideEffect({ ...write, ...change, permit }).kind).toBe('hold');
    }
  });

  it('refuses an expired permit', () => {
    expect(decideEffect({ ...write, permit: { ...permit, expiresAt: 1000 } })).toEqual({ kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction: true });
  });

  it('allows the planned navigation and same-origin redirects, holds cross-origin ones', () => {
    const next = 'https://other.example/';
    expect(decideEffect(request({ url: next, topLevelNavigation: true, expectedNavigation: next })).kind).toBe('allow');
    expect(decideEffect(request({ topLevelNavigation: true })).kind).toBe('allow');
    expect(decideEffect(request({ url: next, topLevelNavigation: true }))).toEqual({ kind: 'hold', reason: 'cross_origin_navigation' });
  });

  it('never lets a page navigate itself between actions', () => {
    expect(decideEffect(request({ actor: 'page', topLevelNavigation: true }))).toEqual({ kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction: false });
  });

  it('lets the owner act during takeover, without a permit', () => {
    expect(decideEffect({ ...write, actor: 'owner' })).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: false });
    expect(decideEffect(request({ actor: 'owner', url: 'https://other.example/', topLevelNavigation: true })).kind).toBe('allow');
  });
});
