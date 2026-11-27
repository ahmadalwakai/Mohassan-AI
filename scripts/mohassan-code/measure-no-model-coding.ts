/**
 * Measures the chat's coding route with no chat model (docs/MOHASSAN-CODE-2026-11-27.md).
 *
 * Fixed sets, each written before either of its arms ran:
 * - `slice1` (2026-11-27): 9 coding requests and one control. With the stub sandbox, the tests fail while src/sum.ts
 *   still has its misspelling.
 * - `slice2` (2026-11-27 10:27 UTC): run the checks and explain the failure, search the project, import relations,
 *   «صحح الأخطاء», and three controls. A target is met only when its final reply contains every expected string.
 * - `projects` (2026-11-27): list registered projects, choose editable files and approve registration, register with
 *   named files, refuse a project outside the allowed roots, and compare two control replies verbatim across arms.
 *
 * Each request runs in a fresh conversation; an approval card is approved once. The demo project is registered, no chat
 * model is configured, and the database is embedded and in memory. Records the first and final replies, the run status
 * and the time per request.
 *
 * Usage: npx tsx scripts/mohassan-code/measure-no-model-coding.ts [checkout] [out.json] [--set=slice1|slice2|projects] [--real-sandbox]
 * `checkout` (default: the current directory) is the repository to measure, so one copy of this file measures a base
 * checkout too. That checkout needs its own installed node_modules. `--real-sandbox` uses the Windows AppContainer
 * sandbox instead of the stub (Windows only; its first isolation probe takes about half a minute).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Case { id: string; goal: string; expect?: string[]; approval?: boolean; question?: { option: string; expect: string[] }; control?: boolean }
const SETS = {
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
  projects: [
    { id: 'P1', goal: 'ما مشاريعي البرمجية؟', expect: ['مشروع تجربة الجمع', 'الملفات القابلة للتعديل', 'src/sum.ts', 'ملفات الاختبار', 'test/sum.test.mjs'] },
    { id: 'P2', goal: 'list my coding projects', expect: ['مشروع تجربة الجمع', 'Editable files', 'src/sum.ts', 'Test files', 'test/sum.test.mjs'] },
    { id: 'P3', goal: 'سجّل مشروع "{selection}" باسم مشروع الاختيار', question: { option: 'src/sum.ts', expect: ['اختر من ملف واحد إلى 5', 'src/sum.ts'] }, approval: true, expect: ['سُجّل مشروع', 'مشروع الاختيار', 'src/sum.ts'] },
    { id: 'P4', goal: 'register project "{direct}" as Direct Project with files src/sum.ts', approval: true, expect: ['Registered coding project', 'Direct Project', 'src/sum.ts'] },
    { id: 'P5', goal: 'register project "{outside}" as Outside Project', expect: ['المشروع خارج الجذور المصرح بها.'] },
    { id: 'K1', goal: 'ابحث عن ملف اسمه README', control: true },
    { id: 'K2', goal: 'صحح هذا النص: انا ذهبت الي المدرسه', control: true },
  ],
} satisfies Record<string, Case[]>;

const flags = process.argv.slice(2).filter(value => value.startsWith('--'));
const [checkoutArgument, out] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const set = flags.find(value => value.startsWith('--set='))?.slice('--set='.length) ?? 'slice1';
if (set !== 'slice1' && set !== 'slice2' && set !== 'projects') throw new Error(`unknown set ${set}`);
const realSandbox = flags.includes('--real-sandbox');
const checkout = resolve(checkoutArgument ?? process.cwd());
const { createApplication } = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
const { createRepairDemoProject, snapshotHash } = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);

const directory = await mkdtemp(join(tmpdir(), 'mohassan-measure-coding-'));
const dataDir = set === 'projects' ? join(directory, 'projects') : directory;
await mkdir(dataDir, { recursive: true });
const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const fixture = {
  available: async () => ({ available: true, provider: 'unit-fixture', message: 'measurement stub' }),
  run: async (request: { files: { path: string; content: string }[] }) => ({
    exitCode: request.files.some(file => file.path === 'src/sum.ts' && file.content.includes('rightHandVaule')) ? 1 : 0,
    stdout: 'measurement stub', stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
    network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files),
  }),
};
const stub = set === 'projects' ? {
  available: fixture.available,
  run: async () => { throw new Error('Project registration and listing need no sandbox run.'); },
} : fixture;
const startedApp = Date.now();
const application = await createApplication({
  authSecret: 'measure-coding-fixture-auth-secret-000001', internalSecret: secret, setupToken: 'measure-coding-fixture-setup-token-001', webOrigin: origin,
  production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: dataDir, codingAllowedRoots: [dataDir], browserChannel: null,
  // Without a runner the coding control builds the Windows AppContainer sandbox itself (apps/server/src/coding.ts).
  ...(realSandbox ? {} : { sandboxRunner: stub }),
});
const startupMs = Date.now() - startedApp;
let cookie = '';
const api = (method: 'GET' | 'POST', url: string, payload?: unknown) => application.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload === undefined ? {} : { payload }) });
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function settled(id: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const detail = (await api('GET', `/api/chat/conversations/${id}`)).json();
    if (detail.status !== 'running') return detail;
    // 150 ms keeps the polls under the harness's own request limit.
    await delay(150);
  }
  return { status: 'timeout', messages: [] };
}
try {
  await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك القياس', email: 'measure@example.test', password: 'Measure-Coding-Password-42', setupToken: 'measure-coding-fixture-setup-token-001' } });
  const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'measure@example.test', password: 'Measure-Coding-Password-42' } });
  cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value: unknown) => String(value).split(';')[0]).join('; ');
  const ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
  await api('POST', '/api/coding/projects/demo', {});
  const fixturePaths: Record<string, string> = set === 'projects' ? {
    selection: (await createRepairDemoProject(join(dataDir, 'choose files'))).path,
    direct: (await createRepairDemoProject(join(dataDir, 'named files'))).path,
    outside: (await createRepairDemoProject(join(directory, 'outside'))).path,
  } : {};
  const rows: Record<string, unknown>[] = [];
  const cases: Case[] = SETS[set];
  for (const item of cases) {
    const started = Date.now();
    const goal = item.goal.replace(/\{(selection|direct|outside)\}/g, (placeholder, name: string) => fixturePaths[name] ?? placeholder);
    const first = await settled((await application.chat.create(ownerId, { goal })).id);
    const row: Record<string, unknown> = { id: item.id, goal: item.goal, first: first.status, firstRun: first.run?.status ?? null, firstText: first.messages?.at(-1)?.text?.slice(0, 1200) ?? null };
    let finalText = row.firstText as string | null;
    let decision = first;
    let questionMet = !item.question;
    if (item.question && first.status === 'waiting_user') {
      const option = first.question?.options?.find((option: { label: string }) => option.label === item.question?.option);
      questionMet = Boolean(option && item.question.expect.every(text => (finalText ?? '').includes(text)));
      if (option) {
        await api('POST', `/api/chat/conversations/${first.id}/respond`, { questionId: first.question.id, optionId: option.id });
        decision = await settled(first.id);
        row.afterQuestion = decision.status;
      }
    }
    if (decision.status === 'waiting_approval' && decision.approval) {
      await api('POST', `/api/chat/conversations/${first.id}/approve`, { approvalId: decision.approval.id, approved: true });
      const done = await settled(first.id);
      row.final = done.status;
      row.finalRun = done.run?.status ?? null;
      finalText = done.messages?.at(-1)?.text?.slice(0, 1200) ?? null;
      row.finalText = finalText;
    }
    row.ms = Date.now() - started;
    if (item.expect) row.met = questionMet && (!item.approval || decision.status === 'waiting_approval') && item.expect.every(text => (finalText ?? '').includes(text));
    if (item.control) row.control = true;
    rows.push(row);
  }
  const tasks = (await application.runtime.snapshot(ownerId)).tasks.map((task: { capabilityId: string; status: string }) => `${task.capabilityId}:${task.status}`);
  if (out) await writeFile(out, JSON.stringify({ set, realSandbox, startupMs, rows, tasks }, null, 1));
  console.log(JSON.stringify({ set, realSandbox, startupMs }));
  for (const row of rows) console.log(JSON.stringify([row.id, row.first, row.final ?? '-', row.met ?? (row.control ? 'control' : '-'), row.ms]));
  console.log(tasks.join(' '));
} finally {
  await application.app.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
