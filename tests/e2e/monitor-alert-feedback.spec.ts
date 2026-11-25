import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';
import type { ChatConversation, MonitorAlert, MonitorCard, MonitorAlertFeedback } from '@mohassan/contracts';
import Fastify from 'fastify';
import { registerMonitorAlertFeedbackRoute } from '../../apps/server/src/monitors-phase1/feedback.js';
import { monitorProposalDecisionSnapshot } from '../../apps/server/src/monitors/decision/features.js';
import { buildMonitorContextFrame } from '../../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../../apps/server/src/monitors/decision/reasoner.js';
import { createMonitorStore } from '../../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../../apps/server/src/notifications-store.js';
import { createMonitorRecordingFixture } from '../../scripts/monitor-decision/check-recording.js';
import { writeMonitorDecisionExport } from '../../scripts/monitor-decision/export.js';
import { signInAsFixtureOwner } from './helpers';

const ownerId = 'feedback-browser-owner';
const test = base.extend<{ feedbackFixture: {
  database: Awaited<ReturnType<typeof createMonitorRecordingFixture>>; api: ReturnType<typeof Fastify>;
} }>({
  feedbackFixture: async ({}, use) => {
    const database = await createMonitorRecordingFixture();
    const api = Fastify();
    try {
      await database.db.insertInto('user').values({ id: ownerId, name: 'Feedback browser fixture', email: 'feedback-browser@example.test' }).execute();
      await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: ownerId }).execute();
      registerMonitorAlertFeedbackRoute(api, database.db, async () => ({ id: ownerId }), {
        onRequest: async () => {}, config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
      });
      await use({ database, api });
    } finally {
      await api.close();
      await database.close();
    }
  },
});

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  // Compile the first offline Next page before timing the feedback interaction.
  expect((await request.get('/', { timeout: 240_000 })).ok()).toBe(true);
});

test('rates the same monitor alert in the conversation and monitor card', async ({ page, feedbackFixture }, testInfo) => {
  test.setTimeout(120_000);
  const at = new Date();
  const now = at.toISOString();
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

  const spec: MonitorCard['spec'] = {
    source: { kind: 'currency', base: 'USD', quote: 'SAR' }, read: { kind: 'number' },
    condition: { kind: 'threshold', direction: 'below', value: 3.7, hysteresis: 0.01 },
    timing: { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1 },
    title, language: 'ar', message: 'انخفض السعر عن القيمة المطلوبة.',
  };
  const { database: { db }, api } = feedbackFixture;
  await db.insertInto('chat_conversations').values({ id: conversation.id, owner_id: ownerId, title }).execute();
  const proposalText = 'نبّهني لما ينزل الدولار تحت ٣٫٧٠';
  const earlierText = 'كم سعر صرف الدولار مقابل الريال السعودي؟';
  const frame = buildMonitorContextFrame({ text: proposalText, history: [{ role: 'user', text: earlierText }], now: at });
  const decisionFeatures = monitorProposalDecisionSnapshot(frame, reasonMonitorContext(frame), 'propose');
  expect(decisionFeatures).toBeDefined();
  const store = createMonitorStore(db, { v2: true, now: () => at });
  const proposal = await store.propose(ownerId, { conversationId: conversation.id, spec, decisionFeatures,
    observation: { value: 3.75, excerpt: 'Fixture preview', observedAt: now } });
  await store.approve(ownerId, proposal.id);
  await recordBackgroundRunOutcome(db, { userId: ownerId, runId: alertId, conversationId: conversation.id,
    monitorId: proposal.id, startedAt: at, outcome: 'completed', language: 'ar' }, at);
  const monitor: MonitorCard = {
    id: proposal.id, conversationId: conversation.id, status: 'completed', spec,
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
    const vote = await api.inject({ method: 'POST', url: new URL(route.request().url()).pathname, payload: input });
    expect(vote.statusCode, vote.body).toBe(200);
    alert.feedback = vote.json();
    await route.fulfill({ json: vote.json() });
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

  await mkdir(testInfo.outputDir, { recursive: true });
  const output = testInfo.outputPath('training-export.jsonl');
  expect(await writeMonitorDecisionExport(db, ownerId, output, 'pipeline-check')).toMatchObject({ rows: 2 });
  const labels = await readFile(output, 'utf8');
  expect(labels.trim().split('\n').map(line => JSON.parse(line).decision)).toEqual(['approved', 'alert_helpful']);
  for (const privateValue of [ownerId, conversation.id, proposalText, earlierText, title, spec.message]) expect(labels).not.toContain(privateValue);

  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(button(bubble, 'مفيد')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(card, 'مفيد')).toHaveAttribute('aria-pressed', 'true');
});
