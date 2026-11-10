import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

const id = '11111111-2222-4333-8444-666666666666', questionId = '11111111-2222-4333-8444-777777777777', now = '2026-11-10T10:00:00.000Z';
const message = (index: number, role: 'user' | 'assistant', text: string) => ({ id: `11111111-2222-4333-8444-00000000000${index}`, role, text, createdAt: now });
const waiting = {
  id, title: 'حملة نقل', status: 'waiting_user', updatedAt: now, browserAccount: null,
  messages: [message(1, 'user', 'أنشئ حملة بحث في حساب Google Ads'), message(2, 'assistant', 'أحتاج إذنك للوصول إلى Google Ads.')],
  question: { id: questionId, prompt: 'أحتاج إذنك للوصول إلى Google Ads.', action: 'google_ads_connect', options: [{ id: 'connect', label: 'تسجيل الدخول إلى Google' }, { id: 'connected', label: 'تم تسجيل الدخول، أكمل' }, { id: 'stop', label: 'توقف هنا' }] },
  approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: true,
};

/**
 * This server has no Google, so the chat and the consent page are served to the page.
 * The server side of the same flow is proven in tests/google-ads-chat.test.ts.
 */
test('Google sign-in from the chat returns to the same conversation and continues it', async ({ page }, testInfo) => {
  let current: typeof waiting | (Omit<typeof waiting, 'question'> & { question: null }) = waiting;
  const answers: unknown[] = [];
  await page.route('**/api/chat/conversations**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/respond')) {
      answers.push(route.request().postDataJSON());
      current = { ...waiting, status: 'idle', question: null, messages: [...waiting.messages, message(3, 'user', 'تم تسجيل الدخول، أكمل'), message(4, 'assistant', 'أنشأت الحملة متوقفة في حسابك.')] };
      return route.fulfill({ json: current });
    }
    if (path.endsWith(id)) return route.fulfill({ json: current });
    return route.fulfill({ json: { conversations: [{ id, title: current.title, status: current.status, updatedAt: now, browserAccount: null }] } });
  });
  // Stands in for Google's consent page, which sends the browser back with the fixed result word.
  await page.route('**/api/google-ads/connect', route => route.fulfill({ json: { authorizationUrl: new URL('/?googleAds=connected#tools', route.request().url()).href } }));

  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'حملة نقل', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تم تسجيل الدخول، أكمل' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-in-question.png'), fullPage: true });
  await page.getByRole('button', { name: 'تسجيل الدخول إلى Google' }).click();

  await expect(page.getByText('أنشأت الحملة متوقفة في حسابك.')).toBeVisible();
  expect(answers).toEqual([{ questionId, optionId: 'connected' }]);
  // Back in the chat, not in the advanced Google Ads section, and the result word is gone from the address.
  await expect(page.getByRole('region', { name: 'Google Ads', exact: true })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('');
  await page.screenshot({ path: testInfo.outputPath('after-sign-in.png'), fullPage: true });
});
