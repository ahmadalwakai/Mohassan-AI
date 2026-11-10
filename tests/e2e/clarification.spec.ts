import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

// The chat routes are mocked to drive the card's states; the real server flow,
// persistence and gates are covered in tests/goal-clarification-chat.test.ts.
const id = '11111111-2222-4333-8444-999999999999', now = '2026-11-10T10:00:00.000Z', run = '44444444-2222-4333-8444-000000000001';
const questionId = '55555555-2222-4333-8444-000000000001';
const goal = {
  version: 1, outcome: 'ASK_USER', status: 'NEEDS_CLARIFICATION', domains: ['google_ads'],
  known: [], missing: [{ slot: 'ads_budget', label: 'الميزانية اليومية' }, { slot: 'ads_url', label: 'رابط صفحة الهبوط' }],
  assumptions: [{ slot: 'ads_language', label: 'لغة الإعلان', value: 'ar' }],
  blockers: [{ code: 'REQUIREMENT_MISSING', message: 'يلزم الميزانية اليومية.', slot: 'ads_budget' }],
  steps: [{ step: 'draft', status: 'READY', reasons: [] }, { step: 'external_write', status: 'NEEDS_CLARIFICATION', reasons: [] }],
};
const decisions = { lastSeq: 2, events: [
  { seq: 1, runId: run, type: 'goal_interpreted', summary: 'فُهم الطلب: إنشاء حملة في الحساب.', data: {}, at: now },
  { seq: 2, runId: run, type: 'clarification_requested', summary: 'سُئل عن الميزانية والرابط.', data: {}, at: now },
] };
const waiting = {
  id, title: 'حملة', status: 'waiting_user', updatedAt: now, browserAccount: null,
  messages: [{ id: '33333333-2222-4333-8444-000000000001', role: 'user', text: 'أنشئ حملة في حسابي', createdAt: now }, { id: '33333333-2222-4333-8444-000000000002', role: 'assistant', text: 'أحتاج قبل المتابعة: الميزانية اليومية، ورابط صفحة الهبوط.', createdAt: now }],
  question: { id: questionId, prompt: 'أحتاج قبل المتابعة: الميزانية اليومية، ورابط صفحة الهبوط.', options: [{ id: 'draft_only', label: 'جهّز مسودة فقط دون إنشاء' }, { id: 'stop', label: 'توقف هنا' }], clarification: { reason: 'الميزانية تحدد ما قد يُصرف من حسابك، فلا أفترضها.', recommendedOptionId: null, allowText: true, slots: ['ads_budget', 'ads_url'], goalVersion: 1, readiness: 'NEEDS_CLARIFICATION' } },
  approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: true, goal, decisions,
};

test('clarification card: reason, free-text answer kept on failure, keyboard use and 360px layout', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const answers: unknown[] = [];
  let failNext = true;
  // The server stays the authority: after it accepts the answer, every read returns the resumed state.
  let current: object = waiting;
  const resumed = { ...waiting, status: 'idle', question: null, messages: [...waiting.messages, { id: '33333333-2222-4333-8444-000000000003', role: 'user', text: 'الميزانية 20 يوميًا، https://example.com', createdAt: now }], goal: { ...goal, status: 'NEEDS_APPROVAL', outcome: 'REQUEST_APPROVAL', missing: [], blockers: [] } };
  await page.route('**/api/chat/conversations**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/respond')) {
      answers.push(route.request().postDataJSON());
      if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: { code: 'CHAT_SHUTTING_DOWN', message: 'الخدمة تتوقف الآن.' } } }); }
      current = resumed;
      return route.fulfill({ json: resumed });
    }
    if (url.pathname.endsWith(id)) return route.fulfill({ json: current });
    return route.fulfill({ json: { conversations: [{ id, title: 'حملة', status: 'waiting_user', updatedAt: now, browserAccount: null }] } });
  });
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'حملة', exact: true }).click();

  const card = page.getByRole('region', { name: 'سؤال قبل المتابعة' });
  await expect(card).toBeVisible();
  await expect(card.getByText('لماذا أسأل؟')).toBeVisible();
  await expect(card.getByText('الميزانية تحدد ما قد يُصرف من حسابك')).toBeVisible();
  await expect(card.getByRole('button', { name: 'جهّز مسودة فقط دون إنشاء' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('clarification-question-360.png'), fullPage: true });

  // Keyboard: the answer box is reachable and Enter submits.
  const box = card.getByLabel('أو اكتب إجابتك');
  await box.focus();
  await box.fill('الميزانية 20 يوميًا، https://example.com');
  await box.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'الخدمة تتوقف الآن.' })).toBeVisible();
  await expect(box).toHaveValue('الميزانية 20 يوميًا، https://example.com');

  await card.getByRole('button', { name: 'إرسال الإجابة' }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('region', { name: 'ملخص المهمة' }).getByText('ما فهمته من طلبك')).toBeVisible();
  expect(answers).toEqual([{ questionId, text: 'الميزانية 20 يوميًا، https://example.com' }, { questionId, text: 'الميزانية 20 يوميًا، https://example.com' }]);

  // No horizontal scroll at 360px; controls are touch-sized.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('clarification-360.png'), fullPage: true });
});

test('clarification card: a button answer sends only the option, and the summary lists assumptions', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const answers: unknown[] = [];
  await page.route('**/api/chat/conversations**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/respond')) { answers.push(route.request().postDataJSON()); return route.fulfill({ json: { ...waiting, status: 'idle', question: null } }); }
    if (url.pathname.endsWith(id)) return route.fulfill({ json: waiting });
    return route.fulfill({ json: { conversations: [{ id, title: 'حملة', status: 'waiting_user', updatedAt: now, browserAccount: null }] } });
  });
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'حملة', exact: true }).click();
  const card = page.getByRole('region', { name: 'سؤال قبل المتابعة' });
  await card.getByText('ما فهمته من طلبك').click();
  await expect(card.getByText('افتراضات (يمكنك تغييرها)')).toBeVisible();
  await expect(card.getByText('سُئل عن الميزانية والرابط.')).toBeVisible();
  const draft = card.getByRole('button', { name: 'جهّز مسودة فقط دون إنشاء' });
  expect((await draft.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await draft.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => answers).toEqual([{ questionId, optionId: 'draft_only' }]);
});
