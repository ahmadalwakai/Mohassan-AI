import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { browserLiveBudget, type ChatConversation } from '@mohassan/contracts';
import { errors, expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';
import { E2E_WEB_PORT } from './isolation';

// Fixture layout follows PR #36's local sign-in story. https://github.com/ahmadalwakai/Mohassan-AI/pull/36 (retrieved 2026-11-27)
const site = new URL('http://127.0.0.1:4201');
const loginPath = '/login';
const proof = 'اكتمل تسجيل الدخول في صفحة الاختبار';
const fixturePassword = randomUUID();
const field = { x: 160, y: 148, width: 300, height: 44 };
// AgentBrowser's production viewport. https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/agent-browser.ts#L217 (retrieved 2026-11-27)
const viewport = { width: 1280, height: 800 };
let fixture: Server | undefined;
let submissions = 0;

test.beforeAll(async () => {
  test.setTimeout(200_000);
  fixture = createServer(async (request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (request.url !== loginPath) { response.writeHead(404).end(); return; }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const accepted = new URLSearchParams(body).get('password') === fixturePassword;
      if (accepted) submissions++;
      response.writeHead(accepted ? 200 : 403, headers).end(accepted
        ? `<!doctype html><html lang="ar"><meta charset="utf-8"><title>${proof}</title><main><h1>${proof}</h1></main></html>`
        : 'Fixture input rejected');
      return;
    }
    response.writeHead(200, headers).end(`<!doctype html><html lang="ar"><meta charset="utf-8"><title>Sign in</title>
      <main><h1>تسجيل الدخول</h1><form method="post" action="${loginPath}">
        <input name="password" type="password" autocomplete="current-password" aria-label="كلمة المرور" required
          style="box-sizing:border-box;position:absolute;left:${field.x}px;top:${field.y}px;width:${field.width}px;height:${field.height}px">
        <button type="submit">دخول</button></form></main></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    fixture!.once('error', reject).listen({ port: Number(site.port), host: site.hostname, exclusive: true }, resolve);
  });
  await fetch(`http://127.0.0.1:${E2E_WEB_PORT}/`, { signal: AbortSignal.timeout(170_000) }).then(response => response.text());
});

test.afterAll(async () => {
  if (fixture?.listening) await new Promise<void>(resolve => fixture!.close(() => resolve()));
});

async function conversation(page: Page, id: string): Promise<ChatConversation> {
  const response = await page.request.get(`/api/chat/conversations/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('the owner sees the paused page, can hide its stream, and explicitly hands back the same run after sign-in', async ({ page }) => {
  await signInAsFixtureOwner(page, 'assistant');
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  const accepted = page.waitForResponse(response => response.request().method() === 'POST'
    && /^\/api\/chat\/conversations(?:\/[^/]+\/messages)?$/.test(new URL(response.url()).pathname));
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(`افتح ${new URL(loginPath, site)} ثم اقرأ الصفحة`);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  const created = await accepted;
  expect(created.ok()).toBe(true);
  const { id } = await created.json() as ChatConversation;

  await expect.poll(async () => (await conversation(page, id)).status, { timeout: 60_000 }).toBe('waiting_input');
  const paused = await conversation(page, id);
  expect(paused.secure).toMatchObject({ kind: 'hands_on', fields: [] });
  expect(paused.run?.id).toBeTruthy();
  expect(submissions).toBe(0);
  const scope = `/api/chat/conversations/${id}/browser/live/${paused.run!.id}`;
  const isFrame = (url: string) => new URL(url).pathname === `${scope}/frame`;
  const live = page.getByTestId('browser-live-panel');
  const image = live.getByTestId('browser-live-frame');
  await expect(live.getByTestId('browser-live-prompt')).toContainText('الدخول بنفسك في المتصفح');
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const frame = await page.waitForResponse(response => isFrame(response.url()) && response.ok() && response.headers()['content-type'] === 'image/jpeg');
  const bytes = (await frame.body()).byteLength;
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(browserLiveBudget.maxFrameBytes);

  const continueButton = live.getByTestId('browser-live-continue');
  const continueResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === `${scope}/continue`);
  const notReady = continueResponse();
  await continueButton.click();
  expect((await notReady).status()).toBe(409);
  expect((await conversation(page, id)).status).toBe('waiting_input');

  const toggle = live.getByTestId('browser-live-toggle');
  await toggle.click();
  await expect(live).toHaveAttribute('data-open', 'false');
  await expect(page.waitForRequest(request => isFrame(request.url()), { timeout: 2 * browserLiveBudget.intervalMs }))
    .rejects.toBeInstanceOf(errors.TimeoutError);
  await toggle.click();
  await expect(live).toHaveAttribute('data-open', 'true');
  await expect(image).toHaveAttribute('data-interactive', 'true');

  const inputResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === `${scope}/input`);
  const pointer = inputResponse();
  const box = await image.boundingBox();
  if (!box) throw new Error('The active browser image has no layout box');
  await image.click({ position: {
    x: box.width * (field.x + field.width / 2) / viewport.width,
    y: box.height * (field.y + field.height / 2) / viewport.height,
  } });
  expect((await pointer).ok()).toBe(true);
  await live.getByTestId('browser-live-text').fill(fixturePassword);
  const typed = inputResponse();
  await live.getByTestId('browser-live-send').click();
  expect((await typed).ok()).toBe(true);
  const enter = inputResponse();
  await live.getByTestId('browser-live-key-Enter').click();
  expect((await enter).ok()).toBe(true);
  await expect.poll(() => submissions).toBe(1);

  // A fresh frame after sign-in does not authorize the run to advance.
  await page.waitForResponse(response => isFrame(response.url()) && response.headers()['content-type'] === 'image/jpeg');
  expect(await conversation(page, id)).toMatchObject({ status: 'waiting_input', secure: { id: paused.secure!.id }, run: { id: paused.run!.id } });
  const continued = continueResponse();
  await continueButton.click();
  expect((await continued).ok()).toBe(true);
  await expect.poll(() => conversation(page, id), { timeout: 40_000 }).toMatchObject({
    status: 'idle', error: null, secure: null, run: { id: paused.run!.id }, browser: { title: proof },
  });
  expect(submissions).toBe(1);
});
