import { expect, test } from '@playwright/test';
import { newestTitle, oldestMessage, oldestTitle, pagingOwner } from './conversation-paging-setup';
import { submitFixtureSignIn } from './helpers';

test('opens the oldest conversation through paging and Arabic search, and restores it after reload', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('البريد الإلكتروني').fill(pagingOwner.email);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(pagingOwner.password);
  await submitFixtureSignIn(page);

  const sidebar = page.getByRole('navigation', { name: 'المحادثات' });
  const older = sidebar.getByRole('button', { name: 'محادثات أقدم', exact: true });
  const oldest = sidebar.getByRole('button', { name: oldestTitle, exact: true });
  const newest = sidebar.getByRole('button', { name: newestTitle, exact: true });
  const message = page.getByRole('log').getByText(oldestMessage, { exact: true });

  await expect(older).toBeVisible();
  await expect(newest).toBeVisible();
  await expect(oldest).toHaveCount(0);
  await older.click();
  await expect(newest).toBeVisible();
  await expect(older).toHaveCount(0);
  await oldest.click();
  await expect(message).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(message).toBeVisible();
  await expect(older).toBeVisible();
  await sidebar.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  await expect(message).toHaveCount(0);

  const search = sidebar.getByRole('searchbox', { name: 'ابحث في المحادثات' });
  await search.fill('عنوان غير موجود');
  await expect(sidebar.getByText('لا توجد محادثات مطابقة.', { exact: true })).toBeVisible();
  await search.fill('اداره قديمه');
  await expect(newest).toHaveCount(0);
  await oldest.click();
  await expect(message).toBeVisible();
  await search.clear();
  await expect(newest).toBeVisible();

  const savedId = () => page.evaluate(() => localStorage.getItem('mohassan-conversation'));
  const oldestId = await savedId();
  expect(oldestId).toBeTruthy();
  const deleted = await page.request.delete(`/api/chat/conversations/${oldestId}`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(deleted.ok()).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(savedId).toBeNull();
  await expect(newest).toBeVisible();
  await expect(message).toHaveCount(0);
});
