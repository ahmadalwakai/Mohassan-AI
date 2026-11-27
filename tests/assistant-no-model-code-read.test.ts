import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserError } from '@mohassan/browser';
import { CodingEngine, createRepairDemoProject, explainCheckRun, generateDeterministicEdits, snapshotHash, type CodingCheckResult } from '@mohassan/coding';
import { createApplication } from '../apps/server/src/app.js';
import { answerNoModelCodeRead, recognizeCodeRead } from '../apps/server/src/assistant/no-model-coding.js';
import { REAL_OUTPUT } from './fixtures/coding-test-output.js';

const NAME = 'مشروع تجربة الجمع';
const demo = { id: 'p-demo', name: NAME };
const shop = { id: 'p-shop', name: 'Shop API' };
const PATHS = ['README.md', 'package.json', 'src/sum.ts', 'test/sum.test.mjs'];
const checked: CodingCheckResult = {
  projectId: demo.id, baseCommit: 'a'.repeat(40), testFiles: ['test/sum.test.mjs'],
  report: explainCheckRun({ stdout: REAL_OUTPUT, stderr: '', exitCode: 1, timedOut: false }, PATHS),
  diagnostics: [{ path: 'src/sum.ts', line: 2, column: 26, code: 'TS2552', message: "Cannot find name 'rightHandVaule'. Did you mean 'rightHandValue'?" }],
  receipt: { provider: 'windows-appcontainer', isolationVerified: true, network: 'denied', snapshotHash: 'b'.repeat(64), exitCode: 1, timedOut: false, durationMs: 1590 },
};

describe('recognizing a read of a named project', () => {
  it('reads the fixed set of 2026-11-27', () => {
    expect(recognizeCodeRead('شغّل اختبارات مشروع تجربة الجمع', NAME)).toEqual({ kind: 'check' });
    expect(recognizeCodeRead('شغّل الفحوص في مشروع تجربة الجمع واشرح سبب الفشل', NAME)).toEqual({ kind: 'check' });
    expect(recognizeCodeRead('Run the tests in مشروع تجربة الجمع', NAME)).toEqual({ kind: 'check' });
    expect(recognizeCodeRead('لماذا تفشل اختبارات مشروع تجربة الجمع؟', NAME)).toEqual({ kind: 'check' });
    expect(recognizeCodeRead('ابحث في مشروع تجربة الجمع عن rightHandVaule', NAME)).toEqual({ kind: 'search', query: 'rightHandVaule' });
    expect(recognizeCodeRead('أين تُستخدم الدالة sum في مشروع تجربة الجمع؟', NAME)).toEqual({ kind: 'search', query: 'sum' });
    expect(recognizeCodeRead('Search مشروع تجربة الجمع for leftHandValue', NAME)).toEqual({ kind: 'search', query: 'leftHandValue' });
    expect(recognizeCodeRead('ما الملفات التي تستورد src/sum.ts في مشروع تجربة الجمع؟', NAME)).toEqual({ kind: 'imports', reference: 'src/sum.ts', direction: 'importers' });
    expect(recognizeCodeRead('ماذا يستورد ملف test/sum.test.mjs في مشروع تجربة الجمع؟', NAME)).toEqual({ kind: 'imports', reference: 'test/sum.test.mjs', direction: 'imports' });
  });

  it('reads other common phrasings and keeps a quoted term whole', () => {
    expect(recognizeCodeRead('ابحث عن "a في b" في مشروع تجربة الجمع', NAME)).toEqual({ kind: 'search', query: 'a في b' });
    expect(recognizeCodeRead('find TODO in Shop API', 'Shop API')).toEqual({ kind: 'search', query: 'TODO' });
    expect(recognizeCodeRead('Where is calculateTotal used in Shop API?', 'Shop API')).toEqual({ kind: 'search', query: 'calculateTotal' });
    expect(recognizeCodeRead('which files import src/cart.ts in Shop API', 'Shop API')).toEqual({ kind: 'imports', reference: 'src/cart.ts', direction: 'importers' });
    expect(recognizeCodeRead('what does src/cart.ts import in Shop API?', 'Shop API')).toEqual({ kind: 'imports', reference: 'src/cart.ts', direction: 'imports' });
    expect(recognizeCodeRead('من يستورد «sum.ts» في مشروع تجربة الجمع', NAME)).toEqual({ kind: 'imports', reference: 'sum.ts', direction: 'importers' });
    expect(recognizeCodeRead('افحص مشروع تجربة الجمع', NAME)).toEqual({ kind: 'check' });
    expect(recognizeCodeRead('why do the tests fail in Shop API', 'Shop API')).toEqual({ kind: 'check' });
  });

  it('leaves change requests, text corrections and other questions alone', () => {
    for (const request of ['أصلح مشروع تجربة الجمع', 'صحح الأخطاء في مشروع تجربة الجمع', 'ما هو مشروع تجربة الجمع؟', 'افتح مشروع تجربة الجمع',
      'اكتب اختبارات لمشروع تجربة الجمع', 'ابحث في مشروع تجربة الجمع']) {
      expect(recognizeCodeRead(request, NAME), request).toBeNull();
    }
  });
});

