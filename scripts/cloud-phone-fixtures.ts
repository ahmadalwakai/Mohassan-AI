/**
 * Records what the iPhone app receives from the cloud server, the same routes the web uses: sign-in, the chat
 * with its questions, approvals and request keys, and Windows remote control. A real server (the current brain,
 * no model, an in-memory database, a browser on a small fixture site) answers every call; the Swift check in
 * apps/ios/Tools decodes the same files, so a shape the server stopped sending fails there.
 *
 * Usage: npx tsx scripts/cloud-phone-fixtures.ts <output directory>
 * Only *.json files in the output directory are replaced. No network beyond 127.0.0.1.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) { console.error('Usage: npx tsx scripts/cloud-phone-fixtures.ts <output directory>'); process.exit(2); }
const OUT = resolve(target);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The phone sends a fresh Idempotency-Key with every create, message, answer and approval; fixed here so the files stay stable. */
const keys = {
  create: 'phone-create-0001', followUp: 'phone-message-0002', fields: 'phone-fields-0003', questionAgain: 'phone-respond-0004',
  stop: 'phone-respond-0005', approve: 'phone-approve-0006', approveAgain: 'phone-approve-0007', greeting: 'phone-create-0008',
};

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
      if (url.pathname === '/consent') return respond(page('Cookie consent', '<h1>Before you continue</h1><p>We use cookies.</p><form method="post"><input type="hidden" name="continue" value="/ads"><button name="choice" value="reject">Reject all</button><button name="choice" value="accept">Accept all</button></form>'));
      if (url.pathname === '/login') return respond(page('Sign in', '<form method="post" action="/login"><input name="username" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>'));
      if (url.pathname === '/account') { if (!cookies.includes('session=ok')) return redirect('/login'); return respond(page('Account', '<main><h1>Balance: 1250</h1></main>')); }
      return respond(page('Home', '<main><h1>Welcome</h1><a href="/account">Account</a></main>'));
    });
  });
}

