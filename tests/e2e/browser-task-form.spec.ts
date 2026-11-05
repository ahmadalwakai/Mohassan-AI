import { test, expect } from '@playwright/test';
import { TaskSchema } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

const goal = 'افتح موقع Google Ads في المتصفح، واعرض لي لقطة من الصفحة بعد تحميلها.';

test('new-task goal routes to browser with a visible target, honest shadow result and bounded approval', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInAsFixtureOwner(page, 'overview');
  const before = await page.request.get('/api/browser/workspace');
  expect(before.ok()).toBe(true);
  const sessionIds = (await before.json()).sessions.map((session: { id: string }) => session.id).sort();
  const create = page.locator('dialog.create-dialog');
  const detail = page.locator('dialog.detail-dialog');

  await page.getByRole('button', { name: 'مهمة جديدة', exact: true }).click();
  await create.getByLabel('عنوان المهمة', { exact: true }).fill('طلب فتح Google Ads من المهمة');
  await create.getByRole('textbox', { name: /ما الذي تريد التحقق منه/ }).fill(goal);
  await expect(create.getByLabel('القدرة المطلوبة')).toHaveValue('browser.open');
  await expect(create.getByLabel('عنوان المهمة', { exact: true })).toHaveValue('طلب فتح Google Ads من المهمة');
  await expect(create.getByRole('textbox', { name: /ما الصفحة التي تريد فتحها/ })).toHaveValue(goal);
  await expect(create.getByRole('status', { name: 'وجهة فتح الصفحة' })).toContainText('https://ads.google.com/home/');
  await expect(create.getByRole('status', { name: 'وجهة فتح الصفحة' })).toContainText('https://consent.google.com');
  await expect(create.getByRole('status', { name: 'وجهة فتح الصفحة' })).toContainText('https://www.gstatic.com');
  await expect(create.getByRole('status', { name: 'وجهة فتح الصفحة' })).toContainText('تسجيل الدخول وإرسال النماذج وتعديل الحسابات تحتاج إجراءات منفصلة');

  // Existing planning drafts remain independent from the inferred browser request.
  await create.getByLabel('القدرة المطلوبة').selectOption('plan.draft');
  await expect(create.getByRole('textbox', { name: /ما الهدف الذي تريد التخطيط له/ })).toHaveValue('');
  await create.getByLabel('القدرة المطلوبة').selectOption('system.diagnostic');
  await expect(create.getByRole('textbox', { name: /ما الصفحة التي تريد فتحها/ })).toHaveValue(goal);
  await create.getByRole('radio', { name: /^اقتراح فقط/ }).check();
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await create.getByRole('button', { name: 'إنشاء المهمة', exact: true }).click();
  const response = await createdResponse;
  expect(response.ok()).toBe(true);
  const shadow = TaskSchema.parse(await response.json());
  expect(shadow).toMatchObject({ capabilityId: 'browser.open', autonomy: 'shadow', goal, browserInput: { url: 'https://ads.google.com/home/', allowedOrigins: ['https://ads.google.com', 'https://consent.google.com', 'https://www.gstatic.com', 'https://business.google.com'] } });
  await expect(detail.getByText('اكتمل الاقتراح', { exact: true })).toBeVisible();
  await expect(detail.locator('.shadow-notice')).toHaveText('وضع الاقتراح: لم تُفتح الصفحة ولم تُلتقط صورة لها.');
  await expect(detail.getByRole('region', { name: 'نتيجة فتح الصفحة' })).toHaveCount(0);
  const shadowDetail = await page.request.get(`/api/tasks/${shadow.id}`);
  expect((await shadowDetail.json()).task.result).toMatchObject({ kind: 'shadow', capabilityId: 'browser.open', executed: false });
  await detail.getByRole('button', { name: 'إغلاق التفاصيل' }).click();

  const rejected = await page.request.post('/api/tasks', {
    headers: { origin: new URL(page.url()).origin, 'idempotency-key': crypto.randomUUID() },
    data: { title: 'لا يجوز اعتبار التشخيص فتحًا للصفحة', goal, capabilityId: 'system.diagnostic', autonomy: 'scoped' },
  });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error.code).toBe('CAPABILITY_GOAL_MISMATCH');

  await page.getByRole('button', { name: 'مهمة جديدة', exact: true }).click();
  await create.getByRole('radio', { name: /^بموافقتك/ }).check();
  const assistedResponse = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await create.getByRole('button', { name: 'إنشاء المهمة', exact: true }).click();
  const assisted = TaskSchema.parse(await (await assistedResponse).json());
  expect(assisted).toMatchObject({ capabilityId: 'browser.open', status: 'waiting_approval', autonomy: 'assisted' });
  await expect(detail.locator('.approval-box')).toContainText('فتح العنوان المحدد وقراءة الصفحة');
  await expect(detail.locator('.approval-box')).toContainText('تسجيل الدخول والإرسال وتعديل الحسابات تحتاج إجراءات منفصلة');
  await detail.getByRole('button', { name: 'إلغاء المهمة', exact: true }).click();
  await expect(detail.getByText('ملغاة', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'إغلاق التفاصيل' }).click();

  await page.getByRole('button', { name: 'مهمة جديدة', exact: true }).click();
  await create.getByLabel('القدرة المطلوبة').selectOption('plan.draft');
  await create.getByLabel('القدرة المطلوبة').selectOption('browser.open');
  await expect(create.getByRole('button', { name: 'إنشاء المهمة', exact: true })).toBeDisabled();
  await create.getByRole('textbox', { name: /^عنوان الصفحة/ }).fill('https://example.com/');
  await create.getByRole('radio', { name: /^اقتراح فقط/ }).check();
  const explicitResponse = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await create.getByRole('button', { name: 'إنشاء المهمة', exact: true }).click();
  expect(TaskSchema.parse(await (await explicitResponse).json())).toMatchObject({ capabilityId: 'browser.open', autonomy: 'shadow', browserInput: { url: 'https://example.com/', allowedOrigins: ['https://example.com'] } });
  await expect(detail.locator('.shadow-notice')).toHaveText('وضع الاقتراح: لم تُفتح الصفحة ولم تُلتقط صورة لها.');
  const after = await page.request.get('/api/browser/workspace');
  expect((await after.json()).sessions.map((session: { id: string }) => session.id).sort()).toEqual(sessionIds);
  expect(errors).toEqual([]);
});
