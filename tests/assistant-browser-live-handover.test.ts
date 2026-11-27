import { randomUUID } from 'node:crypto';
import { BrowserHumanStepError, detectBrowserHumanStep, type AgentAction, type AgentAuthority, type AgentBrowser, type AgentPage } from '@mohassan/browser';
import { readBrowserLiveHandover } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const ownerId = 'fixture-browser-live-owner';
const url = 'https://browser-handover.test/catalogue';
const nextUrl = 'https://browser-handover.test/details';
type Wall = 'sign-in' | 'consent' | 'CAPTCHA';
const catalogueText = 'The catalogue lists the available books and shows where to find them on the library shelves.';

function observed(wall: Wall | null, address = url): AgentPage {
  return {
    id: randomUUID(), url: address, title: 'Fixture catalogue', observedAt: new Date().toISOString(), documentStatus: 200,
    text: wall === 'CAPTCHA' ? 'Verify you are human' : wall === 'consent' ? 'Manage cookie consent' : catalogueText,
    elements: wall === 'sign-in' ? [{ ref: 'e1', role: 'textbox', label: 'Password', field: 'password', inViewport: true }]
      : wall === 'consent' ? [{ ref: 'e1', role: 'button', label: 'Accept all', inViewport: true }]
        : wall === null && address === url ? [{ ref: 'e1', role: 'link', label: 'Details', href: nextUrl, inViewport: true }] : [],
    hash: 'a'.repeat(24), scroll: { top: 0, height: 200, viewport: 800 },
    signals: { captcha: wall === 'CAPTCHA', password: wall === 'sign-in', otp: false, card: false },
  };
}

describe('owner browser handover in the production chat worker', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let fixtureWall: (address: string) => Wall | null;
  let allowed: boolean;
  const actions: AgentAction[] = [];
  const pages = new Map<string, { runId: string; wall: Wall | null; url: string }>();
  const activePage = (id: string) => { const page = pages.get(id)!; return observed(page.wall, page.url); };

  beforeAll(async () => {
    database = await createDatabase({});
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async bindRecoveryCheckpoint() {}, async close() {},
      hasPage: async (_ownerId: string, id: string) => pages.has(id),
      observe: async (_ownerId: string, id: string) => ({ page: activePage(id), changed: false }),
      normalizeUrl: (value: string) => new URL(value).href,
      async act(_ownerId: string, id: string, action: AgentAction, authority: AgentAuthority) {
        actions.push(action);
        await authority.assertActive();
        const address = action.kind === 'open' ? action.text! : pages.get(id)!.url;
        pages.set(id, { runId: authority.liveRunId!, wall: fixtureWall(address), url: address });
        return { page: activePage(id), changed: true };
      },
      liveView: {
        hasPage: async (scope: { conversationId: string; runId: string }) => pages.get(scope.conversationId)?.runId === scope.runId,
        async complete(scope: { conversationId: string; runId: string }) {
          const page = activePage(scope.conversationId);
          const step = detectBrowserHumanStep(page);
          if (step) throw new BrowserHumanStepError(step, page);
          return { url: page.url };
        },
      },
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, browserHands: 'on', recordExperiences: false,
      models: { fast: [], deep: [], vision: '' }, fullAccess: async () => allowed });
  });

  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  it.each([['sign-in', 'سجّل الدخول'], ['consent', 'راجع طلب الموافقة'], ['CAPTCHA', 'التحقق البشري']] as const)(
    'pauses on %s and resumes the exact same run once the owner continues', async (wall, instructions) => {
      fixtureWall = () => wall;
      allowed = true;
      actions.length = 0;
      const goal = wall === 'sign-in' ? `افتح ${url}` : `افتح ${url} ثم اقرأ الصفحة`;
      const { id } = await control.create(ownerId, { goal });
      await control.settled(id);
      const paused = await control.detail(ownerId, id);
      expect(paused.status, paused.error ?? '').toBe('waiting_input');
      const handover = readBrowserLiveHandover(paused.secure)!;
      expect(handover.prompt).toContain(instructions);
      expect(paused.secure?.fields).toEqual([]);
      const runId = paused.run!.id;

      await expect(control.secureSubmit(ownerId, id, { action: 'done', requestId: handover.id })).rejects.toMatchObject({ code: 'CHAT_BROWSER_HANDOVER_LIVE' });
      await expect(control.browserLive.continue(ownerId, id, randomUUID(), handover.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(control.browserLive.continue(ownerId, id, runId, handover.id)).rejects.toMatchObject({ code: 'AGENT_HUMAN_STEP' });
      expect((await control.detail(ownerId, id)).status).toBe('waiting_input');
      expect(actions).toEqual([{ kind: 'open', text: url }]);

      pages.get(id)!.wall = null;
      expect((await control.detail(ownerId, id)).status).toBe('waiting_input');
      allowed = false;
      await expect(control.browserLive.continue(ownerId, id, runId, handover.id)).rejects.toMatchObject({ code: 'CHAT_TOOL_FORBIDDEN' });
      allowed = true;
      await control.browserLive.continue(ownerId, id, runId, handover.id);
      await control.settled(id);
      const resumed = await control.detail(ownerId, id);
      expect(resumed.status, resumed.error ?? '').toBe('idle');
      expect(resumed.run?.id).toBe(runId);
      expect(resumed.secure).toBeNull();
      expect(actions).toEqual([{ kind: 'open', text: url }]);
      await expect(control.browserLive.continue(ownerId, id, runId, handover.id)).rejects.toMatchObject({ statusCode: 409 });
    });

  it('keeps the completed link navigation and runs the remaining read after consent', async () => {
    allowed = true;
    fixtureWall = address => address === nextUrl ? 'consent' : null;
    actions.length = 0;
    const { id } = await control.create(ownerId, { goal: `افتح ${url} ثم اضغط على Details ثم اقرأ الصفحة` });
    await control.settled(id);
    const paused = await control.detail(ownerId, id);
    const handover = readBrowserLiveHandover(paused.secure);
    expect(paused.status, paused.error ?? '').toBe('waiting_input');
    expect(handover?.prompt).toContain('راجع طلب الموافقة');
    expect(actions).toEqual([{ kind: 'open', text: url }, { kind: 'open', text: nextUrl, ref: 'e1' }]);
    pages.get(id)!.wall = null;
    await control.browserLive.continue(ownerId, id, paused.run!.id, handover!.id);
    await control.settled(id);
    const resumed = await control.detail(ownerId, id);
    expect(resumed.status, resumed.error ?? '').toBe('idle');
    expect(resumed.run?.id).toBe(paused.run?.id);
    expect(resumed.messages.at(-1)?.text).toContain(catalogueText);
    expect(actions).toHaveLength(2);
  });

  it('keeps a cancelled run’s challenged page out of a fresh open in the same conversation', async () => {
    allowed = true;
    fixtureWall = address => address === url ? 'CAPTCHA' : null;
    const { id } = await control.create(ownerId, { goal: `افتح ${url}` });
    await control.settled(id);
    const first = await control.detail(ownerId, id);
    expect(first.status).toBe('waiting_input');
    await control.cancel(ownerId, id);
    actions.length = 0;
    await control.send(ownerId, id, { text: `افتح ${nextUrl} ثم اقرأ الصفحة` });
    await control.settled(id);
    const second = await control.detail(ownerId, id);
    expect(second.status, second.error ?? '').toBe('idle');
    expect(second.run?.id).not.toBe(first.run?.id);
    expect(second.secure).toBeNull();
    expect(actions).toEqual([{ kind: 'open', text: nextUrl }]);
  });
});
