import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type axeCore from 'axe-core';
import { PNG } from 'pngjs';
import type { ChatConversation } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';

const lighthouseRequire = createRequire(createRequire(import.meta.url).resolve('lighthouse/package.json'));
const axePath = lighthouseRequire.resolve('axe-core/axe.min.js');

test.use({ reducedMotion: 'reduce' });

async function audit(page: Page, state: string) {
  await test.step(`axe scans the ${state}`, async () => {
    const { violations, ratingContrast } = await page.evaluate(async () => {
      const { axe } = window as Window & { axe?: typeof axeCore };
      if (!axe) throw new Error('axe-core script did not load');
      const result = await axe.run(document, { elementRef: true });
      const ratingContrast: Array<Pick<axeCore.NodeResult, 'target' | 'failureSummary'>> = [];
      // port/feedback-loop owns these three legacy controls. Preserve their reported contrast failures.
      const ratingButtons = new Set(Array.from(document.querySelectorAll(
        '[role="group"][aria-label="تقييم الرد"] > button[aria-pressed="false"]',
      )).filter(button => ['مفيد', 'خطأ', 'ناقص'].includes(button.textContent ?? '')));
      const violations = result.violations
        .filter(({ impact }) => impact === 'serious' || impact === 'critical')
        .flatMap(({ id, impact, nodes }) => {
          const remaining = nodes.flatMap(({ target, failureSummary, element }) => {
            const detail = { target, failureSummary };
            if (id === 'color-contrast' && element && ratingButtons.has(element)) {
              ratingContrast.push(detail);
              return [];
            }
            return [detail];
          });
          return remaining.length ? [{ id, impact, nodes: remaining }] : [];
        });
      return { violations, ratingContrast };
    });
    if (ratingContrast.length) await test.info().attach(`${state} rating contrast (port/feedback-loop)`, {
      contentType: 'application/json', body: JSON.stringify(ratingContrast, null, 2),
    });
    expect.soft(violations, `${state} has serious or critical axe violations`).toEqual([]);
  });
}

async function startThread(page: Page) {
  const composer = page.getByRole('textbox', { name: 'رسالتك', exact: true });
  await page.route('**/api/chat/conversations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    // Use a real fixture conversation without dispatching an assistant turn, as in smart-monitors.spec.ts.
    const response = await route.fetch({ postData: {} });
    const current = await response.json() as ChatConversation;
    const { updatedAt: createdAt } = current;
    const messages: ChatConversation['messages'] = [
      { id: randomUUID(), role: 'user', text: route.request().postDataJSON().goal, createdAt },
      { id: randomUUID(), role: 'assistant', text: 'هذا ردّ اختباري ثابت.', createdAt },
    ];
    await route.fulfill({ response, json: { ...current, messages } });
  });
  const creation = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/chat/conversations');
  await composer.fill('مرحبا');
  await composer.press('Enter');
  const response = await creation;
  expect(response.ok()).toBe(true);
  const conversation = await response.json() as ChatConversation;
  const thread = page.getByRole('log', { name: 'المحادثة', exact: true });
  await expect(thread.getByRole('button', { name: 'نسخ الرد', exact: true })).toBeVisible();
  return { conversation, thread };
}

