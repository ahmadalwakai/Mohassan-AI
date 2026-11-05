import { expect, type Page } from '@playwright/test';

/** Honor the real sign-in throttle when independent browser stories share one fixture owner. */
export async function submitFixtureSignIn(page:Page,buttonName='دخول'){
  for(let attempt=0;attempt<3;attempt++){
    const response=page.waitForResponse(response=>response.url().endsWith('/api/auth/sign-in/email')&&response.request().method()==='POST');
    await page.getByRole('button',{name:buttonName,exact:true}).click();
    const result=await response;
    if(result.status()!==429){expect(result.ok()).toBe(true);return;}
    const delay=Math.max(1,Math.min(11,Number(result.headers()['retry-after']??result.headers()['x-retry-after'])||10));
    await new Promise(resolve=>setTimeout(resolve,delay*1000+100));
    buttonName='دخول';
  }
  throw new Error('Fixture sign-in remained throttled after honoring Retry-After');
}

/** The advanced sections sit behind the account menu of the assistant. */
export async function openAdvancedTools(page: Page) {
  await page.getByRole('navigation',{name:'المحادثات'}).getByRole('button',{name:'مالك الاختبار'}).click();
  await page.getByRole('button',{name:'الأدوات المتقدمة'}).click();
  await expect(page.getByRole('heading',{name:'أهلًا، مالك.'})).toBeVisible();
}

/** Shared owner belongs only to the disposable e2e database/server. */
export async function signInAsFixtureOwner(page: Page, initialView: 'assistant' | 'overview' = 'overview') {
  await page.goto('/');
  const setup = await page.request.get('/api/setup');
  expect(setup.ok()).toBe(true);
  const needsSetup = (await setup.json()).needsSetup === true;
  if (needsSetup) {
    await expect(page.getByRole('heading',{name:'أنشئ حساب المالك'})).toBeVisible();
    await page.getByLabel('الاسم',{exact:true}).fill('مالك الاختبار');
    await page.getByLabel('رمز الإعداد المحلي').fill('browser-test-setup-token-isolated-fixture-0001');
  } else {
    const current=await page.request.get('/api/auth/get-session');
    if ((await current.json())?.user) {
      if (initialView === 'overview') await openAdvancedTools(page);
      return;
    }
    await expect(page.getByRole('heading',{name:'تسجيل الدخول'})).toBeVisible();
  }
  await page.getByLabel('البريد الإلكتروني').fill('owner@example.test');
  await page.getByLabel('كلمة المرور',{exact:true}).fill('Isolated-Browser-Password-42');
  await submitFixtureSignIn(page,needsSetup?'إنشاء الحساب':'دخول');
  await expect(page.getByRole('heading',{name:/كيف أساعدك اليوم/})).toBeVisible();
  if (initialView === 'overview') await openAdvancedTools(page);
}
