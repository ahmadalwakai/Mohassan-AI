/**
 * Measures the chat's coding route with no chat model (docs/MOHASSAN-CODE-2026-11-27.md).
 *
 * Fixed sets, each written before either of its arms ran:
 * - `slice1` (2026-11-27): 9 coding requests and one control. With the stub sandbox, the tests fail while src/sum.ts
 *   still has its misspelling.
 * - `slice2` (2026-11-27 10:27 UTC): run the checks and explain the failure, search the project, import relations,
 *   «صحح الأخطاء», and three controls. A target is met only when its final reply contains every expected string.
 * - `before-after` (2026-11-27): three approved fixes and two read controls. Both arms use the same demo and fixtures.
 * - `suite` (2026-11-27): bilingual checks, search, imports and approved fixes on five fixture repositories, plus six controls.
 *
 * Each request runs in a fresh conversation; an expected approval card is approved once. The older sets use the demo.
 * The chat model is off and the database is embedded and in memory. Records the first and final replies, the run status
 * and the time per request.
 *
 * Usage: npx tsx scripts/mohassan-code/measure-no-model-coding.ts [checkout] [out.json] [--set=slice1|slice2|before-after|suite] [--real-sandbox]
 * `checkout` (default: the current directory) is the repository to measure, so one copy of this file measures a base
 * checkout too. That checkout needs its own installed node_modules. `--real-sandbox` uses the Windows AppContainer
 * sandbox instead of the stub (Windows only; its first isolation probe takes about half a minute).
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatConversation } from '@mohassan/contracts';
import { PASSING_OUTPUT, REAL_OUTPUT } from '../../tests/fixtures/coding-test-output.js';
import { registerFixtures } from './fixtures.ts';
import { SUITE_CASES } from './suite-cases.ts';
import { scoreSuiteCase, suiteTotals } from './suite-results.ts';
import { createSuiteSandbox } from './suite-sandbox.ts';

interface Case { id: string; goal: string; expect?: string[]; approval?: boolean; control?: boolean }
const beforeAfter = ['قبل التعديل: نجح 0 من 2، وفشل 2.', 'بعد التعديل: نجح 2 من 2، وفشل 0.', 'adds positive values', 'test/sum.test.mjs:5', 'ReferenceError', 'src/sum.ts:2'];
const SETS: Record<'slice1' | 'slice2' | 'before-after', Case[]> = {
  slice1: [
    'أصلح الكود في مشروع تجربة الجمع',
    'أصلح مشروع تجربة الجمع',
    'نسّق الكود في مشروع تجربة الجمع',
    'من فضلك أصلح الكود في مشروع تجربة الجمع',
    'اجعل دالة الجمع في مشروع تجربة الجمع تضرب بدل أن تجمع',
    'Fix the code in مشروع تجربة الجمع',
    'صحح الأخطاء في مشروع تجربة الجمع',
    'شغّل اختبارات مشروع تجربة الجمع',
    'أصلح الكود',
    'ما عاصمة فرنسا؟',
  ].map((goal, index) => ({ id: `A${index + 1}`, goal })),
  slice2: [
    { id: 'C1', goal: 'شغّل اختبارات مشروع تجربة الجمع', expect: ['adds positive values', 'src/sum.ts:2', 'rightHandVaule'] },
    { id: 'C2', goal: 'شغّل الفحوص في مشروع تجربة الجمع واشرح سبب الفشل', expect: ['adds positive values', 'src/sum.ts:2', 'rightHandVaule'] },
    { id: 'C3', goal: 'Run the tests in مشروع تجربة الجمع', expect: ['adds positive values', 'src/sum.ts:2', 'rightHandVaule'] },
    { id: 'C4', goal: 'لماذا تفشل اختبارات مشروع تجربة الجمع؟', expect: ['adds positive values', 'src/sum.ts:2', 'rightHandVaule'] },
    { id: 'S1', goal: 'ابحث في مشروع تجربة الجمع عن rightHandVaule', expect: ['src/sum.ts:2'] },
    { id: 'S2', goal: 'أين تُستخدم الدالة sum في مشروع تجربة الجمع؟', expect: ['test/sum.test.mjs', 'src/sum.ts'] },
    { id: 'S3', goal: 'Search مشروع تجربة الجمع for leftHandValue', expect: ['src/sum.ts:1', 'src/sum.ts:2'] },
    { id: 'I1', goal: 'ما الملفات التي تستورد src/sum.ts في مشروع تجربة الجمع؟', expect: ['test/sum.test.mjs'] },
    { id: 'I2', goal: 'ماذا يستورد ملف test/sum.test.mjs في مشروع تجربة الجمع؟', expect: ['node:test', 'node:assert/strict', 'src/sum.ts'] },
    { id: 'F1', goal: 'صحح الأخطاء في مشروع تجربة الجمع', approval: true, expect: ['طبّقت أدوات الإصلاح المؤكد'] },
    { id: 'K1', goal: 'ابحث عن ملف اسمه README', control: true },
    { id: 'K2', goal: 'ما عاصمة فرنسا؟', control: true },
    { id: 'K3', goal: 'صحح هذا النص: انا ذهبت الي المدرسه', control: true },
  ],
  'before-after': [
    { id: 'B1', goal: 'أصلح الكود في مشروع تجربة الجمع', approval: true, expect: beforeAfter },
    { id: 'B2', goal: 'أصلح مشروع تجربة الجمع', approval: true, expect: beforeAfter },
    { id: 'B3', goal: 'صحح الأخطاء في مشروع تجربة الجمع', approval: true, expect: beforeAfter },
    { id: 'K1', goal: 'ابحث في مشروع تجربة الجمع عن rightHandVaule', control: true, expect: ['src/sum.ts:2', 'rightHandVaule'] },
    { id: 'K2', goal: 'ماذا يستورد ملف test/sum.test.mjs في مشروع تجربة الجمع؟', control: true, expect: ['node:test', 'node:assert/strict', 'src/sum.ts'] },
  ],
};

const flags = process.argv.slice(2).filter(value => value.startsWith('--'));
const [checkoutArgument, out] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const requestedSet = flags.find(value => value.startsWith('--set='))?.slice('--set='.length) ?? 'slice1';
if (requestedSet !== 'slice1' && requestedSet !== 'slice2' && requestedSet !== 'before-after' && requestedSet !== 'suite') throw new Error(`unknown set ${requestedSet}`);
const set = requestedSet;
const realSandbox = flags.includes('--real-sandbox');
if (set === 'suite' && realSandbox && process.platform !== 'win32') throw new Error('The real suite sandbox requires Windows AppContainer');
const checkout = await realpath(resolve(checkoutArgument ?? process.cwd()));
const directory = await realpath(await mkdtemp(join(tmpdir(), 'mohassan-measure-coding-')));
if (set === 'suite') {
  // Keep any models, account settings and shadow logs in the owner's normal environment out of this fixture run.
  process.env.MOHASSAN_ISOLATED_TEST = 'true';
  // The server's existing test path skips loading the bundled scratch classifier weights.
  process.env.VITEST = 'true';
  process.env.MOHASSAN_SCRATCH_CLASSIFIERS = '0';
  process.env.MOHASSAN_ARITHMETIC_SEARCH = '0';
  process.env.MOHASSAN_REFUSAL_POLICY = '0';
  process.env.MOHASSAN_MODEL_COUNCIL = 'off';
  process.env.MOHASSAN_MODELS_ROOT = directory;
  process.env.MOHASSAN_OCR_MODEL_DIR = join(directory, 'unused-ocr');
}
const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const setupToken = 'measure-coding-fixture-setup-token-001';
const owner = { name: 'مالك القياس', email: 'measure@example.test', password: 'Measure-Coding-Password-42' };
const member = { name: 'عضو القياس', email: 'member@example.test', password: 'Measure-Member-Password-42' };
type Application = Awaited<ReturnType<typeof import('../../apps/server/src/app.ts').createApplication>>;
let application: Application | undefined;
type WebFixture = Awaited<ReturnType<typeof startWebFixture>>;
let webFixture: WebFixture | undefined;

async function disableLearnedRouting() {
  const assistant = pathToFileURL(join(checkout, 'apps/server/src/assistant') + '/').href;
  // Use the same test-only module hook as scripts/response-policy/development-bench.mjs.
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith(assistant)) return result;
    const path = result.url.slice(assistant.length);
    if (path === 'refusal/learned-model.json' || path === 'arithmetic-search-model.json') {
      throw new Error('The suite must not load learned weights');
    }
    const stub = path === 'refusal/learned-classifier.ts' ? 'classifyLearnedRefusal'
      : path === 'arithmetic-search-ranker.ts' ? 'selectArithmeticCandidate' : null;
    return stub ? { url: `data:text/javascript,export const ${stub} = () => null; export const weightFree = true;`, shortCircuit: true } : result;
  } });
  for (const file of ['refusal/learned-classifier.ts', 'arithmetic-search-ranker.ts']) {
    const stub = await import(new URL(file, assistant).href);
    if (stub.weightFree !== true) throw new Error(`Could not disable the learned module ${file}`);
  }
}

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

async function measure(app: Application, startupMs: number) {
  const chats = '/api/chat/conversations';
  let cookie = '';
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, session = cookie) => app.app.inject({
    method, url, headers: { ...headers, cookie: session }, ...(payload === undefined ? {} : { payload: payload as object }),
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
  const ownerId = (await app.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
  const tasks = (accountId = ownerId) => app.runtime.snapshot(accountId).then(snapshot => snapshot.tasks);
  const reply = (detail: ChatConversation | null) => detail?.messages.findLast(message => message.role === 'assistant')?.text ?? null;
  const caseStatus = (detail: ChatConversation | null) => detail?.status ?? 'timeout';

  if (set === 'suite') {
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
    const summary = { set, realSandbox, startupMs, totals };
    if (out) await writeFile(out, JSON.stringify({ ...summary, rows }, null, 2));
    for (const { id, capability, first, final, met, misses, ms } of rows) {
      console.log(JSON.stringify({ id, capability, first, final, met, misses, ms }));
    }
    console.log(JSON.stringify(summary));
    return;
  }

  requireOk(await api('POST', '/api/coding/projects/demo', {}), 'Register demo project');
  const rows: Record<string, unknown>[] = [];
  for (const item of SETS[set]) {
    const started = Date.now();
    const first = await settled((await app.chat.create(ownerId, { goal: item.goal })).id);
    const row: Record<string, unknown> = { id: item.id, goal: item.goal, first: caseStatus(first), firstRun: null, firstText: first?.messages.at(-1)?.text.slice(0, 1200) ?? null };
    let finalText = row.firstText as string | null;
    if (first?.status === 'waiting_approval' && first.approval) {
      await api('POST', `${chats}/${first.id}/approve`, { approvalId: first.approval.id, approved: true });
      const done = await settled(first.id);
      row.final = caseStatus(done);
      row.finalRun = null;
      finalText = done?.messages.at(-1)?.text.slice(0, 1200) ?? null;
      row.finalText = finalText;
    }
    row.ms = Date.now() - started;
    if (item.expect) row.met = (!item.approval || first?.status === 'waiting_approval') && item.expect.every(text => (finalText ?? '').includes(text));
    if (item.control) row.control = true;
    rows.push(row);
  }
  const statuses = (await tasks()).map(task => `${task.capabilityId}:${task.status}`);
  if (out) await writeFile(out, JSON.stringify({ set, realSandbox, startupMs, rows, tasks: statuses }, null, 1));
  console.log(JSON.stringify({ set, realSandbox, startupMs }));
  for (const row of rows) console.log(JSON.stringify([row.id, row.first, row.final ?? '-', row.met ?? (row.control ? 'control' : '-'), row.ms]));
  console.log(statuses.join(' '));
}

try {
  if (set === 'suite') await disableLearnedRouting();
  const { createApplication }: typeof import('../../apps/server/src/app.ts') = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
  const { snapshotHash }: typeof import('../../packages/coding/src/index.ts') = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);
  const stub: NonNullable<Parameters<typeof createApplication>[0]['sandboxRunner']> = {
    available: async () => ({ available: true, provider: 'unit-fixture', message: 'measurement stub' }),
    run: async (request) => {
      const misspelled = request.files.some(file => file.path === 'src/sum.ts' && file.content.includes('rightHandVaule'));
      return {
        exitCode: misspelled ? 1 : 0,
        stdout: set === 'before-after' ? (misspelled ? REAL_OUTPUT : PASSING_OUTPUT) : 'measurement stub',
        stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
        network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files),
      };
    },
  };
  if (set === 'suite') webFixture = await startWebFixture();
  const startedApp = Date.now();
  application = await createApplication({
    authSecret: 'measure-coding-fixture-auth-secret-000001', internalSecret: secret, setupToken, webOrigin: origin,
    production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
    ...(webFixture ? { browser: webFixture.browser, browserProfileDir: join(directory, 'browser'), documentsDir: join(directory, 'documents') } : {}),
    // Without a runner the coding control builds the Windows AppContainer sandbox itself.
    ...(realSandbox ? {} : { sandboxRunner: set === 'suite' ? createSuiteSandbox(snapshotHash) : stub }),
  });
  await measure(application, Date.now() - startedApp);
} finally {
  try {
    await application?.app.close();
  } finally {
    await webFixture?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
