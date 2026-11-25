import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { ownerButton, startBrowserHandsFixture, type FixtureWall } from './fixtures/browser-hands-site.js';

const owner = 'browser-hands-chat';
let profile: string;
let server: Awaited<ReturnType<typeof startBrowserHandsFixture>>;
let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;
let browser: AgentBrowser;

beforeAll(async () => {
  server = await startBrowserHandsFixture();
  profile = await mkdtemp(join(tmpdir(), 'mohassan-browser-hands-chat-'));
  browser = new AgentBrowser({ profileDir: profile, testOrigins: [server.origin], channel: null, browserHands: true });
  database = await createDatabase();
  await migrate(database.db);
  control = await createCommandChatControl(database.db, {
    browser, browserHands: 'on', models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
  });
});

afterAll(async () => {
  try {
    if (control) await control.shutdown();
    else await browser?.close();
  } finally {
    await database?.close();
    await server?.close();
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('browser handovers through the existing owner take-over path', () => {
  const walls = [
    ['login', 'needs_login'], ['code', 'needs_code'], ['bot', 'hands_on'], ['payment', 'hands_on'],
  ] as const satisfies Array<[FixtureWall, 'needs_login' | 'needs_code' | 'hands_on']>;

  it.each(walls)('pauses at %s with %s and resumes the same run automatically', async (wall, code) => {
    const url = new URL(`/wall/ar/${wall}`, server.origin).href;
    // Assemble a controller command without storing prompts in the acceptance matrix.
    const { id } = await control.create(owner, { goal: ['افتح', url, 'ثم', 'اقرأ الصفحة'].join(' ') });
    try {
      await expect.poll(async () => (await control.detail(owner, id)).status, { timeout: 8000 }).toBe('waiting_input');
      const paused = await control.detail(owner, id);
      expect(paused.visibility).toMatchObject({ level: 3, code });
      expect(paused.secure).toMatchObject({ kind: 'hands_on', fields: [] });
      expect(paused.secure?.prompt).toContain('127.0.0.1');
      expect(paused.secure?.prompt).toMatch(/\p{Script=Arabic}/u);
      const runId = paused.run?.id;
      if (wall === 'login' || wall === 'code') {
        const requestId = paused.secure!.id;
        await expect(control.secureSubmit(owner, id, { requestId, action: 'submit', values: { code: '000000' } }))
          .rejects.toMatchObject({ code: 'CHAT_BROWSER_MANUAL_INPUT' });
        expect((await control.secureSubmit(owner, id, { requestId, action: 'done' })).status).toBe('waiting_input');
      }
      await control.pointer(owner, id, ownerButton);
      await expect.poll(async () => (await control.detail(owner, id)).status, { timeout: 10000 }).toBe('idle');
      await control.settled(id);
      const done = await control.detail(owner, id);
      expect(done.error).toBeNull();
      expect(done.secure).toBeNull();
      expect(done.run?.id).toBe(runId);
      expect(done.visibility?.code).not.toBe(code);
      expect(done.messages.at(-1)?.text).toContain('fixture-main-27');
      expect((await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute()).map(row => row.status))
        .toEqual(['completed']);
    } finally {
      await control.cancel(owner, id);
      await browser.closeConversation(owner, id);
    }
  });
});

it('uses the existing exact approval for an irreversible browser submission', async () => {
  const url = new URL('/approval/ar/record', server.origin).href;
  const before = server.approvedActions();
  const { id } = await control.create(owner, { goal: ['افتح', url, 'ثم', 'اضغط زر «حذف السجل»', 'ثم', 'اقرأ الصفحة'].join(' ') });
  try {
    await expect.poll(async () => (await control.detail(owner, id)).status, { timeout: 8000 }).toBe('waiting_approval');
    const paused = await control.detail(owner, id);
    expect(paused.visibility).toMatchObject({ level: 3, code: 'needs_approval' });
    expect(server.approvedActions()).toBe(before);
    const approval = paused.approval;
    if (!approval) throw new Error('Fixture approval is missing');
    await control.approve(owner, id, { approved: true, approvalId: approval.id });
    await control.settled(id);
    const done = await control.detail(owner, id);
    expect(done.error).toBeNull();
    expect(done.run?.id).toBe(paused.run?.id);
    expect(done.run?.permissions).toContainEqual(expect.objectContaining({ decision: 'consumed' }));
    expect(done.messages.at(-1)?.text).toContain('fixture-record-removed');
    expect(server.approvedActions()).toBe(before + 1);
  } finally {
    await control.cancel(owner, id);
    await browser.closeConversation(owner, id);
  }
});

it('records only a masked value and read-back evidence for an actual input write', async () => {
  const url = new URL('/control/en/input', server.origin).href;
  const value = '371761';
  const { id } = await control.create(owner, { goal: ['Open', url, 'then', `fill "Fixture entry" with "${value}"`].join(' ') });
  try {
    await control.settled(id);
    const done = await control.detail(owner, id);
    expect(done.error).toBeNull();
    expect(done.run?.phase).toBe('completed');
    const logs = done.steps.map(step => step.text).join('\n');
    expect(logs).toContain('••••');
    expect(logs).not.toContain(value);
    expect(done.run?.evidence).toContainEqual(expect.objectContaining({ kind: 'readback', independent: true }));
    expect(JSON.stringify(done.run?.evidence)).not.toContain(value);
    const page = (await browser['conversation'](owner, id)).page;
    expect(await page.locator('#field').inputValue()).toBe(value);
  } finally {
    await control.cancel(owner, id);
    await browser.closeConversation(owner, id);
  }
});

it.each([undefined, 'shadow'] as const)('keeps the legacy browser path in mode %s', async mode => {
  const legacyProfile = await mkdtemp(join(tmpdir(), 'mohassan-browser-hands-legacy-'));
  const legacyBrowser = new AgentBrowser({ profileDir: legacyProfile, testOrigins: [server.origin], channel: null });
  const legacy = await createCommandChatControl(database.db, {
    browser: legacyBrowser, browserHands: mode, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
  });
  try {
    const url = new URL('/read/en/data', server.origin).href;
    const { id } = await legacy.create(owner, { goal: ['Open', url].join(' ') });
    await legacy.settled(id);
    const done = await legacy.detail(owner, id);
    expect(done.error).toBeNull();
    expect(done.browser?.url).toBe(url);
    expect(done.run?.plan?.steps.some(step => step.id.startsWith('browser-task-'))).not.toBe(true);
    const events = await database.db.selectFrom('chat_events').select('data').where('conversation_id', '=', id)
      .where('kind', '=', 'browser_task_shadow').execute();
    if (mode === 'shadow') {
      expect(events).toEqual([{ data: { risk: 'read-only', target: 'site', steps: ['open'], missing: [] } }]);
    } else {
      expect(events).toEqual([]);
    }
  } finally {
    await legacy.shutdown();
    await rm(legacyProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
