import { describe, expect, it } from 'vitest';
import { decideEffect, requiresGoogleAdsTypedApi, type EffectRequest } from './effect-policy.ts';

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

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('holds a %s disguised as the expected link navigation', method => {
    for (const url of [`${page}/save`, 'https://other.example/save']) {
      expect(decideEffect(request({ url, method, bodyHash: 'unreviewed-account-change', topLevelNavigation: true, expectedNavigation: url })))
        .toEqual({ kind: 'hold', reason: 'write' });
    }
  });

  it('still requires an exact one-use permit for an expected write destination', () => {
    const navigation = { ...write, topLevelNavigation: true, expectedNavigation: permit.url };
    expect(decideEffect({ ...navigation, permit })).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: true });
    expect(decideEffect({ ...navigation, permit, bodyHash: 'different-account-or-values' })).toEqual({ kind: 'hold', reason: 'write' });
  });

  it('never lets a page navigate itself between actions', () => {
    expect(decideEffect(request({ actor: 'page', topLevelNavigation: true }))).toEqual({ kind: 'deny', code: 'AGENT_EFFECT_DENIED', failsAction: false });
  });

  it('lets the owner act during takeover, without a permit', () => {
    expect(decideEffect({ ...write, actor: 'owner' })).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: false });
    expect(decideEffect(request({ actor: 'owner', url: 'https://other.example/', topLevelNavigation: true })).kind).toBe('allow');
  });
});

describe('Google Ads generic-browser mutation boundary', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks %s via click, Enter, form and autosave transport even with an exact generic permit', method => {
    for (const actor of ['agent', 'owner', 'page'] as const) for (const topLevelNavigation of [true, false]) {
      const url = 'https://ads.google.com/aw/campaigns';
      expect(decideEffect(request({ url, method, actor, topLevelNavigation, expectedNavigation: url, bodyHash: 'approved-generic-body',
        permit: { url, method, bodyHash: 'approved-generic-body', used: false, expiresAt: 2000 } })))
        .toEqual({ kind: 'deny', code: 'GOOGLE_ADS_TYPED_API_REQUIRED', failsAction: actor === 'agent' });
    }
  });

  it('protects the Ads API and legacy UI endpoints, including subdomains and a trailing DNS dot', () => {
    for (const url of ['https://googleads.googleapis.com/v23/customers/123/googleAds:mutate', 'https://adwords.google.com/', 'https://test.ads.google.com/', 'https://ADS.GOOGLE.COM./aw/campaigns']) {
      expect(requiresGoogleAdsTypedApi(url, 'post')).toBe(true);
    }
  });

  it('keeps read-only Ads observations and Google account login handoff available', () => {
    for (const method of ['GET', 'HEAD']) expect(requiresGoogleAdsTypedApi('https://ads.google.com/aw/campaigns', method)).toBe(false);
    expect(requiresGoogleAdsTypedApi('https://accounts.google.com/signin', 'POST')).toBe(false);
    expect(decideEffect(request({ url: 'https://accounts.google.com/signin', method: 'POST', actor: 'owner', topLevelNavigation: true }))).toEqual({ kind: 'allow', credentials: 'keep', consumesPermit: false });
  });

  it('does not mistake unrelated hostnames for the protected integration', () => {
    for (const url of ['https://ads.google.com.example.org/', 'https://notads.google.com/', 'https://example.org/ads.google.com']) expect(requiresGoogleAdsTypedApi(url, 'POST')).toBe(false);
    expect(decideEffect(write)).toEqual({ kind: 'hold', reason: 'write' });
  });
});
