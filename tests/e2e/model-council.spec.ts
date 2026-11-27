import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ChatConversationSchema } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('the owner reads an Arabic council discussion and opens it with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });

  const id = randomUUID();
  const now = new Date().toISOString();
  const summary = { id, title: 'نقاش تجريبي', status: 'idle', updatedAt: now, browserAccount: null };
  const total = 12 + 7;
  const reply = `المجموع يساوي ${total}.`;
  const evidenceUrl = 'https://example.test/council-evidence';
  const evidenceQuote = `ورد في دليل الاختبار أن 12 + 7 = ${total}.`;
  const reasonAr = 'وجد نموذج القراءة الجواب في الدليل وأيّدته نتيجة التحقق.';
  const checkNote = 'اقتُبس الناتج من السطر نفسه.';
  const weightSource = 'قياس دقة في الاختبار التجريبي';
  const failureNote = 'انتهت مهلة المحاولة في الاختبار.';
  // Member IDs and Arabic labels come from the council at 29448ae (retrieved 2026-11-27).
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-council.ts
  const reader = { model: 'reading-v3-last', label: 'نموذج القراءة v3' };
  const checker = { model: 'chat-v5', label: 'نموذج المحادثة v5' };
  const absent = { model: 'chat-v4', label: 'نموذج المحادثة v4' };
  const conversation = ChatConversationSchema.parse({
    ...summary,
    question: null, approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: true,
    messages: [
      { id: randomUUID(), role: 'user', text: 'ما حاصل جمع 12 و7؟', createdAt: now },
      {
        id: randomUUID(), role: 'assistant', text: reply, createdAt: now,
        council: {
          version: 1, chosen: reader.model, changed: true, reason: reasonAr, elapsedMs: 20,
          members: [
            { ...reader, round: 'answer', outcome: 'ok', elapsedMs: 10, output: String(total), chosen: true },
            { ...checker, round: 'answer', outcome: 'ok', elapsedMs: 10, output: String(total) },
            { ...absent, round: 'answer', outcome: 'timeout', elapsedMs: 20, note: failureNote },
          ],
          discussion: {
            proposals: [{ member: reader.model, answer: String(total), evidenceUrl, evidenceQuote }],
            checks: [{ checker: checker.model, member: reader.model, verdict: 'supports', note: checkNote }],
            votes: [{ member: reader.model, weight: 3 / 4, weightSource }],
            decision: { chosen: reader.model, reasonAr, reasonEn: 'The reader found the answer in the evidence and the check supported it.' },
          },
        },
      },
    ],
  });
  await page.route('**/api/chat/conversations**', route => {
    expect(route.request().method()).toBe('GET');
    return new URL(route.request().url()).pathname.endsWith(id)
      ? route.fulfill({ json: conversation }) : route.fulfill({ json: { conversations: [summary] } });
  });

  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: summary.title, exact: true }).click();

  const answer = page.getByRole('article').filter({ hasText: reply });
  const disclosure = answer.getByRole('button', { name: /ناقش.*اختير جواب/u });
  const panel = answer.getByTestId('council-panel');
  await expect(disclosure).toHaveAccessibleName(new RegExp(reasonAr, 'u'));
  await expect(disclosure.getByTitle(reasonAr)).toHaveCSS('white-space', 'nowrap');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveAttribute('id', /\S/u);
  expect(await disclosure.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
  await expect(panel).toBeHidden();
  await expect(answer.getByRole('heading', { name: 'المقترحات' })).toHaveCount(0);

  await disclosure.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(disclosure).toBeFocused();
  expect(await disclosure.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(disclosure).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('direction', 'rtl');
  for (const heading of ['المقترحات', 'التحقّق', 'التصويت', 'القرار', 'من تعذّرت مشاركتهم']) {
    await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  await expect(panel.getByTitle(reader.model).first()).toHaveText(reader.label);
  await expect(panel.getByText(evidenceQuote, { exact: true })).toBeVisible();
  await expect(panel.getByText(checkNote, { exact: true })).toBeVisible();
  await expect(panel.getByText(weightSource, { exact: true })).toBeVisible();
  await expect(panel.getByText(reasonAr, { exact: true })).toBeVisible();
  await expect(panel.getByText(failureNote, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const evidence = panel.getByRole('link');
  await expect(evidence).toHaveAttribute('href', evidenceUrl);
  await page.keyboard.press('Tab');
  await expect(evidence).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(disclosure).toBeFocused();
  await expect(panel).toBeHidden();
});
