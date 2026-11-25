import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ChatConversation, ReminderDeliverySummary, ReminderSummary } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

test('reminder settings surface arrivals and support keyboard edit and cancellation', async ({ page }) => {
  await page.clock.install();
  const deliveries: ReminderDeliverySummary[] = [];
  await page.route('**/api/reminders/due', (route) => route.fulfill({ json: { deliveries } }));
  await signInAsFixtureOwner(page, 'assistant');
  const composer = page.getByRole('textbox', { name: 'رسالتك' });
  await composer.fill('مرحبا');
  const sent = page.waitForResponse((response) => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'POST');
  await composer.press('Enter');
  const conversation: ChatConversation = await (await sent).json();
  const thread = page.getByRole('log', { name: 'المحادثة' });
  await expect(thread.getByText('مرحبا', { exact: true })).toBeVisible();

  // The two occurrences of 01:30 follow the EU "last Sunday in October" rule.
  // https://data.iana.org/time-zones/tzdb/europe (retrieved 2026-11-25).
  const reminder: ReminderSummary = {
    id: randomUUID(), conversationId: conversation.id, text: 'اجتماع الفريق', timeZone: 'Europe/London',
    dueAt: new Date(Date.UTC(2027, 9, 31, 0, 15)).toISOString(), recurrence: null,
    status: 'scheduled', attempts: 0, lastError: null, createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt,
  };
  let rejectList!: () => void;
  const loading = new Promise<void>((resolve) => { rejectList = resolve; });
  let listCalls = 0;
  await page.route('**/api/reminders', async (route) => {
    if (++listCalls === 1) {
      await loading;
      await route.fulfill({ status: 503, json: { error: { message: 'تعذّر تحميل التذكيرات.' } } });
      return;
    }
    await route.fulfill({ json: { reminders: reminder.status === 'scheduled' ? [reminder] : [] } });
  });
  await page.route(`**/api/reminders/${reminder.id}`, async (route) => {
    if (route.request().method() === 'DELETE') reminder.status = 'cancelled';
    else {
      expect(route.request().method()).toBe('PATCH');
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({ localDueAt: '2027-10-31T01:30', timeZone: 'Europe/London', expected: { dueAt: reminder.dueAt, updatedAt: reminder.updatedAt } });
      if (!input.overlap) {
        await route.fulfill({ status: 400, json: { error: { code: 'REMINDER_TIME_AMBIGUOUS', message: 'اختر الموعد المقصود.' } } });
        return;
      }
      expect(input.overlap).toBe('later');
      reminder.dueAt = new Date(Date.UTC(2027, 9, 31, 1, 30)).toISOString();
    }
    await route.fulfill({ json: { reminder } });
  });

  const trigger = page.getByRole('button', { name: 'التذكيرات', exact: true });
  const dialog = page.getByRole('dialog', { name: 'التذكيرات' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  try {
    await expect(dialog.getByText('جارٍ تحميل التذكيرات…')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'إغلاق التذكيرات' })).toBeFocused();
  } finally {
    rejectList();
  }
  await expect(dialog.getByRole('alert')).toContainText('تعذّر تحميل التذكيرات.');
  await dialog.getByRole('button', { name: 'إعادة المحاولة' }).click();

  const edit = dialog.getByRole('button', { name: 'تعديل وقت اجتماع الفريق' });
  await edit.focus();
  await page.keyboard.press('Enter');
  const time = dialog.getByLabel(/الموعد الجديد/);
  await expect(time).toBeFocused();
  await expect(time).toHaveValue('2027-10-31T01:15');
  await time.fill('2027-10-31T01:30');
  await dialog.getByRole('button', { name: 'حفظ الوقت' }).click();
  await expect(dialog.getByRole('alert')).toContainText('اختر الموعد المقصود.');
  await expect(dialog.getByRole('radio', { name: 'المرة الأولى' })).toBeFocused();
  await dialog.getByRole('radio', { name: 'المرة الثانية' }).check();
  await dialog.getByRole('button', { name: 'حفظ الوقت' }).click();
  await expect(dialog.getByText('حُفظ الموعد الجديد.')).toBeVisible();
  await expect(edit).toBeFocused();
  await expect(dialog.locator('time')).toHaveAttribute('datetime', reminder.dueAt);

  await dialog.getByRole('button', { name: 'إلغاء تذكير اجتماع الفريق' }).click();
  await expect(dialog.getByText('أُلغي التذكير.')).toBeVisible();
  await expect(dialog.getByText('لا توجد تذكيرات مجدولة.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'إغلاق التذكيرات' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  const deliveredAt = new Date(Date.parse(conversation.updatedAt) + 60_000).toISOString();
  const delivery: ReminderDeliverySummary = {
    id: randomUUID(), reminderId: reminder.id, conversationId: conversation.id,
    text: 'الاتصال بسامي', timeZone: reminder.timeZone, dueAt: conversation.updatedAt, deliveredAt, late: true,
  };
  await page.route(`**/api/chat/conversations/${conversation.id}`, async (route) => {
    const original = await route.fetch();
    const snapshot: ChatConversation = await original.json();
    await route.fulfill({
      response: original,
      json: { ...snapshot, updatedAt: deliveredAt, messages: [...snapshot.messages, {
        id: delivery.id, role: 'assistant', text: 'تذكير: الاتصال بسامي', createdAt: deliveredAt,
      }] },
    });
  });
  deliveries.push(delivery);
  await page.clock.fastForward(30_000);
  await expect(thread.getByText('تذكير: الاتصال بسامي')).toBeVisible();
  await trigger.click();
  await expect(dialog.getByText(/متأخر/)).toBeVisible();
  await dialog.getByRole('button', { name: 'فتح محادثة تذكير الاتصال بسامي' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(thread.getByText('تذكير: الاتصال بسامي')).toBeVisible();
});
