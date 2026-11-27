import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserLiveBudget } from '@mohassan/contracts';
import type { Frame, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentPage } from './agent-browser.js';
import { detectBrowserHumanStep, requireBrowserHumanForAction } from './browser-human-step.js';
import { bindBrowserLivePage, createBrowserLiveView, trackBrowserLiveNavigation } from './browser-live-page.js';

const site = 'https://example.test';
const jpeg = Buffer.from('fixture JPEG');
// AgentBrowser's existing CSS viewport. https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/agent-browser.ts#L217 (retrieved 2026-11-27).
const viewport = { width: 1280, height: 800 };
const snapshot = (fields: Partial<AgentPage> = {}): AgentPage => ({
  id: randomUUID(), url: site, title: '', text: '', elements: [],
  signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 0, viewport: 0 }, hash: '', observedAt: new Date().toISOString(), ...fields,
});

function nativePage(url = site) {
  const screenshot = vi.fn<() => Promise<Buffer>>(async () => jpeg);
  const click = vi.fn(async () => {});
  const insertText = vi.fn(async () => {});
  const getByText = vi.fn();
  const locator = vi.fn();
  const evaluate = vi.fn(async () => '');
  const mainFrame = { isDetached: () => false, getByText, locator, evaluate } as unknown as Frame;
  const page = { isClosed: () => false, url: () => url, screenshot, mainFrame: () => mainFrame, frames: () => [mainFrame],
    mouse: { click }, keyboard: { insertText }, viewportSize: () => viewport } as unknown as Page;
  return { page, screenshot, click, insertText, mainFrame, getByText, locator, evaluate };
}

function fixture(observed = snapshot()) {
  const native = nativePage();
  const scope = { ownerId: randomUUID(), conversationId: randomUUID(), runId: randomUUID() };
  const initialLastUsed = Date.now();
  const entry: Parameters<typeof bindBrowserLivePage>[0] = {
    ...scope, page: native.page, captureEpoch: 0, mutations: 0, lastUsed: initialLastUsed,
    redactions: new Map(), recovery: { status: 'ready', reviewRequired: false },
  };
  const saved: string[] = [];
  const live = createBrowserLiveView({
    find: async () => entry,
    read: async () => observed,
    secrets: item => [...item.redactions.keys()],
    beginInput: () => { entry.ownerInputUntil = Infinity; },
    save: async item => { saved.push(item.recovery.status); },
  });
  bindBrowserLivePage(entry, scope.runId);
  return { ...native, scope, live, entry, saved, initialLastUsed, setObserved: (page: AgentPage) => { observed = page; } };
}

