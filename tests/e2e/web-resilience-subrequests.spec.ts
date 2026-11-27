import { expect, test } from '@playwright/test';
import type { ChatConversation } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('an expired chat export returns to Arabic sign-in', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  const listPath = '/api/chat/conversations';
  const created = await page.request.post(listPath, {
    data: {},
    headers: { origin: new URL(page.url()).origin },
  });
  expect(created.ok()).toBe(true);
  const { id, status, updatedAt }: ChatConversation = await created.json();
  const title = 'محادثة لاختبار التصدير';
  await page.route(url => url.pathname === listPath, route => route.fulfill({
    json: { conversations: [{ id, status, updatedAt, title }] },
  }));
  await page.reload();
  await page.getByRole('navigation', { name: 'المحادثات' })
    .getByRole('button', { name: title, exact: true }).click();

  const matchesExport = (url: URL) => url.pathname === `${listPath}/${id}/export`;
  // The authentication hook's response at the baseline, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/app.ts#L250-L255
  await page.route(matchesExport, route => route.fulfill({
    status: 401,
    json: { error: { code: 'UNAUTHORIZED', message: 'سجل الدخول للمتابعة.' } },
  }));
  await page.getByRole('button', { name: 'تصدير', exact: true }).click();
  const response = page.waitForResponse(value => matchesExport(new URL(value.url())));
  await page.getByRole('dialog', { name: 'تصدير المحادثة' }).getByRole('button', { name: 'Markdown' }).click();

  expect((await response).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});
