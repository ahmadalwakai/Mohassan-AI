import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

/**
 * The browser levels of docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §6, against the model-free brain
 * (playwright.browser-visibility.config.ts): a calculation never shows a panel; a hidden browser shows only the
 * chip; a sign-in opens the panel with its reason and folds it back when answered; a hidden tab gets one notice.
 */
test.describe.configure({ mode: 'serial' });

let site: Server;
test.beforeAll(async () => {
  test.setTimeout(200_000);
  site = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url?.startsWith('/login')) {
      response.end(`<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Sign in</title></head><body style="font:18px Arial">
        <main><h1>تسجيل الدخول</h1><form method="post" action="/session"><label>البريد<input name="email" type="email" autocomplete="username"></label>
        <label>كلمة المرور<input name="password" type="password" autocomplete="current-password"></label><button type="submit">دخول</button></form></main></body></html>`);
      return;
    }
    response.end(`<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>صفحة القياس</title></head><body style="font:18px Arial">
      <main><h1>صفحة اختبار المتصفح المخفي</h1><p>هذه الصفحة تُقرأ في الخلفية. العاصمة هنا هي مدينة الاختبار، وعدد السكان مئة.</p></main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve); });
  // The dev web server compiles the page on its first request; on a loaded machine that alone took up to two minutes
  // and timed out the first story. Pay it here, once, outside any test's clock.
  await fetch('http://127.0.0.1:3100/', { signal: AbortSignal.timeout(170_000) }).then(response => response.text()).catch(() => undefined);
});
test.afterAll(async () => { await new Promise<void>(resolve => site.close(() => resolve())); });

async function send(page: Page, text: string): Promise<string> {
  const accepted = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/chat\/conversations(?:\/[^/]+\/messages)?$/.test(new URL(response.url()).pathname));
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(text);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).id as string;
}
const detail = async (page: Page, id: string) => (await (await page.request.get(`/api/chat/conversations/${id}`)).json());
async function settled(page: Page, id: string) {
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 60_000 }).not.toBe('running');
  return detail(page, id);
}
const panel = (page: Page) => page.getByRole('complementary', { name: 'المتصفح' });
const chip = (page: Page) => page.getByTestId('browser-chip');

test('a calculation never shows the browser panel or its chip (level 0)', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const id = await send(page, 'كم 15 ضرب 23؟');
  const result = await settled(page, id);
  expect(result.visibility).toMatchObject({ level: 0, code: 'local_compute', requested: 0, canView: true });
  expect(result.browser).toBeNull();
  await expect(page.getByRole('log')).toContainText('345');
  await expect(panel(page)).toHaveCount(0);
  await expect(chip(page)).toHaveCount(0);
});

test('a hidden browser shows only the chip; the owner can open the panel from it (level 2)', async ({ page }, testInfo) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const id = await send(page, 'افتح http://127.0.0.1:4201/ ثم اقرأ الصفحة');
  const result = await settled(page, id);
  expect(result.visibility).toMatchObject({ level: 2, canView: true });
  expect(result.browser).not.toBeNull();
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toContainText('المتصفح');
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('level-2-chip.png') });
  await chip(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('browser-reason')).toHaveCount(0);
  await page.getByRole('button', { name: 'إغلاق المتصفح', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(chip(page)).toBeVisible();
});

test('a sign-in opens the panel with its reason, then folds it back when the step is answered (level 3 → 2)', async ({ page }, testInfo) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const id = await send(page, 'افتح http://127.0.0.1:4201/login ثم اقرأ الصفحة');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 60_000 }).toBe('waiting_input');
  const waiting = await detail(page, id);
  expect(waiting.secure.kind).toBe('login');
  expect(waiting.visibility).toMatchObject({ level: 3, code: 'needs_login', requested: 2 });
  expect(waiting.visibility.reason).toContain('تسجيل الدخول إلى 127.0.0.1:4201');
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('browser-reason')).toContainText('هذه الخطوة تحتاجك');
  await expect(chip(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('level-3-panel.png') });
  await page.getByRole('button', { name: 'تخطي', exact: true }).click();
  await expect(panel(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(chip(page)).toBeVisible();
  const after = await settled(page, id);
  expect(after.visibility.level).toBeLessThanOrEqual(2);
});

test('a hidden tab keeps following its task and gets one system notice when it finishes', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  type ShownNotification = { title: string; body: string; tag: string };
  await page.addInitScript(() => {
    const shown: ShownNotification[] = [];
    const noticesByTag = new Map<string, FakeNotification>();
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        const tag = options?.tag ?? '';
        shown.push({ title, body: options?.body ?? '', tag });
        noticesByTag.set(tag, this);
      }
      close() { /* nothing to close */ }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    Object.defineProperty(window, '__notices', { value: shown });
    Object.defineProperty(window, '__clickNotice', { value: (tag: string) => noticesByTag.get(tag)?.onclick?.() });
    Object.defineProperty(window, '__hidden', { value: false, writable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => (window as unknown as { __hidden: boolean }).__hidden, configurable: true });
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => (window as unknown as { __hidden: boolean }).__hidden ? 'hidden' : 'visible', configurable: true });
  });
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const hiddenSync = page.waitForResponse(response => response.url().endsWith('/api/notifications/sync')
    && response.request().postDataJSON()?.state === 'hidden');
  await page.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  expect((await hiddenSync).ok()).toBe(true);

  // Hold the history row at running so the old notice effect observes both transitions even for a fast calculation.
  const goal = 'كم 17 ضرب 29؟';
  let showRunningHistory = true;
  await page.route('**/api/chat/conversations', async route => {
    if (route.request().method() !== 'GET' || !showRunningHistory) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const history = await response.json() as { conversations: { title: string; status: string }[] };
    const task = history.conversations.find(conversation => conversation.title === goal);
    if (!task) return route.fulfill({ response });
    task.status = 'running';
    const headers = response.headers();
    delete headers['content-length'];
    delete headers['content-encoding'];
    return route.fulfill({ response, headers, json: history });
  });
  const id = await send(page, goal);
  await expect(page.getByTitle(goal, { exact: true }).getByRole('img', { name: 'يعمل الآن' })).toBeVisible();
  const result = await settled(page, id);
  showRunningHistory = false;
  // The history effect saves this ID after processing the idle result. Wait while the tab is still hidden.
  await expect.poll(() => page.evaluate(conversationId => {
    const seen = JSON.parse(localStorage.getItem('mohassan-seen-tasks') ?? '{}');
    return Object.hasOwn(seen, conversationId);
  }, id), { timeout: 40_000 }).toBe(true);
  const taskNotices = () => page.evaluate(title => (window as unknown as { __notices: ShownNotification[] }).__notices
    .filter(notice => notice.body === title), goal);
  const tag = `mohassan-task-${result.run.id}`;
  const expected = [{ title: 'اكتملت المهمة', body: goal, tag }];
  await expect.poll(taskNotices, { timeout: 40_000 }).toEqual(expected);
  // Back to the tab: the title counted the finished task while it was hidden, and clears once the owner looks.
  await page.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.title()).toBe('موحسن');
  expect(await taskNotices()).toEqual(expected);

  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  await expect(page.getByRole('log')).toHaveCount(0);
  const navigation = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).searchParams.get('conversation') === id);
  await page.evaluate(noticeTag => {
    setTimeout(() => (window as unknown as { __clickNotice: (tag: string) => void }).__clickNotice(noticeTag), 0);
  }, tag);
  await navigation;
  await expect(page.getByRole('log')).toContainText(goal);
  await expect.poll(() => new URL(page.url()).searchParams.get('conversation')).toBeNull();
});

test('notification permission is offered after an eligible background task and a denial stays in settings', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { hidden: false, prompts: 0 };
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission() { state.prompts++; FakeNotification.permission = 'denied'; return FakeNotification.permission; }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    Object.defineProperty(window, '__notificationTest', { value: state });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => state.hidden, configurable: true });
  });
  let eligible = false;
  let hiddenSyncs = 0;
  const visibleTabs = new Set<string>();
  const closedTabs = new Set<string>();
  await page.route('**/api/notifications/sync', async route => {
    const { state, tabId } = route.request().postDataJSON();
    if (state === 'visible') visibleTabs.add(tabId);
    if (state === 'closed') closedTabs.add(tabId);
    if (state === 'hidden') hiddenSyncs++;
    await route.fulfill({ json: { backgroundTask: eligible && state === 'hidden', pending: [] } });
  });
  const setHidden = (hidden: boolean) => page.evaluate(value => {
    (window as unknown as { __notificationTest: { hidden: boolean } }).__notificationTest.hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const prompts = () => page.evaluate(() => (window as unknown as { __notificationTest: { prompts: number } }).__notificationTest.prompts);

  await signInAsFixtureOwner(page, 'assistant');
  await expect.poll(() => visibleTabs.size).toBeGreaterThan(0);
  await expect(page.getByTestId('notice-offer')).toHaveCount(0);
  expect(await prompts()).toBe(0);

  const firstTab = [...visibleTabs].at(-1);
  const beforeRestore = visibleTabs.size;
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => visibleTabs.size).toBeGreaterThan(beforeRestore);
  await expect.poll(() => firstTab && closedTabs.has(firstTab)).toBe(true);

  eligible = true;
  await setHidden(true);
  await expect(page.getByTestId('notice-offer')).toBeVisible();
  await setHidden(false);
  await page.getByRole('button', { name: 'تفعيل الإشعارات' }).click();
  expect(await prompts()).toBe(1);
  await expect(page.getByTestId('notice-offer')).toHaveCount(0);

  await page.getByRole('button', { name: 'مالك الاختبار' }).click();
  await page.getByRole('button', { name: 'الإشعارات', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'الإشعارات' })).toContainText('الإشعارات محظورة لهذا الموقع.');
  await page.getByRole('button', { name: 'إغلاق إعدادات الإشعارات' }).click();
  await page.reload();
  const beforeHidden = hiddenSyncs;
  await setHidden(true);
  await expect.poll(() => hiddenSyncs).toBeGreaterThan(beforeHidden);
  await expect(page.getByTestId('notice-offer')).toHaveCount(0);
  expect(await prompts()).toBe(0);
});
