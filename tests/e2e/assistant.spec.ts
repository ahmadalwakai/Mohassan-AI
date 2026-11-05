import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { openAdvancedTools, signInAsFixtureOwner } from './helpers';

const PASSWORD = 'fixture-site-pass-7741';
const CODE = '551204';

/** A small site on the origin the test server allows: sign-in, then a code, then an account page. */
function startSite() {
  const state = { deleted: false };
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
      if (url.pathname === '/delete') { state.deleted = true; return go('/account'); }
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
  test.setTimeout(150000);
  const site = startSite();
  await new Promise<void>((resolve) => site.server.listen(4201, '127.0.0.1', resolve));
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
    await send(page, 'ادخل إلى حسابي التجريبي واحذفه');
    await expect(page.getByRole('button', { name: 'متابعة' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('complementary', { name: 'المتصفح' }).getByRole('img')).toBeVisible();
    await page.screenshot({ path: 'artifacts/assistant-login.png' });
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
    await page.screenshot({ path: 'artifacts/assistant-approval.png' });
    await page.getByRole('button', { name: 'موافق' }).click();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeVisible({ timeout: 30000 });
    expect(site.state.deleted).toBe(true);

    await page.reload();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeVisible();
    await expect(page.getByRole('log')).not.toContainText(PASSWORD);
    await expect(page.getByRole('log')).not.toContainText(CODE);
    await page.screenshot({ path: 'artifacts/assistant-desktop.png' });

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.getByRole('button', { name: 'فتح القائمة' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
    await page.getByRole('log').getByText('تم حذف الحساب كما طلبت.').scrollIntoViewIfNeeded();
    await expect(page.getByRole('log').getByText('تم حذف الحساب كما طلبت.')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'artifacts/assistant-mobile.png' });
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
