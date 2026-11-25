import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test('reviews a chat rating in Arabic and explicitly allows its frozen case for training', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsFixtureOwner(page, 'assistant');

  const question = 'احسب ٢ + ٢';
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(question);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  const rating = page.getByRole('group', { name: 'تقييم الرد' });
  await rating.getByRole('button', { name: 'خطأ', exact: true }).click();
  const note = 'أعدت الحساب يدويًا.';
  await rating.getByPlaceholder('ما الذي كان خطأ أو ناقصًا؟ (اختياري)').fill(note);
  const saved = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/feedback'));
  await rating.getByRole('button', { name: 'حفظ', exact: true }).click();
  expect((await saved).ok()).toBe(true);

  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'مالك الاختبار' }).click();
  await page.getByRole('button', { name: 'ملاحظات الإجابات' }).click();
  await expect(page.getByRole('heading', { name: 'ملاحظات الإجابات' })).toBeVisible();
  const card = page.getByRole('article', { name: question });
  await expect(card.getByText(note)).toBeVisible();
  await expect(card.getByText('لا توجد صفحات استند إليها الرد.')).toBeVisible();
  const choices = card.getByRole('group', { name: 'راجع الإجابة' });
  await expect(choices.getByRole('button', { name: 'خطأ', exact: true })).toBeVisible();
  await expect(choices.getByRole('button', { name: 'غير متأكد' })).toBeVisible();
  await choices.getByRole('button', { name: 'صحيح', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'تمت مراجعتها للتو' })).toBeVisible();
  await expect(card.getByText('هذه الحالة مخصصة للاختبار فقط.')).toBeVisible();
  await expect(card.locator('code')).toHaveText(/^[a-f0-9]{64}$/u);
  await card.getByRole('button', { name: 'السماح بالتدريب على هذه الحالة' }).click();
  await expect(card.getByText('هذه الحالة مسموحة للتدريب.')).toBeVisible();
  await card.getByRole('button', { name: 'إلغاء السماح بالتدريب' }).click();
  await expect(card.getByText('هذه الحالة مخصصة للاختبار فقط.')).toBeVisible();
});
