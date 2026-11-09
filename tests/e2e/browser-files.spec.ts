import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test('owner reviews an upload grant and releases a verified download from quarantine', async ({ page }) => {
  test.setTimeout(150000);
  const writes: string[] = [];
  const fixture = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/upload' && request.method === 'POST') { writes.push(body); response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Transport received'); return; }
      if (request.url === '/download') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="fixture.txt"' }); response.end('محتوى التنزيل التجريبي'); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>File transfer</title><main><h1>File transfer fixture ready</h1><form method=post action=/upload enctype=multipart/form-data><label>Owner document<input type=file name=document></label><input type=hidden name=csrf value=fixture-token><button>Upload</button></form><a href=/download>Download fixture</a></main>');
    });
  });
  await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve); });
  try {
    await signInAsFixtureOwner(page, 'assistant');
    await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
    await page.getByRole('textbox', { name: 'رسالتك' }).fill('افتح صفحة نقل الملفات التجريبية');
    await page.getByRole('textbox', { name: 'رسالتك' }).press('Enter');
    await expect(page.getByRole('log').getByText('صفحة الملفات جاهزة للمراجعة.')).toBeVisible({ timeout: 45000 });
    const panel = page.getByRole('complementary', { name: 'المتصفح' }).locator('details').filter({ has: page.locator('summary').getByText('نقل الملفات بإذنك', { exact: true }) });
    await panel.locator('summary').first().click();
    await expect(panel.getByLabel('موضع الرفع')).toContainText('Owner document');
    await panel.getByLabel('موضع الرفع').selectOption({ label: 'Owner document' });
    await panel.getByLabel('الملف من جهازك').setInputFiles({ name: 'دليل.txt', mimeType: 'text/plain', buffer: Buffer.from('ملف المالك عبر الواجهة') });
    await panel.getByRole('button', { name: 'مراجعة منحة الرفع', exact: true }).click();
    const upload = panel.getByRole('article').filter({ hasText: 'رفع: دليل.txt' });
    await expect(upload).toContainText('بانتظار موافقتك'); expect(writes).toHaveLength(0);
    await expect(upload).toContainText('http://127.0.0.1:4201/upload');
    await upload.scrollIntoViewIfNeeded();
    await upload.screenshot({ path: 'artifacts/browser-files-grant-desktop.png', animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await upload.scrollIntoViewIfNeeded();
    await expect(upload.getByRole('button', { name: 'أوافق على إرسال الملف مرة واحدة', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await upload.screenshot({ path: 'artifacts/browser-files-grant-mobile.png', animations: 'disabled' });
    await page.screenshot({ path: 'artifacts/browser-files-review-mobile.png', animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await upload.getByRole('button', { name: 'أوافق على إرسال الملف مرة واحدة', exact: true }).click();
    await expect(upload).toContainText('وصل رد الموقع'); expect(writes).toHaveLength(1); expect(writes[0]).toContain('ملف المالك عبر الواجهة'); expect(writes[0]).toContain('fixture-token');
    await expect(upload.getByRole('button', { name: 'أوافق على إرسال الملف مرة واحدة', exact: true })).toHaveCount(0);
    await panel.getByLabel('الرابط المرصود').selectOption({ label: 'Download fixture' });
    await panel.getByRole('button', { name: 'مراجعة منحة التنزيل', exact: true }).click();
    await panel.getByRole('button', { name: 'أوافق على التنزيل إلى الحجر', exact: true }).click();
    await expect(panel.getByText('في الحجر بعد فحص النوع والحجم', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'حفظ على جهازي' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'تحرير الملف المفحوص', exact: true }).click();
    const downloaded = page.waitForEvent('download'); await panel.getByRole('link', { name: 'حفظ على جهازي', exact: true }).click();
    const file = await downloaded; expect(file.suggestedFilename()).toMatch(/^download-.*\.txt$/);
    expect(await readFile((await file.path())!, 'utf8')).toBe('محتوى التنزيل التجريبي');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.evaluate(node => { node.scrollTop = 0; });
    await panel.screenshot({ path: 'artifacts/browser-files-mobile.png', animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.evaluate(node => { node.scrollTop = 0; });
    await panel.screenshot({ path: 'artifacts/browser-files-desktop.png', animations: 'disabled' });
  } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
