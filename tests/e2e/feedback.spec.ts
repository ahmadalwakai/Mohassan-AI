import { expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

async function sendCalculation(page: Page) {
  await page.getByRole('textbox', { name: 'رسالتك' }).fill('احسب ٢ + ٢');
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  await expect(page.getByRole('log').getByRole('button', { name: 'نسخ الرد' })).toBeVisible();
}

test('answer feedback keeps the existing owner submission and hides it for members', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signInAsFixtureOwner(page, 'assistant');
  await sendCalculation(page);
  const rating = page.getByRole('group', { name: 'تقييم الرد' });
  const saved = page.waitForResponse(response => response.request().method() === 'POST'
    && /^\/api\/chat\/conversations\/[^/]+\/feedback$/.test(new URL(response.url()).pathname));
  await rating.getByRole('button', { name: 'مفيد', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'مالك الاختبار' }).click();
  await expect(page.getByRole('button', { name: 'ملاحظات الإجابات' })).toHaveCount(0);

  const memberName = 'عضو اختبار الملاحظات';
  const invite = await page.request.post('/api/members/invites', {
    headers: { origin: new URL(page.url()).origin },
    data: { name: memberName, email: 'feedback-member@example.test' },
  });
  expect(invite.ok()).toBe(true);
  const { url } = await invite.json();
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await member.goto(`/${new URL(url).hash}`);
    await expect(member.getByRole('heading', { name: 'انضم إلى موحسن' })).toBeVisible();
    await member.getByLabel('كلمة المرور', { exact: true }).fill('Feedback-Member-Test-42');
    await member.getByLabel('تأكيد كلمة المرور').fill('Feedback-Member-Test-42');
    await member.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await expect(member.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
    expect((await (await member.request.get('/api/access')).json()).role).toBe('member');
    await sendCalculation(member);
    await expect(member.getByRole('group', { name: 'تقييم الرد' })).toHaveCount(0);
    await member.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: memberName }).click();
    await expect(member.getByRole('button', { name: 'ملاحظات الإجابات' })).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});
