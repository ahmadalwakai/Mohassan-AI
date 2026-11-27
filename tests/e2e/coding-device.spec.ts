import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CODING_DEVICE_PROTOCOL_VERSION, CodingPairResponseSchema, type CodingPollRequest } from '@mohassan/coding-link';
import { postCodingDeviceJson } from '@mohassan/coding-link/worker';
import { signInAsFixtureOwner } from './helpers';
import { E2E_SERVER_PORT } from './isolation';

test('owner pairs, checks and revokes a coding device using the keyboard', async ({ page, context }) => {
  test.setTimeout(150_000);
  await signInAsFixtureOwner(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  let releaseStatus!: () => void;
  const statusDelay = new Promise<void>(resolve => { releaseStatus = resolve; });
  let statusUnavailable = false;
  await page.route('**/api/coding/devices', async route => {
    await statusDelay;
    if (statusUnavailable) {
      await route.fulfill({ status: 503, json: { error: { message: 'تعذر تحديث حالة جهاز البرمجة.' } } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'مشاريع البرمجة', exact: true }).click();
  const panel = page.getByRole('region', { name: 'ربط جهاز البرمجة' });
  try {
    await expect(panel).toHaveAttribute('dir', 'rtl');
    await expect(panel.getByText('جارٍ تحميل حالة جهاز البرمجة…')).toBeVisible();
  }
  finally { releaseStatus(); }
  await expect(panel.getByText('لا يوجد جهاز مربوط.')).toBeVisible();

  const pair = panel.getByRole('button', { name: 'اربط جهازك' });
  await pair.press('Enter');
  const announcement = panel.locator('div[aria-live="polite"]').filter({ has: page.getByLabel('رمز الربط', { exact: true }) });
  const codeInput = announcement.getByLabel('رمز الربط', { exact: true });
  await expect(codeInput).toHaveValue(/^[A-Za-z0-9_-]{16}$/);
  await expect(announcement.getByText(/صالح حتى/)).toBeVisible();
  await expect(announcement.locator('time')).toHaveAttribute('datetime', /Z$/);
  const code = await codeInput.inputValue();
  const copy = panel.getByRole('button', { name: 'نسخ رمز الربط' });
  await copy.press('Enter');
  await expect(panel.getByText('نُسخ رمز الربط.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    });
  });
  await copy.press('Enter');
  await expect(panel.getByText('تعذر النسخ تلقائيًا. انسخ الرمز المحدد.')).toBeVisible();
  await expect(codeInput).toBeFocused();
  expect(await codeInput.evaluate(input => (input as HTMLInputElement).selectionEnd)).toBe(code.length);

  const webPairStatus = await page.evaluate(async code => (await fetch('/api/coding/device/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'جهاز الاختبار' }),
  })).status, code);
  expect(webPairStatus).toBe(403);

  const server = `http://127.0.0.1:${E2E_SERVER_PORT}`;
  const paired = await postCodingDeviceJson(server, '/api/coding/device/pair', JSON.stringify({ code, name: 'جهاز الاختبار' }));
  expect(paired.status).toBe(200);
  const { deviceId, deviceKey } = CodingPairResponseSchema.parse(paired.body);
  await expect(panel.getByText('الجهاز غير متصل.')).toBeVisible();
  await expect(panel.getByText('جهاز الاختبار', { exact: true })).toBeVisible();
  await expect(codeInput).toHaveCount(0);

  async function poll(available: boolean) {
    const data: CodingPollRequest = {
      nonce: randomUUID(), sentAt: new Date().toISOString(), activeJobId: null, progress: [], result: null,
      status: { protocolVersion: CODING_DEVICE_PROTOCOL_VERSION, platform: 'win32', sandbox: {
        available, provider: 'windows-appcontainer', message: available ? 'بيئة العزل متاحة' : 'لم يثبت توفر بيئة عزل.',
      } },
    };
    return postCodingDeviceJson(server, '/api/coding/device/poll', JSON.stringify(data), { authorization: `Bearer ${deviceId}.${deviceKey}` });
  }
  expect((await poll(false)).status).toBe(200);
  await expect(panel.getByText('الجهاز متصل وبيئة العزل غير جاهزة.')).toBeVisible();
  expect((await poll(true)).status).toBe(200);
  await expect(panel.getByText('الجهاز متصل وبيئة العزل جاهزة.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const revoke = panel.getByRole('button', { name: 'إلغاء ربط الجهاز' });
  await context.setOffline(true);
  await expect(panel.getByText('الاتصال بالخادم منقطع. تعذر تحديث حالة الجهاز.')).toBeVisible();
  await expect(pair).toBeDisabled();
  await expect(revoke).toBeDisabled();
  await context.setOffline(false);
  await expect(revoke).toBeEnabled();

  statusUnavailable = true;
  await expect(panel.getByRole('alert')).toHaveText('تعذر تحديث حالة جهاز البرمجة.');
  statusUnavailable = false;
  await panel.getByRole('button', { name: 'تحديث حالة الجهاز' }).press('Enter');
  await expect(revoke).toBeEnabled();
  await revoke.press('Enter');
  await expect(panel.getByText('أُلغي ربط جهاز البرمجة.')).toBeVisible();
  await expect(panel.getByText('لا يوجد جهاز مربوط.')).toBeVisible();
  expect((await poll(true)).status).toBe(401);
});
