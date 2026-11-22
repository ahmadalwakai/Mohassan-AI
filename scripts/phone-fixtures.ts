/**
 * Records what the iPhone app receives from Mohassan through the Wasla gateway, from a real
 * server: the current brain, no model, an in-memory database, a browser on a small fixture
 * site. Every file in tests/fixtures/phone/ is one real exchange; the TypeScript, Python and
 * Swift contract checks read the same files, so a shape the server stopped sending fails all
 * three (a hand-written fake once hid a wrapped list).
 *
 * Usage: npx tsx scripts/phone-fixtures.ts
 * Nothing outside tests/fixtures/phone/ is written. No network beyond 127.0.0.1.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../apps/server/src/app.ts';

const OUT = join(process.cwd(), 'tests', 'fixtures', 'phone');
const gateway = '/api/wasla/gateway';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A small real site: a cookie wall with a POST form (an approval), and a sign-in page. */
function fixtureSite() {
  const page = (title: string, body: string) => `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site');
    const cookies = request.headers.cookie ?? '';
    const respond = (html: string, headers: Record<string, string> = {}) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); response.end(html); };
    const redirect = (location: string, headers: Record<string, string> = {}) => { response.writeHead(303, { location, ...headers }); response.end(); };
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      if (url.pathname === '/ads') {
        if (!cookies.includes('cookie_choice=reject')) return redirect('/consent');
        return respond(page('Ads landing page', '<h1>Advertising home</h1>'));
      }
      if (url.pathname === '/consent' && request.method === 'POST' && form.get('choice') === 'reject') return redirect('/ads', { 'set-cookie': 'cookie_choice=reject; Path=/' });
      if (url.pathname === '/consent') return respond(page('Cookie consent', '<h1>Before you continue</h1><p>We use cookies.</p><form method="post"><input type="hidden" name="continue" value="/ads"><button name="choice" value="reject">Reject all</button></form>'));
      if (url.pathname === '/login') return respond(page('Sign in', '<form method="post" action="/login"><input name="username" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>'));
      if (url.pathname === '/account') { if (!cookies.includes('session=ok')) return redirect('/login'); return respond(page('Account', '<main><h1>Balance: 1250</h1></main>')); }
      return respond(page('Home', '<main><h1>Welcome</h1><a href="/account">Account</a></main>'));
    });
  });
}

async function main() {
  const site = fixtureSite();
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-phone-fixtures-')));
  const webOrigin = 'http://127.0.0.1:3000', secret = 'phone-fixture-internal-secret-000000001', setupToken = 'phone-fixture-setup-token-00000000001';
  const owner = { name: 'Phone fixture owner', email: 'phone-owner@example.test', password: 'Phone-Owner-Fixture-Password-42' };
  // No model is configured: the brain answers with its own calculator, writer, planner and browser hands.
  const application = await createApplication({ authSecret: 'phone-fixture-auth-secret-0000000000001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false,
    codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), browser: { testOrigins: [origin] }, testRequestLimit: 2000, waslaBridgeEnabled: true });
  const app = application.app;
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  const written: { file: string; status: number; conversationStatus?: string }[] = [];

  const web = (cookie = '') => ({ origin: webOrigin, 'x-mohassan-internal': secret, ...(cookie ? { cookie } : {}) });
  let ownerCookie = '', key = '';
  const service = () => ({ authorization: `Bearer ${key}` });
  const expectStatus = (response: { statusCode: number; body: string }, code: number, what: string) => { if (response.statusCode !== code) throw new Error(`${what}: ${response.statusCode} ${response.body}`); };

  /** The fixture site's address changes with every run; the recorded text names it `fixture-site.test` instead. */
  const stable = (text: string) => text.split(origin).join('http://fixture-site.test').split(origin.replace('http://', '')).join('fixture-site.test');
  /** Makes the phone's call and records the exchange. */
  async function record(file: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    const response = await app.inject({ method, url, headers: service(), ...(payload === undefined ? {} : { payload }) });
    const text = stable(response.body);
    const body = text ? JSON.parse(text) : null;
    const envelope = { capturedAt: new Date().toISOString(), sourceCommit: commit, request: { method, url: stable(url), ...(payload === undefined ? {} : { body: JSON.parse(stable(JSON.stringify(payload))) }) }, response: { status: response.statusCode, body } };
    await writeFile(join(OUT, `${file}.json`), JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    written.push({ file, status: response.statusCode, ...(body && typeof body === 'object' && 'status' in body && typeof body.status === 'string' ? { conversationStatus: body.status } : {}) });
    return body;
  }
  async function settle(id: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = (await app.inject({ url: `${gateway}/conversations/${id}`, headers: service() })).json();
      if (detail.status !== 'running') return detail;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`conversation ${id} did not settle`);
  }
  /** Creates a conversation, waits, then records the settled detail under `file`. */
  async function scenario(file: string, goal: string) {
    const created = (await app.inject({ method: 'POST', url: `${gateway}/conversations`, headers: service(), payload: { goal } })).json();
    if (!uuid.test(created.id ?? '')) throw new Error(`${file}: create failed ${JSON.stringify(created)}`);
    await settle(created.id);
    const detail = await record(file, 'GET', `${gateway}/conversations/${created.id}`);
    console.log(`${file}: ${detail.status}`);
    return detail;
  }

  try {
    await mkdir(OUT, { recursive: true });
    for (const entry of await readdir(OUT)) if (entry.endsWith('.json')) await unlink(join(OUT, entry));

    expectStatus(await app.inject({ method: 'POST', url: '/api/setup', headers: web(), payload: { ...owner, setupToken } }), 200, 'setup');
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: web(), payload: { email: owner.email, password: owner.password } });
    expectStatus(signIn, 200, 'sign-in');
    ownerCookie = [signIn.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const pairing = await app.inject({ method: 'POST', url: '/api/wasla/pairing', headers: web(ownerCookie), payload: {} });
    expectStatus(pairing, 200, 'pairing code');
    const paired = await app.inject({ method: 'POST', url: `${gateway}/pair`, payload: { code: pairing.json().code, name: 'Wasla on this PC' } });
    expectStatus(paired, 200, 'gateway pair');
    key = paired.json().gatewayKey;

    await record('status', 'GET', `${gateway}/status`);
    await record('list-empty', 'GET', `${gateway}/conversations`);

    // 1. A finished answer from the brain's calculator; the create response is the first thing the phone sees.
    const created = await record('create', 'POST', `${gateway}/conversations`, { goal: 'كم يساوي 15 ضرب 23؟' });
    await settle(created.id);
    await record('detail-completed', 'GET', `${gateway}/conversations/${created.id}`);
    await record('campaign-events', 'GET', `${gateway}/conversations/${created.id}/campaign-events?after=0`);
    // A second message in the finished conversation. Today the brain's calculator does not take «و 40 ضرب 3؟» as a follow-up, so this records the honest no-model failure the phone must show.
    const followUp = await record('messages-text', 'POST', `${gateway}/conversations/${created.id}/messages`, { text: 'و 40 ضرب 3؟' });
    await settle(followUp.id);
    await record('detail-failed-follow-up-no-model', 'GET', `${gateway}/conversations/${created.id}`);

    // 2. A question with several fields (the writer), answered as one numbered reply, the way the web does at this commit.
    const letter = await scenario('detail-question-fields', 'اكتب لي رسالة اعتذار لعميل');
    if (letter.status === 'waiting_user' && letter.question?.fields?.length) {
      const values = ['الأستاذ خالد', 'اعتذار', 'تأخر التسليم يومين بسبب الشحن، وسيصل الطلب يوم الأحد', 'موحسن'];
      const text = letter.question.fields.map((_: unknown, index: number) => `${index + 1}. ${values[index] ?? 'نعم'}`).join('\n');
      await record('messages-numbered-reply', 'POST', `${gateway}/conversations/${letter.id}/messages`, { text });
      await settle(letter.id);
      await record('detail-completed-letter', 'GET', `${gateway}/conversations/${letter.id}`);
      // The question is gone: answering it again is refused.
      await record('error-question-changed', 'POST', `${gateway}/conversations/${letter.id}/respond`, { questionId: letter.question.id, optionId: 'stop' });
    }
    // The same question, stopped with its one option.
    const stopped = await scenario('detail-question-before-stop', 'اكتب رسالة شكر لفريق العمل');
    if (stopped.status === 'waiting_user' && stopped.question?.options?.some((option: { id: string }) => option.id === 'stop')) {
      await record('respond-stop', 'POST', `${gateway}/conversations/${stopped.id}/respond`, { questionId: stopped.question.id, optionId: 'stop' });
      await settle(stopped.id);
      await record('detail-stopped', 'GET', `${gateway}/conversations/${stopped.id}`);
    }

    // 3. An approval: the cookie wall's POST form waits for the owner; here the owner refuses.
    const consent = await scenario('detail-approval', `افتح ${origin}/ads`);
    if (consent.status === 'waiting_approval') {
      await record('approve-refused', 'POST', `${gateway}/conversations/${consent.id}/approve`, { approvalId: consent.approval.id, approved: false });
      await settle(consent.id);
      await record('detail-approval-refused', 'GET', `${gateway}/conversations/${consent.id}`);
      await record('error-approval-changed', 'POST', `${gateway}/conversations/${consent.id}/approve`, { approvalId: consent.approval.id, approved: true });
    }

    // 4. Stopping while an approval waits. The conversation returns to idle; the run alone is marked cancelled.
    const interrupted = await scenario('detail-approval-before-cancel', `افتح ${origin}/ads`);
    await record('cancel', 'POST', `${gateway}/conversations/${interrupted.id}/cancel`, {});
    await record('detail-cancelled', 'GET', `${gateway}/conversations/${interrupted.id}`);

    // 5. Three real failures: a sign-in the hands cannot do without a model, a private address, and a
    //    question that goes to web search (the default) while the fixture allows no public network.
    await scenario('detail-failed-no-model', `افتح ${origin}/account وسجّل الدخول`);
    await scenario('detail-failed-blocked-address', 'افتح http://10.0.0.9/');
    await scenario('detail-failed-search-blocked', 'مرحبا، كيف حالك اليوم؟');

    await record('list', 'GET', `${gateway}/conversations`);
    await record('error-not-found', 'GET', `${gateway}/conversations/00000000-0000-4000-8000-000000000000`);
    await record('error-invalid-id', 'GET', `${gateway}/conversations/not-a-uuid`);
    await record('delete', 'DELETE', `${gateway}/conversations/${created.id}`);
    await record('error-deleted', 'GET', `${gateway}/conversations/${created.id}`);

    await writeFile(join(OUT, 'index.json'), JSON.stringify({ capturedAt: new Date().toISOString(), sourceCommit: commit, generator: 'scripts/phone-fixtures.ts', fixtures: written }, null, 2) + '\n', 'utf8');
    console.log(`\n${written.length} fixtures written to ${OUT}`);
    for (const item of written) console.log(`  ${item.file.padEnd(32)} HTTP ${item.status}${item.conversationStatus ? `  ${item.conversationStatus}` : ''}`);
  } finally {
    await app.close().catch(() => {});
    await new Promise(resolve => site.close(resolve));
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exit(1); });
