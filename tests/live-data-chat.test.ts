import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBrowser, SafeNetwork, type SafeResponse } from '@mohassan/browser';
import type { ChatConversation } from '@mohassan/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import forecast from './fixtures/live-data/open-meteo-forecast.json';
import geocoding from './fixtures/live-data/open-meteo-geocoding.json';

const ecb = readFileSync(new URL('./fixtures/live-data/ecb-daily-2026-11-24.xml', import.meta.url));
const origin = 'http://127.0.0.1:3000';
const internalSecret = 'fixture-live-data-internal-00001';
const setupToken = 'fixture-live-data-setup-token-00001';
const owner = { name: 'Live Data Owner', email: 'live-owner@example.test', password: 'Live-Owner-Fixture-Password-42' };
const member = { name: 'Live Data Member', email: 'live-member@example.test', password: 'Live-Member-Fixture-Password-42' };
const chats = '/api/chat/conversations';
const clock = new Date('2026-11-25T03:44:25Z'); // Date of the recorded Open-Meteo forecast.
const search = vi.fn(async (_query: string) => []);
const model = vi.fn<typeof fetch>(async () => { throw new Error('An offline chat test cannot reach a model.'); });
const browserAct = vi.fn<AgentBrowser['act']>(async () => { throw new Error('An offline chat test cannot act in a browser.'); });
const browserObserve = vi.fn<AgentBrowser['observe']>(async () => { throw new Error('An offline chat test cannot observe a browser.'); });
const source = vi.fn<SafeNetwork['request']>(async (input): Promise<SafeResponse> => {
  const url = new URL(input);
  if (url.origin === 'https://geocoding-api.open-meteo.com' && url.pathname === '/v1/search') {
    // Hand-written source failure for this city. Successful requests use recorded fixtures.
    if (url.searchParams.get('name') === 'Reykjavik') return { url: input, status: 503, headers: {}, body: Buffer.alloc(0) };
    if (url.searchParams.get('name') === 'London' && url.searchParams.get('language') === 'ar') {
      return { url: input, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(geocoding)) };
    }
  }
  if (url.origin === 'https://api.open-meteo.com' && url.pathname === '/v1/forecast') {
    expect(Number(url.searchParams.get('latitude'))).toBe(geocoding.results[0].latitude);
    expect(Number(url.searchParams.get('longitude'))).toBe(geocoding.results[0].longitude);
    return { url: input, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(forecast)) };
  }
  if (url.origin === 'https://www.ecb.europa.eu' && url.pathname === '/stats/eurofxref/eurofxref-daily.xml') {
    return { url: input, status: 200, headers: { 'content-type': 'application/xml' }, body: ecb };
  }
  throw new Error(`Unexpected live data endpoint ${url.origin}${url.pathname}`);
});

const assistantMessages = (conversation: ChatConversation) => conversation.messages.filter(message => message.role === 'assistant');
const answer = (conversation: ChatConversation) => assistantMessages(conversation).at(-1)?.text;

