import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { type AgentPage } from '@mohassan/browser';
import { type ChatSecureRequest } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { browserHandoverResumed, premiumBrowserTarget, projectBrowserPremium, watchPremiumBrowserHandover } from '../apps/server/src/assistant/browser-premium.js';
import { capturePremiumBrowserFrame, readBrowserPremiumPage, rememberPremiumOwnerValue } from '../packages/browser/src/browser-live-premium.js';

const site = 'https://portal.example.test';
const makePage = (kind: 'login' | 'code' | 'content', origin = site): AgentPage => {
  const pagePath = { login: 'login', code: 'code', content: 'content' }[kind];
  const title = { login: 'Sign in', code: 'Verification', content: 'Account content' }[kind];
  const fields = {
    login: [{ ref: 'e1', field: 'password', label: 'Password', role: 'textbox', inViewport: true }],
    code: [{ ref: 'e2', field: 'otp', label: 'Verification code', role: 'textbox', inViewport: true }],
    content: [],
  } as const;
  return {
    id: randomUUID(), url: `${origin}/${pagePath}`, title, text: title, elements: [...fields[kind]],
    signals: { password: kind === 'login', otp: kind === 'code', captcha: false, card: false },
    hash: kind, observedAt: new Date().toISOString(), documentStatus: 200,
    scroll: { top: 0, height: 800, viewport: 800 },
  };
};
const loginRequest: ChatSecureRequest = { id: randomUUID(), kind: 'login', site, prompt: 'Sign in', note: null, fields: [] };

it('projects stable, bounded narration and omits task values and raw selectors', async () => {
  const target = { x: 0.2, y: 0.25, width: 0.3, height: 0.1 };
  const page = makePage('login');
  const peek = vi.fn(async (_owner: string, _id: string, choose?: (observed: AgentPage) => string | undefined) => {
    expect(choose?.(page)).toBe('e1');
    return { page, target, favicon: 'data:image/png;base64,AAAA' };
  });
  const result = await projectBrowserPremium({
    browser: { premiumPage: peek }, ownerId: 'owner', conversationId: 'conversation', pageUrl: page.url,
    status: 'waiting_input', secure: loginRequest, run: { id: 'run', status: 'waiting_input' },
    steps: [
      { id: 'ignored', message: '#secret-selector' },
      { id: '1', message: 'فتح portal.example.test' },
      { id: '2', message: 'الكتابة في «private-value»' },
      { id: '3', message: 'انتظار تحميل الصفحة' },
    ],
  });
  expect(result).toEqual({ site: { domain: 'portal.example.test', favicon: 'data:image/png;base64,AAAA' }, target, steps: [
    { id: '1', kind: 'opening' }, { id: '2', kind: 'typing' }, { id: '3', kind: 'loading' }, { id: 'run-handover', kind: 'handover' },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/private-value|secret-selector|e1/);
  expect(premiumBrowserTarget(makePage('login', 'https://unrelated.example.test'), loginRequest)).toBeUndefined();
  expect(premiumBrowserTarget(makePage('code'), { ...loginRequest, kind: 'code' })).toBe('e2');
  expect(premiumBrowserTarget(page, null, 'e7')).toBe('e7');
  const complete = await projectBrowserPremium({
    browser: { premiumPage: async () => null }, ownerId: 'owner', conversationId: 'conversation', pageUrl: page.url,
    status: 'idle', secure: null, run: { id: 'run', status: 'completed' },
    steps: [{ id: 'resume', message: browserHandoverResumed }, { id: 'read', message: 'قراءة الصفحة' }],
  });
  expect(complete?.steps.map(step => step.kind)).toEqual(['resumed', 'reading', 'done']);
});

it('clips a real-element box to the browser viewport and ignores absent or mutating pages', async () => {
  const observed = makePage('login');
  const page = { url: () => observed.url, isClosed: () => false, viewportSize: () => ({ width: 1280, height: 800 }) } as Page;
  const entry = { page, shot: null, redactions: new Map<string, number>(), readers: 0, mutations: 0 };
  const observe = vi.fn(async () => observed);
  const bound = vi.fn(async () => ({ x: -128, y: 100, width: 384, height: 100 }));
  expect(await readBrowserPremiumPage(entry, observe, bound, () => 'e1')).toMatchObject({ target: { x: 0, y: 0.125, width: 0.2, height: 0.125 } });
  expect(bound).toHaveBeenCalledWith(entry, 'e1');
  expect(entry.readers).toBe(0);
  expect(await readBrowserPremiumPage(undefined, observe, bound, () => 'e1')).toBeNull();
  expect(await readBrowserPremiumPage({ ...entry, mutations: 1 }, observe, bound, () => 'e1')).toMatchObject({ page: null });
  expect(observe).toHaveBeenCalledTimes(1);
});

it('masks editable fields after takeover and discards failed or stale captures', async () => {
  const fieldLocator = { kind: 'fixture editable locator' };
  const locator = vi.fn(() => fieldLocator);
  const screenshot = vi.fn(async () => Buffer.from('test frame'));
  const page = { frames: () => [{ isDetached: () => false, locator }], screenshot } as unknown as Page;
  const entry = { page, shot: null, redactions: new Map<string, number>(), ownerInputLimit: 1 };
  await capturePremiumBrowserFrame(entry, []);
  expect(locator.mock.calls).toHaveLength(1);
  expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: [fieldLocator], maskColor: '#364052' }));
  expect(entry.shot).toEqual(Buffer.from('test frame'));
  screenshot.mockRejectedValueOnce(new Error('Capture changed'));
  await capturePremiumBrowserFrame(entry, []);
  expect(entry.shot).toBeNull();
  rememberPremiumOwnerValue(entry.redactions, 'a');
  expect(entry.redactions.has('a')).toBe(true);
  rememberPremiumOwnerValue(entry.redactions, 'ab');
  expect([...entry.redactions.keys()]).toEqual(['ab']);
});

