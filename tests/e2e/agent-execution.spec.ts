import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ChatConversation } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

/**
 * One safe task through the whole application: the composer and its Enter key, the chat API, the runtime's run ledger,
 * the permission gate, steering a waiting task, and the verdict, plan and evidence the screen draws from the server.
 * The isolated server runs the local deterministic controller (no model), and its desktop engine is confined to the
 * fixture's own home folder; no deletion is approved here, so no file is touched.
 */
async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'رسالتك' });
  await box.fill(text);
  await box.press('Enter');
}

async function conversationOf(page: Page): Promise<ChatConversation> {
  const list = await (await page.request.get('/api/chat/conversations')).json() as { conversations: { id: string; updatedAt: string }[] };
  const newest = [...list.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
  return await (await page.request.get(`/api/chat/conversations/${newest.id}`)).json() as ChatConversation;
}

test('a request goes from the composer through the runtime to a verdict the screen shows as the server holds it', async ({ page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const root = process.env.MOHASSAN_E2E_ROOT;
  if (!root) throw new Error('The isolated fixture root is missing.');
  const desktop = path.join(root, 'home', 'Desktop');
  await mkdir(desktop, { recursive: true });
  await writeFile(path.join(desktop, 'old.txt'), 'old\n');
  await writeFile(path.join(desktop, 'new.txt'), 'new\n');

  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();

  // 1. The direct path: a calculation answered by the runtime itself, with its verdict, engine and evidence on screen.
  await send(page, 'كم 37 × 24؟');
  await expect(page.getByRole('log').getByText(/888/).first()).toBeVisible();
  const verdict = page.getByTestId('run-verdict').last();
  await expect(verdict).toHaveAttribute('data-verdict', 'completed');
  const computed = await conversationOf(page);
  expect(computed.run).toMatchObject({ verdict: { status: 'completed' }, engine: { kind: 'rules', modelCalls: 0 } });
  await page.getByTestId('run-details-toggle').last().click();
  await expect(page.getByTestId('run-engine').last()).toContainText('دون نموذج لغوي');
  await expect(page.getByTestId('run-details').last()).toContainText('حساب');
  await page.screenshot({ path: info.outputPath('1-direct-verdict.png'), fullPage: true });

  // 2. An approval bound to its exact target, corrected from the composer while it waits, then refused.
  await page.getByRole('button', { name: 'محادثة جديدة' }).first().click();
  await send(page, 'احذف ملف old.txt من سطح المكتب');
  await expect(page.getByTestId('approval-target')).toContainText('old.txt');
  await expect(page.getByText('يُنقل العنصر إلى سلة المحذوفات.')).toBeVisible();
  const waiting = await conversationOf(page);
  expect(waiting.run).toMatchObject({ phase: 'awaiting_approval', permissions: [{ decision: 'asked', target: 'old.txt' }] });
  await page.screenshot({ path: info.outputPath('2-approval-card.png'), fullPage: true });

  // The composer stays open while the card waits: Enter sends a correction, which replaces the queued deletion.
  await expect(page.getByRole('textbox', { name: 'رسالتك' })).toBeEnabled();
  await send(page, 'احذف ملف new.txt من سطح المكتب');
  await expect(page.getByTestId('approval-target')).toContainText('new.txt');
  const corrected = await conversationOf(page);
  expect(corrected.run).toMatchObject({ steeredFrom: waiting.run!.id, permissions: [{ decision: 'asked', target: 'new.txt' }] });
  // The old card's approval no longer exists anywhere: answering it now is refused by the server. Without the app's own
  // Origin header the server's cross-site guard refuses it first (403 ORIGIN_DENIED); with it, the approval itself is refused.
  const origin = new URL(page.url()).origin;
  const crossSite = await page.request.post(`/api/chat/conversations/${corrected.id}/approve`, { data: { approvalId: waiting.approval!.id, approved: true } });
  expect(crossSite.status()).toBe(403);
  const stale = await page.request.post(`/api/chat/conversations/${corrected.id}/approve`, { headers: { origin }, data: { approvalId: waiting.approval!.id, approved: true } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('CHAT_APPROVAL_CHANGED');

  await page.getByRole('button', { name: 'لا تفعل' }).click();
  await expect(page.getByRole('log').getByText('حسنًا، لم أنفّذ هذا الإجراء على جهازك.')).toBeVisible();
  const refused = await conversationOf(page);
  expect(refused.run).toMatchObject({ verdict: { status: 'blocked' }, permissions: [{ decision: 'refused' }] });
  // The screen shows exactly the server's verdict: blocked, not a check mark.
  await expect(page.getByTestId('run-verdict').last()).toHaveAttribute('data-verdict', refused.run!.verdict!.status);
  await expect(page.getByTestId('run-verdict').last()).toContainText('تعذّر الإكمال');
  for (const name of ['old.txt', 'new.txt']) await access(path.join(desktop, name));

  // 3. The same view on a 360 px phone, loaded fresh there (a live resize catches the drawer mid-slide): the badge is the
  // server's, the details open with the keyboard, and the panel stays inside the screen.
  await page.setViewportSize({ width: 360, height: 760 });
  await page.reload();
  await expect(page.getByTestId('run-verdict').last()).toHaveAttribute('data-verdict', refused.run!.verdict!.status);
  const toggle = page.getByTestId('run-details-toggle').last();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByTestId('run-details').last();
  await expect(details).toContainText('رفضتَ');
  await details.scrollIntoViewIfNeeded();
  const box = (await details.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: info.outputPath('3-phone-details.png') });
  expect(errors).toEqual([]);
});
