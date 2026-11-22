import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { signInAsFixtureOwner } from './helpers';

// The deployed API before named browser profiles accepted only this shape.
const legacyCreate = z.object({ goal: z.string().trim().min(1).max(4000).optional() }).strict();
const validationMessage = 'تحقق من الحقول المطلوبة وطول المدخلات.';

test('a default conversation can be created through the legacy strict API contract', async ({ page }) => {
  const attempts: unknown[] = [];
  await page.route('**/api/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body: unknown = route.request().postDataJSON();
    attempts.push(body);
    if (!legacyCreate.safeParse(body).success) {
      return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_ERROR', message: validationMessage } } });
    }
    return route.continue();
  });
  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('مرحبا');
  const created = page.waitForResponse(response => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'POST');
  await composer.press('Enter');
  expect((await created).ok()).toBe(true);
  await expect(page.getByRole('log').getByText('مرحبا', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.getByText(validationMessage, { exact: true })).toHaveCount(0);
  expect(attempts).toEqual([{ goal: 'مرحبا' }]);
});

test('a failed create keeps the draft, while a successful retry with a failed history refresh stays sent once', async ({ page }) => {
  test.setTimeout(60_000);
  const goal = 'احسب 7 + 8';
  let attempts = 0;
  let failHistory = false;
  let successfulId: string | undefined;
  await page.route('**/api/chat/conversations', async route => {
    if (route.request().method() === 'GET') {
      if (!failHistory) return route.continue();
      failHistory = false;
      return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'تعذر تحديث قائمة المحادثات.' } } });
    }
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (attempts === 1) {
      return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_ERROR', message: validationMessage } } });
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    successfulId = (await response.json()).id;
    failHistory = true;
    return route.fulfill({ response });
  });
  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill(goal);
  await composer.press('Enter');
  await expect(page.getByText(validationMessage, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(goal);
  await expect(page.getByRole('button', { name: 'إرسال', exact: true })).toBeEnabled();

  const failedRefresh = page.waitForResponse(response => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'GET' && response.status() === 503);
  await composer.press('Enter');
  await failedRefresh;
  await expect(page.getByRole('log').getByText(goal, { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: 'إرسال', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'إرسال', exact: true })).toBeDisabled();
  // A user's habitual second Enter cannot resubmit the already accepted goal.
  await composer.press('Enter');
  expect(attempts).toBe(2);
  expect(successfulId).toBeTruthy();
  const detail = await page.request.get(`/api/chat/conversations/${successfulId}`);
  expect(detail.ok()).toBe(true);
  const conversation = await detail.json();
  expect(conversation.messages.filter((message: { role: string; text: string }) => message.role === 'user' && message.text === goal)).toHaveLength(1);
});