async function main() {
  // Use the server's test guard before importing the app, including its shadow classifiers.
  process.env.VITEST = '1';
  delete process.env.MOHASSAN_SCRATCH_CLASSIFIERS;
  const { createApplication } = await import('../apps/server/src/app.ts');
  const site = fixtureSite();
  await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-cloud-phone-fixtures-')));
  const webOrigin = 'http://127.0.0.1:3000', secret = 'cloud-phone-fixture-internal-secret-0001', setupToken = 'cloud-phone-fixture-setup-token-000001';
  const owner = { name: 'Phone fixture owner', email: 'phone-owner@example.test', password: 'Phone-Owner-Fixture-Password-42' };
  const wrongPassword = 'not-the-password-0000';
  // No model is configured: the brain answers with its own calculator, writer, planner and browser hands.
  const application = await createApplication({ authSecret: 'cloud-phone-fixture-auth-secret-00000001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false,
    codingAllowedRoots: [directory], codingDataDir: join(directory, 'coding'), documentsDir: join(directory, 'documents'), browserProfileDir: join(directory, 'browser'),
    browser: { testOrigins: [origin] }, windowsEnabled: true, testRequestLimit: 2000 });
  const app = application.app;
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  const written: { file: string; status: number; conversationStatus?: string }[] = [];
  let cookie = '';
  const redactions = new Map([[owner.password, '[fixture password]'], [wrongPassword, '[wrong fixture password]']]);
  /** What the web proxy sends to the server for the phone: the internal secret, the site's origin and the session cookie. */
  const web = (extra: Record<string, string> = {}) => ({ origin: webOrigin, 'x-mohassan-internal': secret, ...(cookie ? { cookie } : {}), ...extra });
  /** Preserve wire shapes while excluding ephemeral credentials from the recordings. */
  const stable = (text: string) => {
    let result = text.replaceAll(origin, 'http://fixture-site.test').replaceAll(origin.replace('http://', ''), 'fixture-site.test');
    for (const [value, replacement] of redactions) result = result.replaceAll(value, replacement);
    return result;
  };

  async function record(file: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, options: { key?: string; signedOut?: boolean; headers?: string[] } = {}) {
    const headers = options.signedOut ? { origin: webOrigin, 'x-mohassan-internal': secret } : web(options.key ? { 'idempotency-key': options.key } : {});
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    const body = response.body ? response.json() : null;
    if (url === '/api/auth/sign-in/email' && typeof body?.token === 'string' && body.token) redactions.set(body.token, '[fixture token]');
    if (url === '/api/auth/get-session' && typeof body?.session?.token === 'string' && body.session.token) redactions.set(body.session.token, '[fixture token]');
    if (url === '/api/windows/pairing' && typeof body?.code === 'string' && body.code) redactions.set(body.code, 'A'.repeat(16));
    const kept: Record<string, string[]> = {};
    for (const name of options.headers ?? []) {
      const value = response.headers[name];
      if (value !== undefined) kept[name] = [value].flat().map(item => String(item).replace(/=([^;]+)/, (_, cookieValue: string) => `=${'A'.repeat(32)}.${'B'.repeat(43)}${cookieValue.endsWith('%3D') ? '%3D' : ''}`));
    }
    const envelope = { capturedAt: new Date().toISOString(), sourceCommit: commit,
      request: { method, url: stable(url), ...(options.key ? { idempotencyKey: options.key } : {}), ...(payload === undefined ? {} : { body: JSON.parse(stable(JSON.stringify(payload))) }) },
      response: { status: response.statusCode, ...(Object.keys(kept).length ? { headers: kept } : {}), body: response.body ? JSON.parse(stable(response.body)) : null } };
    await writeFile(join(OUT, `${file}.json`), JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    written.push({ file, status: response.statusCode, ...(body && typeof body === 'object' && 'status' in body && typeof body.status === 'string' ? { conversationStatus: body.status } : {}) });
    return { status: response.statusCode, body, raw: response };
  }
  async function settle(id: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = (await app.inject({ url: `/api/chat/conversations/${id}`, headers: web() })).json();
      if (detail.status !== 'running') return detail;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`conversation ${id} did not settle`);
  }
  /** Creates a conversation, waits, then records the settled detail under `file`. */
  async function scenario(file: string, goal: string) {
    const created = (await app.inject({ method: 'POST', url: '/api/chat/conversations', headers: web({ 'idempotency-key': `phone-${randomUUID()}` }), payload: { goal } })).json();
    if (!uuid.test(created.id ?? '')) throw new Error(`${file}: create failed ${JSON.stringify(created)}`);
    await settle(created.id);
    const { body } = await record(file, 'GET', `/api/chat/conversations/${created.id}`);
    console.log(`${file}: ${body.status}`);
    return body;
  }

  try {
    await mkdir(OUT, { recursive: true });
    for (const entry of await readdir(OUT)) if (entry.endsWith('.json')) await unlink(join(OUT, entry));

    // 0. Signing in, as the phone does it: the session cookie comes back in Set-Cookie and is sent on every later call.
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: web(), payload: { ...owner, setupToken } });
    if (setup.statusCode !== 200) throw new Error(`setup: ${setup.statusCode} ${setup.body}`);
    await record('auth-sign-in-wrong-password', 'POST', '/api/auth/sign-in/email', { email: owner.email, password: wrongPassword, rememberMe: true }, { signedOut: true });
    const signIn = await record('auth-sign-in', 'POST', '/api/auth/sign-in/email', { email: owner.email, password: owner.password, rememberMe: true }, { signedOut: true, headers: ['set-cookie'] });
    if (signIn.status !== 200) throw new Error(`sign-in: ${signIn.status}`);
    cookie = [signIn.raw.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    await record('error-signed-out', 'GET', '/api/chat/conversations', undefined, { signedOut: true });
    await record('auth-session', 'GET', '/api/auth/get-session');

    await record('list-empty', 'GET', '/api/chat/conversations');
    await record('images-available', 'GET', '/api/chat/images');

    // 1. A finished answer from the brain's calculator; the create reply is the first thing the phone sees.
    const created = (await record('create', 'POST', '/api/chat/conversations', { goal: 'كم يساوي 15 ضرب 23؟' }, { key: keys.create })).body;
    const finished = await settle(created.id);
    await record('detail-completed', 'GET', `/api/chat/conversations/${created.id}`);
    // A held read that sees no change answers after its wait with the same view.
    if (typeof finished.version === 'string') await record('detail-held-unchanged', 'GET', `/api/chat/conversations/${created.id}?since=${finished.version}&wait=300`);
    // The same request again with its key, as after a lost reply: the first answer comes back, nothing runs twice.
    await record('create-replayed', 'POST', '/api/chat/conversations', { goal: 'كم يساوي 15 ضرب 23؟' }, { key: keys.create });
    // The same key for a different request is refused.
    await record('error-request-reused', 'POST', '/api/chat/conversations', { goal: 'كم يساوي 2 ضرب 2؟' }, { key: keys.create });
    const followUp = (await record('messages-text', 'POST', `/api/chat/conversations/${created.id}/messages`, { text: 'و 40 ضرب 3؟' }, { key: keys.followUp })).body;
    const followed = await settle(followUp.id);
    await record('detail-completed-follow-up', 'GET', `/api/chat/conversations/${created.id}`);
    const reply = [...followed.messages].reverse().find((message: { role: string }) => message.role === 'assistant');
    if (reply) await record('feedback', 'POST', `/api/chat/conversations/${created.id}/feedback`, { messageId: reply.id, verdict: 'useful' });

    // 2. A question with several fields (the writer), answered the way the phone and the web answer it.
    const letter = await scenario('detail-question-fields', 'اكتب لي رسالة اعتذار لعميل');
    if (letter.status === 'waiting_user' && letter.question?.fields?.length) {
      const typed: Record<string, string> = { to: 'الأستاذ خالد', details: 'تأخر التسليم يومين بسبب الشحن، وسيصل الطلب يوم الأحد', from: 'موحسن' };
      const answers = letter.question.fields.map((field: { id: string; suggestions: { label: string }[]; selected?: number[] }) =>
        ({ fieldId: field.id, value: typed[field.id] ?? field.suggestions[field.selected?.[0] ?? 0]?.label ?? 'نعم' }));
      await record('messages-field-answers', 'POST', `/api/chat/conversations/${letter.id}/messages`, { text: '', questionId: letter.question.id, answers }, { key: keys.fields });
      await settle(letter.id);
      await record('detail-completed-letter', 'GET', `/api/chat/conversations/${letter.id}`);
      // The question is gone: answering it again is refused.
      await record('error-question-changed', 'POST', `/api/chat/conversations/${letter.id}/respond`, { questionId: letter.question.id, optionId: 'stop' }, { key: keys.questionAgain });
    }
    // The same kind of question, stopped with its one option.
    const stopped = await scenario('detail-question-before-stop', 'اكتب رسالة شكر لفريق العمل');
    if (stopped.status === 'waiting_user' && stopped.question?.options?.some((option: { id: string }) => option.id === 'stop')) {
      await record('respond-stop', 'POST', `/api/chat/conversations/${stopped.id}/respond`, { questionId: stopped.question.id, optionId: 'stop' }, { key: keys.stop });
      await settle(stopped.id);
      await record('detail-stopped', 'GET', `/api/chat/conversations/${stopped.id}`);
    }

    // 3. An approval: the cookie wall's POST form waits for the owner; here the owner refuses.
    const consent = await scenario('detail-approval', `افتح ${origin}/ads`);
    if (consent.status === 'waiting_approval') {
      await record('approve-refused', 'POST', `/api/chat/conversations/${consent.id}/approve`, { approvalId: consent.approval.id, approved: false }, { key: keys.approve });
      await settle(consent.id);
      await record('detail-approval-refused', 'GET', `/api/chat/conversations/${consent.id}`);
      await record('error-approval-changed', 'POST', `/api/chat/conversations/${consent.id}/approve`, { approvalId: consent.approval.id, approved: true }, { key: keys.approveAgain });
    }

    // 4. Stopping while an approval waits.
    const interrupted = await scenario('detail-approval-before-cancel', `افتح ${origin}/ads`);
    await record('cancel', 'POST', `/api/chat/conversations/${interrupted.id}/cancel`, {});
    await record('detail-cancelled', 'GET', `/api/chat/conversations/${interrupted.id}`);

    // 5. A sign-in page, a private address the brain refuses, and a greeting.
    const login = await scenario('detail-sign-in', `افتح ${origin}/account وسجّل الدخول`);
    if (login.status === 'waiting_input' && login.secure) {
      await record('secure-skip', 'POST', `/api/chat/conversations/${login.id}/secure`, { requestId: login.secure.id, action: 'skip' });
      await settle(login.id);
      await record('detail-sign-in-skipped', 'GET', `/api/chat/conversations/${login.id}`);
    }
    await scenario('detail-failed-blocked-address', 'افتح http://10.0.0.9/');
    const greeting = (await record('create-greeting', 'POST', '/api/chat/conversations', { goal: 'مرحبا، كيف حالك اليوم؟' }, { key: keys.greeting })).body;
    await settle(greeting.id);
    await record('detail-greeting', 'GET', `/api/chat/conversations/${greeting.id}`);

    await record('list', 'GET', '/api/chat/conversations');
    await record('error-not-found', 'GET', '/api/chat/conversations/00000000-0000-4000-8000-000000000000');
    await record('error-invalid-id', 'GET', '/api/chat/conversations/not-a-uuid');
    await record('error-invalid-body', 'POST', `/api/chat/conversations/${created.id}/messages`, { text: '' }, { key: 'phone-message-0009' });
    await record('delete', 'DELETE', `/api/chat/conversations/${created.id}`);
    await record('error-deleted', 'GET', `/api/chat/conversations/${created.id}`);

    // 6. Windows remote control from the phone: no device, a pairing code, the companion's live state, a control
    //    grant, a fresh frame, one click, then STOP. The companion's own calls are made here as the companion makes them.
    await record('windows-empty', 'GET', '/api/windows');
    const pairing = (await record('windows-pairing', 'POST', '/api/windows/pairing', {})).body;
    const paired = await app.inject({ method: 'POST', url: '/api/windows/companion/pair', payload: { code: pairing.code, name: 'Office PC' } });
    if (paired.statusCode !== 200) throw new Error(`companion pair: ${paired.statusCode} ${paired.body}`);
    const { deviceId, deviceKey } = paired.json() as { deviceId: string; deviceKey: string };
    const approvalNonce = randomUUID(), targetKey = 'a'.repeat(64);
    const jpeg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64');
    const poll = (frame: unknown, localControl = true) => app.inject({ method: 'POST', url: '/api/windows/companion/poll', headers: { authorization: `Bearer ${deviceId}.${deviceKey}` }, payload: {
      nonce: randomUUID(), sentAt: new Date().toISOString(), ack: null, frame,
      state: { approvalNonce, sessionId: 1, safeDesktop: true, localView: true, localControl, target: { key: targetKey, mode: 'window', title: 'Mohassan Companion', width: 400, height: 200 }, status: 'جلسة تفاعلية' } } });
    if ((await poll(null, false)).statusCode !== 200) throw new Error('companion poll failed');
    await record('windows-view-only', 'GET', '/api/windows');
    await record('error-windows-control-not-allowed', 'POST', `/api/windows/devices/${deviceId}/grants`, { scope: 'control', durationSeconds: 120, targetKey, approvalNonce });
    if ((await poll(null)).statusCode !== 200) throw new Error('companion poll failed');
    await record('windows-ready', 'GET', '/api/windows');
    const grant = (await record('windows-grant', 'POST', `/api/windows/devices/${deviceId}/grants`, { scope: 'control', durationSeconds: 120, targetKey, approvalNonce })).body;
    const frameId = randomUUID();
    if ((await poll({ id: frameId, targetKey, capturedAt: new Date().toISOString(), width: 400, height: 200, jpeg, elements: [] })).statusCode !== 200) throw new Error('companion frame poll failed');
    await record('windows-active', 'GET', '/api/windows');
    await record('windows-frame', 'GET', `/api/windows/devices/${deviceId}/frame`);
    await record('windows-action', 'POST', `/api/windows/devices/${deviceId}/actions`, { grantId: grant.id, nonce: randomUUID(), frameId, action: { type: 'click', x: 0.5, y: 0.25, button: 'left' } });
    await record('windows-stop', 'POST', `/api/windows/devices/${deviceId}/stop`, {});
    await record('windows-stopped', 'GET', '/api/windows');
    await record('error-windows-frame', 'GET', `/api/windows/devices/${deviceId}/frame`);

    await record('auth-sign-out', 'POST', '/api/auth/sign-out', {});
    await record('error-after-sign-out', 'GET', '/api/chat/conversations');

    await writeFile(join(OUT, 'index.json'), JSON.stringify({ capturedAt: new Date().toISOString(), sourceCommit: commit, generator: 'scripts/cloud-phone-fixtures.ts', fixtures: written }, null, 2) + '\n', 'utf8');
    console.log(`\n${written.length} fixtures written to ${OUT}`);
    for (const item of written) console.log(`  ${item.file.padEnd(34)} HTTP ${item.status}${item.conversationStatus ? `  ${item.conversationStatus}` : ''}`);
  } finally {
    await app.close().catch(() => {});
    await new Promise(done => site.close(done));
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exit(1); });
