import { expect, test, type Page } from '@playwright/test';
import { MemberExportTooLarge } from '../../apps/server/src/member-data-zip';
import { signInAsFixtureOwner, submitFixtureSignIn } from './helpers';

const email = 'rights-e2e@example.test';
const name = 'عضو حقوق البيانات';
const password = 'Data-Rights-Fixture-Password-42';

async function signInMember(page: Page) {
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await submitFixtureSignIn(page);
}

async function openMemberData(page: Page) {
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name }).click();
  await page.getByRole('button', { name: 'الأدوات المتقدمة' }).click();
  await page.locator('summary').filter({ hasText: 'بياناتي' }).click();
  await expect(page.getByRole('heading', { name: 'الجلسات النشطة' })).toBeVisible();
}

async function requestDeletion(page: Page) {
  await page.getByRole('button', { name: 'طلب حذف الحساب', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'تأكيد طلب حذف الحساب' });
  await confirmation.getByLabel('كلمة المرور الحالية').fill(password);
  await confirmation.getByRole('button', { name: 'تأكيد طلب الحذف' }).click();
  await expect(page.getByRole('heading', { name: 'طلب حذف الحساب', exact: true })).toBeVisible();
}

test('handles exports, sessions and the deletion grace period in the Arabic account views', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signInAsFixtureOwner(page);
  const origin = new URL(page.url()).origin;
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الأعضاء' }).click();
  await expect(page.getByRole('heading', { name: 'سجل الأعضاء' })).toBeVisible();
  await expect(page.getByText('لا توجد طلبات حذف معلّقة.')).toBeVisible();
  await page.locator('summary').filter({ hasText: 'بياناتي' }).click();
  await expect(page.getByRole('button', { name: 'تنزيل نسخة ZIP' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'طلب حذف الحساب', exact: true })).toHaveCount(0);

  const invited = await page.request.post('/api/members/invites', { headers: { origin }, data: { name, email } });
  expect(invited.ok()).toBe(true);
  const { url } = await invited.json();
  const token = new URL(url).hash.slice('#invite='.length);

  const memberContext = await browser.newContext({ baseURL: origin });
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const accepted = await memberContext.request.post('/api/invites/accept', { headers: { origin }, data: { token, password, name } });
    expect(accepted.ok()).toBe(true);
    const member = await memberContext.newPage();
    const other = await otherContext.newPage();
    await member.goto('/');
    await signInMember(member);
    await other.goto('/');
    await signInMember(other);
    await openMemberData(member);
    await expect(member.getByText('الجلسة الحالية', { exact: true })).toBeVisible();
    await expect(member.getByText('بادئة عنوان IP', { exact: false }).nth(1)).toBeVisible();

    await member.getByRole('button', { name: 'إنهاء الجلسات الأخرى' }).click();
    await member.getByRole('dialog').getByRole('button', { name: 'رجوع' }).click();
    await expect(member.getByRole('button', { name: 'إنهاء الجلسات الأخرى' })).toBeVisible();
    await member.getByRole('button', { name: 'إنهاء الجلسات الأخرى' }).click();
    await member.getByRole('dialog').getByRole('button', { name: 'تأكيد إنهاء الجلسات' }).click();
    await expect(member.getByText('أُنهيت الجلسات الأخرى.')).toBeVisible();
    await expect(member.getByRole('button', { name: 'إنهاء الجلسات الأخرى' })).toHaveCount(0);
    await expect(member.getByText('بادئة عنوان IP', { exact: false })).toHaveCount(1);
    expect(await (await otherContext.request.get('/api/auth/get-session')).json()).toBeNull();

    const crossSite = await memberContext.request.get('/api/member-data/export', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status()).toBe(403);
    const downloadButton = member.getByRole('button', { name: 'تنزيل نسخة ZIP' });
    const dataOnlyButton = member.getByRole('button', { name: 'تنزيل البيانات بدون محتوى الملفات' });
    await expect(dataOnlyButton).toHaveCount(0);
    const tooLarge = new MemberExportTooLarge();
    await member.route(url => url.pathname === '/api/member-data/export' && !url.search, route => route.fulfill({
      status: tooLarge.statusCode, json: { error: { code: tooLarge.code, message: tooLarge.message } },
    }), { times: 1 });
    await downloadButton.click();
    await expect(member.getByRole('alert').filter({ hasText: tooLarge.message })).toBeVisible();
    await expect(dataOnlyButton).toBeEnabled();
    const downloaded = member.waitForEvent('download');
    const exported = member.waitForResponse(response => new URL(response.url()).pathname === '/api/member-data/export');
    await dataOnlyButton.click();
    const result = await exported;
    expect(new URL(result.url()).search).toBe('?files=omit');
    expect(result.status()).toBe(200);
    const archive = await downloaded;
    expect(archive.suggestedFilename()).toBe('mohassan-data.zip');
    expect(await archive.failure()).toBeNull();
    await expect(member.getByText('بدأ تنزيل ملف بياناتك.')).toBeVisible();
    const limited = member.waitForResponse(response => response.url().endsWith('/api/member-data/export'));
    await downloadButton.click();
    const rejection = await limited;
    expect(rejection.status()).toBe(429);
    await expect(member.getByRole('alert').filter({ hasText: (await rejection.json()).error.message })).toBeVisible();

    await requestDeletion(member);
    await expect(member.getByText(/المهلة المتبقية/)).toBeVisible();
    expect(await (await memberContext.request.get('/api/auth/get-session')).json()).toBeNull();
    const requests = page.getByRole('region', { name: 'طلبات حذف الحسابات' });
    await requests.getByRole('button', { name: 'تحديث طلبات الحذف' }).click();
    await expect(requests.getByText(email, { exact: true })).toBeVisible();

    await member.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await signInMember(member);
    await expect(member.getByRole('heading', { name: 'طلب حذف الحساب', exact: true })).toBeVisible();
    await member.getByRole('button', { name: 'إلغاء طلب الحذف', exact: true }).click();
    await member.getByRole('dialog').getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await expect(member.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();

    await page.getByRole('button', { name: 'تحديث سجل الأعضاء' }).click();
    const log = page.getByRole('table');
    for (const action of ['إنشاء دعوة', 'استخدام دعوة', 'تنزيل نسخة البيانات', 'طلب حذف حساب', 'إلغاء طلب حذف']) {
      await expect(log.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
    }
    await page.reload();
    await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الأعضاء' }).click();
    const memberSessions = page.locator('details').filter({ has: page.getByRole('heading', { name: 'جلسات الأعضاء' }) });
    await memberSessions.locator('summary').click();
    await memberSessions.getByRole('listitem').filter({ hasText: email }).getByRole('button', { name: 'إنهاء جلسات العضو' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'تأكيد إنهاء الجلسات' }).click();
    await expect(page.getByText('أُنهيت جلسات العضو.')).toBeVisible();
    expect(await (await memberContext.request.get('/api/auth/get-session')).json()).toBeNull();

    const members = page.locator('section').filter({ has: page.getByRole('heading', { name: 'الأعضاء', exact: true, level: 2 }) });
    const row = members.getByRole('listitem').filter({ hasText: email });
    await row.getByRole('button', { name: 'إيقاف', exact: true }).click();
    await expect(row.getByRole('button', { name: 'إعادة التفعيل' })).toBeVisible();
    await member.reload();
    await signInMember(member);
    await expect(member.getByRole('heading', { name: 'حسابك موقوف', exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: 'تنزيل نسخة ZIP' })).toBeVisible();
    await expect(member.getByRole('navigation', { name: 'المحادثات' })).toHaveCount(0);

    await requestDeletion(member);
    await requests.getByRole('button', { name: 'تحديث طلبات الحذف' }).click();
    await requests.getByRole('listitem').filter({ hasText: email }).getByRole('button', { name: 'إلغاء طلب الحذف' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await expect(requests.getByText('أُلغي طلب حذف الحساب.')).toBeVisible();
    await expect(requests.getByText('لا توجد طلبات حذف معلّقة.')).toBeVisible();
  } finally {
    await Promise.all([memberContext.close(), otherContext.close()]);
  }
});
