import { test, expect } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test('provider settings are reachable, accessible and fit a 360px screen', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await signInAsFixtureOwner(page, 'overview');
  await page.getByRole('button', { name: 'الاتصالات', exact: true }).click();
  const panel = page.getByRole('region', { name: 'مزودو النماذج و FreeLLMAPI' });
  await expect(panel).toBeVisible();
  // The isolated fixture has no FreeLLMAPI key: the panel must say so and keep the toggle off.
  const enable = panel.getByRole('switch', { name: 'تفعيل FreeLLMAPI للمساعد' });
  await expect(enable).toBeDisabled();
  await expect(enable).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByText('غير متاح', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'فحص الاتصال والنماذج' })).toBeDisabled();

  const freeOnly = panel.getByRole('switch', { name: 'المجاني فقط' });
  await expect(freeOnly).toHaveAttribute('aria-checked', 'true');
  await freeOnly.click();
  await expect(freeOnly).toHaveAttribute('aria-checked', 'false');
  await panel.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(panel.getByRole('status')).toContainText('حُفظت الإعدادات');
  await page.reload();
  await page.getByRole('button', { name: 'الاتصالات', exact: true }).click();
  await expect(page.getByRole('region', { name: 'مزودو النماذج و FreeLLMAPI' }).getByRole('switch', { name: 'المجاني فقط' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('region', { name: 'مزودو النماذج و FreeLLMAPI' }).getByRole('switch', { name: 'المجاني فقط' }).click();
  await page.getByRole('region', { name: 'مزودو النماذج و FreeLLMAPI' }).getByRole('button', { name: 'حفظ الإعدادات' }).click();

  await page.setViewportSize({ width: 360, height: 780 });
  const region = page.getByRole('region', { name: 'مزودو النماذج و FreeLLMAPI' });
  await region.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await region.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  await region.screenshot({ path: test.info().outputPath('providers-360.png') });
  expect(browserErrors).toEqual([]);
});
