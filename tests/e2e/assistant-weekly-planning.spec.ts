import { expect, test } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

test('weekly planning shows the questions and keeps them in the completed conversation', async ({ page }) => {
  test.setTimeout(240_000);
  await signInAsFixtureOwner(page, 'assistant');
  const session = await page.request.get('/api/chat/conversations');
  expect(session.ok()).toBe(true);
  test.skip((await session.json()).configured === true, 'Uses the model-free fixture in playwright.agent-execution.config.ts.');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('خطط لي أسبوعي');
  await composer.press('Enter');

  const thread = page.getByRole('log');
  const questions = page.getByRole('dialog', { name: 'أسئلة موحسن' });
  const prompts = [/ما مهامك هذا الأسبوع/u, /أي أيام تعمل فيها/u, /هل عندك مواعيد ثابتة/u];
  for (const prompt of prompts) await expect(thread.getByText(prompt)).toBeVisible();
  await expect(questions.getByRole('textbox', { name: prompts[0] })).toBeVisible();

  await page.reload();
  await questions.getByRole('textbox', { name: prompts[0] }).fill('!مراجعة التقرير الأسبوعي');
  await questions.getByRole('button', { name: 'التالي' }).click();
  await questions.getByRole('radio', { name: 'لا توجد مواعيد' }).click();
  await questions.getByRole('button', { name: 'أرسل الإجابات' }).click();
  await expect(thread.getByText('خطة الأسبوع', { exact: true })).toBeVisible();
  await expect(thread.getByText('مراجعة التقرير الأسبوعي', { exact: true })).toBeVisible();
  await expect(questions).toHaveCount(0);

  await page.reload();
  for (const prompt of prompts) await expect(thread.getByText(prompt)).toBeVisible();
  await expect(thread.getByText('خطة الأسبوع', { exact: true })).toBeVisible();

  // A status change outside this tab must retire the live card without removing its questions from the thread.
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).first().click();
  const creation = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/api/chat/conversations'));
  await composer.fill('خطط لي أسبوعي');
  await composer.press('Enter');
  const created = await creation;
  expect(created.ok()).toBe(true);
  const { id } = await created.json() as { id: string };
  await expect(questions).toBeVisible();
  const cancelled = await page.request.post(`/api/chat/conversations/${id}/cancel`, {
    headers: { origin: new URL(page.url()).origin }, data: {},
  });
  expect(cancelled.ok()).toBe(true);
  await expect(questions).toHaveCount(0, { timeout: 30_000 });
  await expect(thread.getByTestId('run-verdict')).toHaveAttribute('data-verdict', 'cancelled');
  for (const prompt of prompts) await expect(thread.getByText(prompt)).toBeVisible();
});
