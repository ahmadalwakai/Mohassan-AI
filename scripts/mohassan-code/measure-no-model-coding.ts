// Dispatch --set=suite to the multi-project runner with the same checkout, output and sandbox flags.
if (process.argv.slice(2).find(value => value.startsWith('--set=')) === '--set=suite') {
  await import('./measure-suite.ts');
  // Flush every result row when the command's stdout is redirected to a file or pipe.
  await new Promise<void>((done, reject) => process.stdout.write('', error => error ? reject(error) : done()));
  process.exit(process.exitCode ?? 0);
}

/**
 * Measures the chat's coding route with no chat model (docs/MOHASSAN-CODE-2026-11-27.md).
 *
 * Fixed sets, each written before either of its arms ran:
 * - `slice1` (2026-11-27): 9 coding requests and one control. With the stub sandbox, the tests fail while src/sum.ts
 *   still has its misspelling.
 * - `slice2` (2026-11-27 10:27 UTC): run the checks and explain the failure, search the project, import relations,
 *   «صحح الأخطاء», and three controls. A target is met only when its final reply contains every expected string.
 * - `before-after` (2026-11-27): three approved fixes and two read controls. Both arms use the same demo and fixtures.
 * - `logic` (2026-11-27): six logic changes that must be blocked without approval, and two project read controls.
 * - `show-change` (2026-11-27): show a previously approved and verified repair in Arabic and English, report no
 *   task for a second registered project, and compare two control replies verbatim across checkouts.
 * - `instructions` (2026-11-27): read saved project instructions in Arabic and English, report an absent file,
 *   surface notes in the check reply and approval card, and compare two controls.
 * - `rename` (2026-11-27): two successful renames, two refusals after approval, and two controls whose replies must
 *   match exactly between arms. Uses a passing variant of the demo with a declaration and its import in separate files.
 * - `projects` (2026-11-27): list registered projects, choose editable files and approve registration, register with
 *   named files, refuse a project outside the allowed roots, and compare two control replies verbatim across arms.
 *
 * Each request runs in a fresh conversation; an approval card is approved once. The demo project is registered, no chat
 * model is configured, and the database is embedded and in memory. Records the first and final replies, the run status
 * and the time per request.
 *
 * Usage: npx tsx scripts/mohassan-code/measure-no-model-coding.ts [checkout] [out.json] [--set=slice1|slice2|before-after|logic|show-change|instructions|rename|projects] [--real-sandbox]
 * `checkout` (default: the current directory) is the repository to measure, so one copy of this file measures a base
 * checkout too. That checkout needs its own installed node_modules. `--real-sandbox` uses the Windows AppContainer
 * sandbox instead of the stub (Windows only; its first isolation probe takes about half a minute).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PASSING_OUTPUT, REAL_OUTPUT } from '../../tests/fixtures/coding-test-output.js';
import { REPAIR_DEMO_FAILURE_OUTPUT, REPAIR_DEMO_SUCCESS_OUTPUT } from '../../tests/fixtures/coding-repair-demo-output.js';
import { git } from '../../packages/coding/src/git.ts';

interface Case { id: string; goal: string; expect?: string[]; approval?: boolean; expectApproval?: string[]; question?: { option: string; expect: string[] }; control?: boolean; blocked?: boolean }
const beforeAfter = ['قبل التعديل: نجح 0 من 2، وفشل 2.', 'بعد التعديل: نجح 2 من 2، وفشل 0.', 'adds positive values', 'test/sum.test.mjs:5', 'ReferenceError', 'src/sum.ts:2'];
const LOGIC_AR = ['مشروع تجربة الجمع', 'تغيير المنطق يحتاج إلى نموذج لا يعمل الآن', 'تشغيل الفحوص وشرح نتائجها', 'البحث', 'الاستيراد', 'الإصلاحات المثبتة', 'بعد موافقتك'];
const LOGIC_EN = ['مشروع تجربة الجمع', 'A logic change needs a model, which is not running now', 'run the checks and explain the results', 'search', 'imports', 'proven fixes', 'with your approval'];
const REPAIR_DIFF = ['mohassan/', 'src/sum.ts', '-  return leftHandValue + rightHandVaule;', '+  return leftHandValue + rightHandValue;', 'git merge'];
const SETS: Record<'slice1' | 'slice2' | 'before-after' | 'logic' | 'show-change' | 'instructions' | 'rename' | 'projects', Case[]> = {
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
  logic: [
    { id: 'G1', goal: 'اجعل دالة الجمع في مشروع تجربة الجمع تضرب بدل أن تجمع', blocked: true, approval: false, expect: [...LOGIC_AR, 'تضرب بدل أن تجمع'] },
    { id: 'G2', goal: 'غيّر سلوك دالة الجمع في مشروع تجربة الجمع لتعيد صفرًا عند غياب المدخلات', blocked: true, approval: false, expect: [...LOGIC_AR, 'لتعيد صفرًا عند غياب المدخلات'] },
    { id: 'G3', goal: 'أضف دالة لحساب المتوسط في مشروع تجربة الجمع', blocked: true, approval: false, expect: [...LOGIC_AR, 'أضف دالة لحساب المتوسط'] },
    { id: 'G4', goal: 'احذف ميزة جمع الأعداد السالبة من مشروع تجربة الجمع', blocked: true, approval: false, expect: [...LOGIC_AR, 'احذف ميزة جمع الأعداد السالبة'] },
    { id: 'G5', goal: 'Make the sum function in مشروع تجربة الجمع multiply instead of adding', blocked: true, approval: false, expect: [...LOGIC_EN, 'multiply instead of adding'] },
    { id: 'G6', goal: 'Add a function to calculate the average in مشروع تجربة الجمع', blocked: true, approval: false, expect: [...LOGIC_EN, 'Add a function to calculate the average'] },
    { id: 'GK1', goal: 'ابحث في مشروع تجربة الجمع عن rightHandVaule', control: true, approval: false, expect: ['وجدت «rightHandVaule»', 'src/sum.ts:2'] },
    { id: 'GK2', goal: 'ماذا يستورد ملف test/sum.test.mjs في مشروع تجربة الجمع؟', control: true, approval: false, expect: ['node:test', 'node:assert/strict', 'src/sum.ts'] },
  ],
  'show-change': [
    { id: 'V1', goal: 'اعرض التعديل الأخير في مشروع تجربة الجمع', expect: ['فرع المراجعة', ...REPAIR_DIFF] },
    { id: 'V2', goal: 'show the last change in مشروع تجربة الجمع', expect: ['Review branch', ...REPAIR_DIFF] },
    { id: 'V3', goal: 'اعرض التعديل الأخير في مشروع بلا تعديلات', expect: ['لا توجد مهمة تعديل', 'مشروع بلا تعديلات'] },
    { id: 'K1', goal: 'ابحث عن ملف اسمه README', control: true },
    { id: 'K2', goal: 'صحح هذا النص: انا ذهبت الي المدرسه', control: true },
  ],
  instructions: [
    { id: 'B1', goal: 'ما تعليمات مشروع Sum Instructions؟', expect: ['Keep arithmetic readable.', 'test/**'] },
    { id: 'B2', goal: 'show the instructions of Sum Instructions', expect: ['Keep arithmetic readable.', 'test/**'] },
    { id: 'B3', goal: 'ما تعليمات مشروع تجربة الجمع؟', expect: ['لا يوجد ملف تعليمات'] },
    { id: 'B4', goal: 'Run the tests in Sum Instructions', expect: ['adds positive values', 'src/sum.ts:2', 'Keep arithmetic readable.'] },
    { id: 'B5', goal: 'أصلح الكود في مشروع Sum Instructions', approval: true, expectApproval: ['Keep arithmetic readable.'], expect: ['طبّقت أدوات الإصلاح المؤكد'] },
    { id: 'BK1', goal: 'ابحث عن ملف اسمه README', control: true },
    { id: 'BK2', goal: 'صحح هذا النص: انا ذهبت الي المدرسه', control: true },
  ],
  rename: [
    { id: 'R1', goal: 'أعد تسمية addValues إلى combineValues في مشروع تجربة الجمع', approval: true, expect: ['addValues', 'combineValues', 'فرع المراجعة'] },
    { id: 'R2', goal: 'rename addValues to addNumbers in مشروع تجربة الجمع', approval: true, expect: ['addValues', 'addNumbers', 'فرع المراجعة'] },
    { id: 'R3', goal: 'غيّر اسم الدالة sum إلى sumValues في مشروع تجربة الجمع', approval: true, expect: ['ملف محمي', 'test/sum.test.mjs'] },
    { id: 'R4', goal: 'أعد تسمية addValues إلى existingName في مشروع تجربة الجمع', approval: true, expect: ['existingName', 'موجود بالفعل في النطاق'] },
    { id: 'K1', goal: 'ابحث عن ملف اسمه README', control: true },
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
};

// Recorded Windows AppContainer demo output from tests/assistant-no-model-code-read.test.ts.
const recordedFailure = [
  '', '✖ adds positive values (0.6578ms)', '✖ adds negative values (0.1019ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 2', 'ℹ cancelled 0',
  'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 54.9709', '', '✖ failing tests:', '', 'test at test\\sum.test.mjs:5:1', '✖ adds positive values (0.6578ms)',
  '  ReferenceError: rightHandVaule is not defined', '      at sum (file:///C:/Users/runner/AppData/Local/Temp/mohassan-sandbox-c1C0rp/work/src/sum.ts:2:26)', '',
  'test at test\\sum.test.mjs:6:1', '✖ adds negative values (0.1019ms)', '  ReferenceError: rightHandVaule is not defined',
  '      at sum (file:///C:/Users/runner/AppData/Local/Temp/mohassan-sandbox-c1C0rp/work/src/sum.ts:2:26)', '',
].join('\n');

const flags = process.argv.slice(2).filter(value => value.startsWith('--'));
const [checkoutArgument, out] = process.argv.slice(2).filter(value => !value.startsWith('--'));
const set = flags.find(value => value.startsWith('--set='))?.slice('--set='.length) ?? 'slice1';
if (set !== 'slice1' && set !== 'slice2' && set !== 'before-after' && set !== 'logic' && set !== 'show-change' && set !== 'instructions' && set !== 'rename' && set !== 'projects') throw new Error(`unknown set ${set}`);
const realSandbox = flags.includes('--real-sandbox');
const checkout = resolve(checkoutArgument ?? process.cwd());
const { createApplication } = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
const { createRepairDemoProject, snapshotHash } = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);

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
const dataDir = set === 'projects' ? join(directory, 'projects') : directory;
await mkdir(dataDir, { recursive: true });
const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const fixture = {
  available: async () => ({ available: true, provider: 'unit-fixture', message: 'measurement stub' }),
  run: async (request: { files: { path: string; content: string }[] }) => {
    const hash = snapshotHash(request.files);
    const recorded = renameDemoOutput.get(hash);
    if (set === 'rename' && recorded === undefined) throw new Error('No recorded result for this rename fixture snapshot');
    const misspelled = request.files.some(file => file.path === 'src/sum.ts' && file.content.includes('rightHandVaule'));
    return {
      exitCode: misspelled ? 1 : 0,
      stdout: set === 'rename' ? recorded! : set === 'before-after' ? (misspelled ? REAL_OUTPUT : PASSING_OUTPUT)
        : set === 'show-change' ? (misspelled ? REPAIR_DEMO_FAILURE_OUTPUT : REPAIR_DEMO_SUCCESS_OUTPUT)
        : set === 'instructions' && misspelled ? recordedFailure : 'measurement stub',
      stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
      network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: hash,
    };
  },
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

async function seedVerifiedChange(ownerId: string, projectId: string) {
  const task = await application.runtime.createTask(ownerId, {
    title: 'Repair the sum demo', goal: 'Fix the code in the registered sum demo', capabilityId: 'coding.change',
    autonomy: 'assisted', projectId,
  }, 'measure-show-change-setup');
  await application.runtime.approve(ownerId, task.id);
  for (let attempt = 0; attempt < 600; attempt++) {
    const { task: current } = await application.runtime.detail(ownerId, task.id);
    if (current.status === 'completed' && current.result?.outcome === 'ready_for_review') return;
    if (current.status === 'failed' || current.status === 'cancelled') break;
    await delay(150);
  }
  throw new Error('The measurement fixture did not reach a verified review branch.');
}

try {
  await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك القياس', email: 'measure@example.test', password: 'Measure-Coding-Password-42', setupToken: 'measure-coding-fixture-setup-token-001' } });
  const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'measure@example.test', password: 'Measure-Coding-Password-42' } });
  cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map((value: unknown) => String(value).split(';')[0]).join('; ');
  const ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
  const demo = set === 'rename' ? null : await api('POST', '/api/coding/projects/demo', {});
  if (set === 'rename') {
    const path = await createRenameDemo(directory);
    const registered = await api('POST', '/api/coding/projects', { name: 'مشروع تجربة الجمع', path, allowedPaths: renameDemoPaths });
    if (registered.statusCode !== 200) throw new Error(`Rename fixture registration failed (${registered.statusCode})`);
  }
  if (set === 'show-change') {
    if (!demo || demo.statusCode !== 200) throw new Error('Could not register the measurement repair demo.');
    const { id } = demo.json();
    await seedVerifiedChange(ownerId, id);
    const untouched = await createRepairDemoProject(join(directory, 'untouched'));
    await application.coding.register(ownerId, { name: 'مشروع بلا تعديلات', path: untouched.path, allowedPaths: untouched.allowedPaths });
  }
  if (set === 'instructions') {
    const { git } = await import(pathToFileURL(join(checkout, 'packages/coding/src/git.ts')).href);
    const project = await createRepairDemoProject(join(directory, 'instructions-fixture'));
    await mkdir(join(project.path, '.mohassan'));
    await writeFile(join(project.path, '.mohassan/instructions.md'), '## Do not edit\n- test/**\n\n## Notes\nKeep arithmetic readable.\n');
    await git(project.path, ['add', '--', '.mohassan/instructions.md']);
    await git(project.path, ['commit', '-m', 'Save fixture instructions'], { deterministicDate: true });
    const registered = await api('POST', '/api/coding/projects', { name: 'Sum Instructions', path: project.path, allowedPaths: project.allowedPaths });
    if (registered.statusCode !== 200) throw new Error(`Instructions fixture registration failed: ${registered.statusCode}`);
  }
  const fixturePaths: Record<string, string> = set === 'projects' ? {
    selection: (await createRepairDemoProject(join(dataDir, 'choose files'))).path,
    direct: (await createRepairDemoProject(join(dataDir, 'named files'))).path,
    outside: (await createRepairDemoProject(join(directory, 'outside'))).path,
  } : {};
  const replyLimit = set === 'show-change' ? undefined : 1200;
  const rows: Record<string, unknown>[] = [];
  const cases: Case[] = SETS[set];
  for (const item of cases) {
    const started = Date.now();
    const goal = item.goal.replace(/\{(selection|direct|outside)\}/g, (placeholder, name: string) => fixturePaths[name] ?? placeholder);
    const first = await settled((await application.chat.create(ownerId, { goal })).id);
    const row: Record<string, unknown> = { id: item.id, goal: item.goal, first: first.status, firstRun: first.run?.verdict?.status ?? first.run?.phase ?? null, firstText: first.messages?.at(-1)?.text?.slice(0, replyLimit) ?? null };
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
      if (item.expectApproval) row.approvalDetail = decision.approval.detail;
      await api('POST', `/api/chat/conversations/${first.id}/approve`, { approvalId: decision.approval.id, approved: true });
      const done = await settled(first.id);
      row.final = done.status;
      row.finalRun = done.run?.verdict?.status ?? done.run?.phase ?? null;
      finalText = done.messages?.at(-1)?.text?.slice(0, replyLimit) ?? null;
      row.finalText = finalText;
    }
    row.ms = Date.now() - started;
    if (item.expect) row.met = questionMet && (item.approval === undefined || (item.approval
      ? decision.status === 'waiting_approval' : decision.status !== 'waiting_approval' && !decision.approval))
      && (!item.blocked || first.run?.verdict?.status === 'blocked')
      && (item.expectApproval ?? []).every(text => (decision.approval?.detail ?? '').includes(text))
      && item.expect.every(text => (finalText ?? '').includes(text));
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
