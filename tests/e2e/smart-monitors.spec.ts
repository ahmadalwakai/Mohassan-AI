import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ChatConversation, MonitorCard } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('shows evidence before approval and keeps the thread and monitor settings in sync', async ({ page }) => {
  await page.clock.install();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const next = () => new Date(Date.now() + 120_000).toISOString();
  const monitorId = randomUUID();
  let monitor!: MonitorCard;
  const writes: string[] = [];

  await page.route('**/api/chat/conversations', async (route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      const history = await response.json();
      await route.fulfill({ response, json: { ...history, capabilities: { ...history.capabilities, smartMonitors: true } } });
      return;
    }
    // Create the fixture conversation without dispatching a real assistant turn.
    const response = await route.fetch({ postData: {} });
    const conversation: ChatConversation = await response.json();
    monitor = {
      id: monitorId, conversationId: conversation.id,
      spec: {
        source: { kind: 'currency', base: 'USD', quote: 'SAR' }, read: { kind: 'number' },
        condition: { kind: 'threshold', direction: 'below', value: 3.7, hysteresis: 0.01 },
        timing: { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1 },
        title: 'USD/SAR exchange rate', language: 'en', message: 'USD/SAR fell below 3.70.',
      },
      current: { value: 3.75, excerpt: 'USD/SAR fixture quote', observedAt: timestamp },
      status: 'proposed', offer: 'explicit', note: 'I’ll notify you when the rate falls below 3.70.',
      lastCheckedAt: timestamp, nextCheckAt: null, expiresAt: new Date(now + 86_400_000).toISOString(),
    };
    await route.fulfill({ response, json: { ...conversation, status: 'idle', monitorProposal: monitor,
      messages: [{ id: randomUUID(), role: 'user', text: route.request().postDataJSON().goal, createdAt: timestamp },
        { id: randomUUID(), role: 'assistant', text: 'I prepared the monitor plan.', createdAt: timestamp }] } });
  });
  await page.route(/\/api\/chat\/monitors(?:[/?]|$)/u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.searchParams.has('conversationId')) expect(url.searchParams.get('conversationId')).toBe(monitor.conversationId);
      await route.fulfill({ json: { monitors: [monitor] } });
      return;
    }
    expect(request.method()).toBe('POST');
    const operation = url.pathname.split('/').at(-1);
    if (operation === 'monitors') {
      expect(request.postDataJSON()).toEqual({ proposalId: monitorId });
      writes.push('approve');
      if (writes.length === 1) {
        await route.fulfill({ status: 409, json: { error: { message: 'Please try approval again.' } } });
        return;
      }
      monitor = { ...monitor, status: 'active', nextCheckAt: next() };
    } else {
      expect(url.pathname).toBe(`/api/chat/monitors/${monitorId}/${operation}`);
      writes.push(operation ?? '');
      if (operation === 'pause') monitor = { ...monitor, status: 'paused', nextCheckAt: null };
      if (operation === 'resume') monitor = { ...monitor, status: 'active', nextCheckAt: next() };
      if (operation === 'stop') monitor = { ...monitor, status: 'stopped', nextCheckAt: null };
    }
    await route.fulfill({ json: monitor });
  });

  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('Let me know when USD/SAR drops below 3.70');
  await composer.press('Enter');
  const thread = page.getByRole('log', { name: 'المحادثة' });
  const approval = thread.getByTestId('monitor-approval');
  await expect(approval.getByText('3.75', { exact: true })).toBeVisible();
  await expect(approval.getByText('USD/SAR fixture quote')).toBeVisible();
  expect(writes).toEqual([]);
  await approval.getByRole('button', { name: 'Start monitoring' }).click();
  await expect(approval.getByRole('alert')).toHaveText('Please try approval again.');
  await approval.getByRole('button', { name: 'Start monitoring' }).click();

  const card = thread.getByTestId('monitor-card');
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.locator('time').first()).toHaveAttribute('datetime', timestamp);
  await expect(card.locator('time').last()).toHaveAttribute('datetime', monitor.nextCheckAt!);
  monitor = { ...monitor, current: { value: 3.74, excerpt: 'USD/SAR fixture quote', observedAt: timestamp }, nextCheckAt: new Date(now + 240_000).toISOString() };
  await page.clock.fastForward(121_000);
  await expect(card.getByText('3.74', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'مالك الاختبار' }).click();
  const settings = page.getByRole('button', { name: 'المراقبات', exact: true });
  await settings.click();
  const dialog = page.getByRole('dialog', { name: 'المراقبات' });
  await expect(dialog.getByText('3.74', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(dialog.getByText('Paused', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await expect(card.getByText('Paused', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(card.getByText('Active', { exact: true })).toBeVisible();

  await settings.click();
  await dialog.getByRole('button', { name: 'Stop monitoring' }).click();
  await expect(dialog.getByText('لا توجد مراقبات نشطة أو متوقفة مؤقتًا.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'إغلاق المراقبات' })).toBeFocused();
  expect(writes).toEqual(['approve', 'approve', 'pause', 'resume', 'stop']);
});
