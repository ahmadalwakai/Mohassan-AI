import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { IosPushRegistration, NotificationSettingsResponse } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('lists and removes a registered iPhone in Arabic notification settings', async ({ page }) => {
  test.setTimeout(120_000); // An isolated Next instance compiles the page on first load.
  await signInAsFixtureOwner(page, 'assistant');
  const settingsPath = '/api/notifications/settings';
  const registrationPath = '/api/push/devices';
  const registration: IosPushRegistration = {
    platform: 'ios', token: randomBytes(32).toString('hex'), environment: 'sandbox', appVersion: '1.0.0',
  };
  const registered = await page.request.post(registrationPath, {
    headers: { origin: new URL(page.url()).origin }, data: registration,
  });
  expect(registered.status()).toBe(204);
  const settings = await page.request.get(settingsPath);
  expect(settings.ok()).toBe(true);
  const { iosDevices } = await settings.json() as NotificationSettingsResponse;
  expect(iosDevices).toHaveLength(1);
  const device = iosDevices[0]!;

  await page.getByRole('button', { name: 'مالك الاختبار' }).click();
  await page.getByRole('button', { name: 'الإشعارات', exact: true }).click();
  const iphones = page.getByRole('dialog', { name: 'الإشعارات' }).getByRole('region', { name: 'أجهزة آيفون' });
  const row = iphones.getByRole('listitem').filter({ hasText: device.label });
  await expect(row).toBeVisible();
  await expect(row.locator('time')).toHaveAttribute('datetime', device.registeredAt);
  await expect(row).toContainText('لم يُسجّل أي إرسال ناجح بعد.');

  const removed = page.waitForResponse(response => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === `${registrationPath}/registrations/${device.id}`);
  await row.getByRole('button', { name: `إزالة جهاز ${device.label}` }).click();
  expect(await (await removed).json()).toEqual({ removed: true });
  await expect(iphones).toContainText('لا توجد أجهزة آيفون مسجّلة.');
  await expect(iphones.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'أُزيل جهاز الآيفون.' })).toBeVisible();
});
