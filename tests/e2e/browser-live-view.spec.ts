import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { browserLiveBudget, type ChatConversation } from '@mohassan/contracts';
import { signInAsFixtureOwner } from './helpers';
import { E2E_WEB_PORT } from './isolation';

const siteOrigin = 'http://127.0.0.1:4201';
const fixtureInput = 'fixture-browser-input';
const fixtureAddress = 'browser-owner@example.test';
const privateTitle = 'محتوى الملف التجريبي';
const privatePage = `<!doctype html><html lang="ar"><meta charset="utf-8"><title>${privateTitle}</title>
  <body><h1>${privateTitle}</h1><p>تم تسجيل الدخول. نتيجة الاختبار تظهر هنا الآن.</p></body></html>`;

let site: Server;
let successfulSignIns = 0;
let loginPageVisits = 0;

test.beforeAll(async () => {
  test.setTimeout(200_000);
  site = createServer(async (request, response) => {
    if (request.url === '/session' && request.method === 'POST') {
      let form = '';
      for await (const chunk of request) form += chunk;
      const fields = new URLSearchParams(form);
      const accepted = fields.get('password') === fixtureInput && fields.get('email') === fixtureAddress;
      if (accepted) successfulSignIns++;
      response.writeHead(accepted ? 200 : 403, { 'content-type': 'text/html; charset=utf-8' });
      response.end(accepted ? privatePage : 'Invalid fixture input');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/login') loginPageVisits++;
    response.end(request.url === '/login' ? `<!doctype html><html lang="ar"><meta charset="utf-8"><title>Sign in</title>
      <body><h1>تسجيل الدخول</h1><form method="post" action="/session">
        <input name="email" aria-label="البريد الإلكتروني" type="email" autocomplete="username" required
          style="box-sizing:border-box;position:absolute;left:160px;top:148px;width:300px;height:44px">
        <input name="password" aria-label="كلمة المرور" type="password" autocomplete="current-password" required
          style="box-sizing:border-box;position:absolute;left:160px;top:218px;width:300px;height:44px">
        <button type="submit">دخول</button></form></body></html>` : `<!doctype html><html lang="ar"><meta charset="utf-8">
      <title>صفحة القياس</title><h1>صفحة الاختبار العامة</h1><p>تعمل الصفحة التجريبية في المتصفح المشترك.</p></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    site.once('error', reject);
    site.listen({ port: 4201, host: '127.0.0.1', exclusive: true }, resolve);
  });
  await fetch(`http://127.0.0.1:${E2E_WEB_PORT}/`, { signal: AbortSignal.timeout(170_000) }).then(response => response.text());
});

test.afterAll(async () => {
  await new Promise<void>(resolve => site.close(() => resolve()));
});

async function send(page: Page, text: string, inspectBrief?: () => Promise<void>): Promise<ChatConversation> {
  const accepted = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/chat\/conversations(?:\/[^/]+\/messages)?$/.test(new URL(response.url()).pathname));
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(text);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  await inspectBrief?.();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  return response.json();
}

async function detail(page: Page, id: string): Promise<ChatConversation> {
  const response = await page.request.get(`/api/chat/conversations/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

type FrameSample = { at: number; bytes: number };

function measureFrames(page: Page) {
  const frames = new Map<string, FrameSample[]>();
  page.on('requestfinished', async request => {
    const url = new URL(request.url());
    const match = /^\/api\/chat\/conversations\/([^/]+)\/screen$/.exec(url.pathname);
    if (!match || url.searchParams.get('liveView') !== '1') return;
    const response = await request.response();
    if (!response?.ok()) return;
    const { responseBodySize } = await request.sizes();
    const samples = frames.get(match[1]) ?? [];
    samples.push({ at: request.timing().startTime, bytes: responseBodySize });
    frames.set(match[1], samples);
  });
  return (id: string) => frames.get(id) ?? [];
}

function bandwidth(samples: FrameSample[]) {
  const ordered = [...samples].sort((first, second) => first.at - second.at);
  const elapsedSeconds = (ordered.at(-1)!.at - ordered[0].at) / 1000;
  const received = ordered.slice(1);
  return {
    samples: ordered.length,
    maxFrameBytes: Math.max(...ordered.map(sample => sample.bytes)),
    framesPerSecond: received.length / elapsedSeconds,
    jpegBytesPerSecond: received.reduce((total, sample) => total + sample.bytes, 0) / elapsedSeconds,
  };
}

test('a browser brief starts the work, then live sign-in automatically resumes the same run', async ({ page }, testInfo) => {
  const samplesFor = measureFrames(page);
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const publicRun = await send(page, `افتح ${siteOrigin}/ ثم اقرأ الصفحة`);
  const liveView = page.getByTestId('browser-live-view');
  await expect(liveView).toHaveAttribute('data-mode', 'small');
  await liveView.getByLabel('زاوية المشاهدة الحية').selectOption('bottom-right');
  await expect(liveView).toHaveAttribute('data-corner', 'bottom-right');
  const drag = liveView.getByRole('button', { name: 'نقل المشاهدة الحية بمفاتيح الأسهم' });
  const grip = await drag.boundingBox();
  if (!grip) throw new Error('Cannot position a drag on the live view');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(80, 80, { steps: 6 });
  await page.mouse.up();
  await expect(liveView).toHaveAttribute('data-corner', 'top-left');
  await drag.press('ArrowRight');
  await expect(liveView).toHaveAttribute('data-corner', 'top-right');
  await drag.press('ArrowLeft');
  await expect(liveView).toHaveAttribute('data-corner', 'top-left');
  await expect.poll(() => samplesFor(publicRun.id).length).toBeGreaterThanOrEqual(3);
  const small = bandwidth(samplesFor(publicRun.id));
  await liveView.getByRole('button', { name: 'طي المشاهدة الحية', exact: true }).click();
  await expect(liveView).toHaveAttribute('data-mode', 'pill');
  const pillWindowMs = 1200;
  await expect(page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === `/api/chat/conversations/${publicRun.id}/screen` && url.searchParams.get('liveView') === '1';
  }, { timeout: pillWindowMs })).rejects.toThrow('Timeout');

  await page.reload();
  await expect(liveView).toHaveAttribute('data-corner', 'top-left');
  await liveView.getByRole('button', { name: 'طي المشاهدة الحية', exact: true }).click();

  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  let manualContinuations = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/secure')) manualContinuations++;
  });
  const loginRun = await send(page, `افتح ${siteOrigin}/login ثم اقرأ الصفحة`, async () => {
    const brief = page.getByTestId('browser-premium-brief');
    await expect(brief).toBeVisible();
    await expect(brief).toContainText('127.0.0.1');
    await expect(brief).toContainText('تسجيل الدخول');
    expect(loginPageVisits).toBe(0);
    await brief.getByRole('button', { name: 'ابدأ', exact: true }).click();
    await expect(brief).toHaveCount(0);
  });
  expect(loginRun.status).toBe('running');
  await expect.poll(async () => (await detail(page, loginRun.id)).status, { timeout: 60_000 }).toBe('waiting_input');
  await expect.poll(async () => (await detail(page, loginRun.id)).browserPremium?.target).toBeTruthy();
  const waiting = await detail(page, loginRun.id);
  expect(waiting).toMatchObject({ visibility: { level: 3, code: 'needs_login' }, secure: { kind: 'login' } });
  expect(waiting.run?.id).toBeTruthy();
  await expect(liveView).toHaveAttribute('data-attention', 'needs_login');
  await expect(liveView).toHaveAttribute('data-mode', 'medium');
  await expect(liveView).toHaveAttribute('data-corner', 'top-left');
  const box = await liveView.boundingBox();
  expect(box?.x).toBeLessThan(64);
  expect(box?.y).toBeLessThan(64);
  const coach = liveView.getByTestId('browser-premium-coach');
  await expect(coach).toContainText('127.0.0.1:4201');
  await expect(coach).toContainText(/سجّل الدخول/u);
  await expect(coach.getByRole('button', { name: 'متابعة', exact: true })).toBeVisible();
  const target = liveView.getByTestId('browser-premium-target');
  await expect(target).toBeVisible();
  const { width, height } = browserLiveBudget.viewport;
  expect(waiting.browserPremium?.target).toMatchObject({ x: 160 / width, y: 148 / height, width: 300 / width });
  expect(waiting.browserPremium?.steps.map(step => step.kind)).toContain('handover');
  await expect.poll(() => liveView.evaluate(element => getComputedStyle(element).animationName)).not.toBe('none');
  await expect.poll(() => liveView.evaluate(element => getComputedStyle(element).animationIterationCount)).toBe('1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => liveView.evaluate(element => getComputedStyle(element).animationName)).toBe('none');

  const beforeMediumSample = samplesFor(loginRun.id).length;
  await expect.poll(() => samplesFor(loginRun.id).length - beforeMediumSample).toBeGreaterThanOrEqual(5);
  const medium = bandwidth(samplesFor(loginRun.id).slice(beforeMediumSample));
  expect(small.maxFrameBytes).toBeGreaterThan(0);
  expect(medium.maxFrameBytes).toBeGreaterThan(0);
  expect(small.maxFrameBytes).toBeLessThanOrEqual(browserLiveBudget.maxFrameBytes);
  expect(medium.maxFrameBytes).toBeLessThanOrEqual(browserLiveBudget.maxFrameBytes);
  // Request timestamps come from Chromium and can drift slightly from the scheduling clock.
  expect(small.framesPerSecond).toBeLessThanOrEqual(browserLiveBudget.framesPerSecond.small * 1.1);
  expect(medium.framesPerSecond).toBeLessThanOrEqual(browserLiveBudget.framesPerSecond.medium * 1.1);
  await testInfo.attach('frame-bandwidth', { contentType: 'application/json', body: JSON.stringify({ small, medium, pill: { frames: 0, windowMs: pillWindowMs } }, null, 2) });

  await liveView.getByRole('button', { name: 'تولَّ التحكم', exact: true }).click();
  const image = liveView.getByTestId('browser-live-view-frame');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const frame = await image.boundingBox();
  if (!frame) throw new Error('Cannot position a click on the live browser frame');
  // The email box is at 160–460 × 148–192 in the browser's 1280 × 800 viewport.
  const chromium = await page.context().newCDPSession(page);
  await chromium.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const wheel = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === 'POST' && new URL(request.url()).pathname === `/api/chat/conversations/${loginRun.id}/browser/keyboard`
      && request.postDataJSON().wheel?.deltaY > 0;
  });
  const touch = { x: frame.x + frame.width * 0.7, y: frame.y + frame.height * 0.7 };
  await chromium.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await chromium.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, y: touch.y - 48 }] });
  await chromium.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect((await wheel).ok()).toBe(true);
  const email = { x: frame.x + frame.width * 310 / width, y: frame.y + frame.height * 170 / height };
  await chromium.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [email] });
  await chromium.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await chromium.detach();
  const keyboard = liveView.getByLabel('الكتابة في صفحة المتصفح');
  await expect(keyboard).toBeFocused();
  await expect(keyboard).toHaveAttribute('type', 'password');
  await page.keyboard.type(fixtureAddress);
  await page.keyboard.press('Tab');
  await page.keyboard.type(fixtureInput);
  await expect(keyboard).toHaveValue('');
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(element, 0, 0);
    const masked = [54, 64, 82];
    return [170, 240].every(y => context.getImageData(310, y, 1, 1).data.slice(0, 3)
      .every((value, index) => Math.abs(value - masked[index]) < 16));
  })).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => successfulSignIns).toBe(1);

  await expect.poll(() => detail(page, loginRun.id), { timeout: 40_000 }).toMatchObject({
    status: 'idle', error: null, secure: null, run: { id: waiting.run!.id },
    browser: { url: `${siteOrigin}/session`, title: privateTitle },
  });
  await expect(page.getByRole("log").getByLabel("كلمة المرور", { exact: true })).toHaveCount(0);
  const finished = await detail(page, loginRun.id);
  expect(manualContinuations).toBe(0);
  expect(finished.browserPremium?.steps.map(step => step.kind)).toContain('resumed');
  expect(JSON.stringify(finished)).not.toContain(fixtureInput);
  expect(JSON.stringify(finished)).not.toContain(fixtureAddress);
  await expect(liveView).not.toHaveAttribute('data-attention', 'needs_login');
});
