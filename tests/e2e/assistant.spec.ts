import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { openAdvancedTools, signInAsFixtureOwner } from './helpers';

const PASSWORD = 'fixture-site-pass-7741';
const CODE = '551204';

/** A small site on the origin the test server allows: sign-in, then a code, then an account page. */
function startSite() {
  const state = { deleted: false, deleteRequests: 0 };
  const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site');
    const signedIn = request.headers.cookie?.includes('session=ok');
    const html = (content: string) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(content); };
    const go = (location: string, cookie?: string) => { response.writeHead(303, { location, ...(cookie ? { 'set-cookie': cookie } : {}) }); response.end(); };
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      if (url.pathname === '/login' && request.method === 'POST') return form.get('password') === PASSWORD ? go('/verify') : go('/login');
      if (url.pathname === '/login') return html(shell('Sign in', '<form method="post"><input name="email" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>'));
      if (url.pathname === '/verify' && request.method === 'POST') return form.get('code') === CODE ? go('/account', 'session=ok; Path=/') : go('/verify');
      if (url.pathname === '/verify') return html(shell('Verify', '<form method="post"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>'));
      if (url.pathname === '/delete') { state.deleted = true; state.deleteRequests++; return go('/account'); }
      if (url.pathname === '/account') {
        if (!signedIn) return go('/login');
        return html(shell('Account', state.deleted ? '<main><h1>Account deleted</h1></main>' : '<main><h1>Balance: 1250</h1><form method="post" action="/delete"><button>Delete account</button></form></main>'));
      }
      return html(shell('Home', '<main><h1>Welcome</h1></main>'));
    });
  });
  return { server, state };
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'رسالتك' });
  await box.fill(text);
  await box.press('Enter');
}

