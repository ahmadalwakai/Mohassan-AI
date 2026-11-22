import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentPage } from '@mohassan/browser';

const owner = 'capture-fixture-owner';
const auth = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
let browser: AgentBrowser, server: Server, origin: string, root: string, temporaryRoot: string;
const requests: string[] = [];
const fixtureHtml = (path: string) => `<!doctype html><title>Capture fixture</title><main><h1>Stable receipt page</h1>${path === '/document' ? '' : '<button>Harmless button</button>'}<p id=state>Original value</p>${path === '/secret' ? '<label>Password<input type=password value="fixture-private-password"></label>' : ''}${path === '/frames' ? Array.from({ length: 6 }, (_, index) => `<iframe src="/child-${index}"></iframe>`).join('') : ''}<div style="height:1600px">Scrollable content</div></main>`;
const open = async (path = '/stable') => {
  const id = randomUUID();
  const result = await browser.act(owner, id, { kind: 'open', text: origin + path }, auth());
  const entry = await browser['conversation'](owner, id);
  return { id, page: result.page, entry };
};
function gateScreenshot(entry: Awaited<ReturnType<AgentBrowser['conversation']>>) {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = entry.page.screenshot.bind(entry.page);
  const spy = vi.spyOn(entry.page, 'screenshot').mockImplementation(async options => { entered(); await gate; return original(options); });
  return { ready, release, spy };
}

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-capture-fixture-'));
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = new URL(request.url!, 'http://localhost').pathname;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml(path));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing capture fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = new AgentBrowser({ profileDir: root, testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-capture-fixture-') || within.includes('..')) throw new Error('Unsafe capture fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('sampled screenshot evidence in real Chromium', () => {
  it('binds real JPEG bytes to the exact owner, conversation and requested observation', async () => {
    const { id, page } = await open();
    const beforeRequests = requests.length;
    const result = await browser.captureEvidence(owner, id, page, auth());
    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(result.receipt).toMatchObject({ version: 1, scope: 'stable_observation_samples', ownerId: owner, conversationId: id,
      requestedPageId: page.id, pageId: result.page.id, pageHash: result.page.hash, url: page.url,
      imageHash: createHash('sha256').update(result.image).digest('hex'), imageBytes: result.image.length, mimeType: 'image/jpeg' });
    expect(result.receipt.beforeFingerprint).toBe(result.receipt.afterFingerprint);
    expect(result.receipt.documentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.viewportFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.page.id).not.toBe(page.id);
    expect(result.page.hash).toBe(page.hash);
    const times = [result.receipt.startedAt, result.receipt.captureStartedAt, result.receipt.captureFinishedAt, result.receipt.finishedAt].map(Date.parse);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(requests.slice(beforeRequests)).toEqual([]);
    await browser.closeConversation(owner, id);
  });

  it('retains actual sensitive-field masks and refuses their DOM-overlay changes conservatively', async () => {
    const { id, page, entry } = await open('/secret');
    const spy = vi.spyOn(entry.page, 'screenshot');
    try {
      const result = await browser.captureEvidence(owner, id, page);
      expect(spy).toHaveBeenCalledOnce();
      const mask = spy.mock.calls[0][0]!.mask!;
      expect(mask.length).toBeGreaterThan(0);
      expect(await mask[0].count()).toBe(1);
      // Playwright installs/removes a masking DOM overlay. Do not whitelist a
      // spoofable element tag merely to manufacture an unchanged epoch.
      expect(result).toEqual({ status: 'unavailable', reason: 'changed' });
      expect(entry.shot).toBeNull();
      expect(JSON.stringify(result)).not.toContain('fixture-private-password');
    } finally { spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('returns no stale image or receipt when masking/capture fails', async () => {
    const { id, page, entry } = await open('/secret');
    expect(entry.shot?.length).toBeGreaterThan(0);
    const spy = vi.spyOn(entry.page, 'screenshot').mockRejectedValue(new Error('fixture mask failure'));
    try {
      expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'capture_failed' });
      expect(entry.shot).toBeNull();
      expect(entry.captureReservation).toBeUndefined();
      expect(entry.readers).toBe(0);
    } finally { spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('does not create a new page for absent or foreign owner/conversation IDs', async () => {
    const { id, page } = await open();
    expect(await browser.captureEvidence('other-owner', id, page)).toEqual({ status: 'unavailable', reason: 'no_page' });
    expect(await browser.captureEvidence(owner, 'absent-conversation', page)).toEqual({ status: 'unavailable', reason: 'no_page' });
    expect(await browser.hasPage('other-owner', id)).toBe(false);
    await browser.closeConversation(owner, id);
  });

  it('rejects fabricated or superseded observation IDs even when URL/content agree', async () => {
    const { id, page } = await open();
    expect(await browser.captureEvidence(owner, id, { ...page, id: randomUUID() })).toEqual({ status: 'unavailable', reason: 'stale_page' });
    const current = await browser.observe(owner, id);
    expect(current.page.hash).toBe(page.hash);
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'stale_page' });
    await browser.closeConversation(owner, id);
  });

  it('rejects source changes before capture instead of certifying the old observation', async () => {
    const { id, page, entry } = await open();
    await entry.page.evaluate(() => { document.getElementById('state')!.textContent = 'Changed value'; });
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'stale_page' });
    await browser.closeConversation(owner, id);
  });

  it('detects an observed DOM ABA change during capture even when final text agrees', async () => {
    const { id, page, entry } = await open(), gate = gateScreenshot(entry);
    try {
      const capture = browser.captureEvidence(owner, id, page);
      await gate.ready;
      await entry.page.evaluate(() => { const node = document.getElementById('state')!; node.textContent = 'Temporary'; node.textContent = 'Original value'; });
      gate.release();
      expect(await capture).toEqual({ status: 'unavailable', reason: 'changed' });
      expect(entry.shot).toBeNull();
    } finally { gate.release(); gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('detects viewport/scroll and same-page URL changes during capture', async () => {
    for (const change of ['scroll', 'url', 'viewport'] as const) {
      const { id, page, entry } = await open(), gate = gateScreenshot(entry);
      try {
        const capture = browser.captureEvidence(owner, id, page);
        await gate.ready;
        if (change === 'scroll') await entry.page.evaluate(() => scrollTo(0, 150));
        else if (change === 'url') await entry.page.evaluate(() => { location.hash = 'changed'; });
        else await entry.page.setViewportSize({ width: 1100, height: 700 });
        gate.release();
        expect(await capture).toEqual({ status: 'unavailable', reason: 'changed' });
      } finally { gate.release(); gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
    }
  });

  it('rejects a new document at the same URL even when the observed content hash agrees', async () => {
    const { id, page, entry } = await open('/document'), gate = gateScreenshot(entry);
    // Fixture-only fulfillment allows an actual document reload independent of
    // the production policy that blocks unsolicited page-driven navigation.
    await entry.page.route(page.url, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml('/document') }));
    try {
      const capture = browser.captureEvidence(owner, id, page);
      await gate.ready;
      await entry.page.goto(page.url, { waitUntil: 'load' });
      gate.release();
      expect(await capture).toEqual({ status: 'unavailable', reason: 'changed' });
      const after = await browser.observe(owner, id);
      expect(after.page.hash).toBe(page.hash);
    } finally { gate.release(); gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('excludes an existing reader and prevents eviction of a reserved capture page', async () => {
    const first = await open();
    const others = await Promise.all([open(), open(), open()]);
    const readingGate = gateScreenshot(first.entry);
    try {
      const reading = browser.observe(owner, first.id);
      await readingGate.ready;
      expect(await browser.captureEvidence(owner, first.id, first.page)).toEqual({ status: 'unavailable', reason: 'busy' });
      readingGate.release(); await reading;
    } finally { readingGate.release(); readingGate.spy.mockRestore(); }
    const current = await browser.observe(owner, first.id);
    const captureGate = gateScreenshot(first.entry);
    let newest: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const capture = browser.captureEvidence(owner, first.id, current.page);
      await captureGate.ready;
      first.entry.lastUsed = 0; // Make this the eviction candidate absent its reader reservation.
      newest = await open();
      expect(first.entry.page.isClosed()).toBe(false);
      expect(await browser.hasPage(owner, first.id)).toBe(true);
      captureGate.release();
      expect((await capture).status).toBe('captured');
    } finally {
      captureGate.release(); captureGate.spy.mockRestore();
      await Promise.all([first, ...others, ...(newest ? [newest] : [])].map(item => browser.closeConversation(owner, item.id)));
    }
  });

  it('excludes a reader admitted before a competing capture acquires the allocation lock', async () => {
    const { id, page, entry } = await open();
    const allocationOwner = await browser['owner'](owner, id);
    let release!: () => void;
    allocationOwner.allocation = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(entry.page, 'screenshot');
    const reading = browser.observe(owner, id);
    const readOutcome = reading.then(() => ({ code: 'unexpected_success' }), error => ({ code: error.code as string }));
    const capture = browser.captureEvidence(owner, id, page);
    try {
      // Let both real operations queue behind the allocation gate, without
      // mocking screenshot/DOM behavior or delaying the browser transport.
      for (let index = 0; index < 40; index++) await Promise.resolve();
      release();
      expect(await readOutcome).toEqual({ code: 'AGENT_CAPTURE_BUSY' });
      expect((await capture).status).toBe('captured');
      expect(spy).toHaveBeenCalledOnce();
      expect(entry.readers).toBe(0);
      expect(entry.captureReservation).toBeUndefined();
    } finally {
      release(); await Promise.allSettled([reading, capture]);
      spy.mockRestore(); await browser.closeConversation(owner, id);
    }
  });

  it('excludes new owner inputs, agent actions, legacy direct actions and concurrent captures', async () => {
    const { id, page, entry } = await open(), gate = gateScreenshot(entry);
    const priorRecovery = structuredClone(entry.recovery);
    try {
      const capture = browser.captureEvidence(owner, id, page);
      await gate.ready;
      for (const action of [() => browser.pointer(owner, id, 0.2, 0.2), () => browser.keyboard(owner, id, { text: 'should not type' }),
        () => browser.act(owner, id, { kind: 'scroll' }, auth()), () => browser.scroll(owner, id, 'down'),
        () => browser.fillSecret(owner, id, page.elements[0].ref, 'should not fill')]) {
        await expect(action()).rejects.toMatchObject({ code: 'AGENT_CAPTURE_BUSY' });
      }
      expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'busy' });
      expect(entry.recovery).toEqual(priorRecovery);
      gate.release();
      expect((await capture).status).toBe('captured');
    } finally { gate.release(); gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('refuses captures while an agent operation or direct mutation is already in flight', async () => {
    const { id, page, entry } = await open();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const authority = auth(); authority.assertActive = async () => { entered(); await gate; };
    const acting = browser.act(owner, id, { kind: 'wait', text: '200' }, authority);
    await ready;
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'busy' });
    release(); await acting;
    const scrolling = browser.scroll(owner, id, 'down');
    await expect.poll(() => entry.mutations).toBe(1);
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'busy' });
    await scrolling;
    expect(entry.mutations).toBe(0);
    await browser.closeConversation(owner, id);
  });

  it('refuses the active owner-input follow-up window', async () => {
    const { id, page } = await open();
    await browser.keyboard(owner, id, { key: 'Tab' });
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'busy' });
    await browser.closeConversation(owner, id);
  });

  it('honors cancellation after capture and releases the reservation without an artifact', async () => {
    const { id, page, entry } = await open(), gate = gateScreenshot(entry), controller = new AbortController();
    try {
      const capture = browser.captureEvidence(owner, id, page, { ...auth(), signal: controller.signal });
      // Attach the rejection assertion before releasing the child operation.
      const rejection = expect(capture).rejects.toThrow('fixture lease revoked');
      await gate.ready;
      controller.abort(new Error('fixture lease revoked'));
      gate.release(); await rejection;
      expect(entry.shot).toBeNull();
      expect(entry.captureReservation).toBeUndefined();
      expect(entry.readers).toBe(0);
    } finally { gate.release(); gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('checks revoked authority even when the masking/screenshot operation fails first', async () => {
    const { id, page, entry } = await open('/secret'), controller = new AbortController();
    const spy = vi.spyOn(entry.page, 'screenshot').mockImplementation(async () => {
      controller.abort(new Error('fixture revoked during mask failure'));
      throw new Error('fixture mask operation failed');
    });
    try {
      await expect(browser.captureEvidence(owner, id, page, { ...auth(), signal: controller.signal })).rejects.toThrow('fixture revoked during mask failure');
      expect(entry.shot).toBeNull();
      expect(entry.captureReservation).toBeUndefined();
      expect(entry.readers).toBe(0);
    } finally { spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('checks the post-fence even for absent and busy capture failures', async () => {
    let checks = 0;
    const noPageAuthority = auth();
    noPageAuthority.assertActive = async () => { if (++checks === 2) throw new Error('fixture no-page lease revoked'); };
    await expect(browser.captureEvidence(owner, 'missing-fixture', { id: 'missing', url: origin, hash: 'a'.repeat(24) }, noPageAuthority)).rejects.toThrow('fixture no-page lease revoked');
    const { id, page, entry } = await open(), gate = gateScreenshot(entry);
    const capture = browser.captureEvidence(owner, id, page);
    try {
      await gate.ready;
      checks = 0;
      const busyAuthority = auth();
      busyAuthority.assertActive = async () => { if (++checks === 3) throw new Error('fixture busy lease revoked'); };
      await expect(browser.captureEvidence(owner, id, page, busyAuthority)).rejects.toThrow('fixture busy lease revoked');
      expect(entry.captureReservation).toBeDefined(); // The competing capture keeps its own reservation.
      gate.release(); expect((await capture).status).toBe('captured');
    } finally { gate.release(); await capture; gate.spy.mockRestore(); await browser.closeConversation(owner, id); }
  });

  it('does not certify an incomplete frame set', async () => {
    const { id, page } = await open('/frames');
    expect(await browser.captureEvidence(owner, id, page)).toEqual({ status: 'unavailable', reason: 'unsupported_frames' });
    await browser.closeConversation(owner, id);
  });
});
