/**
 * Phase 0 measurement fixture (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.1).
 *
 * The isolated E2E server (tests/e2e/isolation.ts) on its own ports: empty embedded database in a
 * disposable temp folder, no chat model, no Google Ads credentials, and Windows control off as in
 * `npm run dev:lab`. Nothing here reads the root .env, the lab database or production.
 */
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createE2EFixture, requireFreePort, spawnOwned, stopOwnedChildren, type OwnedChild } from '../../tests/e2e/isolation.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export interface MeasureFixture {
  directory: string;
  apiBase: string;
  webBase: string | null;
  origin: string;
  secret: string;
  apiPid: number | undefined;
  webPid: number | undefined;
  apiReadyMs: number;
  webReadyMs: number | null;
  stop(): Promise<void>;
}

async function waitFor(url: string, child: OwnedChild, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.hasClosed()) throw new Error(`FIXTURE_CHILD_EXITED:${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* still starting */ }
    await delay(200);
  }
  throw new Error(`FIXTURE_READINESS_TIMEOUT:${url}`);
}

export async function startMeasureFixture(options: { apiPort?: number; webPort?: number; withWeb?: boolean; environment?: NodeJS.ProcessEnv } = {}): Promise<MeasureFixture> {
  const apiPort = options.apiPort ?? 4110, webPort = options.webPort ?? 3110;
  await requireFreePort(apiPort);
  if (options.withWeb) await requireFreePort(webPort);
  const fixture = await createE2EFixture();
  const origin = `http://127.0.0.1:${webPort}`;
  Object.assign(fixture.environment, {
    MOHASSAN_E2E_LOCAL_BRAIN: '1',
    // `npm run dev:lab` sets this too: no request in a measurement may act on the owner's desktop.
    WINDOWS_REMOTE_ENABLED: 'false',
    SERVER_PORT: String(apiPort), PORT: String(webPort), WEB_ORIGIN: origin, MOHASSAN_SERVER_URL: `http://127.0.0.1:${apiPort}`,
    // A caller's own switches, such as the mind (MOHASSAN_MIND=1), for a measurement of that path.
    ...(options.environment ?? {}),
  });
  const children: OwnedChild[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { await stopOwnedChildren(children); await fixture.cleanup(); })();
  try {
    const started = performance.now();
    const api = spawnOwned(['--import', pathToFileURL(path.join(repository, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      path.join(repository, 'tests', 'e2e', 'server-entry.ts')], fixture.directory, fixture.environment, true);
    children.push(api);
    await new Promise<void>((resolve, reject) => {
      // On a machine busy with other agents the API took over three minutes to start (2026-11-22); FIXTURE_READY_MS widens the wait.
      const timer = setTimeout(() => reject(new Error('FIXTURE_API_READY_TIMEOUT')), Number(process.env.FIXTURE_READY_MS ?? 600_000));
      api.child.once('message', message => {
        clearTimeout(timer);
        const receipt = message as { type?: string; root?: string };
        if (receipt.type === 'e2e.ready' && receipt.root === fixture.directory) resolve(); else reject(new Error('FIXTURE_API_READY_INVALID'));
      });
      void api.closed.then(() => { clearTimeout(timer); reject(new Error('FIXTURE_API_EXITED')); }, reject);
    });
    await waitFor(`http://127.0.0.1:${apiPort}/health`, api, 10_000);
    const apiReadyMs = performance.now() - started;
    let web: OwnedChild | null = null, webReadyMs: number | null = null;
    if (options.withWeb) {
      const webStarted = performance.now();
      web = spawnOwned([path.join(repository, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(webPort)],
        fixture.webDirectory, fixture.environment);
      children.push(web);
      await waitFor(`${origin}/api/setup`, web, Number(process.env.FIXTURE_READY_MS ?? 600_000));
      webReadyMs = performance.now() - webStarted;
    }
    return {
      directory: fixture.directory, apiBase: `http://127.0.0.1:${apiPort}`, webBase: web ? origin : null, origin,
      secret: String(fixture.environment.INTERNAL_API_SECRET), apiPid: api.child.pid, webPid: web?.child.pid,
      apiReadyMs, webReadyMs, stop,
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** One signed-in owner of the disposable fixture. Calls go straight to the API (as the web proxy does) or through the web. */
export class FixtureClient {
  private cookie = '';
  constructor(private readonly fixture: MeasureFixture) {}

  private async raw(base: string, method: string, route: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { origin: this.fixture.origin };
    if (base === this.fixture.apiBase) headers['x-mohassan-internal'] = this.fixture.secret;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    return fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  }

  async call<T>(method: string, route: string, body?: unknown, via: 'api' | 'web' = 'api'): Promise<T> {
    const base = via === 'web' ? this.fixture.webBase : this.fixture.apiBase;
    if (!base) throw new Error('FIXTURE_WEB_NOT_STARTED');
    const response = await this.raw(base, method, route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${method} ${route}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async signIn(): Promise<void> {
    const email = 'owner@example.test', password = 'Isolated-Browser-Password-42';
    const setup = await this.call<{ needsSetup: boolean }>('GET', '/api/setup');
    if (setup.needsSetup) await this.call('POST', '/api/setup', { name: 'مالك القياس', email, password, setupToken: 'browser-test-setup-token-isolated-fixture-0001' });
    const response = await this.raw(this.fixture.apiBase, 'POST', '/api/auth/sign-in/email', { email, password });
    if (!response.ok) throw new Error(`SIGN_IN_FAILED ${response.status} ${(await response.text()).slice(0, 200)}`);
    await response.body?.cancel();
    this.cookie = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    if (!this.cookie) throw new Error('SIGN_IN_NO_COOKIE');
  }
}

export interface Conversation {
  id: string; status: string; title: string; updatedAt: string;
  messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[];
  question: { id: string; prompt: string; options?: unknown[]; fields?: unknown[] } | null;
  approval: unknown; secure: { kind: string; site: string } | null;
  browser: { url: string; title: string; live: boolean } | null;
  /** The server's browser level (0–4) when the conversation records one; absent before the browser levels existed. */
  visibility?: { level: number; code?: string; reason?: string } | null;
  progress: string | null; steps: { id: string; text: string; createdAt: string }[]; error: string | null;
}

export interface RunObservation {
  conversationId: string;
  sentAt: number;
  acceptMs: number;
  acceptedStatus: string;
  acceptedProgress: string | null;
  settleMs: number | null;
  timedOut: boolean;
  status: string;
  progress: { text: string; firstSeenMs: number }[];
  browserVisibleMs: number | null;
  browserUrl: string | null;
  /** The highest browser level (conversation.visibility.level) seen while following the run; 3 = the panel would open. Null when the server records none. */
  browserLevel: number | null;
  polls: number;
  userAt: number | null;
  assistantAt: number | null;
  serverMs: number | null;
  steps: { text: string; atMs: number }[];
  answer: string | null;
  question: { prompt: string; fields: number; options: number } | null;
  secure: string | null;
  error: string | null;
}

/** Sends one request and follows it to a settled state. Times are client wall-clock ms from just before the POST. */
export async function observeRun(client: FixtureClient, request: { text: string; conversationId?: string }, options: { pollMs: number; timeoutMs: number }): Promise<RunObservation> {
  const userCountBefore = request.conversationId
    ? (await client.call<Conversation>('GET', `/api/chat/conversations/${request.conversationId}`)).messages.length : 0;
  const sentAt = Date.now();
  const accepted = request.conversationId
    ? await client.call<Conversation>('POST', `/api/chat/conversations/${request.conversationId}/messages`, { text: request.text })
    : await client.call<Conversation>('POST', '/api/chat/conversations', { goal: request.text });
  const acceptMs = Date.now() - sentAt;
  const progress: { text: string; firstSeenMs: number }[] = [];
  const seen = new Set<string>();
  const note = (detail: Conversation, at: number) => {
    if (detail.progress && !seen.has(detail.progress)) { seen.add(detail.progress); progress.push({ text: detail.progress, firstSeenMs: at }); }
  };
  note(accepted, acceptMs);
  let detail = accepted, polls = 0, browserVisibleMs: number | null = accepted.browser ? acceptMs : null;
  let browserLevel: number | null = accepted.visibility?.level ?? null;
  const level = (current: Conversation) => { const seen = current.visibility?.level; if (typeof seen === 'number') browserLevel = Math.max(browserLevel ?? -1, seen); };
  let settleMs: number | null = accepted.status === 'running' ? null : acceptMs;
  const deadline = sentAt + options.timeoutMs;
  while (detail.status === 'running' && Date.now() < deadline) {
    await delay(options.pollMs);
    detail = await client.call<Conversation>('GET', `/api/chat/conversations/${accepted.id}`);
    polls++;
    const at = Date.now() - sentAt;
    note(detail, at);
    level(detail);
    if (browserVisibleMs === null && detail.browser) browserVisibleMs = at;
    if (detail.status !== 'running') settleMs = at;
  }
  level(detail);
  const timedOut = detail.status === 'running';
  if (timedOut) {
    await client.call('POST', `/api/chat/conversations/${accepted.id}/cancel`, {}).catch(() => {});
    await delay(1500);
    detail = await client.call<Conversation>('GET', `/api/chat/conversations/${accepted.id}`);
  }
  const fresh = detail.messages.slice(userCountBefore);
  const user = fresh.find(message => message.role === 'user');
  const assistant = [...fresh].reverse().find(message => message.role === 'assistant');
  const userAt = user ? Date.parse(user.createdAt) : null, assistantAt = assistant ? Date.parse(assistant.createdAt) : null;
  const question = detail.question
    ? { prompt: detail.question.prompt, fields: Array.isArray(detail.question.fields) ? detail.question.fields.length : 0, options: Array.isArray(detail.question.options) ? detail.question.options.length : 0 }
    : null;
  return {
    conversationId: accepted.id, sentAt, acceptMs, acceptedStatus: accepted.status, acceptedProgress: accepted.progress,
    settleMs, timedOut, status: detail.status, progress, browserVisibleMs, browserUrl: detail.browser?.url ?? null, browserLevel, polls,
    userAt, assistantAt, serverMs: userAt !== null && assistantAt !== null ? assistantAt - userAt : null,
    steps: detail.steps.map(step => ({ text: step.text, atMs: userAt !== null ? Date.parse(step.createdAt) - userAt : NaN })),
    answer: assistant?.text ?? null, question, secure: detail.secure ? `${detail.secure.kind}:${detail.secure.site}` : null, error: detail.error,
  };
}

export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  // Nearest-rank: the smallest value with at least p% of the sample at or below it.
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]!;
}

export function stats(values: (number | null)[]): { n: number; p50: number | null; p95: number | null; min: number | null; max: number | null } {
  const list = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return { n: list.length, p50: percentile(list, 50), p95: percentile(list, 95), min: list.length ? Math.min(...list) : null, max: list.length ? Math.max(...list) : null };
}
