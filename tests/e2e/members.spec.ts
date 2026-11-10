import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

/** The owner invites someone; that person joins from the link and sees chat plus their own Google Ads only. */
test('an invited member joins from a one-time link and reaches only cloud services', async ({ page, browser }, testInfo) => {
  await signInAsFixtureOwner(page);
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الأعضاء' }).click();
  await page.getByLabel('الاسم', { exact: true }).fill('عضو الاختبار');
  await page.getByLabel('البريد الإلكتروني').fill('member-e2e@example.test');
  await page.getByRole('button', { name: 'إنشاء رابط دعوة' }).click();
  const link = (await page.locator('code').filter({ hasText: '#invite=' }).textContent())?.trim() ?? '';
  expect(link).toMatch(/#invite=[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText('دعوات لم تُستخدم')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('owner-members.png'), fullPage: true });

  const guest = await browser.newContext();
  try {
    const member = await guest.newPage();
    await member.goto(new URL(link).hash ? `/${new URL(link).hash}` : link);
    await expect(member.getByRole('heading', { name: 'انضم إلى موحسن' })).toBeVisible();
    await expect(member.getByText('member-e2e@example.test')).toBeVisible();
    await member.getByLabel('كلمة المرور', { exact: true }).fill('Member-E2E-Fixture-Password-42');
    await member.getByLabel('تأكيد كلمة المرور').fill('Member-E2E-Fixture-Password-42');
    await member.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await expect(member.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
    expect(new URL(member.url()).hash).toBe('');

    const access = await (await member.request.get('/api/access')).json();
    expect(access.role).toBe('member');
    expect((await member.request.get('/api/workspace')).status()).toBe(403);
    expect((await member.request.get('/api/coding/projects')).status()).toBe(403);

    await member.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'عضو الاختبار' }).click();
    await member.getByRole('button', { name: 'الأدوات المتقدمة' }).click();
    await expect(member.getByRole('heading', { name: 'Google Ads' })).toBeVisible();
    await expect(member.getByText(/خلال 24 ساعة/)).toBeVisible();
    await expect(member.getByRole('button', { name: 'مشاريع البرمجة' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'التحكم بالكمبيوتر' })).toHaveCount(0);
    await member.screenshot({ path: testInfo.outputPath('member-tools.png'), fullPage: true });
    await member.getByRole('button', { name: /العودة إلى المحادثة/ }).click();
    await expect(member.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
    await member.screenshot({ path: testInfo.outputPath('member-chat.png'), fullPage: true });

    // The same link cannot make a second account.
    const reused = await guest.newPage();
    await reused.goto(`/${new URL(link).hash}`);
    await expect(reused.getByText('رابط الدعوة غير صالح أو انتهت مدته')).toBeVisible();
  } finally { await guest.close(); }

  await page.reload();
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الأعضاء' }).click();
  await expect(page.getByText('member-e2e@example.test')).toBeVisible();
  await expect(page.getByText('دعوات لم تُستخدم')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('owner-members-after.png'), fullPage: true });
});
