import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CODING_DEVICE_PROTOCOL_VERSION, CodingPairResponseSchema, type CodingPollRequest } from '@mohassan/coding-link';
import { postCodingDeviceJson } from '@mohassan/coding-link/worker';
import { signInAsFixtureOwner } from './helpers';
import { E2E_SERVER_PORT } from './isolation';

test('owner pairs, checks, replaces and revokes a coding device using the keyboard', async ({ page, context }) => {
  test.setTimeout(180_000);
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
  const replacementWarning = 'استخدام رمز ربط جديد يستبدل الجهاز المرتبط حاليًا ويُبطل مفتاحه.';
  await expect(panel.getByText(replacementWarning)).toHaveCount(0);
  await pair.press('Enter');
  const announcement = panel.locator('div[aria-live="polite"][aria-atomic="true"]');
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
  const firstDevice = CodingPairResponseSchema.parse(paired.body);
  await expect(panel.getByText('الجهاز غير متصل.')).toBeVisible();
  await expect(panel.getByRole('strong').getByText('جهاز الاختبار', { exact: true })).toBeVisible();
  await expect(codeInput).toHaveCount(0);
  await expect(announcement).toHaveText('اكتمل ربط جهاز البرمجة «جهاز الاختبار».');
  await expect(panel.getByText(replacementWarning)).toBeVisible();
  await expect(pair).toHaveAccessibleDescription(replacementWarning);

  async function poll({ deviceId, deviceKey }: typeof firstDevice, available: boolean) {
    const data: CodingPollRequest = {
      nonce: randomUUID(), sentAt: new Date().toISOString(), activeJobId: null, progress: [], result: null,
      status: { protocolVersion: CODING_DEVICE_PROTOCOL_VERSION, platform: 'win32', sandbox: {
        available, provider: 'windows-appcontainer', message: available ? 'بيئة العزل متاحة' : 'لم يثبت توفر بيئة عزل.',
      } },
    };
    return postCodingDeviceJson(server, '/api/coding/device/poll', JSON.stringify(data), { authorization: `Bearer ${deviceId}.${deviceKey}` });
  }
  expect((await poll(firstDevice, false)).status).toBe(200);
  await expect(panel.getByText('الجهاز متصل وبيئة العزل غير جاهزة.')).toBeVisible();
  expect((await poll(firstDevice, true)).status).toBe(200);
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

  await pair.press('Enter');
  await expect(codeInput).toHaveValue(/^[A-Za-z0-9_-]{16}$/);
  const newCode = await codeInput.inputValue();
  expect((await poll(firstDevice, true)).status).toBe(200);
  const replacementName = 'جهاز الاختبار البديل';
  const replaced = await postCodingDeviceJson(server, '/api/coding/device/pair', JSON.stringify({ code: newCode, name: replacementName }));
  expect(replaced.status).toBe(200);
  const replacement = CodingPairResponseSchema.parse(replaced.body);
  await expect(announcement).toHaveText(`اكتمل ربط جهاز البرمجة «${replacementName}».`);
  await expect(codeInput).toHaveCount(0);
  expect((await poll(firstDevice, true)).status).toBe(401);

  async function confirmRevocation(accept: boolean) {
    const confirmation = page.waitForEvent('dialog').then(async dialog => {
      const type = dialog.type();
      const message = dialog.message();
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      expect(type).toBe('confirm');
      expect(message).toContain(replacementName);
    });
    await Promise.all([confirmation, revoke.press('Enter')]);
  }
  await confirmRevocation(false);
  expect((await poll(replacement, true)).status).toBe(200);
  await expect(announcement).toContainText(replacementName);
  await confirmRevocation(true);
  await expect(panel.getByText('أُلغي ربط جهاز البرمجة.')).toBeVisible();
  await expect(panel.getByText('لا يوجد جهاز مربوط.')).toBeVisible();
  expect((await poll(replacement, true)).status).toBe(401);
});

test('device status polling stops when the link is disabled and stays stopped after reconnecting', async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.clock.install();
  await signInAsFixtureOwner(page);
  let statusReads = 0;
  let enabled = true;
  await page.route('**/api/coding/devices', route => {
    statusReads++;
    return route.fulfill({ json: { enabled, devices: [] } });
  });
  const openCoding = page.getByRole('button', { name: 'مشاريع البرمجة', exact: true });
  await openCoding.click();
  const panel = page.getByRole('region', { name: 'ربط جهاز البرمجة' });
  await expect(panel.getByText('لا يوجد جهاز مربوط.')).toBeVisible();
  const enabledReads = statusReads;
  enabled = false;
  await page.clock.fastForward(5_000);
  const disabled = panel.getByText('ربط جهاز البرمجة غير مفعّل على الخادم.');
  await expect(disabled).toBeVisible();
  await expect(panel.getByRole('button', { name: 'اربط جهازك' })).toHaveCount(0);
  expect(statusReads).toBeGreaterThan(enabledReads);

  // Capture attempts in the browser even when offline requests cannot be routed.
  const attempts = await page.evaluateHandle(() => {
    let count = 0;
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input === '/api/coding/devices') count++;
      return request(input, init);
    };
    return { read: () => count };
  });
  await page.clock.runFor(15_000);
  await context.setOffline(true);
  await expect(panel.getByText('الاتصال بالخادم منقطع. تعذر تحديث حالة الجهاز.')).toBeVisible();
  await context.setOffline(false);
  await expect(disabled).toBeVisible();
  await page.clock.runFor(10_000);
  expect(await attempts.evaluate(counter => counter.read())).toBe(0);

  await page.getByRole('button', { name: 'نظرة عامة', exact: true }).click();
  await openCoding.click();
  await expect(disabled).toBeVisible();
  const remountAttempts = await attempts.evaluate(counter => counter.read());
  expect(remountAttempts).toBeGreaterThan(0);
  await page.clock.runFor(10_000);
  expect(await attempts.evaluate(counter => counter.read())).toBe(remountAttempts);
  await attempts.dispose();
});