describe('answering a read without a model', () => {
  const calls: string[] = [];
  const base = {
    list: async () => '', inventory: async () => [demo, shop], approve: async () => {}, cancel: async () => {},
    outcome: async () => ({ settled: true, text: '' }),
  };
  const work = {
    ...base,
    codeCheck: async (_owner: string, projectId: string) => { calls.push(`check ${projectId}`); return checked; },
    codeSearch: async (_owner: string, projectId: string, query: string) => {
      calls.push(`search ${projectId} ${query}`);
      return query === 'sum'
        ? { query, wholeWord: true, matches: [], total: 0, files: 0, masked: 0, pathMatches: ['src/sum.ts', 'test/sum.test.mjs'] }
        : { query, wholeWord: true, matches: [{ path: 'src/sum.ts', line: 2, text: 'return leftHandValue + rightHandVaule;' }], total: 1, files: 1, masked: 0, pathMatches: [] };
    },
    codeImports: async (_owner: string, projectId: string, reference: string) => {
      calls.push(`imports ${projectId} ${reference}`);
      return { kind: 'file' as const, relations: { target: 'src/sum.ts', imports: [], importedBy: [{ path: 'test/sum.test.mjs', specifier: '../src/sum.ts' }] } };
    },
  };
  const signal = new AbortController().signal;
  const labels: string[] = [];
  const progress = async (label: string) => { labels.push(label); };

  it('runs the checks once and explains each failure from the sandbox output, with nothing changed', async () => {
    calls.length = 0;
    const answer = await answerNoModelCodeRead('شغّل اختبارات مشروع تجربة الجمع', work, 'owner', signal, progress);
    expect(calls).toEqual(['check p-demo']);
    expect(answer?.status).toBe('completed');
    expect(answer?.text).toContain('نجح 0 وفشل 2 من أصل 2');
    expect(answer?.text).toContain('1. «adds positive values» في `test/sum.test.mjs:5`');
    expect(answer?.text).toContain('الخطأ: ReferenceError: rightHandVaule is not defined');
    expect(answer?.text).toContain('مصدره: `src/sum.ts:2`');
    expect(answer?.text).toContain('الخطأ نفسه، من `src/sum.ts:2`.');
    expect(answer?.text).toContain("Did you mean 'rightHandValue'? (TS2552)");
    expect(answer?.text).toContain('لم يتغيّر شيء في المشروع.');
    expect(answer?.text).toContain('اطلب «أصلح مشروع تجربة الجمع»');
    expect(answer?.step).toMatchObject({ id: 'code-check', capability: 'code.check', ok: true });
    expect(answer?.step.evidence).toBe('windows-appcontainer: exit 1; tests 0/2 passed; network denied; snapshot bbbbbbbbbbbb');
    expect(labels.at(-1)).toBe('تشغيل فحوص «مشروع تجربة الجمع» في نسخة معزولة');
  });

  it('answers in the language of the request, not of the project name', async () => {
    const answer = await answerNoModelCodeRead('Run the tests in مشروع تجربة الجمع', work, 'owner', signal, progress);
    expect(answer?.text).toMatch(/^I ran the checks of "مشروع تجربة الجمع" once in an isolated copy with no network, and they failed\. 0 passed and 2 failed out of 2\./u);
    expect(answer?.text).toContain('1. "adds positive values" at `test/sum.test.mjs:5`');
  });

  it('searches and reads imports of the named project only', async () => {
    calls.length = 0;
    const found = await answerNoModelCodeRead('ابحث في مشروع تجربة الجمع عن rightHandVaule', work, 'owner', signal, progress);
    expect(found?.text).toBe('وجدت «rightHandVaule» في «مشروع تجربة الجمع»: سطر واحد في ملف واحد، من الملفات المحفوظة في Git، بالكلمة كاملة.\n\n- `src/sum.ts:2` — `return leftHandValue + rightHandVaule;`');
    expect(found?.step).toMatchObject({ id: 'code-read', capability: 'code.read', ok: true });
    const imported = await answerNoModelCodeRead('ما الملفات التي تستورد src/sum.ts في مشروع تجربة الجمع؟', work, 'owner', signal, progress);
    expect(imported?.text).toBe('الملفات التي تستورد `src/sum.ts` في «مشروع تجربة الجمع»، من الملفات المحفوظة في Git:\n- `test/sum.test.mjs` (عبر `../src/sum.ts`)');
    expect(calls).toEqual(['search p-demo rightHandVaule', 'imports p-demo src/sum.ts']);
  });

  it('finds a file by its name when the owner asks for a file', async () => {
    expect(recognizeCodeRead('ابحث عن ملف اسمه sum في مشروع تجربة الجمع', NAME)).toEqual({ kind: 'search', query: 'sum' });
    expect(recognizeCodeRead('find the file named sum in Shop API', 'Shop API')).toEqual({ kind: 'search', query: 'sum' });
    const answer = await answerNoModelCodeRead('ابحث عن ملف اسمه sum في مشروع تجربة الجمع', work, 'owner', signal, progress);
    expect(answer?.text).toBe('لم أجد «sum» داخل ملفات «مشروع تجربة الجمع» المحفوظة في Git. ملفات يطابق مسارها «sum»: `src/sum.ts`، `test/sum.test.mjs`.');
  });

  it('is not this path\'s when no registered project is named, or when the reads are not wired', async () => {
    calls.length = 0;
    expect(await answerNoModelCodeRead('شغّل الاختبارات', work, 'owner', signal, progress)).toBeNull();
    expect(await answerNoModelCodeRead('ابحث عن ملف اسمه README', work, 'owner', signal, progress)).toBeNull();
    expect(await answerNoModelCodeRead('ما عاصمة فرنسا؟', work, 'owner', signal, progress)).toBeNull();
    expect(await answerNoModelCodeRead('ابحث في مشروع تجربة الجمع عن sum', { ...base }, 'owner', signal, progress)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('says plainly why nothing ran when the sandbox or the project is not ready', async () => {
    const noSandbox = await answerNoModelCodeRead('شغّل اختبارات مشروع تجربة الجمع', { ...base, codeSearch: work.codeSearch, codeImports: work.codeImports }, 'owner', signal, progress);
    expect(noSandbox).toMatchObject({ status: 'blocked', step: { ok: false, evidence: 'SANDBOX_UNAVAILABLE' } });
    expect(noSandbox?.text).toContain('بيئة العزل غير متاحة هنا، فلم أشغّل أي كود.');
    const dirty = await answerNoModelCodeRead('Search مشروع تجربة الجمع for sum', {
      ...work, codeSearch: async () => { throw new BrowserError('DIRTY_PROJECT', 'المشروع يحتوي تغييرات staged غير محفوظة.', 409); },
    }, 'owner', signal, progress);
    expect(dirty?.status).toBe('blocked');
    expect(dirty?.text).toBe('I could not read "مشروع تجربة الجمع": The project has changes not committed to Git, and I read and check only the committed version. Commit your changes, then ask again.');
  });
});

describe('the engine\'s read-only check', () => {
  let directory = '';
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'mohassan-code-check-')); });
  afterAll(async () => {
    const base = await realpath(tmpdir()), target = await realpath(directory), inside = relative(base, target);
    if (!isAbsolute(inside) && inside.startsWith('mohassan-code-check-')) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const engineWith = (run: (files: { path: string; content: string }[]) => unknown) => new CodingEngine({
    dataDir: join(directory, 'data'), allowedRoots: [directory], generateEdits: generateDeterministicEdits,
    sandbox: { available: async () => ({ available: true, provider: 'unit-fixture', message: 'unit' }), run: async request => run(request.files) as never },
  });
  const receipt = (files: { path: string; content: string }[], hash = snapshotHash(files)) => ({ exitCode: 1, stdout: REAL_OUTPUT, stderr: '', timedOut: false, durationMs: 3,
    provider: 'unit-fixture', network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: hash });

  it('explains the run, adds the compiler\'s diagnostic for the failing file, and creates no worktree', async () => {
    const built = await createRepairDemoProject(join(directory, 'projects'));
    const project = { id: '7e0f8f61-6a2b-4b4d-9a55-1d2c3e4f5a6b', ownerId: 'owner', name: NAME, path: built.path, baseCommit: built.baseCommit,
      allowedPaths: built.allowedPaths, testProfile: 'node-test' as const, createdAt: new Date().toISOString() };
    const result = await engineWith(files => receipt(files)).check({ ownerId: 'owner', project, signal: new AbortController().signal });
    expect(result.report.failures.map(failure => `${failure.test} ${failure.origin?.path}:${failure.origin?.line}`)).toEqual(['adds positive values src/sum.ts:2', 'adds negative values src/sum.ts:2']);
    expect(result.diagnostics).toEqual([{ path: 'src/sum.ts', line: 2, column: 26, code: 'TS2552', message: "Cannot find name 'rightHandVaule'. Did you mean 'rightHandValue'?" }]);
    expect(result.receipt).toMatchObject({ provider: 'unit-fixture', isolationVerified: true, network: 'denied', exitCode: 1 });
    await expect(lstat(join(directory, 'data', 'coding-worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(built.path, 'src', 'sum.ts'), 'utf8')).toContain('rightHandVaule');
    // A receipt for other files than those sent proves nothing.
    await expect(engineWith(files => receipt(files, 'c'.repeat(64))).check({ ownerId: 'owner', project, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'UNVERIFIED_SANDBOX' });
    await expect(engineWith(files => receipt(files)).check({ ownerId: 'someone-else', project, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'PROJECT_FORBIDDEN' });
  });
});

describe('a read of a named project in the chat when no model exists', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory = '', cookie = '', ownerId = '';
  const secret = 'no-model-code-read-fixture-internal-secret', origin = 'http://127.0.0.1:3000';
  const headers = { 'x-mohassan-internal': secret, origin };
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) => application.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function settled(id: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const detail = (await api('GET', `/api/chat/conversations/${id}`)).json();
      if (detail.status !== 'running') return detail;
      await delay(25);
    }
    throw new Error('the conversation never settled');
  }
  const ask = async (goal: string) => settled((await application.chat.create(ownerId, { goal })).id);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-no-model-code-read-'));
    application = await createApplication({
      authSecret: 'no-model-code-read-fixture-auth-secret-01', internalSecret: secret, setupToken: 'no-model-code-read-fixture-setup-token', webOrigin: origin,
      production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
      sandboxRunner: {
        available: async () => ({ available: true, provider: 'unit-fixture', message: 'injected unit test only' }),
        // The real sandbox's output for the misspelled demo; no project code is executed here.
        run: async request => ({ exitCode: 1, stdout: REAL_OUTPUT, stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
          network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files) }),
      },
    });
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك اختبار القراءة', email: 'code-read@example.test', password: 'No-Model-Code-Read-Password-42', setupToken: 'no-model-code-read-fixture-setup-token' } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'code-read@example.test', password: 'No-Model-Code-Read-Password-42' } });
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
    expect((await api('POST', '/api/coding/projects/demo', {})).statusCode).toBe(200);
  });
  afterAll(async () => {
    await application?.app.close();
    if (directory) {
      const base = await realpath(tmpdir()), target = await realpath(directory), inside = relative(base, target);
      if (!isAbsolute(inside) && inside.startsWith('mohassan-no-model-code-read-')) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('runs the checks without approval, explains them, records the step and its receipt, and changes nothing', async () => {
    const project = (await application.coding.workspace(ownerId)).projects[0]!;
    const before = await readFile(join(project.path, 'src', 'sum.ts'), 'utf8');
    const done = await ask('شغّل اختبارات مشروع تجربة الجمع');
    expect(done.status).toBe('idle');
    const reply = done.messages.at(-1).text as string;
    expect(reply).toContain('«adds positive values» في `test/sum.test.mjs:5`');
    expect(reply).toContain('مصدره: `src/sum.ts:2`');
    expect(reply).toContain("Did you mean 'rightHandValue'? (TS2552)");
    expect(done.run.plan.steps).toEqual([expect.objectContaining({ id: 'code-check', capability: 'code.check', state: 'verified', risk: 'read', authorization: 'not_needed' })]);
    expect(done.run.evidence).toEqual([expect.objectContaining({ stepId: 'code-check', kind: 'adapter_report', label: expect.stringContaining('unit-fixture: exit 1; tests 0/2 passed') })]);
    expect((await application.runtime.snapshot(ownerId)).tasks).toEqual([]);
    expect(await readFile(join(project.path, 'src', 'sum.ts'), 'utf8')).toBe(before);
  });

  it('searches the committed files and reads imports in the chat', async () => {
    const found = await ask('ابحث في مشروع تجربة الجمع عن rightHandVaule');
    expect(found.messages.at(-1).text).toContain('- `src/sum.ts:2` — `return leftHandValue + rightHandVaule;`');
    expect(found.run.plan.steps).toEqual([expect.objectContaining({ id: 'code-read', capability: 'code.read', state: 'verified' })]);
    const imports = await ask('ماذا يستورد ملف test/sum.test.mjs في مشروع تجربة الجمع؟');
    const text = imports.messages.at(-1).text as string;
    expect(text).toContain('- `node:test` — وحدة مدمجة أو حزمة خارج المشروع');
    expect(text).toContain('- `../src/sum.ts` ← `src/sum.ts`');
  });

  it('sends «صحح الأخطاء» in a named project to the approved change path', async () => {
    const waiting = await ask('صحح الأخطاء في مشروع تجربة الجمع');
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval.detail).toContain('لا يُنفَّذ أي تغيير في المنطق');
    expect((await api('POST', `/api/chat/conversations/${waiting.id}/approve`, { approvalId: waiting.approval.id, approved: false })).statusCode).toBe(200);
    await settled(waiting.id);
  });
});
