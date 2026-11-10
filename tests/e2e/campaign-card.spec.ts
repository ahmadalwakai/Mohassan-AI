import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

// The server stream is mocked here; the real event flow is covered in tests/campaign-progress-chat.test.ts.
const id = '11111111-2222-4333-8444-888888888888', now = '2026-11-10T10:00:00.000Z', task = 'campaign-run-1';
const ev = (seq: number, type: string, status: string, data: object, stepId: string | null = null) => ({ id: `22222222-2222-4333-8444-${String(seq).padStart(12, '0')}`, taskId: task, seq, type, stepId, status, at: now, data });
const events = [
  ev(1, 'task_started', 'passed', { kind: 'google_ads_search_campaign', createInAccount: true }, 'intent'),
  ev(2, 'draft_updated', 'passed', { fields: [{ kind: 'headline', index: 1, text: 'Glasgow House Removals', length: 22, limit: 30, status: 'corrected', issues: [] }, { kind: 'headline', index: 2, text: 'Local Movers Glasgow And More Today', length: 35, limit: 30, status: 'invalid', issues: ['TOO_LONG'] }], keywords: 2, negativeKeywords: 1, source: 'corrected_draft' }, 'draft'),
  ev(3, 'correction_completed', 'corrected', { attempt: 1, strategy: 'deterministic', changes: [{ field: 'headline 1', before: 'Glasgow House Removals!', after: 'Glasgow House Removals', reasonCode: 'POLICY_PUNCTUATION', reason: 'Google does not allow an exclamation mark in a headline', category: 'policy', strategy: 'deterministic', basis: 'observed', verified: true }], remaining: 1, failure: null }, 'correction'),
  ev(4, 'verification_completed', 'passed', { authority: 'local', scope: 'landing_page', passed: true, checks: [{ id: 'https', passed: true, detail: 'the destination uses HTTPS' }] }, 'landing_page'),
  ev(5, 'external_operation_started', 'running', { operation: 'create_paused', mutates: true, attempt: 1 }, 'paused_creation'),
  ev(6, 'task_cancelled', 'unknown', { reason: 'owner_cancelled', reconciliationRequired: true }, 'outcome'),
];
const conversation = { id, title: 'حملة', status: 'idle', updatedAt: now, browserAccount: null, messages: [{ id: '33333333-2222-4333-8444-000000000001', role: 'user', text: 'أنشئ حملة', createdAt: now }], question: null, approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: true, campaign: { taskId: task, lastSeq: 6, events } };

test('campaign card shows sources, corrections and an unresolved write at 360px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.route('**/api/chat/conversations**', route => new URL(route.request().url()).pathname.endsWith(id) ? route.fulfill({ json: conversation }) : route.fulfill({ json: { conversations: [{ id, title: 'حملة', status: 'idle', updatedAt: now, browserAccount: null }] } }));
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'حملة', exact: true }).click();
  const card = page.getByRole('region', { name: 'تقدم الحملة' });
  await expect(card).toBeVisible();
  await expect(card.getByText('يلزم تأكيد النتيجة من الحساب').first()).toBeVisible();
  await expect(card.getByText('22/30')).toBeVisible();
  await expect(card.getByText('35/30')).toBeVisible();
  await card.getByRole('button', { name: /headline 1/ }).click();
  await expect(card.getByText('Google does not allow an exclamation mark in a headline')).toBeVisible();
  await expect(card.getByText('أُوقفت المهمة بعد إرسال طلب كتابة')).toBeVisible();
  // No horizontal page scroll and every control is large enough to touch.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await card.getByRole('button', { name: /headline 1/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath('campaign-card-360.png'), fullPage: true });
});
