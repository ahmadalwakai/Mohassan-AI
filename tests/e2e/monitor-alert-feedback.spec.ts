import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ChatConversation, MonitorAlert, MonitorCard, MonitorAlertFeedback } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  // Compile the first offline Next page before timing the feedback interaction.
  expect((await request.get('/', { timeout: 240_000 })).ok()).toBe(true);
});

test('rates the same monitor alert in the conversation and monitor card', async ({ page }) => {
  test.setTimeout(120_000);
  const now = new Date().toISOString();
  const alertId = randomUUID();
  const title = 'تنبيه سعر العملة';
  const alert: MonitorAlert = { id: alertId, happenedAt: now };
  const submitted: MonitorAlertFeedback[] = [];
  await signInAsFixtureOwner(page, 'assistant');
  const created = await page.request.post('/api/chat/conversations', {
    data: {}, headers: { origin: new URL(page.url()).origin },
  });
  expect(created.ok()).toBe(true);
  const conversation: ChatConversation = await created.json();

  const monitor: MonitorCard = {
    id: randomUUID(), conversationId: conversation.id, status: 'completed',
    spec: {
      source: { kind: 'currency', base: 'USD', quote: 'SAR' }, read: { kind: 'number' },
      condition: { kind: 'threshold', direction: 'below', value: 3.7, hysteresis: 0.01 },
      timing: { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1 },
      title, language: 'ar', message: 'انخفض السعر عن القيمة المطلوبة.',
    },
    current: { value: 3.65, excerpt: 'قيمة تجريبية', observedAt: now },
    lastCheckedAt: now, nextCheckAt: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    alerts: [alert],
  };

  await page.route('**/api/chat/conversations', async route => {
    const response = await route.fetch();
    const history = await response.json();
    await route.fulfill({ response, json: {
      ...history, conversations: [{ ...conversation, title }], capabilities: { ...history.capabilities, smartMonitors: true },
    } });
  });
  await page.route(`**/api/chat/conversations/${conversation.id}`, route => route.fulfill({ json: {
    ...conversation, title, monitorAlerts: [alert], monitors: [monitor],
    messages: [{ id: alertId, role: 'assistant', text: monitor.spec.message, createdAt: now }],
  } }));
  await page.route(`**/api/chat/monitors/alerts/${alertId}/feedback`, async route => {
    expect(route.request().method()).toBe('POST');
    const input = route.request().postDataJSON() as MonitorAlertFeedback;
    submitted.push(input);
    alert.feedback = { ...input, updatedAt: new Date(Date.parse(now) + submitted.length * 1000).toISOString() };
    await route.fulfill({ json: alert.feedback });
  });

  const thread = page.getByRole('log', { name: 'المحادثة' });
  const bubble = thread.getByRole('article').filter({ hasText: monitor.spec.message });
  const card = thread.getByTestId('monitor-card');
  const button = (surface: typeof bubble, name: string) => surface.getByRole('button', { name, exact: true });

  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(button(bubble, 'مفيد')).toHaveAttribute('aria-pressed', 'false');
  await expect(button(card, 'غير مفيد')).toHaveAttribute('aria-pressed', 'false');
  await button(bubble, 'غير مفيد').click();
  await expect(button(card, 'غير مفيد')).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('combobox', { name: 'السبب (اختياري)' }).selectOption({ label: 'تأخر التنبيه' });
  await expect(bubble.getByRole('combobox')).toHaveValue('late');
  await button(card, 'مفيد').click();
  await expect(button(bubble, 'مفيد')).toHaveAttribute('aria-pressed', 'true');
  await expect(bubble.getByRole('combobox')).toHaveCount(0);
  expect(submitted).toEqual([
    { rating: 'not_helpful' }, { rating: 'not_helpful', reason: 'late' }, { rating: 'helpful' },
  ]);

  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(button(bubble, 'مفيد')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(card, 'مفيد')).toHaveAttribute('aria-pressed', 'true');
});
