import type { TrainingMonitorSnapshot, TrainingRun } from '@mohassan/contracts';
import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

const updatedAt = '2026-11-25T00:07:28Z';
const etaAt = '2026-11-26T00:10:00Z';
const endedAt = '2026-11-24T23:41:00Z';
const snapshot: TrainingMonitorSnapshot = {
  active: {
    run: 'fixture-run', shape: '85m', status: 'running', step: 60350,
    processedTokens: 494355456, totalTokens: 1000000000, percentDone: 49.4355456, updatedAt, etaAt,
    speed: {
      current: 5198, average30Minutes: 6150, averageWindowSeconds: 900, firstMinute: 7175,
      guardLine: 5022.5, distanceFromGuardLine: 175.5, consecutiveSlowSeconds: 0, sampledAt: updatedAt,
    },
    lastValidation: { ar: 2.5486, en: 2.8095 },
    bestValidation: { ar: 2.52, en: 2.785 },
    lastCheckpoint: { tokens: 400000000, savedAt: updatedAt },
    nextCheckpoint: { tokens: 500000000, etaAt: '2026-11-25T00:22:45Z' },
    stopRequested: true,
    currentAttempt: 'attempt-three',
    attempts: [
      { id: 'attempt-one', startedAt: '2026-11-24T00:10:00Z', endedAt: '2026-11-24T08:00:00Z', status: 'crashed', resumed: false },
      { id: 'attempt-two', startedAt: '2026-11-24T11:10:00Z', endedAt: '2026-11-24T21:00:00Z', status: 'failed', resumed: true },
      { id: 'attempt-three', startedAt: '2026-11-24T23:58:00Z', endedAt: null, status: 'running', resumed: null },
    ],
  },
  recent: [],
  gpu: { temperatureC: 80, utilizationPercent: 99, memoryUsedMiB: 3600 },
  gpuLock: { owner: 'fixture-gpu-owner', purpose: 'training', pid: 123, started: updatedAt },
  sampledAt: updatedAt,
};
const active = snapshot.active!;
const finished: TrainingRun = {
  ...active, run: 'finished-run', status: 'completed', processedTokens: 1000000000, percentDone: 100,
  etaAt: null, speed: null, stopRequested: false, nextCheckpoint: null, lastValidation: {}, bestValidation: {},
  attempts: [{ id: 'attempt-three', startedAt: '2026-11-24T22:00:00Z', endedAt, status: 'completed', resumed: null }],
};

test.use({ timezoneId: 'Asia/Riyadh' });

