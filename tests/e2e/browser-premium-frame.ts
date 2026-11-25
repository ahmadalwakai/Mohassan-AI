import { expect, test } from '@playwright/test';

test('the frame keeps its decoded image through a corrupt update and maps takeover to the highlighted target', async ({ page }) => {
  await page.setContent('<body style="margin:0;background:#e9eee7"><main style="margin:24px;padding:24px;background:white">Browser fixture</main></body>');
  const jpeg = await page.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 320, height: 200 } });
  let corrupt = false;
  let corruptUpdates = 0;
  await page.route('**/screen?liveView=1', (route) => {
    if (corrupt) corruptUpdates++;
    return route.fulfill({ contentType: 'image/jpeg', body: corrupt ? 'Corrupt fixture' : jpeg });
  });
  await page.route('**/browser/activity', (route) => route.fulfill({ json: null }));
  await page.route('**/browser/pointer', (route) => route.fulfill({ status: 204 }));

  await page.goto('/browser-premium-matrix?state=login&size=medium');
  const live = page.getByTestId('browser-live-view');
  const viewport = live.getByTestId('browser-premium-frame');
  const active = viewport.getByTestId('browser-live-view-frame');
  const target = viewport.getByTestId('browser-premium-target');
  const error = viewport.getByRole('status', { name: '' }).filter({ hasText: 'تعذّر تحديث المشاهدة.' });
  await expect(active).toBeVisible();
  await expect(viewport.locator('img[data-ready="true"]')).toHaveCount(2);
  corrupt = true;
  await expect(error).toBeVisible();
  const lastDecoded = await active.getAttribute('src');
  expect(lastDecoded).toMatch(/^blob:/);
  await expect.poll(() => corruptUpdates).toBeGreaterThanOrEqual(2);
  await expect(active).toHaveAttribute('src', lastDecoded!);
  await expect(active).toBeVisible();
  expect(await active.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  corrupt = false;
  await expect(error).toHaveCount(0);
  await expect(active).not.toHaveAttribute('src', lastDecoded!);

  const viewportBox = await viewport.boundingBox();
  const targetBox = await target.boundingBox();
  expect(viewportBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  expect((targetBox!.x - viewportBox!.x) / viewportBox!.width).toBeCloseTo(.25, 2);
  expect((targetBox!.y - viewportBox!.y) / viewportBox!.height).toBeCloseTo(.355, 2);
  expect(targetBox!.width / viewportBox!.width).toBeCloseTo(.5, 2);
  expect(targetBox!.height / viewportBox!.height).toBeCloseTo(.24, 2);

  await live.getByRole('button', { name: 'تولَّ التحكم', exact: true }).click();
  const click = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/browser/pointer') && request.method() === 'POST');
  await viewport.press('Enter');
  const point = (await click).postDataJSON();
  expect(point.x).toBeCloseTo(.5, 3);
  expect(point.y).toBeCloseTo(.475, 3);
  await expect(viewport.locator('[data-user-cursor]')).toBeVisible();
  await expect(live.getByLabel('الكتابة في صفحة المتصفح')).toBeFocused();
});

test('the timeline opens on hover and the wide modal keeps the coach and focus beside the frame', async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 860 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/screen?liveView=1', route => route.fulfill({ status: 503 }));
  await page.route('**/browser/activity', route => route.fulfill({ json: null }));
  await page.goto('/browser-premium-matrix?state=login&size=medium');
  const view = page.getByTestId('browser-live-view');
  const timeline = view.getByTestId('browser-premium-timeline').getByRole('button');
  const show = view.getByRole('button', { name: 'أرني', exact: true });

  await timeline.hover();
  await expect(timeline).toHaveAttribute('aria-expanded', 'true');
  await show.hover();
  await expect(timeline).toHaveAttribute('aria-expanded', 'false');
  await show.click();

  const dialog = page.getByTestId('browser-premium-dialog');
  await expect(dialog).toBeVisible();
  const frame = await dialog.getByTestId('browser-premium-frame').boundingBox();
  const coach = await dialog.getByTestId('browser-premium-coach').boundingBox();
  if (!frame || !coach) throw new Error('The expanded frame and coach must both be visible.');
  expect(frame.y).toBeCloseTo(coach.y, 0);
  expect(frame.x + frame.width <= coach.x || coach.x + coach.width <= frame.x).toBe(true);

  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(show).toBeFocused();
});