describe('browser live page', () => {
  it('limits JPEG size, rate and concurrent reads without refreshing browser idle time', async () => {
    const { live, scope, entry, initialLastUsed, screenshot } = fixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let finish!: (bytes: Buffer) => void;
      screenshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = live.frame(scope);
      await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
      now += browserLiveBudget.intervalMs;
      const competing = await live.frame(scope);
      expect(competing).toBeNull();
      finish(jpeg);
      const first = await pending;
      expect(first?.bytes).toEqual(jpeg);
      screenshot.mockResolvedValueOnce(Buffer.alloc(browserLiveBudget.maxFrameBytes + 1));
      expect(await live.frame(scope)).toBeNull();
      expect(await live.frame(scope)).toBeNull();
      expect(screenshot).toHaveBeenCalledTimes(2);
      now += browserLiveBudget.intervalMs;
      const limit = Buffer.alloc(browserLiveBudget.maxFrameBytes);
      screenshot.mockResolvedValueOnce(limit);
      const fresh = await live.frame(scope);
      expect(fresh?.bytes).toBe(limit);
      expect(fresh?.id).toBe(first?.id);
      expect(entry.lastUsed).toBe(initialLastUsed);
    } finally { clock.mockRestore(); }
  });

  it('checks owner, conversation, run and the active page before and after capture', async () => {
    const { live, scope, entry, screenshot, mainFrame } = fixture();
    const different = randomUUID();
    for (const other of [{ ownerId: different }, { conversationId: different }, { runId: different }]) {
      expect(await live.frame({ ...scope, ...other })).toBeNull();
    }
    expect(screenshot).not.toHaveBeenCalled();
    let finish!: (bytes: Buffer) => void;
    screenshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = live.frame(scope);
    await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
    const next = nativePage(site + '/new-tab');
    entry.page = next.page;
    entry.operation = { authority: { liveRunId: scope.runId } };
    trackBrowserLiveNavigation(entry, mainFrame);
    expect(await live.hasPage(scope)).toBe(false);
    trackBrowserLiveNavigation(entry, next.mainFrame);
    finish(jpeg);
    expect(await pending).toBeNull();
    expect(await live.hasPage(scope)).toBe(true);
    bindBrowserLivePage(entry, different);
    expect(await live.hasPage(scope)).toBe(false);
    expect(await live.frame({ ...scope, runId: different })).toMatchObject({ bytes: jpeg });
    expect(next.screenshot).toHaveBeenCalledOnce();
  });

  it('discards a response when hiding aborts an in-flight frame', async () => {
    const { live, scope, screenshot } = fixture();
    const controller = new AbortController();
    let finish!: (bytes: Buffer) => void;
    screenshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = live.frame(scope, controller.signal);
    await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
    controller.abort();
    finish(jpeg);
    expect(await pending).toBeNull();
  });

  it('retains manual recovery until the exact handover completes on a fresh, clear page', async () => {
    const login = snapshot({ elements: [{ ref: 'e1', label: 'Password', role: 'textbox', field: 'password', inViewport: true }] });
    const { live, scope, entry, saved, click, setObserved } = fixture(login);
    const handoverId = randomUUID();
    await expect(live.complete(scope, handoverId)).rejects.toMatchObject({ code: 'AGENT_HUMAN_STEP', step: { reason: 'login' } });
    expect(saved).toEqual([]);
    const frame = await live.frame(scope);
    expect(frame).not.toBeNull();
    const input = { handoverId, frameId: frame!.id, kind: 'pointer', x: 0.5, y: 0.5 } as const;
    await live.input(scope, input);
    expect(click).toHaveBeenCalledOnce();
    expect(saved).toEqual(['review_required']);
    await expect(live.input(scope, input)).rejects.toMatchObject({ code: 'AGENT_LIVE_FRAME_CHANGED' });
    setObserved(snapshot({ url: site + '/clear' }));
    await expect(live.complete(scope, randomUUID())).rejects.toMatchObject({ code: 'AGENT_RECOVERY_REVIEW_REQUIRED' });
    expect(saved).toEqual(['review_required']);
    expect(await live.complete(scope, handoverId)).toEqual({ url: site + '/clear' });
    expect(saved).toEqual(['review_required', 'ready']);
    expect(entry.ownerInputUntil).toBeUndefined();
    entry.recovery.reviewRequired = true;
    await expect(live.input(scope, input)).rejects.toMatchObject({ code: 'AGENT_RECOVERY_REVIEW_REQUIRED' });
    expect(click).toHaveBeenCalledOnce();
  });

  it('discards coordinates captured before same-run navigation', async () => {
    const { live, scope, entry, click } = fixture();
    const frame = await live.frame(scope);
    expect(frame).not.toBeNull();
    entry.captureEpoch++;
    await expect(live.input(scope, { handoverId: randomUUID(), frameId: frame!.id, kind: 'pointer', x: 0.5, y: 0.5 }))
      .rejects.toMatchObject({ code: 'AGENT_LIVE_FRAME_CHANGED' });
    expect(click).not.toHaveBeenCalled();
  });

  it('masks editable surfaces and visible echoes of manual typing in a subsequent frame', async () => {
    const { live, scope, insertText, getByText, locator, evaluate } = fixture();
    const text = randomUUID();
    const combined = randomUUID() + text;
    evaluate.mockResolvedValueOnce(combined);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const frame = await live.frame(scope);
      expect(frame).not.toBeNull();
      await live.input(scope, { handoverId: randomUUID(), frameId: frame!.id, kind: 'keyboard', text });
      expect(insertText).toHaveBeenCalledWith(text);
      now += browserLiveBudget.intervalMs;
      expect((await live.frame(scope))?.id).not.toBe(frame!.id);
      expect(locator).toHaveBeenCalledWith(expect.stringContaining('[contenteditable]'));
      expect(getByText).toHaveBeenCalledWith(text, { exact: false });
      expect(getByText).toHaveBeenCalledWith(combined, { exact: false });
    } finally { clock.mockRestore(); }
  });
});

