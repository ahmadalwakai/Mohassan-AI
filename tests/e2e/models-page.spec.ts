import { expect, test, type Page } from '@playwright/test';
import type { ModelInfo, ModelList, ModelRunResponse } from '@mohassan/contracts';
import { PNG } from 'pngjs';
import { signInAsFixtureOwner } from './helpers';

function fixtureModel(id: string, input: ModelInfo['input'], present = true): ModelInfo {
  return {
    id, input, present, version: 'fixture', task: `Preview ${id}`, runtime: 'node-cpu', gates: [],
    uses: present && input !== 'none' ? ['page'] : [],
  };
}

const textModel = fixtureModel('fixture-text', 'text');
const otherTextModel = fixtureModel('fixture-other-text', 'text');
const readingModel = fixtureModel('fixture-reader', 'reading');
const imageModel = fixtureModel('fixture-image', 'image');
const lowerImageModel = fixtureModel('fixture-lower-image', 'image');
const runnable = [textModel, otherTextModel, readingModel, imageModel, lowerImageModel];
const installedOnly = fixtureModel('fixture-installed-only', 'none');
const absent = Array.from({ length: 24 }, (_, index) => fixtureModel(`fixture-absent-${index}`, 'text', false));
const modelList: ModelList = { models: [...runnable.slice(0, -1), installedOnly, ...absent, lowerImageModel], council: false };

const card = (page: Page, model: ModelInfo) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: model.id, exact: true }) });
const tryModel = (page: Page, model: ModelInfo) => card(page, model).getByRole('button', { name: 'جرّبه', exact: true });
const modelForm = (page: Page, model: ModelInfo) => page.getByRole('form', { name: `تجربة ${model.id}` });
const runPath = (model: ModelInfo) => `/api/models/${model.id}/run`;
const listRoute = '**/api/models';

async function openModels(page: Page) {
  await signInAsFixtureOwner(page);
  await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'النماذج', exact: true }).click();
}

function delayResponse() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

// The owner page's loading, count, and filter copy at 29448ae, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/web/components/models-workspace.tsx#L122-L132
test('shows loading, live summary counts, an empty council filter and legible card terms', async ({ page }) => {
  const list = delayResponse();
  await page.route(listRoute, async route => {
    await list.pending;
    await route.fulfill({ json: modelList });
  });
  try {
    await openModels(page);
    await expect(page.getByText('جارٍ تحميل النماذج…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'تحديث', exact: true })).toBeDisabled();
  } finally {
    list.release();
  }

  const summary = page.getByRole('status').filter({ hasText: 'مسجّل' });
  await expect(summary.getByText(`${modelList.models.length} مسجّل`, { exact: true })).toBeVisible();
  await expect(summary.getByText(`${runnable.length + 1} ملفاته على الخادم`, { exact: true })).toBeVisible();
  await expect(summary.getByText(`${runnable.length} يعمل من هذه الصفحة`, { exact: true })).toBeVisible();
  await expect(summary.getByText('مجلس النماذج مطفأ على هذا الخادم', { exact: true })).toBeVisible();

  // WCAG 2.2 contrast minimum and sRGB relative luminance, retrieved 2026-11-27.
  // https://www.w3.org/TR/WCAG22/#contrast-minimum
  const contrast = await card(page, textModel).locator('dt').first().evaluate(term => {
    const luminance = (color: string) => {
      const [red, green, blue] = color.match(/\d+/g)!.map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = luminance(getComputedStyle(term).color);
    const background = luminance(getComputedStyle(term.closest('article')!).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);

  const filters = page.getByRole('group', { name: 'تصفية النماذج' });
  const council = filters.getByRole('button', { name: 'أعضاء المجلس' });
  await council.focus();
  await page.keyboard.press('Enter');
  await expect(council).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('لا نماذج في هذا التصنيف.')).toBeVisible();
  await expect(card(page, textModel)).toHaveCount(0);
  await filters.getByRole('button', { name: 'الجاهزة للتجربة' }).click();
  await expect(card(page, lowerImageModel)).toBeVisible();
  await expect(card(page, installedOnly)).toHaveCount(0);
});

test('moves keyboard focus to an off-screen form and clears the image when changing models', async ({ page }) => {
  await page.route(listRoute, route => route.fulfill({ json: modelList }));
  await openModels(page);
  await expect(card(page, textModel)).toBeVisible();
  const opener = tryModel(page, lowerImageModel);
  await expect(opener).not.toBeInViewport();
  await opener.focus();
  await expect(opener).toBeInViewport();
  await page.keyboard.press('Enter');

  const form = modelForm(page, lowerImageModel);
  await expect(form).toBeFocused();
  await expect(form).toBeInViewport({ ratio: 0.75 });
  const image = form.getByLabel('الصورة');
  const run = form.getByRole('button', { name: 'شغّل' });
  await page.keyboard.press('Tab');
  await expect(image).toBeFocused();
  await expect(run).toBeDisabled();
  await image.setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
  await expect(run).toBeDisabled();
  await image.setInputFiles({ name: 'text.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') });
  await expect(run).toBeDisabled();
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  await image.setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect(run).toBeEnabled();

  await tryModel(page, imageModel).click();
  const otherForm = modelForm(page, imageModel);
  await expect(otherForm).toBeFocused();
  await expect(otherForm.getByLabel('الصورة')).toHaveValue('');
  await expect(otherForm.getByRole('button', { name: 'شغّل' })).toBeDisabled();
  await tryModel(page, lowerImageModel).click();
  await expect(image).toHaveValue('');
  await expect(run).toBeDisabled();

  await page.route(`**${runPath(lowerImageModel)}`, async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ image: { mimeType: 'image/png', data: png.toString('base64') } });
    await route.fulfill({ json: { ok: true, elapsedMs: 20, text: 'Preview image response' } satisfies ModelRunResponse });
  });
  await image.setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await run.press('Enter');
  await expect(form.getByRole('status')).toContainText('Preview image response');
  await form.getByRole('button', { name: 'إغلاق' }).press('Enter');
  await expect(form).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toBeInViewport();
});