test('a task runs from one message through sign-in, a code and an approval', async ({ page }) => {
  test.setTimeout(240000);
  const site = startSite();
  await new Promise<void>((resolve, reject) => { site.server.once('error', reject); site.server.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve); });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await signInAsFixtureOwner(page, 'assistant');
    await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
    for (const hidden of ['نظرة عامة', 'القدرات', 'النظام متصل', 'مساحة العمل']) await expect(page.getByText(hidden)).toHaveCount(0);

    await send(page, 'مرحبا');
    await expect(page.getByRole('log').getByText('إجابة')).toBeVisible();
    await expect(page.getByRole('log').locator('li')).toHaveCount(2);
    await expect(page.getByRole('complementary')).toHaveCount(0);

    await send(page, 'اختر طريقة تناسبك');
    await page.getByRole('button', { name: 'الأولى' }).click();
    await expect(page.getByRole('log').getByText('اخترت')).toBeVisible();

    await page.getByRole('button', { name: 'محادثة جديدة' }).click();
    const accountSelector = page.locator('details').filter({ has: page.getByText('حساب المتصفح: الافتراضي', { exact: true }) });
    await accountSelector.locator('summary').click();
    await page.getByLabel('اسم جلسة الحساب').fill('work-e2e');
    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
    await expect(page.getByLabel('اسم جلسة الحساب')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-account-selector-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByLabel('اسم جلسة الحساب').fill('غير صالح');
    let creations = 0;
    const countCreations = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/chat/conversations') && request.method() === 'POST') creations++; };
    page.on('request', countCreations);
    await send(page, 'ادخل إلى حسابي التجريبي واحذفه');
    await expect(page.getByText('استخدم حروفًا إنجليزية وأرقامًا وشرطة لاسم حساب المتصفح.')).toBeVisible();
    expect(creations).toBe(0);
    await page.getByLabel('اسم جلسة الحساب').fill('work-e2e');
    const creation = page.waitForResponse(response => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'POST');
    await send(page, 'ادخل إلى حسابي التجريبي واحذفه');
    const workConversation = await (await creation).json();
    expect(workConversation.browserAccount).toBe('work-e2e');
    page.off('request', countCreations);
    await expect(page.getByRole('button', { name: 'متابعة' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('complementary', { name: 'المتصفح' })).toContainText('حساب المتصفح: work-e2e');
    await expect(page.getByLabel('اسم جلسة الحساب')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'المتصفح' }).getByRole('img')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-login.png') });
    await page.getByLabel('البريد أو اسم المستخدم').fill('owner@example.test');
    await page.getByLabel('كلمة المرور').fill('not-the-right-one');
    await page.getByRole('button', { name: 'متابعة' }).click();
    await expect(page.getByText('لم يقبل الموقع هذه البيانات')).toBeVisible({ timeout: 30000 });

    await page.getByLabel('البريد أو اسم المستخدم').fill('owner@example.test');
    await page.getByLabel('كلمة المرور').fill(PASSWORD);
    await page.getByRole('button', { name: 'متابعة' }).click();
    await expect(page.getByLabel('رمز التحقق')).toBeVisible({ timeout: 30000 });
    await page.getByLabel('رمز التحقق').fill(CODE);
    await page.getByRole('button', { name: 'متابعة' }).click();

    await expect(page.getByRole('button', { name: 'موافق' })).toBeVisible({ timeout: 30000 });
    expect(site.state.deleted).toBe(false);
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-approval.png') });
    await page.getByRole('button', { name: 'موافق' }).click();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeVisible({ timeout: 30000 });
    expect(site.state.deleted).toBe(true);
    expect(site.state.deleteRequests).toBe(1);

    await page.reload();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeVisible();
    await expect(page.getByRole('log')).not.toContainText(PASSWORD);
    await expect(page.getByRole('log')).not.toContainText(CODE);
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-desktop.png') });

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.getByRole('button', { name: 'فتح القائمة' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
    await page.getByRole('log').getByText('تم حذف الحساب كما طلبت.').scrollIntoViewIfNeeded();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 800 });

    // A second named profile must not inherit the first profile's fixture cookie.
    await page.getByRole('button', { name: 'محادثة جديدة' }).click();
    await page.locator('summary').filter({ hasText: 'حساب المتصفح: الافتراضي' }).click();
    await expect(page.getByLabel('اسم جلسة الحساب')).toHaveValue('');
    await page.getByLabel('اسم جلسة الحساب').fill('personal-e2e');
    const personalCreation = page.waitForResponse(response => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'POST');
    await send(page, 'افتح حسابي التجريبي الشخصي');
    const personalConversation = await (await personalCreation).json();
    await expect(page.getByLabel('كلمة المرور', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('complementary', { name: 'المتصفح' })).toContainText('حساب المتصفح: personal-e2e');
    await page.getByRole('button', { name: 'إيقاف', exact: true }).click();
    await expect(page.getByRole('button', { name: 'إيقاف', exact: true })).toHaveCount(0);

    const post = async (path: string, data: object) => {
      const response = await page.request.post(path, { headers: { origin: 'http://127.0.0.1:3100' }, data });
      expect(response.ok(), await response.text()).toBe(true); return response.json();
    };
    const detail = async (id: string) => {
      const response = await page.request.get(`/api/chat/conversations/${id}`);
      expect(response.ok()).toBe(true); return response.json();
    };
    // An authenticated owner's physical input leaves a conservative review boundary.
    // It clicks only blank space on our local fixture; it does not submit a request.
    await post(`/api/chat/conversations/${personalConversation.id}/browser/pointer`, { x: 0.95, y: 0.95 });
    await page.reload();
    const reviewLabel = 'راجعت بنفسي أثر الإجراء السابق.';
    const reviewButton = 'تسجيل المراجعة دون تكرار الإجراء';
    await expect(page.getByRole('button', { name: reviewButton })).toBeDisabled();
    await page.getByRole('checkbox', { name: reviewLabel }).check();
    await expect(page.getByRole('button', { name: reviewButton })).toBeEnabled();
    await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'ادخل إلى حسابي التجريبي واحذفه', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'المتصفح' })).toContainText('حساب المتصفح: work-e2e');
    await expect(page.getByRole('checkbox', { name: reviewLabel })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'افتح حسابي التجريبي الشخصي', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: reviewLabel })).not.toBeChecked();
    await expect(page.getByRole('button', { name: reviewButton })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole('checkbox', { name: reviewLabel }).check();
    await expect(page.getByRole('button', { name: reviewButton })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-review-mobile.png') });
    await page.getByRole('button', { name: reviewButton }).click();
    await expect(page.getByRole('checkbox', { name: reviewLabel })).toHaveCount(0, { timeout: 30000 });
    expect(site.state.deleteRequests).toBe(1);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Exceed the real four-page limit in the same account to exercise durable readback.
    for (let index = 0; index < 5; index++) {
      const extra = await post('/api/chat/conversations', { goal: `افتح حسابي التجريبي للقراءة ${index}`, browserAccount: 'work-e2e' });
      await expect.poll(async () => (await detail(extra.id)).status, { timeout: 30000 }).not.toBe('running');
      expect((await detail(extra.id)).browser?.live).toBe(true);
    }
    expect((await detail(workConversation.id)).browser).toMatchObject({ live: false, recovery: 'available' });
    await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'ادخل إلى حسابي التجريبي واحذفه', exact: true }).click();
    await expect(page.getByRole('button', { name: 'استعادة الصفحة', exact: true })).toBeEnabled();
    await expect(page.getByRole('complementary', { name: 'المتصفح' })).toContainText('حساب المتصفح: work-e2e');
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-restore-desktop.png') });
    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
    await expect(page.getByRole('button', { name: 'استعادة الصفحة', exact: true })).toBeInViewport();
    await page.screenshot({ animations: 'disabled', path:test.info().outputPath('assistant-restore-mobile.png') });
    await page.getByRole('button', { name: 'استعادة الصفحة', exact: true }).click();
    await expect(page.getByRole('button', { name: 'استعادة الصفحة', exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByRole('complementary', { name: 'المتصفح' }).getByRole('img')).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('log')).toContainText('أعدت قراءة الصفحة المحفوظة.');
    expect(site.state.deleteRequests).toBe(1);
    expect((await detail(workConversation.id)).browser).toMatchObject({ live: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    await openAdvancedTools(page);
    await page.getByRole('button', { name: 'المحادثة', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'رسالتك' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    site.server.closeAllConnections();
    await new Promise((resolve) => site.server.close(resolve));
  }
});
