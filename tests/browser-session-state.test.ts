import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, AgentSessionCheckpointSchema, evidenceHash, safeResumeUrl, type AgentAuthority, type AgentPage, type AgentSessionCheckpoint } from '@mohassan/browser';

const owner = 'checkpoint-owner';
const authority = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const ref = (page: AgentPage, label: string) => page.elements.find(element => element.label === label)!.ref;
const browsers = new Set<AgentBrowser>();
const received: string[] = [];
let server: Server, origin: string, root: string, temporaryRoot: string;
const makeBrowser = (profile = randomUUID(), onCheckpoint?: (checkpoint: AgentSessionCheckpoint) => Promise<void>) => {
  const browser = new AgentBrowser({ profileDir: join(root, profile), testOrigins: [origin], channel: null, onCheckpoint });
  browsers.add(browser); return browser;
};
const open = (browser: AgentBrowser, id: string, path: string, auth = authority()) => browser.act(owner, id, { kind: 'open', text: origin + path }, auth);

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-browser-state-'));
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    request.resume();
    request.on('end', () => {
      received.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/uncertain' && request.method === 'POST') { response.destroy(); return; }
      if (url.pathname === '/cookie-set') response.setHeader('set-cookie', 'session=durable-account; Path=/; Max-Age=3600');
      const content = url.pathname === '/cookie-read' ? `<p>${request.headers.cookie ?? 'no cookie'}</p>`
        : url.pathname === '/done' ? '<h1>Accepted receipt</h1>'
          : `<label>Note<input name=note></label><label>Password<input type=password></label><button onclick="document.querySelector('output').textContent='Unrelated change'">Change</button><output>Waiting</output><form method=post action="${url.pathname === '/unknown-form' ? '/uncertain' : '/done'}"><input name=message value=hello><button>Send</button></form>`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>State fixture</title><main>${content}</main>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await Promise.allSettled([...browsers].map(browser => browser.close()));
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-browser-state-') || within.includes('..')) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('durable browser readback and declared postconditions', () => {
  it('binds exact field, URL, title and HTTP evidence to the final observation', async () => {
    const browser = makeBrowser(), id = randomUUID(), first = await open(browser, id, '/fields');
    const expected = [{ kind: 'field' as const, ref: ref(first.page, 'Note'), equals: 'specific user value' }, { kind: 'url' as const, equals: origin + '/fields' }, { kind: 'title' as const, equals: 'State fixture' }, { kind: 'http_status' as const, allowed: [200] }, { kind: 'element' as const, role: 'button', label: 'Send' }];
    const result = await browser.act(owner, id, { kind: 'type', ref: expected[0].ref, text: 'specific user value' }, authority(), undefined, expected);
    expect(result.verification).toMatchObject({ status: 'passed', pageId: result.page.id, pageHash: result.page.hash, observedAt: result.page.observedAt });
    expect(result.verification!.checks.map(check => check.expectedHash)).toEqual(expected.map(check => evidenceHash(JSON.stringify(check))));
    const checkpoint = await browser.snapshotSession(owner, id);
    expect(checkpoint).toMatchObject({ status: 'ready', actionKind: null, resumeUrl: origin + '/fields' });
    expect(JSON.stringify(checkpoint)).not.toContain('specific user value');
    expect(AgentSessionCheckpointSchema.safeParse({ ...checkpoint, cookies: 'secret' }).success).toBe(false);
    await browser.close();
  });

  it('does not count unrelated page changes as the requested outcome and does not inspect secret fields', async () => {
    const browser = makeBrowser(), id = randomUUID(), first = await open(browser, id, '/fields');
    const result = await browser.act(owner, id, { kind: 'click', ref: ref(first.page, 'Change') }, authority());
    expect(result.changed).toBe(true);
    const failed = await browser.verifyPostconditions(owner, id, [{ kind: 'text', contains: 'Payment accepted' }], authority(), { timeoutMs: 0 });
    expect(failed.verification.status).toBe('failed');
    const secret = await browser.verifyPostconditions(owner, id, [{ kind: 'field', ref: ref(first.page, 'Password'), equals: '' }], authority(), { timeoutMs: 0 });
    expect(secret.verification).toMatchObject({ status: 'unavailable', checks: [{ status: 'unavailable', actualHash: null }] });
    await browser.close();
  });

  it('waits within a fixed budget for independent readback and respects revoked authority', async () => {
    const browser = makeBrowser(), id = randomUUID(); await open(browser, id, '/fields');
    const entry = await browser['conversation'](owner, id);
    await entry.page.evaluate(() => { setTimeout(() => { document.querySelector('output')!.textContent = 'Receipt #42'; }, 350); });
    const verified = await browser.verifyPostconditions(owner, id, [{ kind: 'text', contains: 'Receipt #42' }], authority(), { timeoutMs: 1400 });
    expect(verified.verification.status).toBe('passed');
    expect(verified.verification.samples).toBeGreaterThan(1);
    const controller = new AbortController(); controller.abort(new Error('lease revoked'));
    await expect(browser.verifyPostconditions(owner, id, [{ kind: 'text', contains: 'Receipt #42' }], { ...authority(), signal: controller.signal })).rejects.toThrow('lease revoked');
    await browser.close();
  });

  it('persists pending effect before dispatch using the execution-bound callback', async () => {
    const events: string[] = [], checkpoints: AgentSessionCheckpoint[] = [];
    const browser = makeBrowser(undefined, async () => { throw new Error('global callback cannot save a running lease'); });
    const auth = authority();
    auth.saveCheckpoint = async checkpoint => { checkpoints.push(checkpoint); events.push(checkpoint.status); };
    auth.dispatched = async permit => { events.push('dispatch'); expect(checkpoints.at(-1)?.status).toBe('effect_pending'); return permit.id; };
    auth.completed = async () => { events.push('response'); };
    const id = randomUUID(), first = await open(browser, id, '/fields', auth);
    const action = { kind: 'click' as const, ref: ref(first.page, 'Send') }, permit = await browser.prepareAction(owner, id, action);
    const result = await browser.act(owner, id, action, auth, permit!);
    expect(result.page.text).toContain('Accepted receipt');
    expect(events.slice(-5)).toEqual(['action_pending', 'effect_pending', 'dispatch', 'response', 'ready']);
    expect(JSON.stringify(checkpoints)).not.toContain('message=hello');
    const count = checkpoints.length; await browser.close();
    expect(checkpoints).toHaveLength(count);
    expect(checkpoints.at(-1)?.status).toBe('ready');
  });

  it('does not send an approved effect when its durable pending record cannot be saved', async () => {
    const browser = makeBrowser(undefined, async checkpoint => { if (checkpoint.status === 'effect_pending') throw new Error('durable store unavailable'); });
    const id = randomUUID(), first = await open(browser, id, '/fields'), action = { kind: 'click' as const, ref: ref(first.page, 'Send') };
    const permit = await browser.prepareAction(owner, id, action), before = received.filter(item => item === 'POST /done').length;
    let dispatches = 0; const auth = authority(); auth.dispatched = async permit => { dispatches++; return permit.id; };
    await expect(browser.act(owner, id, action, auth, permit!)).rejects.toBeDefined();
    expect(received.filter(item => item === 'POST /done')).toHaveLength(before);
    expect(dispatches).toBe(0);
    await browser.close();
  });

  it('restores a ready account profile after shutdown by readback only and rejects foreign or expired state', async () => {
    const profile = randomUUID(), id = randomUUID(), saved: AgentSessionCheckpoint[] = [];
    const browser = makeBrowser(profile, async checkpoint => { saved.push(checkpoint); });
    await browser.bindAccount(owner, id, 'work'); await open(browser, id, '/cookie-set'); await open(browser, id, '/cookie-read');
    await browser.bindAccount(owner, id, 'work');
    const checkpoint = saved.at(-1)!; await browser.close();
    expect(saved.at(-1)?.status).toBe('ready');
    const restarted = makeBrowser(profile);
    await expect(restarted.restoreSession('foreign-owner', id, checkpoint, authority())).rejects.toMatchObject({ code: 'AGENT_CHECKPOINT_INVALID' });
    const before = received.length;
    expect(await restarted.restoreSession(owner, id, { ...checkpoint, savedAt: new Date(Date.now() - 25 * 3600000).toISOString() }, authority())).toMatchObject({ status: 'review_required', reason: 'checkpoint_expired' });
    expect(received).toHaveLength(before);
    const restored = await restarted.restoreSession(owner, id, checkpoint, authority());
    expect(restored.status).toBe('readback');
    if (restored.status !== 'readback') throw new Error('Expected readback');
    expect(restored).toMatchObject({ sameUrl: true, requiresReplan: true });
    expect(restored.result.page.text).toContain('session=durable-account');
    expect((await restarted.snapshotSession(owner, id))?.accountId).toBe('work');
    await restarted.close();
  });

  it('allows a freshly fenced checkpoint after an earlier cancelled lease save failed', async () => {
    const browser = makeBrowser(), id = randomUUID(), rejectedAuthority = authority();
    rejectedAuthority.saveCheckpoint = async () => { throw new Error('expired old lease'); };
    await expect(open(browser, id, '/fields', rejectedAuthority)).rejects.toThrow('expired old lease');
    const saved: AgentSessionCheckpoint[] = [], fresh = authority();
    fresh.saveCheckpoint = async checkpoint => { saved.push(checkpoint); };
    expect((await open(browser, id, '/fields', fresh)).page.url).toBe(origin + '/fields');
    expect(saved.map(checkpoint => checkpoint.status)).toEqual(['action_pending', 'ready']);
    await browser.close();
  });

  it('keeps unknown effects under review across reads and restart without replaying them', async () => {
    const profile = randomUUID(), id = randomUUID(), saved: AgentSessionCheckpoint[] = [];
    const browser = makeBrowser(profile, async checkpoint => { saved.push(checkpoint); });
    const first = await open(browser, id, '/unknown-form'), action = { kind: 'click' as const, ref: ref(first.page, 'Send') }, permit = await browser.prepareAction(owner, id, action);
    const before = received.filter(item => item === 'POST /uncertain').length;
    await expect(browser.act(owner, id, action, authority(), permit!)).rejects.toMatchObject({ code: 'AGENT_EFFECT_UNKNOWN' });
    expect(received.filter(item => item === 'POST /uncertain')).toHaveLength(before + 1);
    expect(saved.at(-1)?.status).toBe('review_required');
    await browser.observe(owner, id);
    await expect(browser.act(owner, id, { kind: 'type', ref: ref(first.page, 'Note'), text: 'retry' }, authority())).rejects.toMatchObject({ code: 'AGENT_RECOVERY_REVIEW_REQUIRED' });
    const checkpoint = saved.at(-1)!; await browser.close();
    const restarted = makeBrowser(profile), requests = received.length;
    expect(await restarted.restoreSession(owner, id, checkpoint, authority())).toMatchObject({ status: 'review_required' });
    expect(received).toHaveLength(requests);
    expect(await restarted.hasPage(owner, id)).toBe(false);
    const acknowledged = await restarted.acknowledgeCheckpoint(owner, id, checkpoint, authority(), { readbackUrl: origin + '/unknown-form' });
    expect(acknowledged.effect).toEqual(checkpoint.effect);
    expect((await restarted.restoreSession(owner, id, acknowledged, authority())).status).toBe('readback');
    expect(received.filter(item => item === 'POST /uncertain')).toHaveLength(before + 1);
    await restarted.close();
  });

  it('never restores a GET effect by repeating its exact destination, even after owner review', async () => {
    const browser = makeBrowser(), id = randomUUID(); await open(browser, id, '/fields');
    const checkpoint = (await browser.snapshotSession(owner, id))!; await browser.close();
    const restarted = makeBrowser(), effect = { method: 'GET', urlHash: checkpoint.urlHash!, bodyHash: evidenceHash('') }, requests = received.length;
    const acknowledged = await restarted.acknowledgeCheckpoint(owner, id, { ...checkpoint, status: 'effect_pending', effect }, authority());
    expect(await restarted.restoreSession(owner, id, acknowledged, authority())).toMatchObject({ status: 'review_required', reason: 'readback_would_repeat_get_effect' });
    expect(received).toHaveLength(requests);
    await restarted.close();
  });

  it('carries durable uncertainty into ordinary work without opening a page at binding time', async () => {
    const browser = makeBrowser(), id = randomUUID(); await open(browser, id, '/fields');
    const checkpoint = (await browser.snapshotSession(owner, id))!; await browser.close();
    const restarted = makeBrowser(), requests = received.length;
    await restarted.bindRecoveryCheckpoint(owner, id, { ...checkpoint, status: 'effect_pending', effect: { method: 'POST', urlHash: evidenceHash(origin + '/done'), bodyHash: evidenceHash('message=hello') } });
    expect(await restarted.hasPage(owner, id)).toBe(false);
    expect(received).toHaveLength(requests);
    const first = await open(restarted, id, '/fields');
    const action = { kind: 'click' as const, ref: ref(first.page, 'Send') };
    await expect(restarted.act(owner, id, action, authority(), (await restarted.prepareAction(owner, id, action))!)).rejects.toMatchObject({ code: 'AGENT_RECOVERY_REVIEW_REQUIRED' });
    expect(received.filter(item => item === 'POST /done').length).toBe(received.slice(0, requests).filter(item => item === 'POST /done').length);
    await restarted.acknowledgeRecovery(owner, id, authority());
    expect((await restarted.snapshotSession(owner, id))?.status).toBe('ready');
    expect((await restarted.snapshotSession(owner, id))?.effect?.method).toBe('POST');
    await restarted.close();
  });

  it('preserves the GET-effect fence for ordinary navigation and rejects another account checkpoint', async () => {
    const browser = makeBrowser(), id = randomUUID(); await open(browser, id, '/fields');
    const checkpoint = (await browser.snapshotSession(owner, id))!; await browser.close();
    const restarted = makeBrowser(), requests = received.length;
    await expect(restarted.bindRecoveryCheckpoint(owner, id, { ...checkpoint, accountId: 'foreign-account' })).rejects.toMatchObject({ code: 'AGENT_CHECKPOINT_INVALID' });
    await restarted.bindRecoveryCheckpoint(owner, id, { ...checkpoint, effect: { method: 'GET', urlHash: checkpoint.urlHash!, bodyHash: evidenceHash('') } });
    await expect(open(restarted, id, '/fields')).rejects.toMatchObject({ code: 'AGENT_RECOVERY_GET_REPLAY_DENIED' });
    expect(received).toHaveLength(requests);
    await restarted.close();
  });

  it('does not overwrite an explicit close checkpoint when an interrupted action finishes', async () => {
    const saved: AgentSessionCheckpoint[] = [], browser = makeBrowser(undefined, async checkpoint => { saved.push(checkpoint); }), id = randomUUID();
    await open(browser, id, '/fields');
    const pending = browser.act(owner, id, { kind: 'wait', text: '600' }, authority());
    const rejected = expect(pending).rejects.toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 75));
    await browser.closeConversation(owner, id); await rejected;
    expect(saved.at(-1)?.status).toBe('closed');
    await browser.close();
  });
});

describe('checkpoint URL minimization', () => {
  it.each(['https://example.com/?token=private', 'https://example.com/?code=private', 'https://example.com/#session', 'https://user:pass@example.com/', 'https://example.com/token/private', 'file:///local'])('does not persist credential-bearing or non-web URL %s', url => {
    expect(safeResumeUrl(url)).toBeNull();
  });
  it('retains a safe exact URL and refuses known owner secrets and oversized addresses', () => {
    expect(safeResumeUrl('https://example.com/search?q=report')).toBe('https://example.com/search?q=report');
    expect(safeResumeUrl('https://example.com/search?q=private-owner-value', ['private-owner-value'])).toBeNull();
    expect(safeResumeUrl('https://example.com/search?q=private%2Downer%2Dvalue', ['private-owner-value'])).toBeNull();
    expect(safeResumeUrl('https://example.com/to%6Ben/private')).toBeNull();
    expect(safeResumeUrl('https://example.com/search?q=[محجوب]')).toBeNull();
    expect(safeResumeUrl('https://example.com/' + 'x'.repeat(2500))).toBeNull();
  });
});
