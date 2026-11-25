import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test('an owner can inspect the decision behind a completed direct answer with no tool steps', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsFixtureOwner(page, 'assistant');
  const box = page.getByRole('textbox', { name: 'رسالتك' });
  await box.fill('مرحبا');
  await box.press('Enter');
  await expect(page.getByRole('log').getByText('مرحبًا! كيف أساعدك؟')).toBeVisible();
  await page.getByTestId('run-details-toggle').click();
  const decision = page.getByTestId('run-deliberation');
  await expect(decision).toBeVisible();
  await expect(decision).toContainText('وضع المراقبة');
  await expect(decision).toContainText('المسار المعتاد المقدّر');
  await decision.getByText('المسارات المرشّحة').click();
  await expect(decision.getByRole('listitem').filter({ hasText: 'local_conversation' })).toBeVisible();
  await expect(decision).toContainText('مراجعة الجواب');
});
