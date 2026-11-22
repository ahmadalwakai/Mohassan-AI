import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { listZip } from '../../packages/sites/src/zip.ts';
import { signInAsFixtureOwner } from './helpers';

/**
 * The owner builds a website from the Sites view with no model: the form, a sandboxed preview that loads its own
 * stylesheet without a session cookie, the three device widths, a plain-language edit, a content question and a ZIP.
 */
test('the owner builds, previews, edits and downloads a website without a model', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signInAsFixtureOwner(page);
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'المواقع' }).click();
  await expect(page.getByRole('heading', { name: /المواقع/ })).toBeVisible();

  await page.getByRole('button', { name: 'موقع جديد' }).click();
  await page.getByLabel('الاسم كما يظهر في الموقع').fill('لمعة للتنظيف');
  await page.getByLabel(/ماذا تقدّم؟/).fill('تنظيف المنازل - 250 ريال\nتنظيف السجاد - 150 ريال\nتعقيم وتطهير');
  await page.getByLabel(/^التواصل/).fill('0501234567 واتساب\ninfo@lamaa.example');
  await page.getByLabel(/أقسام إضافية/).fill('أسئلة شائعة ونموذج تواصل');
  const created = page.waitForResponse(response => response.url().endsWith('/api/sites/draft') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'إنشاء الموقع' }).click();
  expect((await created).ok()).toBe(true);

  const frameElement = page.locator('iframe[title="معاينة لمعة للتنظيف"]');
  await expect(frameElement).toBeVisible();
  const preview = page.frameLocator('iframe[title="معاينة لمعة للتنظيف"]');
  await expect(preview.locator('h1')).toContainText('لمعة');
  await expect(preview.getByText('تنظيف المنازل')).toBeVisible();
  // The stylesheet loaded inside the sandboxed frame (no cookie): the header is sticky only through styles.css.
  expect(await preview.locator('.site-header').evaluate(element => getComputedStyle(element).position)).toBe('sticky');
  await page.screenshot({ path: testInfo.outputPath('sites-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'هاتف' }).click();
  await expect(frameElement).toHaveAttribute('style', /width: 375px/);
  await expect(preview.getByRole('button', { name: 'القائمة' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sites-phone.png'), fullPage: true });

  await page.getByLabel('أمر التعديل').fill('غيّر اللون إلى أزرق');
  await page.getByRole('button', { name: 'نفّذ', exact: true }).click();
  await expect(page.getByText('غيّرت اللون الأساسي إلى أزرق.')).toBeVisible();

  await page.getByLabel('أمر التعديل').fill('أضف قسم الفريق');
  await page.getByRole('button', { name: 'نفّذ', exact: true }).click();
  const answer = page.getByLabel('محتوى أعضاء الفريق');
  await expect(answer).toBeVisible();
  await answer.fill('أبو فهد - مشرف الفرق\nسالم - فني تعقيم');
  await page.getByRole('button', { name: 'أضف', exact: true }).click();
  await expect(preview.getByText('أبو فهد')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /تنزيل ZIP/ }).click()]);
  const archive = await download.path();
  expect(archive).toBeTruthy();
  const entries = listZip(await readFile(archive!));
  expect(entries.map(entry => entry.path)).toEqual(expect.arrayContaining(['index.html', 'contact.html', 'styles.css', 'site.js', 'assets/logo.svg', '404.html']));
});
