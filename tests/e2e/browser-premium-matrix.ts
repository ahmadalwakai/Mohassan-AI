import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { browserLiveBudget, type BrowserPremiumTarget } from '@mohassan/contracts';

const pageFixture = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>بوابة الحساب</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #eaf1ee; color: #20372f; font: 22px Arial, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 24px 50px; background: #183d32; color: #fff; }
  #mark { display: grid; align-items: center; justify-content: center; width: 38px; height: 38px; background: #d9ece1; color: #183d32; border-radius: 10px; font-weight: bold; }
  main { width: 680px; margin: 52px auto; padding: 24px 38px 36px; background: white; border-radius: 20px; box-shadow: 0 12px 35px #183d3214; }
  h1 { margin: 6px 0 10px; font-size: 34px; }
  p { margin: 0 0 22px; color: #406154; }
  label { display: block; margin-bottom: 16px; font-weight: bold; }
  input { width: 100%; margin-top: 8px; padding: 12px; border: 2px solid #acc5b8; border-radius: 8px; font: inherit; }
  button { padding: 13px 30px; border: 0; background: #1f694f; border-radius: 8px; color: #fff; font: inherit; }
</style>
<header><span id="mark" aria-hidden="true">ب</span> بوابة الحساب</header>
<main><h1>تسجيل الدخول</h1><p id="help">تابع إلى حسابك للوصول إلى تفاصيل الطلب.</p>
<form><label>البريد الإلكتروني <input type="email" placeholder="you@example.test"></label>
<label>كلمة المرور <input type="password" placeholder="••••••••"></label><button>دخول</button></form></main></html>`;

let frames: Buffer[];
let favicon: Buffer;
const attentionFrames = new Map<string, { image: Buffer; target: BrowserPremiumTarget }>();
const viewports = { small: { width: 390, height: 844 }, medium: { width: 768, height: 900 } } as const;
type Size = keyof typeof viewports;
type Matrix = { theme: 'light' | 'dark'; dir: 'rtl' | 'ltr'; size: Size };
const componentSelector = (id: string) => `[data-testid="${id}"]`;
const viewId = 'browser-live-view';
const briefId = 'browser-premium-brief';
const dialogId = 'browser-premium-dialog';

test.beforeAll(async ({ browser }) => {
  const documentPage = await browser.newPage({ viewport: browserLiveBudget.viewport, deviceScaleFactor: 1 });
  try {
    await documentPage.setContent(pageFixture);
    const first = await documentPage.screenshot({ type: 'jpeg', quality: 72 });
    favicon = await documentPage.locator('#mark').screenshot({ type: 'png' });
    const saveTarget = async (state: string, locator: Locator, image: Buffer) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`Fixture target missing in ${state}`);
      const { width, height } = browserLiveBudget.viewport;
      attentionFrames.set(state, { image, target: { x: box.x / width, y: box.y / height, width: box.width / width, height: box.height / height } });
    };
    const maskedFrame = () => documentPage.screenshot({ type: 'jpeg', quality: 72, mask: [documentPage.locator('input')], maskColor: '#364052' });
    await saveTarget('login', documentPage.getByRole('textbox', { name: 'البريد الإلكتروني' }), await maskedFrame());
    await documentPage.locator('#help').evaluate(element => { element.textContent = 'صفحة الدخول إلى حسابك جاهزة.'; });
    const second = await documentPage.screenshot({ type: 'jpeg', quality: 72 });
    frames = [first, second];

    await documentPage.setContent(pageFixture.replace('تسجيل الدخول</h1>', 'التحقق من الحساب</h1>')
      .replace('تابع إلى حسابك للوصول إلى تفاصيل الطلب.', 'أرسلنا رمزًا إلى هاتفك.')
      .replace(/<form>.*?<\/form>/s, '<form><label>رمز التحقق <input inputmode="numeric" autocomplete="one-time-code"></label><button>تحقق</button></form>'));
    await saveTarget('code', documentPage.getByRole('textbox', { name: 'رمز التحقق' }), await maskedFrame());

    await documentPage.setContent(pageFixture.replace('تسجيل الدخول</h1>', 'تأكيد الطلب</h1>')
      .replace('تابع إلى حسابك للوصول إلى تفاصيل الطلب.', 'راجع رقم الطلب قبل الإرسال.')
      .replace(/<form>.*?<\/form>/s, '<form><label>رقم الطلب <input type="text"></label><button>إرسال</button></form>'));
    await saveTarget('hands', documentPage.getByRole('textbox', { name: 'رقم الطلب' }), await maskedFrame());
    await saveTarget('approval', documentPage.getByRole('button', { name: 'إرسال' }), await documentPage.screenshot({ type: 'jpeg', quality: 72 }));
  } finally {
    await documentPage.close();
  }
});

async function routeFrames(page: Page, animate = false) {
  let frameCount = 0;
  await page.route('**/browser-premium-favicon.png', route => route.fulfill({ contentType: 'image/png', body: favicon }));
  await page.route('**/api/chat/conversations/*/browser/activity', route => route.fulfill({ json: null }));
  await page.route('**/api/chat/conversations/*/screen?liveView=1', route => {
    const state = new URL(page.url()).searchParams.get('state') ?? '';
    const body = attentionFrames.get(state)?.image ?? frames[animate ? frameCount % frames.length : 0];
    frameCount++;
    return route.fulfill({ contentType: 'image/jpeg', body });
  });
  return () => frameCount;
}

async function openState(page: Page, config: Matrix, state: string) {
  const query = new URLSearchParams({ state, size: config.size, dir: config.dir });
  const target = attentionFrames.get(state)?.target;
  if (target) query.set('target', JSON.stringify(target));
  await page.goto(`/browser-premium-matrix?${query}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('dir', config.dir);
  const view = page.getByTestId(viewId);
  if (state.startsWith('brief')) return page.getByTestId(briefId);
  await expect(view).toBeVisible();
  if (await view.getAttribute('data-mode') !== config.size) {
    await view.getByRole('button', { name: config.size === 'small' ? 'تصغير المشاهدة الحية' : 'تكبير المشاهدة الحية' }).click();
  }
  await expect(view).toHaveAttribute('data-mode', config.size);
  await expect.poll(() => view.getByTestId('browser-live-view-frame').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  return view;
}

async function audit(page: Page, id: string, scenario: string) {
  const { violations } = await new AxeBuilder({ page }).include(componentSelector(id)).analyze();
  expect(violations.filter(item => item.impact === 'serious' || item.impact === 'critical').map(item => ({
    id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target),
  })), `Serious or critical axe violations in ${scenario}`).toEqual([]);
}

async function snapshot(page: Page, component: Locator, config: Matrix, state: string, id = viewId) {
  const label = `${config.theme}-${config.dir}-${config.size}-${state}`;
  await expect(component).toBeVisible();
  const hasAlexandria = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(face => face.status === 'loaded' && /alexandria/i.test(face.family) && !/fallback/i.test(face.family));
  });
  expect(hasAlexandria, 'The screenshot uses the real Alexandria typeface').toBe(true);
  const bytes = await component.screenshot({ type: 'jpeg', quality: 80, animations: 'disabled', caret: 'hide', scale: 'css' });
  expect(bytes.byteLength, `JPEG bytes for ${label}`).toBeLessThan(60 * 1024);
  expect(bytes).toMatchSnapshot(`${label}.jpg`, { maxDiffPixelRatio: .003 });
  await audit(page, id, label);
}

for (const theme of ['light', 'dark'] as const) {
  for (const dir of ['rtl', 'ltr'] as const) {
    for (const size of ['small', 'medium'] as const) {
      const config = { theme, dir, size } satisfies Matrix;
      test(`${theme} ${dir} ${size} visual and accessibility states`, async ({ page }) => {
        await page.setViewportSize(viewports[size]);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await routeFrames(page);

        for (const state of ['brief', 'brief-read', 'opening', 'loading', 'reading', 'typing', 'login', 'code', 'hands', 'approval', 'resumed', 'done', 'failed']) {
          await test.step(state, async () => {
            const surface = await openState(page, config, state);
            if (!state.startsWith('brief')) {
              const status = ['login', 'code', 'hands', 'approval'].includes(state) ? 'waiting'
                : ['typing', 'done', 'failed'].includes(state) ? state : 'reading';
              await expect(surface.getByTestId('browser-premium-status')).toHaveAttribute('data-status', status);
            }
            if (attentionFrames.has(state)) await expect(surface.getByTestId('browser-premium-target')).toBeVisible();
            await snapshot(page, surface, config, state, state.startsWith('brief') ? briefId : viewId);
          });
        }

        const reading = await openState(page, config, 'reading');
        const timeline = reading.getByTestId('browser-premium-timeline');
        const timelineButton = timeline.getByRole('button');
        await timelineButton.hover();
        await expect(timelineButton).toHaveAttribute('aria-expanded', 'true');
        await page.mouse.move(0, 0);
        await expect(timelineButton).toHaveAttribute('aria-expanded', 'false');
        await timelineButton.click();
        await snapshot(page, reading, config, 'timeline');
        await timelineButton.click();

        const show = reading.getByRole('button', { name: 'أرني', exact: true });
        await show.click();
        const dialog = page.getByTestId(dialogId);
        await snapshot(page, dialog, config, 'dialog', dialogId);
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        for (let index = 0; index < 7; index++) {
          await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab');
          expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(show).toBeFocused();

        await reading.getByRole('button', { name: 'طي المشاهدة الحية', exact: true }).click();
        await expect(reading).toHaveAttribute('data-mode', 'pill');
        await snapshot(page, reading, config, 'pill');

        const takeover = await openState(page, config, 'login');
        await takeover.getByRole('button', { name: 'تولَّ التحكم', exact: true }).click();
        const keyboard = takeover.getByLabel('الكتابة في صفحة المتصفح');
        await expect(keyboard).toHaveAttribute('type', 'password');
        await expect(keyboard).toBeFocused();
        const target = await takeover.getByTestId('browser-premium-target').boundingBox();
        if (!target) throw new Error('The user cursor needs a visible target');
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
        await snapshot(page, takeover, config, 'takeover');
        await takeover.getByRole('button', { name: 'أعد التحكم', exact: true }).click();
        await expect(keyboard).toHaveCount(0);
      });
    }
  }
}

test('Chromium maintains a 60 fps animation target while live frames cross-fade', async ({ page }, testInfo) => {
  const config = { theme: 'light', dir: 'rtl', size: 'medium' } satisfies Matrix;
  await page.setViewportSize(viewports.medium);
  await page.emulateMedia({ colorScheme: config.theme, reducedMotion: 'no-preference' });
  const framesReceived = await routeFrames(page, true);
  const view = await openState(page, config, 'reading');
  await page.bringToFront();
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect(view.locator('img[data-ready="true"]')).toHaveCount(2);
  const ring = view.getByTestId('browser-premium-status').locator(':scope > span:has(svg)');
  await expect(ring).toHaveCSS('animation-duration', '1.8s');
  const before = framesReceived();
  const metrics = await view.evaluate(element => new Promise<{
    fps: number; p95FrameMs: number; updates: number; transitions: number; durationMs: number;
  }>(resolve => {
    let updates = 0;
    let transitions = 0;
    const countTransition = (event: Event) => {
      if (event.target instanceof HTMLImageElement) transitions++;
    };
    element.addEventListener('animationstart', countTransition);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if ((record.target as Element).matches('img[data-current="true"]')) updates++;
      }
    });
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ['data-current'] });
    const intervals: number[] = [];
    let started = 0;
    let previous = 0;
    const measure = (now: number) => {
      if (!started) started = now;
      if (previous) intervals.push(now - previous);
      previous = now;
      const durationMs = now - started;
      if (durationMs < 3_000) {
        requestAnimationFrame(measure);
        return;
      }
      observer.disconnect();
      element.removeEventListener('animationstart', countTransition);
      const p95 = intervals.toSorted((a, b) => a - b)[Math.ceil(intervals.length * .95) - 1];
      resolve({ fps: +(1_000 * intervals.length / durationMs).toFixed(2), p95FrameMs: +p95.toFixed(2), durationMs, updates, transitions });
    };
    requestAnimationFrame(measure);
  }));
  const result = { targetFps: 60, ...metrics, deliveredFrames: framesReceived() - before };
  await testInfo.attach('chromium-animation-fps', { contentType: 'application/json', body: JSON.stringify(result, null, 2) });
  console.log(`Chromium animation ${JSON.stringify(result)}`);
  expect(result.deliveredFrames).toBeGreaterThanOrEqual(8);
  expect(result.updates).toBeGreaterThanOrEqual(8);
  expect(result.transitions).toBeGreaterThanOrEqual(8);
  expect(result.fps).toBeGreaterThanOrEqual(57);
  expect(result.p95FrameMs).toBeLessThanOrEqual(25);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(ring).toHaveCSS('animation-name', 'none');
  await expect(view.getByTestId('browser-live-view-frame')).toHaveCSS('animation-name', 'none');
});
