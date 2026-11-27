/** Runs the model-free suite from measure-no-model-coding.ts. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatConversation } from '@mohassan/contracts';
import { configureModelFreeMeasurement, registerFixtures } from './fixtures.ts';
import { SUITE_CASES } from './suite-cases.ts';
import { scoreSuiteCase, suiteTotals } from './suite-results.ts';
import { createSuiteSandbox } from './suite-sandbox.ts';
import { pairMeasurementDevice, unavailableServerSandbox } from './device-fixture.ts';

const flags = process.argv.slice(2).filter(value => value.startsWith('--'));
const [checkoutArgument, out] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const realSandbox = flags.includes('--real-sandbox');
const viaDeviceLink = flags.includes('--via-device-link');
if (realSandbox && process.platform !== 'win32') throw new Error('The real suite sandbox requires Windows AppContainer');
const checkout = await realpath(resolve(checkoutArgument ?? process.cwd()));
const directory = await realpath(await mkdtemp(join(tmpdir(), 'mohassan-measure-coding-')));

const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const setupToken = 'measure-coding-fixture-setup-token-001';
const owner = { name: 'مالك القياس', email: 'measure@example.test', password: 'Measure-Coding-Password-42' };
const member = { name: 'عضو القياس', email: 'member@example.test', password: 'Measure-Member-Password-42' };
type Application = Awaited<ReturnType<typeof import('../../apps/server/src/app.ts').createApplication>>;
let application: Application | undefined;
type WebFixture = Awaited<ReturnType<typeof startWebFixture>>;
let webFixture: WebFixture | undefined;
let stopDevice: (() => Promise<void>) | undefined;

async function startWebFixture() {
  const fact = 'باريس هي عاصمة فرنسا وأكبر مدنها.';
  const title = 'عاصمة فرنسا';
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('User-agent: *\nAllow: /\n');
    } else if (request.url === '/france') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="ar"><title>${title}</title><body><article><h1>${title}</h1><p>${fact}</p></article></body></html>`);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the local web control');
  const webOrigin = `http://127.0.0.1:${address.port}`;
  return {
    browser: {
      testOrigins: [webOrigin],
      resolver: async () => [],
      searchProvider: { name: 'measurement-web-fixture', async search(question: string) {
        return question.includes('فرنسا') ? [{ title, url: `${webOrigin}/france`, snippet: fact }] : [];
      } },
    },
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}

async function measure(app: Application, startedApp: number, sandbox: ReturnType<typeof createSuiteSandbox> | undefined) {
  const chats = '/api/chat/conversations';
  let cookie = '';
  const api = (method: 'GET' | 'POST', url: string, payload?: object, session = cookie) => app.app.inject({
    method, url, headers: { ...headers, cookie: session }, ...(payload === undefined ? {} : { payload }),
  });
  function requireOk(response: { statusCode: number }, operation: string) {
    if (response.statusCode !== 200) throw new Error(`${operation}: HTTP ${response.statusCode}`);
  }
  async function signIn({ email, password }: typeof owner) {
    const login = await api('POST', '/api/auth/sign-in/email', { email, password }, '');
    requireOk(login, 'Sign-in');
    const values = [login.headers['set-cookie']].flat().filter(Boolean);
    if (!values.length) throw new Error('Sign-in returned no session cookie');
    return values.map(value => String(value).split(';')[0]).join('; ');
  }
  async function settled(id: string, session = cookie) {
    const deadline = Date.now() + 90_000;
    do {
      const response = await api('GET', `${chats}/${id}`, undefined, session);
      requireOk(response, 'Read conversation');
      const detail = response.json<ChatConversation>();
      if (detail.status !== 'running') return detail;
      // Keep polling bounded even if a worker stalls.
      await new Promise(done => setTimeout(done, 300));
    } while (Date.now() < deadline);
    return null;
  }

  requireOk(await api('POST', '/api/setup', { ...owner, setupToken }), 'Owner setup');
  cookie = await signIn(owner);
  const ownerSession = await api('GET', '/api/access');
  requireOk(ownerSession, 'Read owner session');
  const ownerId = ownerSession.json<{ user: { id: string } }>().user.id;
  const tasks = (accountId = ownerId) => app.runtime.snapshot(accountId).then(snapshot => snapshot.tasks);
  const reply = (detail: ChatConversation | null) => detail?.messages.findLast(message => message.role === 'assistant')?.text ?? null;
  const caseStatus = (detail: ChatConversation | null) => detail?.status ?? 'timeout';

  if (viaDeviceLink) {
    const device = await pairMeasurementDevice(app, {
      checkout, ownerId, dataDir: directory, allowedRoots: [directory], sandbox,
      createPairing: () => api('POST', '/api/coding/devices/pairing', {}),
    });
    stopDevice = await device.start();
  }
  const startupMs = Date.now() - startedApp;
  if (realSandbox) {
    const workspace = await api('GET', '/api/coding/projects');
    requireOk(workspace, 'Check Windows sandbox readiness');
    const { sandbox } = workspace.json<{ sandbox: { available: boolean; provider: string | null } }>();
    if (!sandbox.available || sandbox.provider !== 'windows-appcontainer') throw new Error('Windows AppContainer did not pass its readiness probe');
  }
  await registerFixtures(directory, project => api('POST', '/api/coding/projects', project));
  const invitation = await api('POST', '/api/members/invites', { name: member.name, email: member.email });
  requireOk(invitation, 'Member invitation');
  const token = new URL(invitation.json<{ url: string }>().url).hash.replace(/^#invite=/, '');
  requireOk(await api('POST', '/api/invites/accept', { token, name: member.name, password: member.password }, ''), 'Accept member invitation');
  const memberCookie = await signIn(member);
  const memberSession = await api('GET', '/api/access', undefined, memberCookie);
  requireOk(memberSession, 'Read member session');
  const memberId = memberSession.json<{ user: { id: string } }>().user.id;
  const memberAccess = await api('GET', '/api/coding/projects', undefined, memberCookie);
  if (memberAccess.statusCode !== 403) throw new Error(`Member coding API access returned HTTP ${memberAccess.statusCode}, expected 403`);
  const inventory = await api('GET', chats);
  requireOk(inventory, 'Check chat model readiness');
  if (inventory.json<{ capabilities?: { chatModel: boolean } }>().capabilities?.chatModel !== false) {
    throw new Error('The suite requires a chat session with no model');
  }

  const rows = [];
  for (const item of SUITE_CASES) {
    const started = Date.now();
    const session = item.actor === 'member' ? memberCookie : cookie;
    // The owner uses the same chat control as the route, without its 20-creates-per-minute HTTP limit.
    let id: string;
    if (item.actor === 'member') {
      const created = await api('POST', chats, { goal: item.goal }, session);
      requireOk(created, 'Create member conversation');
      id = created.json<{ id: string }>().id;
    } else {
      id = (await app.chat.create(ownerId, { goal: item.goal })).id;
    }
    const first = await settled(id, session);
    let final: ChatConversation | null | undefined;
    let approvalHttpStatus: number | undefined;
    if (item.approval && first?.status === 'waiting_approval' && first.approval) {
      const approval = await api('POST', `${chats}/${id}/approve`, { approvalId: first.approval.id, approved: true }, session);
      approvalHttpStatus = approval.statusCode;
      if (approval.statusCode === 200) final = await settled(id, session);
    }
    const accountId = item.actor === 'member' ? memberId : ownerId;
    const codingTask = (await tasks(accountId)).find(task => task.goal === item.goal && task.capabilityId === 'coding.change');
    const task = codingTask ? (await app.runtime.detail(accountId, codingTask.id)).task : null;
    const codingEffect = Boolean(task) || [first, final].some(detail =>
      detail?.run?.plan?.steps.some(step => step.capability === 'code.read' || step.capability === 'code.check'));
    if ([first, final].some(detail => detail && (detail.configured || detail.run?.engine.modelCalls))) {
      throw new Error(`${item.id}: a model was reported during measurement`);
    }
    const observed = {
      first: caseStatus(first), firstText: reply(first), firstPhase: first?.run?.phase ?? null,
      approvalPrompt: first?.approval?.prompt, approvalDetail: first?.approval?.detail, approvalHttpStatus,
      final: final === undefined ? undefined : caseStatus(final), finalPhase: final?.run?.phase ?? null,
      finalText: reply(final === undefined ? first : final), codingEffect,
      codingTaskStatus: task?.status ?? null, codingOutcome: task?.result?.outcome ?? null,
      readyForReview: task?.result?.outcome === 'ready_for_review' && typeof task.result.checkpoint === 'string',
    };
    const row = { ...item, ...observed, ...scoreSuiteCase(item, observed), ms: Date.now() - started };
    rows.push(row);
  }
  const totals = suiteTotals(rows);
  const summary = { set: 'suite', realSandbox, viaDeviceLink, startupMs, totals };
  if (out) await writeFile(out, JSON.stringify({ ...summary, rows }, null, 2));
  for (const { id, capability, first, final, met, misses, ms } of rows) {
    console.log(JSON.stringify({ id, capability, first, final, met, misses, ms }));
  }
  console.log(JSON.stringify(summary));
}

try {
  await configureModelFreeMeasurement(checkout, directory);
  const { createApplication }: typeof import('../../apps/server/src/app.ts') = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
  const { snapshotHash }: typeof import('../../packages/coding/src/index.ts') = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);
  webFixture = await startWebFixture();
  const startedApp = Date.now();
  const sandbox = realSandbox ? undefined : createSuiteSandbox(snapshotHash);
  application = await createApplication({
    authSecret: 'measure-coding-fixture-auth-secret-000001', internalSecret: secret, setupToken, webOrigin: origin,
    production: false, runWorker: true, testRequestLimit: 2000, browserChannel: null,
    codingDeviceLink: viaDeviceLink, codingDataDir: viaDeviceLink ? join(directory, 'unused-server-coding') : directory,
    codingAllowedRoots: viaDeviceLink ? [] : [directory],
    browser: webFixture.browser, browserProfileDir: join(directory, 'browser'), documentsDir: join(directory, 'documents'),
    sandboxRunner: viaDeviceLink ? unavailableServerSandbox : sandbox,
  });
  await measure(application, startedApp, sandbox);
} finally {
  try {
    await stopDevice?.();
  } finally {
    try {
      await application?.app.close();
    } finally {
      try {
        await webFixture?.close();
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
}
