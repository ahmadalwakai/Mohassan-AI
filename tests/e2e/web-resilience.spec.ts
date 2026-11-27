import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import type { ChatConversation, ChatConversationSummary } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

const listPath = '/api/chat/conversations';
const offlineNotice = 'أنت غير متصل بالإنترنت. ستُستأنف المحادثة عند عودة الاتصال.';
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'المحادثات' });
const thread = (page: Page) => page.getByRole('log', { name: 'المحادثة' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'رسالتك' });

async function mockRunningConversation(page: Page, read: (conversation: ChatConversation) => { status?: number; json: unknown }) {
  const summary: ChatConversationSummary = {
    id: randomUUID(), title: 'محادثة قيد التنفيذ', status: 'running', updatedAt: new Date().toISOString(),
  };
  const conversation: ChatConversation = {
    ...summary, messages: [{ id: randomUUID(), role: 'user', text: summary.title, createdAt: summary.updatedAt }],
    question: null, approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: false,
  };
  const matchesDetail = (url: URL) => url.pathname === `${listPath}/${summary.id}`;
  await page.route(url => url.pathname === listPath, route => route.fulfill({ json: { conversations: [summary] } }));
  await page.route(matchesDetail, route => route.fulfill(read(conversation)));
  await signInAsFixtureOwner(page, 'assistant');
  await sidebar(page).getByTitle(summary.title, { exact: true }).click();
  await expect(thread(page).getByText(summary.title, { exact: true })).toBeVisible();
}

test('the running chat shows an Arabic offline notice and resumes polling online', async ({ page, context }) => {
  let detailRequests = 0;
  let finished = false;
  const reply = 'اكتملت المحادثة بعد عودة الاتصال.';
  await mockRunningConversation(page, conversation => {
    detailRequests++;
    if (!finished) return { json: conversation };
    const finishedAt = new Date().toISOString();
    const completed: ChatConversation = {
      ...conversation,
      status: 'idle',
      updatedAt: finishedAt,
      messages: [...conversation.messages, { id: randomUUID(), role: 'assistant', text: reply, createdAt: finishedAt }],
    };
    return { json: completed };
  });
  await expect.poll(() => detailRequests).toBeGreaterThan(1);

  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: offlineNotice })).toBeVisible();
  const before = detailRequests;
  // Observe more than two ordinary poll intervals while the network is disconnected.
  await delay(1_200);
  expect(detailRequests).toBe(before);

  finished = true;
  await context.setOffline(false);
  await expect(page.getByText(offlineNotice, { exact: true })).toHaveCount(0);
  await expect(thread(page).getByText(reply, { exact: true })).toBeVisible();
  expect(detailRequests).toBeGreaterThan(before);
});

test('clearing cookies returns to Arabic sign-in on the next send', async ({ page, context }) => {
  const history = page.waitForResponse(response => new URL(response.url()).pathname === listPath && response.request().method() === 'GET' && response.ok());
  await signInAsFixtureOwner(page, 'assistant');
  await history;
  await composer(page).fill('اختبار انتهاء الجلسة');
  const send = page.getByRole('button', { name: 'إرسال', exact: true });
  await expect(send).toBeEnabled();
  await context.clearCookies();

  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === listPath && response.request().method() === 'POST');
  await send.click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('failed polls back off during a server outage and then recover', async ({ page }) => {
  let detailRequests = 0;
  let failures = 0;
  let available = false;
  await mockRunningConversation(page, conversation => {
    if (++detailRequests === 1) return { json: conversation };
    if (available) return { json: { ...conversation, status: 'idle' } };
    failures++;
    return { status: 503, json: { error: { message: 'Service unavailable' } } };
  });

  const notice = page.getByRole('status').filter({ hasText: 'الخدمة غير متاحة مؤقتًا.' });
  await expect(notice).toBeVisible();
  await expect(page.getByText('Service unavailable', { exact: true })).toHaveCount(0);
  const before = failures;
  // At the baseline's 450 ms cadence, this window would contain at least six more requests (retrieved 2026-11-27).
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/web/components/assistant-app.tsx#L44
  await delay(3_000);
  expect(failures - before).toBeLessThanOrEqual(4);

  available = true;
  await expect(notice).toHaveCount(0);
  await expect(thread(page)).toBeVisible();
});

test('a failed conversation list shows a retry in the sidebar', async ({ page }) => {
  const matchesList = (url: URL) => url.pathname === listPath;
  await page.route(matchesList, route => route.fulfill({ status: 503, json: { error: { message: 'Service unavailable' } } }));
  await signInAsFixtureOwner(page, 'assistant');
  await expect(sidebar(page).getByRole('alert')).toContainText('تعذّر تحميل المحادثات.');
  await expect(sidebar(page).getByText('ستظهر محادثاتك هنا.', { exact: true })).toHaveCount(0);

  await page.unroute(matchesList);
  const recovered = page.waitForResponse(response => matchesList(new URL(response.url())) && response.request().method() === 'GET');
  const retry = sidebar(page).getByRole('button', { name: 'إعادة المحاولة', exact: true });
  await retry.click();
  expect((await recovered).ok()).toBe(true);
  await expect(retry).toHaveCount(0);
});

test('a malformed conversation shows an Arabic fallback and retries the same conversation', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  const created = await page.request.post(listPath, { data: {}, headers: { origin: new URL(page.url()).origin } });
  expect(created.ok()).toBe(true);
  const conversation: ChatConversation = await created.json();
  const title = 'محادثة لاختبار استعادة العرض';
  const summary: ChatConversationSummary = {
    id: conversation.id, title, status: conversation.status, updatedAt: conversation.updatedAt,
  };
  await page.route(url => url.pathname === listPath, route => route.fulfill({ json: { conversations: [summary] } }));
  const matchesDetail = (url: URL) => url.pathname === `${listPath}/${conversation.id}`;
  await page.route(matchesDetail, route => route.fulfill({ json: { ...conversation, messages: null } }));
  await page.reload();
  const selected = sidebar(page).getByRole('button', { name: title, exact: true });
  await selected.click();
  await expect(page.getByText('تعذّر عرض المحادثة.', { exact: true })).toBeVisible();

  await page.unroute(matchesDetail);
  const recovered = page.waitForResponse(response => matchesDetail(new URL(response.url())));
  await page.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  expect((await recovered).ok()).toBe(true);
  await expect(selected).toHaveAttribute('aria-current', 'true');
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('تعذّر عرض المحادثة.', { exact: true })).toHaveCount(0);
});

test('a page render error shows an Arabic fallback and retries after the cause is removed', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  const matchesSession = (url: URL) => url.pathname === '/api/auth/get-session';
  await page.route(matchesSession, async route => {
    const response = await route.fetch();
    const session = await response.json();
    // The chat header expects the session's name to be a string.
    await route.fulfill({ json: { ...session, user: { ...session.user, name: {} } } });
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'تعذّر عرض الصفحة', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.unroute(matchesSession);
  await page.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
});

test('an unknown path shows an Arabic right-to-left 404', async ({ page }) => {
  const unknownPath = '/web-resilience-not-a-route';
  const response = await page.goto(unknownPath);
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'الصفحة غير موجودة', exact: true })).toBeVisible();
  const retried = page.waitForResponse(next => new URL(next.url()).pathname === unknownPath && next.request().isNavigationRequest());
  await page.getByRole('link', { name: 'إعادة المحاولة', exact: true }).click();
  expect((await retried).status()).toBe(404);
});
