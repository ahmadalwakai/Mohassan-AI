import { expect, test, type Page, type Request } from '@playwright/test';
import type { SiteSummary } from '@mohassan/contracts';
import { signInAsFixtureOwner, submitFixtureSignIn } from './helpers';

// Composer, quota and publish labels from the production baseline, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/web/components/assistant-app.tsx#L653-L673
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/web/components/members.tsx#L202-L204
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/web/components/sites-workspace.tsx#L219
const isImageUpload = (request: Request) => new URL(request.url()).pathname === '/api/chat/images' && request.method() === 'POST';
const composer = (page: Page) => page.getByRole('textbox', { name: 'رسالتك' });

async function transferImage(page: Page, event: 'paste' | 'drop', name: string) {
  await composer(page).evaluate(async (element, { event, name }) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(image => image ? resolve(image) : reject(new Error('Could not encode the fixture PNG.')));
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], name, { type: 'image/png' }));
    element.dispatchEvent(event === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { event, name });
}

test('the owner can paste and drop a chat image, and a new chat clears attachments', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('button', { name: 'إرفاق صورة' })).toBeVisible();

  const pasted = page.waitForResponse(response => isImageUpload(response.request()));
  await transferImage(page, 'paste', 'pasted.png');
  expect((await pasted).ok()).toBe(true);
  await expect(page.getByRole('img', { name: 'pasted.png' })).toBeVisible();

  let releaseUpload!: () => void;
  const uploadHeld = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/chat/images', async route => {
    await uploadHeld;
    await route.continue();
  }, { times: 1 });
  const dropping = page.waitForRequest(isImageUpload);
  const dropped = page.waitForResponse(response => isImageUpload(response.request()));
  try {
    await transferImage(page, 'drop', 'dropped-before-reset.png');
    await dropping;
    await page.getByRole('button', { name: 'محادثة جديدة' }).click();
    await expect(page.getByRole('img', { name: 'pasted.png' })).toHaveCount(0);
  } finally {
    releaseUpload();
  }
  expect((await dropped).ok()).toBe(true);

  const pastedAfterReset = page.waitForResponse(response => isImageUpload(response.request()));
  await transferImage(page, 'paste', 'pasted-after-reset.png');
  expect((await pastedAfterReset).ok()).toBe(true);
  await expect(page.getByRole('img', { name: 'pasted-after-reset.png' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'dropped-before-reset.png' })).toHaveCount(0);
});

test('an invited member uses chat and selected sites without owner controls and sees current quota', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signInAsFixtureOwner(page, 'assistant');
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const name = 'عضو اختبار الصلاحيات';
  const email = 'member-honest-ui@example.test';
  const password = 'Member-Honest-UI-Fixture-42';
  const invited = await page.request.post('/api/members/invites', { headers, data: { name, email } });
  expect(invited.ok()).toBe(true);
  const { url } = await invited.json();
  const token = new URL(url).hash.slice('#invite='.length);
  const ownerSites = await page.request.get('/api/sites');
  expect(ownerSites.ok()).toBe(true);
  expect((await ownerSites.json()).publish).toEqual({ available: true, provider: 'vercel' });

  const guest = await browser.newContext({ baseURL: origin });
  try {
    const accepted = await guest.request.post('/api/invites/accept', { headers, data: { token, name, password } });
    expect(accepted.ok()).toBe(true);
    const member = await guest.newPage();
    await member.goto('/');
    await member.getByLabel('البريد الإلكتروني').fill(email);
    await member.getByLabel('كلمة المرور', { exact: true }).fill(password);
    await submitFixtureSignIn(member);
    await expect(composer(member)).toBeVisible();
    await expect(member.getByRole('button', { name: 'إرفاق صورة' })).toHaveCount(0);

    const memberUploadAttempts: string[] = [];
    member.on('request', request => { if (isImageUpload(request)) memberUploadAttempts.push(request.url()); });
    await transferImage(member, 'paste', 'member-paste.png');
    await transferImage(member, 'drop', 'member-drop.png');

    const access = await guest.request.get('/api/access');
    expect(access.ok()).toBe(true);
    const { quota } = await access.json();
    for (const siteName of ['موقع اختبار الصيانة', 'موقع اختبار التنظيف']) {
      const created = await guest.request.post('/api/sites/draft', { headers, data: {
        lang: 'ar', kind: 'services', name: siteName,
        answers: { items: 'صيانة المنازل - 100 ريال', contact: '0501234567 واتساب' },
      } });
      expect(created.ok()).toBe(true);
      expect((await created.json()).id).toBeTruthy();
    }
    const siteList = await guest.request.get('/api/sites');
    expect(siteList.ok()).toBe(true);
    const { sites }: { sites: SiteSummary[] } = await siteList.json();
    expect(sites).toHaveLength(2);
    const [defaultSite, linkedSite] = sites;
    await member.evaluate(id => { location.hash = `sites=${id}`; }, linkedSite.id);
    const linkedPreview = member.getByTitle(`معاينة ${linkedSite.name}`);
    await expect(linkedPreview).toBeVisible();
    await member.reload();
    await expect(linkedPreview).toBeVisible();
    await expect(member.getByRole('button', { name: new RegExp(defaultSite.name) })).toBeVisible();
    await expect(member.getByRole('button', { name: 'نشر', exact: true })).toHaveCount(0);
    const quotaText = (used: number) => `استخدمت ${used} من ${quota.dailyRuns} طلبًا خلال 24 ساعة`;
    await expect(member.getByText(quotaText(quota.used))).toBeVisible();

    await member.evaluate(id => { location.hash = `sites=${id}`; }, defaultSite.id);
    await expect(member.getByTitle(`معاينة ${defaultSite.name}`)).toBeVisible();
    await member.getByRole('button', { name: /العودة إلى المحادثة/ }).click();
    const submitted = member.waitForResponse(response => response.url().endsWith('/api/chat/conversations') && response.request().method() === 'POST');
    const refreshed = member.waitForResponse(async response => response.url().endsWith('/api/access') && response.ok() && (await response.json()).quota?.used === quota.used + 1);
    const greeting = 'مرحبا';
    await composer(member).fill(greeting);
    await composer(member).press('Enter');
    expect((await submitted).ok()).toBe(true);
    await refreshed;
    await expect(member.getByRole('log')).toContainText(greeting);
    expect(memberUploadAttempts).toEqual([]);

    await member.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name }).click();
    await member.getByRole('button', { name: 'الأدوات المتقدمة' }).click();
    await expect(member.getByText(quotaText(quota.used + 1))).toBeVisible();
  } finally {
    await guest.close();
  }
});
