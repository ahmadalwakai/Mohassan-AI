import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

async function send(page: Page, text: string) {
  const accepted = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/chat\/conversations(?:\/[^/]+\/messages)?$/.test(new URL(response.url()).pathname));
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(text);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  const { id } = await response.json();
  await expect.poll(async () => (await (await page.request.get(`/api/chat/conversations/${id}`)).json()).status,
    { timeout: 45_000 }).not.toBe('running');
  return id as string;
}

test('shows the real agent cursor moving between targets and recovers a failed screen frame', async ({ page }) => {
  test.setTimeout(120_000);
  const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Cursor fixture</title></head>
      <body style="margin:0;min-height:800px;font:20px Arial"><main>
      <button type="button" style="position:absolute;left:120px;top:140px;width:140px;height:60px" onclick="document.getElementById('result').textContent='تم اختيار البداية'">ابدأ</button>
      <label style="position:absolute;left:820px;top:430px">المدينة<input aria-label="المدينة" style="display:block;width:200px;height:40px"></label>
      <p id="result" style="position:absolute;left:120px;top:250px">صفحة اختبار المؤشر الحقيقي</p>
      </main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve); });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signInAsFixtureOwner(page, 'assistant');
    await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
    const id = await send(page, 'افتح http://127.0.0.1:4201/ ثم اضغط على «ابدأ»');
    const browser = page.getByRole('complementary', { name: 'المتصفح' });
    const cursor = browser.getByTestId('agent-cursor');
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveAttribute('data-action', 'click');
    const first = await cursor.evaluate(element => Number.parseFloat((element as HTMLElement).style.left));
    expect(first).toBeLessThan(35);
    const clickActivity = await (await page.request.get(`/api/chat/conversations/${id}/browser/activity`)).json();
    expect(clickActivity.cursor.action).toBe('click');
    expect(clickActivity.cursor.x).toBeCloseTo(190 / 1280, 2);
    const firstPixel = (await cursor.boundingBox())!.x;
    await cursor.evaluate(element => {
      const motion = { active: true, positions: [] as number[] };
      (window as unknown as { cursorMotion: typeof motion }).cursorMotion = motion;
      const sample = () => {
        if (!motion.active) return;
        motion.positions.push(element.getBoundingClientRect().left);
        requestAnimationFrame(sample);
      };
      sample();
    });
    await send(page, 'اكتب لندن في خانة المدينة');
    await expect(cursor).toHaveAttribute('data-action', 'type');
    const second = await cursor.evaluate(element => Number.parseFloat((element as HTMLElement).style.left));
    expect(second - first).toBeGreaterThan(35);
    const secondPixel = (await cursor.boundingBox())!.x;
    const motion = await page.evaluate(() => {
      const recorded = (window as unknown as { cursorMotion: { active: boolean; positions: number[] } }).cursorMotion;
      recorded.active = false;
      return recorded.positions;
    });
    expect(motion.some(x => x > firstPixel + 8 && x < secondPixel - 8), 'The cursor must visibly interpolate between the real targets.').toBe(true);
    await expect(browser.getByRole('img')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath('agent-cursor-desktop.png') });

    let screenRequests = 0;
    await page.route(`**/api/chat/conversations/${id}/screen?*`, async route => {
      screenRequests++;
      if (screenRequests === 1) await route.abort('failed');
      else await route.continue();
    });
    await page.reload();
    await expect.poll(() => screenRequests).toBeGreaterThan(1);
    await expect(browser.getByRole('img')).toBeVisible();
    await expect(cursor).toHaveAttribute('data-action', 'type');
    await expect(browser.getByRole('button', { name: 'إعادة تحميل المشاهدة' })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath('agent-cursor-mobile.png') });
    expect(errors).toEqual([]);
  } finally {
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('resumes the same browser task when scrolling replaces the observed button before input', async ({ page }) => {
  test.setTimeout(120_000);
  let clicks = 0;
  const site = createServer((request, response) => {
    if (request.url === '/clicked') { clicks++; response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Recovery fixture</title></head>
      <body><main><p>اختبار استئناف المهمة بعد تغير العنصر</p><div style="height:1400px"></div>
      <button id="continue" type="button" onclick="document.getElementById('result').textContent='اكتملت المتابعة';fetch('/clicked')">المتابعة</button>
      <p id="result"></p><div style="height:600px"></div></main>
      <script>addEventListener('scroll', () => {
        const button = document.getElementById('continue');
        button.replaceWith(button.cloneNode(true));
      }, { once: true });</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { site.once('error', reject); site.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve); });
  try {
    await signInAsFixtureOwner(page, 'assistant');
    await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
    const goal = 'افتح http://127.0.0.1:4201/ ثم اضغط على «المتابعة»';
    const id = await send(page, goal);
    const detail = await (await page.request.get(`/api/chat/conversations/${id}`)).json();
    expect(detail.error).toBeNull();
    expect(detail.status).toBe('idle');
    expect(detail.steps.some((step: { text: string }) => step.text.includes('إعادة قراءة المتصفح لمتابعة الطلب'))).toBe(true);
    expect(detail.question).toBeNull();
    await expect.poll(() => clicks).toBe(1);
    await expect(page.getByRole('log')).toContainText(goal);
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath('browser-automatic-resume.png') });
  } finally {
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});