describe('human-only browser controls', () => {
  it('detects identifier-only login, CAPTCHA and cookie consent with Arabic Continue instructions', () => {
    const identifier = snapshot({ title: 'Sign in', elements: [{ ref: 'e1', label: 'Email', role: 'textbox', field: 'identifier', inViewport: true }] });
    const captcha = snapshot({ text: 'Verify you are human' });
    const consent = snapshot({ text: 'Cookie preferences', elements: [{ ref: 'e1', label: 'Reject all', role: 'button', inViewport: true }] });
    for (const [page, reason] of [[identifier, 'login'], [captcha, 'captcha'], [consent, 'consent']] as const) {
      expect(detectBrowserHumanStep(page)).toMatchObject({ reason, site, prompt: expect.stringContaining('«متابعة»') });
    }
    expect(detectBrowserHumanStep(snapshot({ text: 'Privacy policy', elements: [{ ref: 'e1', label: 'Reject order', role: 'button', inViewport: true }] }))).toBeNull();
  });

  it('rejects navigation through an offscreen consent choice even when it is addressed as an open', () => {
    const href = site + '/accept';
    const page = snapshot({ text: 'Cookie preferences', elements: [{ ref: 'e1', label: 'Accept all', role: 'link', href, inViewport: false }] });
    expect(detectBrowserHumanStep(page)).toMatchObject({ reason: 'consent' });
    expect(() => requireBrowserHumanForAction(page, { kind: 'open', text: href })).toThrowError(expect.objectContaining({ code: 'AGENT_HUMAN_STEP' }));
  });

  it('keeps ordinary native refs usable and leaves CAPTCHA interaction to the owner', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'mohassan-live-page-test-'));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/challenge') {
        response.end('<title>CAPTCHA</title><main><h1>Verify you are human</h1><a href="/clear">My manual check</a></main>');
      } else if (request.url === '/clear') {
        response.end('<title>Clear document</title><main>Manual check complete.</main>');
      } else {
        response.end('<title>Form fixture</title><label>Task name <input></label><button onclick="document.querySelector(\'main\').textContent = \'Button clicked\'">Read task</button><main></main>');
      }
    });
    const { origin } = await new Promise<{ origin: string }>((resolve, reject) => {
      server.once('error', reject).listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Fixture address is unavailable'));
        resolve({ origin: `http://127.0.0.1:${address.port}` });
      });
    });
    const scope = { ownerId: randomUUID(), conversationId: randomUUID(), runId: randomUUID() };
    const browser = new AgentBrowser({ profileDir, channel: null, testOrigins: [origin], allowedOrigins: [origin], settleQuietMs: 0 });
    const authority: AgentAuthority = {
      liveRunId: scope.runId, signal: new AbortController().signal, assertActive: async () => {},
      dispatched: async permit => permit.id, completed: async () => {},
    };
    const act = (action: Parameters<AgentBrowser['act']>[2]) => browser.act(scope.ownerId, scope.conversationId, action, authority);
    const handoverId = randomUUID();
    try {
      const { page: opened } = await act({ kind: 'open', text: origin });
      const typedValue = randomUUID();
      const name = opened.elements.find(element => element.label === 'Task name')!;
      const read = opened.elements.find(element => element.label === 'Read task')!;
      await expect(act({ kind: 'type', ref: name.ref, text: typedValue })).resolves.toMatchObject({
        page: { elements: expect.arrayContaining([expect.objectContaining({ ref: name.ref, value: typedValue.slice(0, 60) })]) },
      });
      await expect(act({ kind: 'click', ref: read.ref })).resolves.toMatchObject({ page: { text: expect.stringContaining('Button clicked') } });
      const { page: checked } = await act({ kind: 'open', text: origin + '/challenge' });
      const challenge = checked.elements.find(element => element.label === 'My manual check')!;
      await expect(act({ kind: 'click', ref: challenge.ref })).rejects.toMatchObject({ code: 'AGENT_HUMAN_STEP', beforeDispatch: true, step: { reason: 'captcha' } });
      await expect(browser.liveView.complete(scope, handoverId)).rejects.toMatchObject({ code: 'AGENT_HUMAN_STEP' });
      const native = (await browser['conversation'](scope.ownerId, scope.conversationId)).page;
      const box = (await native.getByRole('link', { name: 'My manual check' }).boundingBox())!;
      const frame = await browser.liveView.frame(scope);
      expect(frame).not.toBeNull();
      await browser.liveView.input(scope, { handoverId, frameId: frame!.id, kind: 'pointer', x: (box.x + box.width / 2) / viewport.width, y: (box.y + box.height / 2) / viewport.height });
      await native.waitForURL(origin + '/clear');
      expect(await browser.liveView.complete(scope, handoverId)).toEqual({ url: origin + '/clear' });
    } finally {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);
});