test('the owner opens the Arabic monitor and sees refreshed speed, dates and run history', async ({ page }) => {
  test.setTimeout(90_000);
  // Finish the initial Next.js compilation before interacting with the sign-in form.
  expect((await page.request.get('/', { timeout: 60_000 })).ok()).toBe(true);
  await signInAsFixtureOwner(page, 'assistant');
  await page.clock.install();

  let requests = 0;
  let fixture = { ...snapshot, recent: [active, finished] };
  await page.route('**/api/training-monitor', async (route) => {
    expect(route.request().method()).toBe('GET');
    requests += 1;
    await route.fulfill({ json: fixture });
  });
  const account = page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'مالك الاختبار' });
  await account.click();
  await page.getByRole('link', { name: 'مراقبة التدريب' }).click();
  await expect(page.getByRole('heading', { name: 'مراقبة التدريب' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '49.4355456');
  await expect(page.getByText('آخر تحديث للتدريب', { exact: false }).locator('time')).toHaveAttribute('datetime', updatedAt);
  await expect(page.getByRole('region', { name: 'سرعة التدريب' })).toContainText('٩٠٠ ثانية');
  await expect(page.getByText('سرعة التدريب قريبة من حد الحماية.')).toBeVisible();
  await expect(page.getByText('حرارة بطاقة الرسومات بلغت ٨٠ درجة مئوية أو أكثر.')).toBeVisible();
  await expect(page.getByText('طُلب إيقاف التدريب مؤقتًا.')).toBeVisible();
  await expect(page.getByText('fixture-gpu-owner')).toBeVisible();

  const finish = page.getByRole('region', { name: 'وقت الانتهاء المتوقع' });
  await expect(finish.locator('time')).toHaveCount(2);
  const [localEta, utcEta] = await page.evaluate((instant) => ['Asia/Riyadh', 'UTC'].map((timeZone) =>
    new Intl.DateTimeFormat('ar-u-nu-arab', {
      calendar: 'gregory', dateStyle: 'medium', timeStyle: 'short', timeZone,
    }).format(new Date(instant))), etaAt);
  await expect(finish.locator('time').nth(0)).toHaveText(localEta);
  await expect(finish.locator('time').nth(1)).toHaveText(utcEta);

  const validation = page.getByRole('region', { name: 'خسارة التحقق' });
  await expect(validation.getByRole('row', { name: /العربية/ })).toContainText('٢٫٥٤٨٦');
  await expect(validation.getByRole('row', { name: /الإنجليزية/ })).toContainText('٢٫٧٨٥');
  const attempts = page.getByRole('region', { name: 'جدول محاولات التدريب' });
  await expect(attempts.getByRole('row', { name: /attempt-one/ })).toContainText('انقطع');
  await expect(attempts.getByRole('row', { name: /attempt-two/ })).toContainText('فشل');
  await expect(attempts.getByRole('row', { name: /attempt-two/ })).toContainText('استئناف');
  await expect(attempts.getByRole('row', { name: /attempt-three/ })).toContainText('إعادة تشغيل');
  const checkpoints = page.getByRole('region', { name: 'نقاط الحفظ' });
  await expect(checkpoints).toContainText('٤٠٠٬٠٠٠٬٠٠٠ رمز');
  await expect(checkpoints).toContainText('٥٠٠٬٠٠٠٬٠٠٠ رمز');

  const runPicker = page.getByRole('combobox', { name: 'التشغيل المعروض' });
  await expect(runPicker.getByRole('option')).toHaveCount(2);
  await runPicker.selectOption({ label: 'finished-run / 85m' });
  await expect(page.getByText('اكتمل التدريب.')).toBeVisible();
  await expect(page.getByText('لا توجد نتائج تحقق مسجّلة.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  await expect(page.getByRole('region', { name: 'وقت انتهاء التدريب' }).locator(`time[datetime="${endedAt}"]`)).toHaveCount(2);
  fixture = {
    ...fixture,
    active: { ...active, speed: { ...active.speed!, current: 4900, distanceFromGuardLine: -122.5 } },
    gpu: null,
  };
  await page.clock.fastForward(15_000);
  await expect.poll(() => requests).toBeGreaterThan(1);
  const gpu = page.getByRole('region', { name: 'بطاقة الرسومات' });
  await expect(gpu.getByText('غير متاح', { exact: true })).toHaveCount(3);
  await expect(page.getByText('اكتمل التدريب.')).toBeVisible();
  await runPicker.selectOption({ label: 'fixture-run / 85m' });
  await expect(page.getByText('سرعة التدريب أقل من حد الحماية.')).toBeVisible();
});

test('missing local files show the server refusal without scheduled requests', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.clock.install();
  let requests = 0;
  await page.route('**/api/training-monitor', async (route) => {
    requests += 1;
    await route.continue();
  });
  await page.goto('/training-monitor');
  const message = page.getByRole('main').getByRole('alert');
  await expect(message).toHaveText('لم يجد موحسن ملفات حالة تدريب قابلة للقراءة على جهاز المالك.');
  const readsBeforeWait = requests;
  expect(readsBeforeWait).toBeGreaterThan(0);
  await page.clock.fastForward(30_000);
  expect(requests).toBe(readsBeforeWait);
  await page.getByRole('button', { name: 'إعادة المحاولة' }).click();
  await expect(message).toHaveText('لم يجد موحسن ملفات حالة تدريب قابلة للقراءة على جهاز المالك.');
  expect(requests).toBe(readsBeforeWait + 1);
});