describe('server-owned handover completion', () => {
  it('keeps a second auth step paused, waits for stable original-site evidence, and claims the current request', async () => {
    const database = await createDatabase({});
    const db = database.db;
    const conversationId = randomUUID(), runId = randomUUID(), ownerId = 'premium-fixture-owner';
    try {
      await migrate(db);
      await commandChatMigration(db);
      await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: ownerId, title: 'Fixture', status: 'waiting_input' }).execute();
      await db.insertInto('chat_runs').values({ id: runId, owner_id: ownerId, conversation_id: conversationId, goal: 'Fixture', status: 'waiting_input',
        lease_token: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000) }).execute();
      await db.updateTable('chat_conversations').set({ active_run_id: runId, secure: JSON.stringify(loginRequest) }).where('id', '=', conversationId).execute();
      const pages = [makePage('code'), makePage('content', 'https://unrelated.example.test'), makePage('content'), makePage('content')];
      const premiumPage = vi.fn(async () => ({ page: pages.shift() ?? makePage('content') }));
      const resume = vi.fn(async () => {});
      const waiting = watchPremiumBrowserHandover({
        db, browser: { premiumPage }, current: { ownerId, page: makePage('login') }, conversationId, runId, secure: loginRequest,
        settled: async () => {}, canWait: () => true, resume,
      });
      await vi.waitFor(async () => {
        const current = await db.selectFrom('chat_conversations').select('secure').where('id', '=', conversationId).executeTakeFirstOrThrow();
        expect(current.secure).toMatchObject({ kind: 'code', site });
      });
      expect(resume).not.toHaveBeenCalled();
      await waiting;
      const current = await db.selectFrom('chat_conversations').select('secure').where('id', '=', conversationId).executeTakeFirstOrThrow();
      expect(current.secure.id).not.toBe(loginRequest.id);
      expect(resume).toHaveBeenCalledExactlyOnceWith(ownerId, current.secure.id);
      expect(premiumPage).toHaveBeenCalledTimes(4);
    } finally { await database.close(); }
  }, 15_000);
});
