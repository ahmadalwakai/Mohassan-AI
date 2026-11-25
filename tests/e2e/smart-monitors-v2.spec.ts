import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ChatConversation, MonitorCard, MonitorManagementCard } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('selects a price before approval and confirms a spoken monitor change', async ({ page }) => {
  const monitorId = randomUUID();
  const actionId = randomUUID();
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const management: MonitorManagementCard = { id: actionId, language: 'ar', question: 'أوقف مراقبة «سعر الورشة»؟' };
  const capabilities = { chatModel: false, available: [], smartMonitors: true, smartMonitorsV2: true };
  let conversation: ChatConversation;
  let monitor: MonitorCard;
  let action: MonitorManagementCard | undefined;
  const writes: object[] = [];

  await page.route(/\/api\/chat\/conversations(?:\/[^/?]+(?:\/messages)?)?(?:\?.*)?$/u, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/chat/conversations' && request.method() === 'GET') {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), capabilities } });
    } else if (path === '/api/chat/conversations') {
      const response = await route.fetch({ postData: {} });
      conversation = { ...await response.json(), status: 'idle', capabilities, messages: [
        { id: randomUUID(), role: 'user', text: request.postDataJSON().goal, createdAt: timestamp },
        { id: randomUUID(), role: 'assistant', text: 'Choose the price to watch.', createdAt: timestamp },
      ] };
      monitor = { id: monitorId, conversationId: conversation.id, status: 'proposed', offer: 'explicit', current: null,
        spec: { language: 'en', title: 'Workshop price', message: 'Workshop price changed.',
          source: { kind: 'page', url: 'https://workshops.example.org/june' }, read: { kind: 'number', label: 'price' },
          condition: { kind: 'threshold', direction: 'below', value: 45, hysteresis: 1 }, v2: { freshnessMs: 3_600_000 },
          timing: { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 28, maxNotifications: 3 } },
        clarification: { question: 'Which price should I watch?', choices: [
          { id: 'standard', label: 'Standard price, USD', value: 42 }, { id: 'member', label: 'Member price, USD', value: 35 },
        ] },
        lastCheckedAt: timestamp, nextCheckAt: null, expiresAt };
      await route.fulfill({ response, json: { ...conversation, monitorProposal: monitor } });
    } else if (path.endsWith('/messages')) {
      expect(request.postDataJSON().text).toBe('أوقف مراقبة سعر الورشة');
      action = management;
      conversation = { ...conversation, messages: [...conversation.messages,
        { id: randomUUID(), role: 'user', text: request.postDataJSON().text, createdAt: timestamp },
        { id: randomUUID(), role: 'assistant', text: 'راجع التغيير في البطاقة.', createdAt: timestamp },
      ] };
      await route.fulfill({ json: { ...conversation, monitors: [monitor] } });
    } else {
      await route.fulfill({ json: { ...conversation, ...(monitor.status === 'proposed' ? { monitorProposal: monitor } : { monitors: [monitor] }) } });
    }
  });

  await page.route('**/api/chat/monitors?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: query.get('control') === 'v2' ? { proactiveOffers: true, action } : { monitors: [monitor] } });
  });
  await page.route('**/api/chat/monitors', async route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (body.candidateId) {
      expect(body).toEqual({ proposalId: monitorId, candidateId: 'standard' });
      monitor = { ...monitor, clarification: undefined, current: { value: 42, excerpt: 'Standard price, USD 42', observedAt: timestamp } };
      await route.fulfill({ json: monitor });
    } else if (body.proposalId) {
      expect(body).toEqual({ proposalId: monitorId });
      monitor = { ...monitor, status: 'active', nextCheckAt: expiresAt };
      await route.fulfill({ json: monitor });
    } else {
      expect(body).toEqual({ actionId, approved: true });
      action = undefined;
      monitor = { ...monitor, status: 'stopped', nextCheckAt: null };
      await route.fulfill({ json: { monitor } });
    }
  });

  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('Watch the workshop price');
  await composer.press('Enter');

  const choice = page.getByTestId('monitor-choice');
  await expect(choice.getByText('Which price should I watch?')).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Member price, USD · 35' })).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Other' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await choice.getByRole('button', { name: 'Standard price, USD · 42' }).click();
  const approval = page.getByTestId('monitor-approval');
  await expect(approval.getByText('42', { exact: true })).toBeVisible();
  expect(monitor.status).toBe('proposed');
  await approval.getByRole('button', { name: 'Start monitoring' }).click();
  const card = page.getByTestId('monitor-card');
  await expect(card.getByText('Active', { exact: true })).toBeVisible();

  await composer.fill('أوقف مراقبة سعر الورشة');
  await composer.press('Enter');
  const confirmation = page.getByTestId('monitor-management');
  await expect(confirmation.getByText(management.question)).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(monitor.status).toBe('active');
  await confirmation.getByRole('button', { name: 'تأكيد تغيير المراقبة' }).click();
  await expect(card.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  expect(writes).toHaveLength(3);
});