describe('live data through the normal owner and member chat routes', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory: string | undefined;
  const sessions = { owner: '', member: '' };

  async function call(method: 'GET' | 'POST', url: string, session: string, payload?: Record<string, unknown>) {
    const response = await application!.app.inject({ method, url, payload, headers: {
      origin, 'x-mohassan-internal': internalSecret, ...(session ? { cookie: session } : {}),
    } });
    expect(response.statusCode, `${method} ${url}`).toBe(200);
    return response;
  }

  async function login(credentials: { email: string; password: string }) {
    const response = await call('POST', '/api/auth/sign-in/email', '', { email: credentials.email, password: credentials.password });
    const cookies = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]);
    expect(cookies.length).toBeGreaterThan(0);
    return cookies.join('; ');
  }

  async function settled(id: string, session: string) {
    return vi.waitFor(async () => {
      const detail = (await call('GET', `${chats}/${id}`, session)).json<ChatConversation>();
      expect(detail.status).not.toBe('running');
      expect(detail.error).toBeNull();
      return detail;
    }, { interval: 20, timeout: 4000 });
  }

  async function create(goal: string, session: string) {
    vi.setSystemTime(Date.now() + 1000);
    const { id } = (await call('POST', chats, session, { goal })).json<ChatConversation>();
    return settled(id, session);
  }

  async function send(id: string, text: string, session: string, questionId?: string) {
    vi.setSystemTime(Date.now() + 1000);
    await call('POST', `${chats}/${id}/messages`, session, { text, ...(questionId ? { questionId } : {}) });
    return settled(id, session);
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: clock });
    vi.spyOn(SafeNetwork.prototype, 'request').mockImplementation(source);
    vi.spyOn(AgentBrowser.prototype, 'act').mockImplementation(browserAct);
    vi.spyOn(AgentBrowser.prototype, 'observe').mockImplementation(browserObserve);
    directory = await mkdtemp(join(tmpdir(), 'mohassan-live-data-chat-'));
    application = await createApplication({
      authSecret: 'fixture-live-data-auth-secret-00001', internalSecret, setupToken, webOrigin: origin,
      production: false, runWorker: false, testRequestLimit: 1000, aiFetch: model,
      dataDir: directory, documentsDir: join(directory, 'documents'), browserProfileDir: join(directory, 'browser'),
      codingDataDir: join(directory, 'coding'), studioAiDataDir: join(directory, 'studio'), codingAllowedRoots: [directory],
      browser: { searchProvider: { name: 'offline-live-data-fallback', search } },
    });
    await call('POST', '/api/setup', '', { ...owner, setupToken });
    sessions.owner = await login(owner);
    const invitation = (await call('POST', '/api/members/invites', sessions.owner, { name: member.name, email: member.email })).json<{ url: string }>();
    const token = new URL(invitation.url).hash.replace(/^#invite=/u, '');
    await call('POST', '/api/invites/accept', '', { token, name: member.name, password: member.password });
    sessions.member = await login(member);
  }, 60_000);

  beforeEach(() => {
    search.mockClear();
    model.mockClear();
    browserAct.mockClear();
    browserObserve.mockClear();
    source.mockClear();
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['owner', 'member'] as const)('answers all four kinds directly for the %s', async role => {
    const session = sessions[role];
    expect((await call('GET', '/api/access', session)).json().role).toBe(role);
    const hijri = await create('ما تاريخ اليوم بالهجري؟', session);
    expect(answer(hijri)).toMatch(/2026-11-25[^\n]+UTC/u);
    expect(answer(hijri)).toContain('جدول تقويم أم القرى');
    expect(answer(hijri)).toContain('جمادى الآخرة');

    const prayer = await send(hijri.id, 'مواقيت الصلاة في London يوم ٢٠٢٦-٠٦-٢١ بقاعدة سبع الليل', session);
    expect(answer(prayer)).toContain('مواقيت الصلاة في لندن');
    expect(answer(prayer)).toContain('2026-06-21 (Europe/London)');
    expect(answer(prayer)).toContain('سُبع الليل');
    expect(answer(prayer)).toContain('رابطة العالم الإسلامي');
    expect(answer(prayer)).toContain('NOAA');

    const weather = await send(hijri.id, 'ما الطقس الآن في London؟', session);
    expect(answer(weather)).toContain('4.4 °C');
    expect(answer(weather)).toContain('2026-11-25 03:30 (Europe/London)');
    expect(answer(weather)).toContain('Open-Meteo');
    expect(answer(weather)).toContain('Best Match');

    const rates = await send(hijri.id, 'حوّل ١٢٣٫٤٥ USD إلى GBP', session);
    expect(answer(rates)).toContain('123.45 USD ≈ 94.25 GBP');
    expect(answer(rates)).toContain('سعر مرجعي يومي من البنك المركزي الأوروبي بتاريخ 2026-11-24، وليس سعر السوق اللحظي');
    expect(rates.status).toBe('idle');
    expect(rates.browser).toBeNull();
    const runs = await application!.database.db.selectFrom('chat_runs').select(['id', 'status'])
      .where('conversation_id', '=', hijri.id).execute();
    expect(runs).toHaveLength(4);
    expect(runs.map(run => run.status)).toEqual(Array(4).fill('completed'));
    const receipts = await application!.database.db.selectFrom('chat_model_receipts').select('id').where('run_id', 'in', runs.map(run => run.id)).execute();
    expect(receipts).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(browserAct).not.toHaveBeenCalled();
    expect(browserObserve).not.toHaveBeenCalled();
  });

  it('asks a member for the city once and uses the next message without adding it to memory', async () => {
    const session = sessions.member;
    const question = await create('مواقيت الصلاة يوم ٢٠٢٦-٠٦-٢١', session);
    expect(question.status).toBe('waiting_user');
    expect(question.question?.prompt).toContain('ما المدينة');
    expect(assistantMessages(question)).toHaveLength(1);
    expect(source).not.toHaveBeenCalled();

    const result = await send(question.id, 'London', session, question.question!.id);
    expect(result.status).toBe('idle');
    expect(result.question).toBeNull();
    expect(assistantMessages(result)).toHaveLength(2);
    expect(answer(result)).toContain('2026-06-21 (Europe/London)');
    expect(answer(result)).toContain('استُخدمت لتقدير الفجر، العشاء');
    expect((await call('GET', '/api/memory', session)).json().items).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(browserAct).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('explains source failure, tries the ordinary lookup and still answers the next direct request', async () => {
    const session = sessions.owner;
    const failed = await create('What is the weather in Reykjavik today?', session);
    expect(source).toHaveBeenCalledTimes(1);
    const replies = assistantMessages(failed).map(message => message.text);
    expect(replies).toHaveLength(2);
    expect(replies).toEqual(expect.arrayContaining([
      expect.stringContaining('Could not retrieve usable data from Open-Meteo geocoding'),
      expect.stringContaining('could not reach a current source'),
    ]));
    expect(search).toHaveBeenCalled();
    expect(browserAct).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();

    const recovered = await send(failed.id, 'ما الطقس الآن في London؟', session);
    expect(answer(recovered)).toContain('4.4 °C');
    expect(answer(recovered)).toContain('Open-Meteo');
  });

  it('explains unsupported market coverage without asking any external source', async () => {
    const result = await create('What is the price of gold today?', sessions.member);
    expect(answer(result)).toContain('لا يوجد مصدر حي موثوق');
    expect(answer(result)).toContain('does not cover gold');
    expect(source).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(browserAct).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
});
