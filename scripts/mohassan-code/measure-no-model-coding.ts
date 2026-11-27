/**
 * Measures the chat's coding route with no chat model (docs/MOHASSAN-CODE-2026-11-27.md).
 *
 * Fixed sets, each written before either of its arms ran:
 * - `slice1` (2026-11-27): 9 coding requests and one control. With the stub sandbox, the tests fail while src/sum.ts
 *   still has its misspelling.
 * - `slice2` (2026-11-27 10:27 UTC): run the checks and explain the failure, search the project, import relations,
 *   «صحح الأخطاء», and three controls. A target is met only when its final reply contains every expected string.
 * - `rename` (2026-11-27): two successful renames, two refusals after approval, and two controls whose replies must
 *   match exactly between arms. Uses a passing variant of the demo with a declaration and its import in separate files.
 *
 * Each request runs in a fresh conversation; an approval card is approved once. The demo project is registered, no chat
 * model is configured, and the database is embedded and in memory. Records the first and final replies, the run status
 * and the time per request.
 *
 * Usage: npx tsx scripts/mohassan-code/measure-no-model-coding.ts [checkout] [out.json] [--set=slice1|slice2|rename] [--real-sandbox]
 * `checkout` (default: the current directory) is the repository to measure, so one copy of this file measures a base
 * checkout too. That checkout needs its own installed node_modules. `--real-sandbox` uses the Windows AppContainer
 * sandbox instead of the stub (Windows only; its first isolation probe takes about half a minute).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../../packages/coding/src/git.ts';

interface Case { id: string; goal: string; expect?: string[]; approval?: boolean; control?: boolean }
const SETS: Record<'slice1' | 'slice2' | 'rename', Case[]> = {
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
  rename: [
    { id: 'R1', goal: 'أعد تسمية addValues إلى combineValues في مشروع تجربة الجمع', approval: true, expect: ['addValues', 'combineValues', 'فرع المراجعة'] },
    { id: 'R2', goal: 'rename addValues to addNumbers in مشروع تجربة الجمع', approval: true, expect: ['addValues', 'addNumbers', 'فرع المراجعة'] },
    { id: 'R3', goal: 'غيّر اسم الدالة sum إلى sumValues في مشروع تجربة الجمع', approval: true, expect: ['ملف محمي', 'test/sum.test.mjs'] },
    { id: 'R4', goal: 'أعد تسمية addValues إلى existingName في مشروع تجربة الجمع', approval: true, expect: ['existingName', 'موجود بالفعل في النطاق'] },
    { id: 'K1', goal: 'ابحث عن ملف اسمه README', control: true },
    { id: 'K3', goal: 'صحح هذا النص: انا ذهبت الي المدرسه', control: true },
  ],
};

const flags = process.argv.slice(2).filter(value => value.startsWith('--'));
const [checkoutArgument, out] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const set = flags.find(value => value.startsWith('--set='))?.slice('--set='.length) ?? 'slice1';
if (set !== 'slice1' && set !== 'slice2' && set !== 'rename') throw new Error(`unknown set ${set}`);
const realSandbox = flags.includes('--real-sandbox');
const checkout = resolve(checkoutArgument ?? process.cwd());
const { createApplication } = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
const { snapshotHash } = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);

const renameDemo = {
  'package.json': '{"name":"mohassan-rename-demo","private":true,"type":"module"}\n',
  'src/sum.ts': "import { addValues } from './values.ts';\n\nexport function sum(left: number, right: number) {\n  return addValues(left, right);\n}\n",
  'src/values.ts': 'export const existingName = 0;\n\nexport function addValues(left: number, right: number) {\n  return left + right;\n}\n',
  'test/sum.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.ts';\n\ntest('adds positive values', () => assert.equal(sum(2, 3), 5));\ntest('adds negative values', () => assert.equal(sum(-3, 1), -2));\n",
};
const renameDemoPaths = ['src/sum.ts', 'src/values.ts'];
// Recorded with Node 24.22.3 on Linux (`node --test test/sum.test.mjs`), including both renamed snapshots.
const renameDemoOutput = new Map(([
  ['addValues', '0.793655', '0.115764', '165.782501'],
  ['combineValues', '1.046726', '0.114192', '153.762073'],
  ['addNumbers', '0.868949', '0.163366', '337.734402'],
] as const).map(([name, positive, negative, duration]) => {
  const files = Object.entries(renameDemo).map(([path, content]) => ({
    path, content: renameDemoPaths.includes(path) ? content.replaceAll('addValues', name) : content,
  }));
  return [snapshotHash(files), `✔ adds positive values (${positive}ms)\n✔ adds negative values (${negative}ms)\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms ${duration}\n`];
}));

async function createRenameDemo(directory: string) {
  const path = join(directory, 'rename-demo-project');
  await mkdir(join(path, 'src'), { recursive: true });
  await mkdir(join(path, 'test'));
  await git(path, ['init', '--initial-branch=main', '--template=', '.']);
  for (const [file, content] of Object.entries(renameDemo)) {
    await writeFile(join(path, file), content, { flag: 'wx' });
    const oid = (await git(path, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).stdout.trim();
    await git(path, ['update-index', '--add', '--cacheinfo', '100644', oid, file]);
  }
  const tree = (await git(path, ['write-tree'])).stdout.trim();
  const commit = (await git(path, ['commit-tree', tree, '-m', 'Mohassan AI: rename measurement fixture'], { deterministicDate: true })).stdout.trim();
  await git(path, ['update-ref', 'refs/heads/main', commit]);
  return path;
}

const directory = await mkdtemp(join(tmpdir(), 'mohassan-measure-coding-'));
const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const stub = {
  available: async () => ({ available: true, provider: 'unit-fixture', message: 'measurement stub' }),
  run: async (request: { files: { path: string; content: string }[] }) => {
    const hash = snapshotHash(request.files);
    const recorded = renameDemoOutput.get(hash);
    if (set === 'rename' && recorded === undefined) throw new Error('No recorded result for this rename fixture snapshot');
    return {
      exitCode: request.files.some(file => file.path === 'src/sum.ts' && file.content.includes('rightHandVaule')) ? 1 : 0,
      stdout: recorded ?? 'measurement stub', stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
      network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: hash,
    };
  },
};
const startedApp = Date.now();
const application = await createApplication({
  authSecret: 'measure-coding-fixture-auth-secret-000001', internalSecret: secret, setupToken: 'measure-coding-fixture-setup-token-001', webOrigin: origin,
  production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
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
  if (set === 'rename') {
    const path = await createRenameDemo(directory);
    const registered = await api('POST', '/api/coding/projects', { name: 'مشروع تجربة الجمع', path, allowedPaths: renameDemoPaths });
    if (registered.statusCode !== 200) throw new Error(`Rename fixture registration failed (${registered.statusCode})`);
  } else {
    await api('POST', '/api/coding/projects/demo', {});
  }
  const rows: Record<string, unknown>[] = [];
  for (const item of SETS[set]) {
    const started = Date.now();
    const first = await settled((await application.chat.create(ownerId, { goal: item.goal })).id);
    const row: Record<string, unknown> = { id: item.id, goal: item.goal, first: first.status, firstRun: first.run?.status ?? null, firstText: first.messages?.at(-1)?.text?.slice(0, 1200) ?? null };
    let finalText = row.firstText as string | null;
    if (first.status === 'waiting_approval' && first.approval) {
      await api('POST', `/api/chat/conversations/${first.id}/approve`, { approvalId: first.approval.id, approved: true });
      const done = await settled(first.id);
      row.final = done.status;
      row.finalRun = done.run?.status ?? null;
      finalText = done.messages?.at(-1)?.text?.slice(0, 1200) ?? null;
      row.finalText = finalText;
    }
    row.ms = Date.now() - started;
    if (item.expect) row.met = (!item.approval || first.status === 'waiting_approval') && item.expect.every(text => (finalText ?? '').includes(text));
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