test('aborts switched and closed runs and ignores late replies even if the transport completes', async ({ page }) => {
  // Leave the mocked fetch pending after abort so the test also exercises the stale-result guard.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof input !== 'string' || !/^\/api\/models\/[^/]+\/run$/.test(input)) return originalFetch(input, init);
      init?.signal?.addEventListener('abort', () => { document.documentElement.dataset.abortedRun = input; }, { once: true });
      return originalFetch(input, { ...init, signal: undefined });
    };
  });

  const switched = delayResponse();
  const closed = delayResponse();
  const oldReply = 'Late response from the first model';
  const currentReply = 'Current response from the second model';
  const closedReply = 'Late response from the closed form';
  await page.route(listRoute, route => route.fulfill({ json: modelList }));
  await page.route(`**${runPath(textModel)}`, async route => {
    await switched.pending;
    await route.fulfill({ json: { ok: true, elapsedMs: 20, text: oldReply } satisfies ModelRunResponse });
  });
  await page.route(`**${runPath(otherTextModel)}`, route => route.fulfill({ json: { ok: true, elapsedMs: 10, text: currentReply } satisfies ModelRunResponse }));
  await openModels(page);

  const finished = (model: ModelInfo) => page.waitForEvent('requestfinished', request => new URL(request.url()).pathname === runPath(model));
  const started = (model: ModelInfo) => page.waitForRequest(request => new URL(request.url()).pathname === runPath(model) && request.method() === 'POST');
  const repainted = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const abortedRun = page.locator('html');
  const first = modelForm(page, textModel);
  const second = modelForm(page, otherTextModel);
  try {
    await tryModel(page, textModel).click();
    await first.getByRole('textbox', { name: 'النص' }).fill('First input');
    await Promise.all([started(textModel), first.getByRole('button', { name: 'شغّل' }).click()]);
    await expect(first.getByRole('button', { name: 'يعمل…' })).toBeDisabled();

    await tryModel(page, otherTextModel).click();
    await expect(abortedRun).toHaveAttribute('data-aborted-run', runPath(textModel));
    await expect(first).toHaveCount(0);
    await second.getByRole('textbox', { name: 'النص' }).fill('Second input');
    await second.getByRole('button', { name: 'شغّل' }).click();
    await expect(second.getByRole('status')).toContainText(currentReply);
    const switchedResult = finished(textModel);
    switched.release();
    await switchedResult;
    await repainted();
    await expect(second.getByRole('status')).toContainText(currentReply);
    await expect(page.getByText(oldReply)).toHaveCount(0);

    await page.route(`**${runPath(otherTextModel)}`, async route => {
      await closed.pending;
      await route.fulfill({ json: { ok: true, elapsedMs: 20, text: closedReply } satisfies ModelRunResponse });
    });
    await Promise.all([started(otherTextModel), second.getByRole('button', { name: 'شغّل' }).click()]);
    await second.getByRole('button', { name: 'إغلاق' }).click();
    await expect(abortedRun).toHaveAttribute('data-aborted-run', runPath(otherTextModel));
    await tryModel(page, otherTextModel).click();
    const closedResult = finished(otherTextModel);
    closed.release();
    await closedResult;
    await repainted();
    await expect(second.getByRole('status')).toHaveCount(0);
    await expect(page.getByText(closedReply)).toHaveCount(0);
  } finally {
    switched.release();
    closed.release();
  }
});

test('requires both reading inputs and shows the runtime unknown-model explanation', async ({ page }) => {
  await page.route(listRoute, route => route.fulfill({ json: modelList }));
  const question = 'What is the capital?';
  const passage = 'London is the capital.';
  await page.route(`**${runPath(readingModel)}`, async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ text: question, passage });
    await route.fulfill({ json: { ok: false, elapsedMs: 0, reason: 'unknown-model' } satisfies ModelRunResponse });
  });
  await openModels(page);
  await tryModel(page, readingModel).click();
  const form = modelForm(page, readingModel);
  const run = form.getByRole('button', { name: 'شغّل' });
  await form.getByRole('textbox', { name: 'السؤال' }).fill(question);
  await expect(run).toBeDisabled();
  const passageField = form.getByRole('textbox', { name: 'الفقرة' });
  await passageField.fill('   ');
  await expect(run).toBeDisabled();
  await passageField.fill(passage);
  await run.press('Enter');
  // Matches the run route's MODEL_UNKNOWN message, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/models-routes.ts#L110
  await expect(form.getByRole('status')).toContainText('لا يوجد نموذج بهذا المعرّف.');
});

test('recovers from a load error using the refresh button', async ({ page }) => {
  const message = 'تعذّر تحميل قائمة النماذج مؤقتًا.';
  await page.route(listRoute, route => route.fulfill({ json: modelList }));
  await page.route(listRoute, route => route.fulfill({ status: 503, json: { error: { message } } }), { times: 1 });
  await openModels(page);
  await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
  const retry = page.getByRole('button', { name: 'تحديث', exact: true });
  await expect(retry).toBeEnabled();
  await retry.press('Enter');
  await expect(card(page, textModel)).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
});
