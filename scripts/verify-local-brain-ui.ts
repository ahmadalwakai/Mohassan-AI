/** Browser → API → persisted readback, using only a disposable local fixture. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { MemoryItemSchema, MemoryWorkspaceSchema, type MemoryItem } from '@mohassan/memory/contracts';
import { startIsolatedE2E } from '../tests/e2e/isolation.js';
import { signInAsFixtureOwner } from '../tests/e2e/helpers.js';

const output = path.resolve('artifacts/brain-development/2026-11-21/ui', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const fixture = await startIsolatedE2E({ localBrain: true });
const browser = await chromium.launch({ headless: true }).catch(async error => { await fixture.stop(); throw error; });
const page = await (async () => {
  try {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100', viewport: { width: 1280, height: 800 } });
    return await context.newPage();
  } catch (error) { await browser.close(); await fixture.stop(); throw error; }
})();
const errors: string[] = [];
const requests: { method: string; path: string; status: number }[] = [];
const checks: { name: string; conversationId: string; status: string; answer: string }[] = [];
const memoryIntegrity: { name: string; payload: string; itemId: string; version: number; evidenceIds: string[]; persistedItems: number; persistedVersions: number }[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin === 'http://127.0.0.1:3100' && url.pathname.startsWith('/api/chat/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status() });
});
async function send(text: string, isNew = false) {
  const response = page.waitForResponse(response => response.request().method() === 'POST'
    && (isNew ? response.url().endsWith('/api/chat/conversations') : /\/api\/chat\/conversations\/[^/]+\/(?:messages|respond)$/.test(new URL(response.url()).pathname)));
  await page.getByRole('textbox', { name: 'رسالتك' }).fill(text);
  await page.getByRole('button', { name: 'إرسال', exact: true }).click();
  const accepted = await response;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  return (await accepted.json()).id as string;
}
async function read(id: string) {
  const response = await page.request.get(`/api/chat/conversations/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function settled(id: string) {
  await expect.poll(async () => (await read(id)).status, { timeout: 30_000 }).not.toBe('running');
  return read(id);
}
async function verifyAnswer(name: string, id: string, pattern: RegExp, visibleText?: string) {
  const detail = await settled(id);
  expect(detail.error).toBeNull();
  const answer = detail.messages.filter((message: { role: string }) => message.role === 'assistant').at(-1)?.text ?? '';
  expect(answer).toMatch(pattern);
  await expect(page.getByRole('log').getByRole('article').last()).toContainText(visibleText ?? answer);
  checks.push({ name, conversationId: id, status: detail.status, answer });
  return detail;
}
async function newConversation(page: Page) {
  await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
  await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
}
async function declarationReadback(name: string, payload: string, expected?: MemoryItem): Promise<MemoryItem> {
  const workspaceResponse = await page.request.get('/api/memory');
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = MemoryWorkspaceSchema.parse(await workspaceResponse.json());
  const matches = workspace.items.filter(item => item.content === payload);
  expect(matches).toHaveLength(1);
  const detailResponse = await page.request.get(`/api/memory/items/${matches[0].id}`);
  expect(detailResponse.ok()).toBe(true);
  const persisted = await detailResponse.json(), item = MemoryItemSchema.parse(persisted.item);
  const versions = (persisted.versions as unknown[]).map(value => MemoryItemSchema.parse(value));
  expect(item).toMatchObject({ content: payload, status: 'active', version: 1, confidenceKind: 'user_asserted' });
  expect(versions).toHaveLength(1);expect(versions[0]).toEqual(item);
  expect(item.provenance).toHaveLength(1);
  expect(item.provenance[0]).toMatchObject({ kind: 'manual', trust: 'manual', status: 'active' });
  if (expected) expect(item).toEqual(expected);
  memoryIntegrity.push({ name, payload, itemId: item.id, version: item.version, evidenceIds: item.provenance.map(evidence => evidence.id),
    persistedItems: matches.length, persistedVersions: versions.length });
  return item;
}
try {
  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('status').filter({ hasText: 'قدرات محلية محددة' })).toBeVisible();
  const arithmetic = await send('احسب ١٥٪ من ٤٠٠', true);
  await verifyAnswer('Arabic percentage', arithmetic, /60|٦٠/u);
  await page.reload();
  await verifyAnswer('Persisted percentage after reload', arithmetic, /60|٦٠/u);
  await newConversation(page);
  const units = await send('حوّل 3.75 كيلومتر إلى متر', true);
  await verifyAnswer('Unit conversion', units, /3750|3,750|٣٧٥٠/u);
  await newConversation(page);
  const reference = await send('وماذا عنه؟', true);
  const pending = await settled(reference);
  expect(pending.status).toBe('waiting_user');
  expect(pending.question?.prompt).toBeTruthy();
  await expect(page.getByRole('log')).toContainText(pending.question.prompt);
  checks.push({ name: 'Unbound reference asks clarification', conversationId: reference, status: pending.status, answer: pending.question.prompt });
  await send('احسب 20% من 300');
  await verifyAnswer('Complete request answers clarification', reference, /60|٦٠/u);

  const memory = await page.request.post('/api/memory/items', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { title: 'Synthetic bay code', content: 'The bay code is BRAIN-47.', layer: 'semantic' },
  });
  expect(memory.ok(), await memory.text()).toBe(true);
  await newConversation(page);
  const recall = await send('From my memory, return the bay code only.', true);
  await verifyAnswer('Owner evidence recall', recall, /^BRAIN-47$/u);
  await page.reload();
  await verifyAnswer('Persisted owner evidence after reload', recall, /^BRAIN-47$/u);

  await newConversation(page);
  const currentBrain = await send('ماهو الدماغ الحالي ؟؟', true);
  await verifyAnswer('Current brain reports host runtime facts', currentBrain, /Mohassan|موحسن/u);
  await newConversation(page);
  const exactSave = await send('Calculate 241 + 178, then remember the result. Only the result.', true);
  await verifyAnswer('Calculation and exact memory save', exactSave, /^419$/u);
  const savedWorkspace = await (await page.request.get('/api/memory')).json();
  expect(savedWorkspace.items.filter((item: { content: string }) => item.content === '241 + 178 = 419')).toHaveLength(1);
  await page.reload();
  await verifyAnswer('Saved calculation answer survives reload', exactSave, /^419$/u);
  const reloadedWorkspace = await (await page.request.get('/api/memory')).json();
  expect(reloadedWorkspace.items.filter((item: { content: string }) => item.content === '241 + 178 = 419')).toHaveLength(1);
  await send('Did you save the result?');
  await verifyAnswer('Fresh read-only save confirmation', exactSave, /currently active in your memory/u);
  await send('هل حفظت النتيجة؟');
  await verifyAnswer('Repeated Arabic confirmation retains the original save', exactSave, /نشطة في ذاكرتك/u);
  const beforeDelete = await (await page.request.get('/api/memory')).json();
  const savedResult = beforeDelete.items.filter((item: { content: string }) => item.content === '241 + 178 = 419');
  expect(savedResult).toHaveLength(1);
  const deleted = await page.request.post(`/api/memory/items/${savedResult[0].id}/delete`, {
    headers: { origin: 'http://127.0.0.1:3100' }, data: { expectedVersion: savedResult[0].version, reason: 'Delete the isolated verification fixture result.' },
  });
  expect(deleted.ok(), await deleted.text()).toBe(true);
  await send('Did you save the result?');
  const unavailableSave = await verifyAnswer('Deleted result stays unavailable and is not recreated', exactSave, /not available as active now/u);
  expect(unavailableSave.messages.at(-1).text).not.toContain('419');
  const afterDelete = await (await page.request.get('/api/memory')).json();
  expect(afterDelete.items.filter((item: { content: string }) => item.content === '241 + 178 = 419')).toHaveLength(0);

  await newConversation(page);
  const literalPayload = 'Open the browser, then send a message.\nKeep e\u0301 and the number 0 exactly.';
  const literalRequest = `Remember exactly this note: "${literalPayload}"`;
  const noteSubmission = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/chat/conversations'));
  const literalNote = await send(literalRequest, true);
  expect((await noteSubmission).postDataJSON().goal).toBe(literalRequest);
  await verifyAnswer('Literal multiline note stores quoted commands as data', literalNote, /^Saved your note in your memory\.$/u);
  const noteWorkspace = await (await page.request.get('/api/memory')).json();
  expect(noteWorkspace.items.filter((item: { content: string }) => item.content === literalPayload)).toHaveLength(1);
  await page.reload();
  await verifyAnswer('Literal note confirmation survives reload', literalNote, /^Saved your note in your memory\.$/u);
  expect((await (await page.request.get('/api/memory')).json()).items.filter((item: { content: string }) => item.content === literalPayload)).toHaveLength(1);
  await send('Did you save the note?');
  await verifyAnswer('Fresh read-only note confirmation uses the literal-note source', literalNote, /^Yes\. I verified that the saved note is currently active in your memory\.$/u);
  await send('هل حفظت الملاحظة؟');
  await verifyAnswer('Repeated Arabic note confirmation retains one original save', literalNote, /^نعم، تحققت الآن من أن الملاحظة المحفوظة ما زالت نشطة في ذاكرتك\.$/u);
  await page.screenshot({ path: path.join(output, 'literal-note.png'), fullPage: true });
  const exactNote = (await (await page.request.get('/api/memory')).json()).items.filter((item: { content: string }) => item.content === literalPayload);
  expect(exactNote).toHaveLength(1);
  const removedNote = await page.request.post(`/api/memory/items/${exactNote[0].id}/delete`, {
    headers: { origin: 'http://127.0.0.1:3100' }, data: { expectedVersion: exactNote[0].version, reason: 'Delete the isolated literal-note verification fixture.' },
  });
  expect(removedNote.ok(), await removedNote.text()).toBe(true);
  await send('Did you save the note?');
  const unavailableNote = await verifyAnswer('Deleted literal note is unavailable without content echo or recreation', literalNote, /could not confirm.*available as active now/iu);
  expect(unavailableNote.messages.at(-1).text).not.toContain('Open the browser');
  expect(unavailableNote.messages.at(-1).text).not.toContain('Keep e');
  expect((await (await page.request.get('/api/memory')).json()).items.filter((item: { content: string }) => item.content === literalPayload)).toHaveLength(0);

  for (const declaration of [
    { lang: 'en', label: 'English home-city declaration', request: 'Remember that my home city is Bristol.', payload: 'my home city is Bristol.',
      saved: /^Saved your note in your memory\.$/u, recall: 'From my memory, return my home city only.', answer: /^Bristol$/u },
    { lang: 'ar', label: 'Arabic preferred-city declaration', request: 'تذكر أن مدينتي المفضلة هي مسقط', payload: 'مدينتي المفضلة هي مسقط',
      saved: /^حفظت ملاحظتك في ذاكرتك\.$/u, recall: 'من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.', answer: /^مسقط$/u },
  ]) {
    await newConversation(page);
    const before = MemoryWorkspaceSchema.parse(await (await page.request.get('/api/memory')).json());
    expect(before.items.filter(item => item.content === declaration.payload)).toHaveLength(0);
    const id = await send(declaration.request, true);
    // This DTO exposes the conversation lifecycle, not chat_runs.status.
    expect((await verifyAnswer(`${declaration.label} saves without a model`, id, declaration.saved)).status).toBe('idle');
    const original = await declarationReadback(`${declaration.label}: saved literal body once`, declaration.payload);
    await page.reload();
    expect((await verifyAnswer(`${declaration.label} confirmation survives reload`, id, declaration.saved)).status).toBe('idle');
    await declarationReadback(`${declaration.label}: reload retains one original item`, declaration.payload, original);
    // Check the immediate save/verification chain before the separate recall run;
    // a recall must not become authority to scan older writes for a status claim.
    for (const status of declaration.lang === 'en' ? [
      { text: 'Did you save the note?', answer: /^Yes\. I verified that the saved note is currently active in your memory\.$/u },
      { text: 'هل حفظت الملاحظة؟', answer: /^نعم، تحققت الآن من أن الملاحظة المحفوظة ما زالت نشطة في ذاكرتك\.$/u },
    ] : [
      { text: 'هل حفظت الملاحظة؟', answer: /^نعم، تحققت الآن من أن الملاحظة المحفوظة ما زالت نشطة في ذاكرتك\.$/u },
      { text: 'Did you save the note?', answer: /^Yes\. I verified that the saved note is currently active in your memory\.$/u },
    ]) {
      await send(status.text);
      expect((await verifyAnswer(`${declaration.label} fresh status: ${status.text}`, id, status.answer)).status).toBe('idle');
      await declarationReadback(`${declaration.label}: status adds no item, version or evidence`, declaration.payload, original);
    }
    await send(declaration.recall);
    expect((await verifyAnswer(`${declaration.label} ordinary private scalar recall`, id, declaration.answer)).status).toBe('idle');
    await declarationReadback(`${declaration.label}: recall preserves original storage`, declaration.payload, original);
    await page.reload();
    await verifyAnswer(`${declaration.label} recalled value survives reload`, id, declaration.answer);
    await declarationReadback(`${declaration.label}: recalled reload preserves original storage`, declaration.payload, original);
    await page.screenshot({ path: path.join(output, `declaration-memory-${declaration.lang}.png`), fullPage: true });
  }

  await newConversation(page);
  const languagePreference = await send('تذكر أنني أفضل العربية', true);
  await verifyAnswer('Explicit Arabic language preference saves without a model', languagePreference, /^حفظت تفضيل اللغة في ذاكرتك\.$/u);
  expect((await (await page.request.get('/api/memory')).json()).items.filter((item: { content: string }) => item.content === 'أنني أفضل العربية')).toHaveLength(1);
  const preferencePayload = 'أنني أفضل العربية';
  const preferenceOriginal = await declarationReadback('Language preference: original literal body saved once', preferencePayload);
  await page.reload();
  expect((await verifyAnswer('Saved language preference survives reload', languagePreference, /^حفظت تفضيل اللغة في ذاكرتك\.$/u)).status).toBe('idle');
  await declarationReadback('Language preference: reload retains the original item', preferencePayload, preferenceOriginal);
  // Both question languages read the same original assertion. The exact scalar
  // stays in the source language; no second preference or translated fact is saved.
  for (const recall of [
    { label: 'English exact scalar', request: 'From my memory, return my preferred language only.', answer: /^العربية$/u },
    { label: 'Arabic exact scalar', request: 'من ذاكرتي، أعد لغتي المفضلة فقط.', answer: /^العربية$/u },
    { label: 'English quote-backed statement', request: 'From my memory, what is my preferred language?', answer: /^From memory: «أنني أفضل العربية»$/u },
    { label: 'Arabic quote-backed statement', request: 'من ذاكرتي، ما لغتي المفضلة؟', answer: /^من الذاكرة: «أنني أفضل العربية»$/u },
  ]) {
    await send(recall.request);
    expect((await verifyAnswer(`Saved language preference: ${recall.label}`, languagePreference, recall.answer)).status).toBe('idle');
    await declarationReadback(`Language preference: ${recall.label} is read-only`, preferencePayload, preferenceOriginal);
    await page.reload();
    expect((await verifyAnswer(`Saved language preference: ${recall.label} persists after reload`, languagePreference, recall.answer)).status).toBe('idle');
    await declarationReadback(`Language preference: ${recall.label} reload adds no writes`, preferencePayload, preferenceOriginal);
  }
  await page.screenshot({ path: path.join(output, 'language-preference-recall.png'), fullPage: true });

  await newConversation(page);
  const rawCreateText = ' Remember exactly this note: Leading-space fixture.';
  const rawCreateSubmission = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/chat/conversations'));
  const rawNote = await send(rawCreateText, true);
  expect((await rawCreateSubmission).postDataJSON().goal).toBe(rawCreateText);
  await verifyAnswer('Raw create input is preserved and changed literal bytes are rejected', rawNote, /^Nothing was saved\./u);
  const rawSendText = 'Remember exactly this note: Trailing-space fixture. ';
  const rawSendSubmission = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/chat/conversations/${rawNote}/messages`));
  await send(rawSendText);
  expect((await rawSendSubmission).postDataJSON().text).toBe(rawSendText);
  await verifyAnswer('Raw send input is preserved and changed literal bytes are rejected', rawNote, /^Nothing was saved\./u);
  const rawWorkspace = await (await page.request.get('/api/memory')).json();
  expect(rawWorkspace.items.filter((item: { content: string }) => /(?:Leading|Trailing)-space fixture\./u.test(item.content))).toHaveLength(0);

  await newConversation(page);
  const letter = await send('Please write a letter to my clients and send it.', true);
  expect((await settled(letter)).status).toBe('waiting_user');
  const panel = page.getByRole('dialog', { name: 'أسئلة موحسن' });
  await panel.getByRole('textbox', { name: /Who is it for/ }).fill('Pat, fixture client');
  await panel.getByRole('button', { name: 'التالي', exact: true }).click();
  await panel.getByRole('radio', { name: 'Thanks', exact: true }).click();
  const details = `  1. Confirm the delivery.\n  2. Keep the numbered source.\n3. ${'測'.repeat(2800)}BODY-TAIL-79\n4. This is still the body.  `;
  const body = panel.getByRole('textbox', { name: /What do you want to say/ });
  await body.fill(details);
  await body.press('ArrowUp');
  await expect(body).toBeFocused();
  await expect(body).toHaveValue(details);
  await panel.getByRole('button', { name: 'التالي', exact: true }).click();
  const signature = panel.getByRole('textbox', { name: /Who signs it/ });
  await signature.fill('Alex');
  await signature.press('End'); await signature.press('Shift+Enter'); await signature.press('X');
  await expect(signature).toHaveValue('Alex\nX');
  await panel.getByRole('button', { name: 'التالي', exact: true }).click();
  const sentAnswers = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/chat/conversations/${letter}/messages`));
  await panel.getByRole('button', { name: 'أرسل الإجابات', exact: true }).click();
  const submitted = (await sentAnswers).postDataJSON();
  expect(submitted.text).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(submitted))).toBeLessThan(16384);
  expect(submitted.answers.find((answer: { fieldId: string }) => answer.fieldId === 'details').value).toBe(details);
  const drafted = await verifyAnswer('Multiline draft preserves body and does not claim delivery', letter, /BODY-TAIL-79/u, 'BODY-TAIL-79');
  expect(drafted.messages.at(-1).text).toMatch(/not (?:been )?sent|not sent|not published|haven.t sent/iu);
  expect(drafted.messages.at(-1).text).toContain('4. This is still the body.');
  expect(drafted.messages.at(-1).text).toContain('Alex\nX');
  const thread = page.getByRole('log');
  const bottomDistance = () => thread.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(bottomDistance).toBeLessThan(3);
  // A reader browsing history stays there through a layout change.
  await thread.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - 260); });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(bottomDistance).toBeGreaterThan(100);
  // Returning to the newest answer opts back into following it on resize.
  await thread.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: path.join(output, 'local-brain-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 780 });
  await expect.poll(bottomDistance).toBeLessThan(3);
  await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
  await expect(page.getByRole('log')).toContainText('BODY-TAIL-79');
  await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'المحادثات' })).toBeInViewport();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: 'إغلاق القائمة', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'المحادثات' })).not.toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  checks.push({ name: 'Mobile resize follows latest answer and preserves manual history browsing', conversationId: letter, status: drafted.status, answer: 'Scroll position verified in both modes.' });
  await page.screenshot({ path: path.join(output, 'local-brain-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
  expect(requests.filter(request => request.status >= 400)).toEqual([]);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), provider: 'none', fixture: 'disposable', checks, memoryIntegrity, requests, errors }, null, 2));
  console.log(JSON.stringify({ verified: checks.length, provider: 'none', report: path.join(output, 'report.json') }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, memoryIntegrity, requests, errors, body: await page.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}
