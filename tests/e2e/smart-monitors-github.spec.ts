import { expect, test } from '@playwright/test';
import { MonitorCardSchema, MonitorListSchema } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('approves a proposed GitHub pull request monitor after reviewing the current state', async ({ page, baseURL }) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin === baseURL) await route.continue();
    else await route.abort();
  });
  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('Tell me when PR 42 in owner/repo is merged');
  await composer.press('Enter');

  const thread = page.getByRole('log', { name: 'المحادثة' });
  const approval = thread.getByTestId('monitor-approval');
  await expect(approval.getByText('owner/repo #42', { exact: true }).first()).toBeVisible();
  await expect(approval.getByText('open', { exact: true })).toBeVisible();
  await expect(approval.getByText(/when the reading is “merged”/u)).toBeVisible();
  await expect(thread.getByTestId('monitor-card')).toHaveCount(0);

  const response = await page.request.get('/api/chat/monitors');
  expect(response.ok()).toBe(true);
  const { monitors } = MonitorListSchema.parse(await response.json());
  expect(monitors).toHaveLength(1);
  const [proposal] = monitors;
  expect(proposal).toMatchObject({
    status: 'proposed', nextCheckAt: null, offer: 'explicit', current: { value: 'open' },
    spec: {
      source: { kind: 'github', owner: 'owner', repo: 'repo', watch: { kind: 'pull-request', number: 42 } },
      condition: { kind: 'equals', value: 'merged' },
    },
  });

  const approvalResponse = page.waitForResponse(result =>
    new URL(result.url()).pathname === '/api/chat/monitors' && result.request().method() === 'POST');
  await approval.getByRole('button', { name: 'Start monitoring' }).click();
  const approved = await approvalResponse;
  expect(approved.ok()).toBe(true);
  expect(approved.request().postDataJSON()).toEqual({ proposalId: proposal.id });
  const active = MonitorCardSchema.parse(await approved.json());
  expect(active).toMatchObject({ id: proposal.id, status: 'active', nextCheckAt: expect.any(String) });
  const card = thread.getByTestId('monitor-card');
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.locator('time').last()).toHaveAttribute('datetime', active.nextCheckAt!);
  await expect(approval).toHaveCount(0);
});