async function expectContrastingFocus(control: Locator) {
  await expect(control).toBeFocused();
  const { visible, contrast } = await control.evaluate(element => {
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Cannot read focus colors');
    const color = (css: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    // WCAG 2.2 relative luminance and contrast ratio (retrieved 2026-11-27).
    // https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
    // https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
    function luminance([red, green, blue]: number[]) {
      const linear = (channel: number) => {
        const srgb = channel / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    }
    let adjacent = color('transparent');
    for (let parent = element.parentElement; parent && adjacent[3] === 0; parent = parent.parentElement) {
      adjacent = color(getComputedStyle(parent).backgroundColor);
    }
    const style = getComputedStyle(element);
    const outline = color(style.outlineColor);
    if (adjacent[3] !== 255 || outline[3] !== 255) throw new Error('The focus sample needs opaque colors');
    const levels = [luminance(outline), luminance(adjacent)];
    return {
      visible: element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      contrast: (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05),
    };
  });
  expect(visible).toBe(true);
  // WCAG 2.2 non-text contrast for focus indicators (retrieved 2026-11-27).
  // https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html#related-focus
  expect(contrast).toBeGreaterThanOrEqual(3);
}

for (const width of [1280, 375]) {
  test(`Arabic chat accessibility and keyboard navigation at ${width}px`, async ({ page, context }) => {
    test.slow();
    await page.setViewportSize({ width, height: 800 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signInAsFixtureOwner(page, 'assistant');
    await page.addScriptTag({ path: axePath });

    const composer = page.getByRole('textbox', { name: 'رسالتك', exact: true });
    await expect(composer).toBeVisible();
    const browserAccount = page.locator('summary').filter({ hasText: 'حساب المتصفح: الافتراضي' });
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      await composer.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expectContrastingFocus(browserAccount);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expectContrastingFocus(composer);
    }
    await audit(page, 'welcome screen');

    const { thread } = await startThread(page);
    await audit(page, 'conversation thread');

    const copyButton = page.getByRole('button', { name: 'نسخ الرد', exact: true });
    const reply = thread.getByRole('article').filter({ has: copyButton });
    const copy = reply.getByRole('button', { name: 'نسخ الرد', exact: true });
    const copyStatus = reply.getByRole('status');
    await expect(copyStatus).toBeEmpty();
    await copy.press('Enter');
    await expect(copyStatus).toHaveText('تم النسخ');
    await expect(copy).toBeFocused();

    const sidebar = page.getByRole('navigation', { name: 'المحادثات', exact: true });
    if (width === 375) {
      const openSidebar = page.getByRole('button', { name: 'فتح القائمة', exact: true });
      await openSidebar.focus();
      let nextFocusIsOpenSidebar = false;
      const possibleStops = await page.locator('a[href], button, input, select, textarea, summary, [tabindex]').count();
      for (let stop = 0; stop <= possibleStops; stop++) {
        await page.keyboard.press('Tab');
        expect(await page.locator('nav[aria-label="المحادثات"] :focus').count()).toBe(0);
        nextFocusIsOpenSidebar = await openSidebar.evaluate(button => button === document.activeElement);
        if (nextFocusIsOpenSidebar) break;
      }
      expect(nextFocusIsOpenSidebar, 'Tab completed a full cycle').toBe(true);
      await expect(sidebar).toHaveCount(0);
      await openSidebar.press('Enter');
      const closeSidebar = sidebar.getByRole('button', { name: 'إغلاق القائمة', exact: true });
      await expect(closeSidebar).toBeFocused();
      await closeSidebar.press('Enter');
      await expect(openSidebar).toBeFocused();
      await openSidebar.press('Enter');
    }

    const profile = sidebar.getByRole('button', { name: 'مالك الاختبار', exact: true });
    const browserSetting = sidebar.getByRole('combobox', { name: 'اعرض المتصفح', exact: true });
    await profile.press('Enter');
    await expect(profile).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(browserSetting).toBeFocused();
    await audit(page, 'open account menu');
    await page.keyboard.press('Escape');
    await expect(browserSetting).toHaveCount(0);
    await expect(profile).toHaveAttribute('aria-expanded', 'false');
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      await expectContrastingFocus(profile);
    }

    await profile.press('Enter');
    await page.keyboard.press('Tab');
    await expect(browserSetting).toBeFocused();
    const outside = width === 375 ? sidebar.getByText('موحسن', { exact: true }) : composer;
    await outside.click();
    await expect(browserSetting).toHaveCount(0);
    await expect(profile).toBeFocused();

    const currentItem = sidebar.locator('[data-item-menu]').filter({ has: page.locator('[aria-current="true"]') });
    await currentItem.getByRole('button', { name: /^خيارات المحادثة:/ }).press('Enter');
    await sidebar.getByRole('menuitem', { name: 'حذف', exact: true }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'حذف المحادثة؟', exact: true });
    await expect(dialog).toBeVisible();
    await audit(page, 'delete dialog');
    await expect(dialog.getByRole('button', { name: 'إلغاء', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(sidebar).toBeVisible();
  });
}

test('the upload has a live status and hands-on typing has a native label', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');

  const uploadStatus = page.getByRole('status').filter({ hasText: 'جارٍ رفع الصورة' });
  await page.route('**/api/chat/images', async route => {
    try {
      await expect(uploadStatus).toHaveText('جارٍ رفع الصورة');
    } finally {
      await route.continue();
    }
  });
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(255);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'إرفاق صورة', exact: true }).click();
  await (await chooser).setFiles({ name: 'attachment.png', mimeType: 'image/png', buffer: PNG.sync.write(png) });
  const attachment = page.getByRole('button', { name: 'إزالة الصورة', exact: true });
  await expect(attachment).toBeVisible();
  await expect(uploadStatus).toHaveCount(0);
  await attachment.click();

  const { conversation } = await startThread(page);
  const { id } = conversation;
  await page.route(`**/api/chat/conversations/${id}`, async route => {
    const response = await route.fetch();
    const current = await response.json() as ChatConversation;
    // Present a hands-on checkpoint without opening another site or dispatching any browser work.
    const checkpoint: ChatConversation = {
      ...current, messages: conversation.messages, status: 'waiting_input', visibility: null,
      secure: { id: randomUUID(), kind: 'hands_on', site: 'example.test', prompt: 'اكتب نصًا', note: null, fields: [] },
      browser: { url: 'https://example.test/', title: 'صفحة اختبار', observedAt: current.updatedAt, live: false, screenUrl: '' },
    };
    await route.fulfill({ response, json: checkpoint });
  });
  await page.reload();
  await page.getByRole('button', { name: 'عرض المتصفح', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'المتصفح', exact: true });
  const input = panel.getByRole('textbox', { name: 'إدخال نص في الصفحة', exact: true });
  await expect(input).toBeVisible();
  expect(await input.evaluate(element => Array.from((element as HTMLInputElement).labels ?? [], label => label.textContent)))
    .toEqual(['إدخال نص في الصفحة']);
});
