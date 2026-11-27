import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner, submitFixtureSignIn } from './helpers';

test('uses the Arabic password change and one-time reset forms', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const email = 'account-recovery-e2e@example.test';
  const name = 'عضو استعادة الحساب';
  const initialPassword = 'Account-Recovery-Initial-42';
  const changedPassword = 'Account-Recovery-Changed-42';
  const resetPassword = 'Account-Recovery-Reset-42';

  await signInAsFixtureOwner(page);
  const origin = new URL(page.url()).origin;
  const invite = await page.request.post('/api/members/invites', { headers: { origin }, data: { name, email } });
  expect(invite.ok()).toBe(true);
  const { url } = await invite.json();
  const token = new URL(url).hash.slice('#invite='.length);

  const context = await browser.newContext({ baseURL: origin });
  try {
    const accepted = await context.request.post('/api/invites/accept', { headers: { origin }, data: { token, password: initialPassword, name } });
    expect(accepted.ok()).toBe(true);
    const member = await context.newPage();
    await member.goto('/');
    await member.getByLabel('البريد الإلكتروني').fill(email);
    await member.getByLabel('كلمة المرور', { exact: true }).fill(initialPassword);
    await submitFixtureSignIn(member);
    await member.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name }).click();
    await member.getByRole('button', { name: 'الأدوات المتقدمة' }).click();
    await member.locator('summary').filter({ hasText: 'بياناتي' }).click();
    const change = member.getByRole('button', { name: 'حفظ كلمة المرور', exact: true });
    await member.getByLabel('كلمة المرور الحالية', { exact: true }).fill(initialPassword);
    await member.getByLabel('كلمة المرور الجديدة', { exact: true }).fill(changedPassword);
    await member.getByLabel('تأكيد كلمة المرور الجديدة', { exact: true }).fill(initialPassword);
    await change.click();
    await expect(member.getByRole('alert').filter({ hasText: 'كلمتا المرور غير متطابقتين.' })).toBeVisible();
    await member.getByLabel('تأكيد كلمة المرور الجديدة', { exact: true }).fill(changedPassword);
    await change.click();
    await expect(member.getByText('تغيّرت كلمة المرور وأُنهيت الجلسات الأخرى.')).toBeVisible();
    await expect(member.getByLabel('كلمة المرور الحالية', { exact: true })).toHaveValue('');

    await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الأعضاء' }).click();
    const members = page.locator('section').filter({ has: page.getByRole('heading', { name: 'الأعضاء', exact: true, level: 2 }) });
    await members.getByRole('listitem').filter({ hasText: email }).getByRole('button', { name: 'إصدار رابط إعادة تعيين كلمة المرور' }).click();
    await page.getByRole('dialog', { name: 'إصدار رابط إعادة تعيين كلمة المرور' }).getByRole('button', { name: 'إصدار الرابط' }).click();
    await expect(members.getByText('أُنشئ رابط إعادة التعيين.', { exact: false })).toBeVisible();
    const resetLink = await members.locator('code').innerText();
    expect(new URL(resetLink).hash.startsWith('#reset=')).toBe(true);

    await member.goto(resetLink);
    await expect(member.getByRole('heading', { name: 'إعادة تعيين كلمة المرور' })).toBeVisible();
    const save = member.getByRole('button', { name: 'تعيين كلمة المرور', exact: true });
    await save.click();
    await expect(member.getByRole('alert').filter({ hasText: 'تحقق من طول كلمة المرور الجديدة.' })).toBeVisible();
    await member.getByLabel('كلمة المرور الجديدة', { exact: true }).fill(resetPassword);
    await member.getByLabel('تأكيد كلمة المرور الجديدة', { exact: true }).fill(resetPassword);
    await save.click();
    await expect(member.getByText('عُيّنت كلمة المرور الجديدة وأُنهيت جميع جلسات الحساب.')).toBeVisible();
    await member.getByRole('button', { name: 'متابعة', exact: true }).click();
    await expect(member.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
    expect(new URL(member.url()).hash).toBe('');

    await member.goto(resetLink);
    await expect(member.getByRole('alert')).toBeVisible();
    await expect(save).toHaveCount(0);
    await member.getByRole('button', { name: 'رجوع', exact: true }).click();
    await member.getByLabel('البريد الإلكتروني').fill(email);
    await member.getByLabel('كلمة المرور', { exact: true }).fill(resetPassword);
    await submitFixtureSignIn(member);
    await expect(member.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
  } finally {
    await context.close();
  }
});
