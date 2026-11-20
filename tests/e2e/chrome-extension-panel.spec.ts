import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

const now = '2026-11-15T10:00:00.000Z';
const clientId = '11111111-2222-4333-8444-111111111111';
const jobId = '11111111-2222-4333-8444-222222222222';
const campaign = {
  campaignName: 'Mobile tyres Leeds', type: 'search', goal: 'calls', customerId: '1234567890', currency: 'GBP', dailyBudget: '20',
  locations: ['Leeds'], countryCode: 'GB', adLanguage: 'en', keywords: ['mobile tyres'], negativeKeywords: [],
  headlines: ['Mobile Tyres Leeds', 'Local Tyre Fitting', 'Tyres At Your Door'], descriptions: ['Mobile tyre fitting in Leeds.', 'Local tyre fitting at your door.'], finalUrl: 'https://example.org/', paths: [],
};

test('Chrome choice persists before pairing; queued and running work can be stopped without claiming publication', async ({ page }, testInfo) => {
  let status: Record<string, unknown> = { connected: false, binding: null, lastSeenAt: null, latestJob: null, preferredTransport: 'api' };
  const mutations: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/chrome-extension/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      mutations.push({ path, body });
      if (path.endsWith('/preference')) status = { ...status, preferredTransport: body.transport };
      if (path.endsWith('/cancel')) status = { ...status, latestJob: { ...(status.latestJob as object), status: 'needs_attention', message: 'طُلب الإيقاف. راجع القيم في التبويب قبل إعادة المحاولة.' } };
      if (path.endsWith('/resume')) status = { ...status, latestJob: { ...(status.latestJob as object), status: 'queued', leaseId: null, message: 'بانتظار استئناف المهمة نفسها بعد مراجعتك.' } };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: status });
  });
  await signInAsFixtureOwner(page, 'assistant');
  const panel = page.getByRole('region', { name: 'إضافة Chrome', exact: true });
  await panel.getByRole('button', { name: /Chrome غير متصل/ }).click();
  await panel.getByRole('button', { name: 'إضافة Chrome', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'إضافة Chrome', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByText('بانتظار الربط', { exact: true })).toBeVisible();
  expect(mutations[0]).toEqual({ path: '/api/chrome-extension/preference', body: { transport: 'chrome' } });

  status = { ...status, connected: true, binding: { clientId, tabId: 12, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0' }, lastSeenAt: now,
    latestJob: { id: jobId, clientId, tabId: 12, customerId: '1234567890', currency: 'GBP', leaseId: clientId, status: 'running', campaign, message: 'تجري تعبئة حقول الحملة.', steps: [{ stage: 'budget', message: 'قُرئت الميزانية بعد تعبئتها.', fields: ['dailyBudget'] }], createdAt: now, updatedAt: now } };
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await expect(panel.getByText('123-456-7890', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('يملأ الحملة في Chrome');
  await expect(panel.getByRole('button', { name: 'الربط الرسمي', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'إيقاف التعبئة' }).click();
  await expect(panel.getByRole('status')).toHaveText('يحتاج مراجعتك');
  await expect(panel.getByText('راجع الصفحة الحالية في تبويب Google Ads أولاً؛ قد تكون بعض الحقول عُبئت قبل التوقف. أكمل الخطوة التي تحتاجك، ثم استأنف التعبئة من هنا.')).toBeVisible();
  expect(mutations.at(-1)).toEqual({ path: `/api/chrome-extension/jobs/${jobId}/cancel`, body: {} });
  await page.screenshot({ path: testInfo.outputPath('chrome-panel-needs-attention.png'), fullPage: true });
  const mutationCount = mutations.length;
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await expect(panel.getByRole('button', { name: 'راجعت الخطوة، أكمل التعبئة' })).toBeVisible();
  expect(mutations).toHaveLength(mutationCount);
  status = { ...status, connected: false };
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await expect(panel.getByRole('button', { name: 'راجعت الخطوة، أكمل التعبئة' })).toHaveCount(0);
  status = { ...status, connected: true, binding: { ...(status.binding as object), customerId: '9999999999' } };
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await expect(panel.getByText('999-999-9999', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'راجعت الخطوة، أكمل التعبئة' })).toHaveCount(0);
  status = { ...status, binding: { ...(status.binding as object), customerId: '1234567890' } };
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await panel.getByRole('button', { name: 'راجعت الخطوة، أكمل التعبئة' }).click();
  await expect(panel.getByRole('status')).toHaveText('بانتظار الإضافة');
  expect(mutations.at(-1)).toEqual({ path: `/api/chrome-extension/jobs/${jobId}/resume`, body: { clientId } });
});

test('Chrome instructions remain usable in a narrow window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.route('**/api/chrome-extension/status', route => route.fulfill({ json: { connected: false, binding: null, lastSeenAt: null, latestJob: null, preferredTransport: 'chrome' } }));
  await signInAsFixtureOwner(page, 'assistant');
  const panel = page.getByRole('region', { name: 'إضافة Chrome', exact: true });
  await panel.getByRole('button', { name: /Chrome بانتظار الربط/ }).click();
  await expect(panel.getByText('chrome://extensions', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'رسالتك' })).toBeInViewport();
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({ path: testInfo.outputPath('chrome-panel-narrow.png'), fullPage: true });
});
