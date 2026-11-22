import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentBrowserActivity, type AgentPage } from '@mohassan/browser';

const owner = 'activity-owner';
const authority = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const ref = (page: AgentPage, label: string) => page.elements.find(element => element.label === label)!.ref;
let browser: AgentBrowser, server: Server, origin: string, root: string, temporaryRoot: string;
const open = (id: string, path = '/controls') => browser.act(owner, id, { kind: 'open', text: origin + path }, authority());

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-browser-activity-'));
  server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    let content = '<h1>Landing page</h1>';
    if (path === '/controls') content = `<button style="position:absolute;left:160px;top:120px;width:100px;height:40px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Target</button>
      <label style="position:absolute;left:320px;top:180px">Private fixture field<input style="width:160px;height:30px" name="private-fixture-name"></label>
      <select aria-label="Choice" style="position:absolute;left:600px;top:240px;width:100px;height:30px"><option>A</option><option>B</option></select>
      <a href="/landing" style="position:absolute;left:200px;top:320px">Navigate</a>
      <a href="/landing" target="_blank" style="position:absolute;left:400px;top:320px">New tab</a><div style="height:2200px"></div>`;
    if (path === '/offscreen') content = '<button style="position:absolute;left:180px;top:1800px;width:100px;height:40px" onclick="document.body.dataset.clicked=\'yes\'">Below fold</button><div style="height:2400px"></div>';
    if (path === '/hover-value') content = `<input aria-label="Hover draft" style="position:absolute;left:900px;top:100px;width:240px;height:40px" onmouseenter="this.value='page draft';document.body.dataset.hover='yes'">
      <select aria-label="Hover choice" style="position:absolute;left:900px;top:240px;width:150px;height:40px" onmouseenter="this.value='B';document.body.dataset.hover='yes'"><option>A</option><option>B</option><option>C</option></select>`;
    if (path === '/focus-value') content = '<input aria-label="Focus draft" style="position:absolute;left:900px;top:100px;width:240px;height:40px" onfocus="this.value=\'page draft\';document.body.dataset.focus=\'yes\'">';
    if (path === '/frame') content = '<iframe src="/child" style="position:absolute;left:200px;top:100px;width:400px;height:300px;border:0"></iframe>';
    if (path === '/child') content = '<button style="position:absolute;left:80px;top:50px;width:120px;height:40px">Frame target</button><input aria-label="Frame field" style="position:absolute;left:60px;top:150px;width:160px;height:30px">';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Activity fixture</title><body>${content}</body>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = new AgentBrowser({ profileDir: root, testOrigins: [origin], channel: null });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  if (root) {
    const target = await realpath(root), within = relative(temporaryRoot, target);
    if (isAbsolute(within) || !within.startsWith('mohassan-browser-activity-') || within.includes('..')) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('ephemeral host browser pointer activity', () => {
  it('does not launch or allocate a page when an absent owner/conversation is polled', async () => {
    const launch = vi.spyOn(browser as any, 'launch');
    expect(await browser.activity('absent-owner', 'absent-conversation')).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it('keeps a short type and subsequent navigation clear observable between polls', async () => {
    const id = randomUUID(), opened = await open(id);
    await browser.act(owner, id, { kind: 'type', ref: ref(opened.page, 'Private fixture field'), text: 'ephemeral-input' }, authority());
    const fresh = await browser.observe(owner, id);
    await browser.act(owner, id, { kind: 'click', ref: ref(fresh.page, 'Navigate') }, authority());
    const sampled = (await browser.activity(owner, id))!;
    expect(sampled.cursor).toBeNull();
    expect(sampled.events?.filter(event => event.cursor?.action === 'type').map(event => event.cursor?.phase)).toEqual(['moving', 'acting', 'done']);
    expect(sampled.events?.at(-1)).toMatchObject({ sequence: sampled.sequence, cursor: null });
    const sequence = sampled.events?.map(event => event.sequence) ?? [];
    expect(sequence.every((value, index) => index === 0 || value > sequence[index - 1])).toBe(true);
    expect(JSON.stringify(sampled)).not.toMatch(/ephemeral-input|Private fixture field|private-fixture-name/);
    await browser.closeConversation(owner, id);
  });

  it('bounds recent metadata to 32 immutable events and expires history after eight seconds', async () => {
    const id = randomUUID(); await open(id);
    const entry = await browser['conversation'](owner, id);
    for (let index = 0; index < 40; index++) browser['publishActivity'](entry, {
      x: index / 40, y: 0.5, action: 'move', phase: 'done', updatedAt: new Date().toISOString(),
    });
    const sampled = (await browser.activity(owner, id))!;
    expect(sampled.events).toHaveLength(32);
    expect(sampled.events![0].sequence).toBe(sampled.sequence - 31);
    expect(sampled.events!.at(-1)!.sequence).toBe(sampled.sequence);
    const expected = structuredClone(sampled);
    sampled.events![0].cursor!.x = 0;
    sampled.events!.pop(); sampled.cursor!.x = 0;
    expect(await browser.activity(owner, id)).toEqual(expected);
    expect(Object.keys(expected.events![0]).sort()).toEqual(['cursor', 'sequence', 'updatedAt']);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expected.events!.at(-1)!.updatedAt) + 8001);
    try {
      const expired = (await browser.activity(owner, id))!;
      expect(expired.events).toEqual([]);
      expect(expired.sequence).toBe(expected.sequence); expect(expired.cursor).toEqual(expected.cursor);
    } finally { now.mockRestore(); }
    await browser.closeConversation(owner, id);
  });

  it('gives each new page entry its own session generation and starts with no events', async () => {
    const id = randomUUID();
    const empty = await browser['conversation'](owner, id);
    expect(empty.activity).toMatchObject({ sequence: 0, cursor: null, events: [] });
    expect(empty.activity.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await browser.activity(owner, id)).toBeNull();
    await open(id);
    const first = (await browser.activity(owner, id))!;
    await open(id, '/landing');
    expect((await browser.activity(owner, id))!.sessionId).toBe(first.sessionId);
    await browser.closeConversation(owner, id);
    expect(await browser.activity(owner, id)).toBeNull();
    await open(id);
    const replacement = (await browser.activity(owner, id))!;
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(replacement.sequence).toBe(3);
    expect(replacement.events?.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(await browser.activity('another-owner', id)).toBeNull();
    await browser.closeConversation(owner, id);
    await browser.bindAccount(owner, id, 'another-activity-account');
    expect(await browser.activity(owner, id)).toBeNull();
    await open(id);
    expect((await browser.activity(owner, id))!.sessionId).not.toBe(replacement.sessionId);
    await browser.closeConversation(owner, id);
  });

  it('moves the real browser pointer once on opening a read-only page', async () => {
    const id = randomUUID();
    await open(id, '/landing');
    expect(await browser.activity(owner, id)).toMatchObject({ cursor: { x: 0.5, y: 0.5, action: 'move', phase: 'done' } });
    const page = (await browser['conversation'](owner, id)).page;
    await page.addInitScript(() => addEventListener('mousemove', event => {
      (window as unknown as { fixtureMouse: { x: number; y: number } }).fixtureMouse = { x: event.clientX, y: event.clientY };
    }));
    await page.mouse.move(80, 80);
    const nativeMove = vi.spyOn(page.mouse, 'move');
    await open(id, '/landing?fresh=1');
    expect(nativeMove).toHaveBeenCalledOnce();
    expect(nativeMove).toHaveBeenCalledWith(640, 400, { steps: 4 });
    nativeMove.mockRestore();
    expect(await page.evaluate(() => (window as unknown as { fixtureMouse: { x: number; y: number } }).fixtureMouse)).toEqual({ x: 640, y: 400 });
    const done = (await browser.activity(owner, id))!;
    await browser.observe(owner, id);
    expect(await browser.activity(owner, id)).toEqual(done);
    await browser.closeConversation(owner, id);
  });

  it('uses actual element geometry, publishes movement, and returns isolated metadata copies', async () => {
    const id = randomUUID(), opened = await open(id);
    const page = (await browser['conversation'](owner, id)).page;
    const target = page.getByRole('button', { name: 'Target', exact: true });
    const box = (await target.boundingBox())!;
    let moving: AgentBrowserActivity | null = null;
    const nativeMove = page.mouse.move.bind(page.mouse);
    const movement = vi.spyOn(page.mouse, 'move').mockImplementationOnce(async (x, y, options) => {
      moving = await browser.activity(owner, id);
      await nativeMove(x, y, options);
    });
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Target') }, authority());
    movement.mockRestore();
    const done = (await browser.activity(owner, id))!;
    expect(moving).toMatchObject({ cursor: { action: 'click', phase: 'moving' } });
    expect(done.cursor).toMatchObject({ action: 'click', phase: 'done', x: (box.x + box.width / 2) / 1280, y: (box.y + box.height / 2) / 800 });
    expect(done.sequence).toBeGreaterThanOrEqual(moving!.sequence + 2);
    expect(Object.keys(done).sort()).toEqual(['cursor', 'events', 'sequence', 'sessionId']);
    expect(Object.keys(done.cursor!).sort()).toEqual(['action', 'phase', 'updatedAt', 'x', 'y']);
    expect(Number.isFinite(Date.parse(done.cursor!.updatedAt))).toBe(true);
    expect(await page.getAttribute('body', 'data-clicks')).toBe('1');
    done.cursor!.x = 0;
    expect((await browser.activity(owner, id))!.cursor!.x).not.toBe(0);
    await target.evaluate(node => (node as HTMLButtonElement).blur());
    await browser.act(owner, id, { kind: 'press', text: 'Escape' }, authority());
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'press', phase: 'done', x: (box.x + box.width / 2) / 1280, y: (box.y + box.height / 2) / 800 });
    expect(await browser.activity('another-owner', id)).toBeNull();
    expect(await browser.activity(owner, 'another-conversation')).toBeNull();
    const other = randomUUID(); await open(other);
    expect((await browser.activity(owner, other))!.cursor).toMatchObject({ x: 0.5, y: 0.5, action: 'move', phase: 'done' });
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'press' });
    await browser.closeConversation(owner, other);
    await browser.closeConversation(owner, id);
  });

  it('measures after scrolling an offscreen element into view', async () => {
    const id = randomUUID(), opened = await open(id, '/offscreen');
    expect(opened.page.elements.find(element => element.label === 'Below fold')!.inViewport).toBe(false);
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Below fold') }, authority());
    const page = (await browser['conversation'](owner, id)).page;
    const box = (await page.getByRole('button').boundingBox())!;
    const cursor = (await browser.activity(owner, id))!.cursor!;
    expect(cursor.x).toBeCloseTo((box.x + box.width / 2) / 1280, 5);
    expect(cursor.y).toBeCloseTo((box.y + box.height / 2) / 800, 5);
    expect(cursor.y).toBeGreaterThanOrEqual(0); expect(cursor.y).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.getAttribute('body', 'data-clicked')).toBe('yes');
    await browser.closeConversation(owner, id);
  });

  it('keeps the previous cursor visible while preparing geometry for the next action', async () => {
    const id = randomUUID(), opened = await open(id);
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Target') }, authority());
    const previous = (await browser.activity(owner, id))!;
    const page = (await browser['conversation'](owner, id)).page;
    const input = (await page.getByRole('textbox').elementHandle())!;
    const prototype = Object.getPrototypeOf(input);
    const nativeScroll = prototype.scrollIntoViewIfNeeded;
    let preparing: AgentBrowserActivity | null = null;
    const measurement = vi.spyOn(prototype, 'scrollIntoViewIfNeeded').mockImplementationOnce(async function(this: typeof input, options) {
      preparing = await browser.activity(owner, id);
      await nativeScroll.call(this, options);
    });
    try { await browser.act(owner, id, { kind: 'type', ref: ref(opened.page, 'Private fixture field'), text: 'fixture' }, authority()); }
    finally { measurement.mockRestore(); await input.dispose(); }
    expect(preparing).toEqual(previous);
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'type', phase: 'done' });
    await browser.closeConversation(owner, id);
  });

  it('rejects an identity changed during offscreen pointer preparation before dispatching a click', async () => {
    const id = randomUUID(), opened = await open(id, '/offscreen');
    const page = (await browser['conversation'](owner, id)).page;
    const start = browser['startActivity'].bind(browser);
    const preparation = vi.spyOn(browser as any, 'startActivity').mockImplementationOnce(async (...args: unknown[]) => {
      const token = await (start as (...input: unknown[]) => Promise<symbol | null>)(...args);
      await page.getByRole('button').evaluate(node => { node.id = 'changed-after-geometry'; });
      return token;
    });
    try {
      await expect(browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Below fold') }, authority()))
        .rejects.toMatchObject({ code: 'AGENT_REF_STALE' });
    } finally { preparation.mockRestore(); }
    expect(await page.getAttribute('body', 'data-clicked')).toBeNull();
    expect(await page.getByRole('button').getAttribute('id')).toBe('changed-after-geometry');
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    const fresh = await browser.observe(owner, id);
    await browser.act(owner, id, { kind: 'click', ref: ref(fresh.page, 'Below fold') }, authority());
    expect(await page.getAttribute('body', 'data-clicked')).toBe('yes');
    await browser.closeConversation(owner, id);
  });

  it.each([
    { kind: 'type' as const, label: 'Hover draft', text: 'agent replacement', current: 'page draft' },
    { kind: 'select' as const, label: 'Hover choice', text: 'C', current: 'B' },
  ])('preserves a $kind field value changed during pointer preparation', async ({ kind, label, text, current }) => {
    const id = randomUUID(), opened = await open(id, '/hover-value');
    const page = (await browser['conversation'](owner, id)).page;
    const field = page.getByLabel(label, { exact: true });
    expect(await field.inputValue()).toBe(kind === 'type' ? '' : 'A');
    await expect(browser.act(owner, id, { kind, ref: ref(opened.page, label), text }, authority()))
      .rejects.toMatchObject({ code: 'AGENT_FIELD_VALUE_PROTECTED' });
    expect(await page.getAttribute('body', 'data-hover')).toBe('yes');
    expect(await field.inputValue()).toBe(current);
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    await browser.closeConversation(owner, id);
  });

  it('preserves a field value populated by focus during the typing fallback', async () => {
    const id = randomUUID(), opened = await open(id, '/focus-value');
    const page = (await browser['conversation'](owner, id)).page;
    const field = page.getByLabel('Focus draft', { exact: true });
    const target = (await field.elementHandle())!;
    const fill = vi.spyOn(Object.getPrototypeOf(target), 'fill').mockRejectedValueOnce(new Error('fixture native fill failure'));
    try {
      expect(await field.inputValue()).toBe('');
      await expect(browser.act(owner, id, { kind: 'type', ref: ref(opened.page, 'Focus draft'), text: 'agent replacement' }, authority()))
        .rejects.toMatchObject({ code: 'AGENT_FIELD_VALUE_PROTECTED' });
    } finally { fill.mockRestore(); await target.dispose(); }
    expect(await page.getAttribute('body', 'data-focus')).toBe('yes');
    expect(await field.inputValue()).toBe('page draft');
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    await browser.closeConversation(owner, id);
  });

  it('uses main-frame geometry for iframe targets and the actual focused field for keys', async () => {
    const id = randomUUID(), opened = await open(id, '/frame');
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Frame target') }, authority());
    const page = (await browser['conversation'](owner, id)).page;
    const frame = page.frames().find(item => item.url().endsWith('/child'))!;
    const buttonBox = (await frame.getByRole('button').boundingBox())!;
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ x: (buttonBox.x + buttonBox.width / 2) / 1280, y: (buttonBox.y + buttonBox.height / 2) / 800 });
    await frame.getByRole('textbox').focus();
    await browser.act(owner, id, { kind: 'press', text: 'x' }, authority());
    const inputBox = (await frame.getByRole('textbox').boundingBox())!;
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'press', phase: 'done', x: (inputBox.x + inputBox.width / 2) / 1280, y: (inputBox.y + inputBox.height / 2) / 800 });
    expect(await frame.getByRole('textbox').inputValue()).toBe('x');
    await frame.goto(origin + '/landing');
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    await browser.closeConversation(owner, id);
  });

  it('tracks type, select and scrolling without exposing values or field identities', async () => {
    const id = randomUUID(), opened = await open(id);
    const field = ref(opened.page, 'Private fixture field');
    await browser.act(owner, id, { kind: 'type', ref: field, text: 'private-test-input' }, authority());
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'type', phase: 'done' });
    const serialized = JSON.stringify(await browser.activity(owner, id));
    expect(serialized).not.toMatch(/private-test-input|private-fixture-name|Private fixture field/);
    const current = await browser.observe(owner, id);
    await browser.act(owner, id, { kind: 'select', ref: ref(current.page, 'Choice'), text: 'B' }, authority());
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ action: 'select', phase: 'done' });
    await browser.act(owner, id, { kind: 'scroll', text: 'down' }, authority());
    expect((await browser.activity(owner, id))!.cursor).toMatchObject({ x: 0.5, y: 0.5, action: 'scroll', phase: 'done' });
    await browser.closeConversation(owner, id);
  });

  it('keeps a successful click single when mouse telemetry fails', async () => {
    const id = randomUUID(), opened = await open(id);
    const page = (await browser['conversation'](owner, id)).page;
    const movement = vi.spyOn(page.mouse, 'move').mockRejectedValueOnce(new Error('fixture telemetry failure'));
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Target') }, authority());
    movement.mockRestore();
    expect(await page.getAttribute('body', 'data-clicks')).toBe('1');
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    const scrolling = vi.spyOn(page.mouse, 'move').mockRejectedValueOnce(new Error('fixture scroll telemetry failure'));
    try { await browser.act(owner, id, { kind: 'scroll', text: 'down' }, authority()); }
    finally { scrolling.mockRestore(); }
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    await browser.closeConversation(owner, id);
  });

  it('clears on navigation, popup adoption and closure without reviving a stale done cursor', async () => {
    const id = randomUUID();
    let opened = await open(id);
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Target') }, authority());
    const before = (await browser.activity(owner, id))!.sequence;
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'Navigate') }, authority());
    expect(await browser.activity(owner, id)).toMatchObject({ cursor: null });
    expect((await browser.activity(owner, id))!.sequence).toBeGreaterThan(before);
    opened = await open(id);
    await browser.act(owner, id, { kind: 'click', ref: ref(opened.page, 'New tab') }, authority());
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    const page = (await browser['conversation'](owner, id)).page;
    await page.close();
    expect((await browser.activity(owner, id))!.cursor).toBeNull();
    await browser.closeConversation(owner, id);
    expect(await browser.activity(owner, id)).toBeNull();
    const closedId = randomUUID(), closedPage = await open(closedId);
    await browser.act(owner, closedId, { kind: 'click', ref: ref(closedPage.page, 'Target') }, authority());
    await (await browser['conversation'](owner, closedId)).page.close();
    expect(await browser.activity(owner, closedId)).toBeNull();
    await browser.closeConversation(owner, closedId);
  });
});
