import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AgentBrowser, type AgentCaptureResult, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-capture-chat-owner';
let server: Server, origin: string, root: string, temporaryRoot: string;
const requests: string[] = [];
interface Fixture {
  browser: AgentBrowser;
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  captures: AgentCaptureResult[];
  screenSpy: MockInstance<AgentBrowser['screen']>;
  searches: string[];
}
const fixtures: Fixture[] = [];

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-capture-chat-fixture-'));
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/redirect') { response.writeHead(302, { location: '/destination' }); response.end(); return; }
    response.writeHead(path === '/missing' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    const title = path === '/missing' ? 'Missing fixture page' : path === '/destination' ? 'Different destination' : 'Stable capture fixture';
    response.end(`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>This is a static local receipt fixture.</p>${path === '/secret' ? '<label>Card<input autocomplete="cc-number" value="fixture-secret-not-for-output"></label>' : ''}</main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing capture chat fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.control.shutdown();
    await fixture.browser.close();
    await fixture.database.close();
  }
  vi.restoreAllMocks();
});
afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-capture-chat-fixture-') || within.includes('..')) throw new Error('Unsafe capture chat fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Explicit in-memory PGlite, fixture-only HTTP and no model/search credentials. */
async function harness(): Promise<Fixture> {
  requests.length = 0;
  const database = await createDatabase({});
  expect(database.mode).toBe('embedded');
  await migrate(database.db);
  const browser = new AgentBrowser({ profileDir: join(root, randomUUID()), testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true });
  const captures: AgentCaptureResult[] = [], searches: string[] = [];
  const originalCapture = browser.captureEvidence.bind(browser);
  vi.spyOn(browser, 'captureEvidence').mockImplementation(async (...args) => {
    const captured = await originalCapture(...args);
    captures.push(captured); return captured;
  });
  const screenSpy = vi.spyOn(browser, 'screen');
  const searchProvider: SearchProvider = { name: 'capture-chat-search-must-not-run', async search(query) {
    searches.push(query); throw new Error('No search belongs to this local capture fixture.');
  } };
  const control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    networkPolicy: { testOrigins: [origin] }, searchProvider,
  });
  const fixture = { database, browser, control, captures, screenSpy, searches };
  fixtures.push(fixture); return fixture;
}

async function start(fixture: Fixture, path = '/stable?proof=one#requested-section') {
  const url = origin + path;
  const conversation = await fixture.control.create(OWNER, { goal: `افتح ${url} واعرض لي لقطة من الصفحة بعد تحميلها.` });
  await fixture.control.settled(conversation.id);
  const detail = await fixture.control.detail(OWNER, conversation.id);
  const run = await fixture.database.db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', conversation.id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  const state = run.state as BrainState;
  const browserState = await fixture.database.db.selectFrom('chat_conversations').select('browser_state').where('id', '=', conversation.id).executeTakeFirstOrThrow();
  expect(detail.status, detail.error ?? '').toBe('idle'); expect(detail.error).toBeNull();
  expect(fixture.screenSpy).not.toHaveBeenCalled(); // No fallback to unrelated raw screen bytes.
  expect(fixture.searches).toEqual([]);
  expect(await fixture.database.db.selectFrom('experiences').select('source_id').where('owner_id', '=', OWNER).execute()).toEqual([]);
  expect(await fixture.database.db.selectFrom('chat_model_receipts').select('id').execute()).toEqual([]);
  expect(await fixture.database.db.selectFrom('chat_effect_receipts').select('id').execute()).toEqual([]);
  expect(requests.every(request => request.startsWith('GET '))).toBe(true);
  return { id: conversation.id, url, detail, run, state, browserState: browserState.browser_state as { version: string; url: string } };
}

function expectUnverifiedCapture(state: BrainState) {
  expect(state.completionReview?.allowCompletion).toBe(false);
  const screenshot = state.supervision!.steps.find(step => step.tool === 'screenshot');
  expect(screenshot).toMatchObject({ result: 'unknown', observations: [] });
  expect(state.completionReview?.missingCriteria).toContain('screenshot');
}

describe('capture proof through the actual isolated chat controller', () => {
  it('completes an exact2xx screenshot goal only with a real JPEG bound to the final captured observation', async () => {
    const fixture = await harness();
    const result = await start(fixture);
    expect(result.run.status).toBe('completed');
    expect(result.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true, missingCriteria: [] });
    expect(fixture.captures).toHaveLength(1);
    const capture = fixture.captures[0];
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') return;
    expect(capture.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(capture.image.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    const hash = createHash('sha256').update(capture.image).digest('hex');
    expect(capture.receipt.imageHash).toBe(hash);
    expect(capture.receipt).toMatchObject({ ownerId: OWNER, conversationId: result.id, pageId: capture.page.id, pageHash: capture.page.hash, url: result.url });
    expect(capture.page.id).not.toBe(capture.receipt.requestedPageId);
    expect(result.browserState).toMatchObject({ version: capture.page.id, url: result.url });
    const screenshot = result.state.supervision!.steps.find(step => step.tool === 'screenshot')!;
    expect(screenshot.result).toBe('succeeded');
    const nav = screenshot.observations.find(observation => observation.kind === 'navigation');
    const artifact = screenshot.observations.find(observation => observation.kind === 'artifact');
    expect(nav).toMatchObject({ reference: capture.page.id, contentHash: capture.page.hash, target: result.url, httpStatus: 200 });
    expect(artifact).toMatchObject({ artifactType: 'screenshot', artifactHash: hash, pageRef: capture.page.id, target: result.url });
    const reviewEvent = await fixture.database.db.selectFrom('chat_events').select('data').where('run_id', '=', result.run.id).where('kind', '=', 'task_review').executeTakeFirstOrThrow();
    expect(reviewEvent.data).toMatchObject({ review: { status: 'verified', allowCompletion: true } });
    expect(result.detail.messages.at(-1)?.text).toContain('التقطت صورة للصفحة');
  });

  it('keeps unavailable captures partial even though a previous raw screenshot exists', async () => {
    const fixture = await harness();
    vi.mocked(fixture.browser.captureEvidence).mockResolvedValue({ status: 'unavailable', reason: 'capture_failed' });
    const result = await start(fixture);
    expect(result.run.status).toBe('partial');
    expectUnverifiedCapture(result.state);
    const entry = await fixture.browser['conversation'](OWNER, result.id);
    expect(entry.shot?.length).toBeGreaterThan(500);
    expect(result.detail.messages.at(-1)?.text).toContain('تعذّر توثيق لقطة');
  });

  it('keeps a browser without the new receipt method partial instead of falling back to screen()', async () => {
    const fixture = await harness();
    Object.defineProperty(fixture.browser, 'captureEvidence', { value: undefined, configurable: true });
    const result = await start(fixture);
    expect(result.run.status).toBe('partial');
    expectUnverifiedCapture(result.state);
    const entry = await fixture.browser['conversation'](OWNER, result.id);
    expect(entry.shot?.length).toBeGreaterThan(500);
    expect(fixture.captures).toEqual([]);
  });

  it('rejects a wrong image hash returned alongside actual browser JPEG bytes', async () => {
    const fixture = await harness(), actual = AgentBrowser.prototype.captureEvidence.bind(fixture.browser);
    vi.mocked(fixture.browser.captureEvidence).mockImplementation(async (...args) => {
      const capture = await actual(...args); fixture.captures.push(capture);
      return capture.status === 'captured' ? { ...capture, receipt: { ...capture.receipt, imageHash: '0'.repeat(64) } } : capture;
    });
    const result = await start(fixture);
    expect(fixture.captures[0].status).toBe('captured');
    expect(result.run.status).toBe('partial');
    expectUnverifiedCapture(result.state);
    const actualCapture = fixture.captures[0];
    if (actualCapture.status === 'captured') expect(result.browserState.version).not.toBe(actualCapture.page.id);
  });

  it('keeps a real404 page partial even when its JPEG capture is valid', async () => {
    const fixture = await harness(), result = await start(fixture, '/missing');
    expect(fixture.captures[0].status).toBe('captured');
    expect(result.run.status).toBe('partial');
    expect(result.state.completionReview).toMatchObject({ status: 'failed', allowCompletion: false });
    expect(result.state.completionReview?.criteria.find(criterion => criterion.id === 'navigation')).toMatchObject({ status: 'failed', reason: 'contradicted' });
    expect(result.detail.browser?.url).toBe(result.url);
  });

  it('keeps a redirect partial when the real captured destination differs from the requested URL', async () => {
    const fixture = await harness(), result = await start(fixture, '/redirect');
    expect(fixture.captures[0].status).toBe('captured');
    expect(result.run.status).toBe('partial');
    expect(result.state.completionReview?.allowCompletion).toBe(false);
    expect(result.state.completionReview?.criteria.find(criterion => criterion.id === 'navigation')).toMatchObject({ status: 'unverified', reason: 'target_mismatch' });
    expect(result.detail.browser?.url).toBe(origin + '/destination');
    expect(result.detail.messages.at(-1)?.text).toContain('لم أتحقق');
  });

  it('keeps strict sensitive-mask instability partial without publishing a screenshot proof', async () => {
    const fixture = await harness(), result = await start(fixture, '/secret');
    expect(fixture.captures).toEqual([{ status: 'unavailable', reason: 'changed' }]);
    expect(result.run.status).toBe('partial');
    expectUnverifiedCapture(result.state);
    expect(JSON.stringify(result.state)).not.toContain('fixture-secret-not-for-output');
    expect(result.detail.messages.at(-1)?.text).toContain('تعذّر توثيق لقطة');
  });
});
