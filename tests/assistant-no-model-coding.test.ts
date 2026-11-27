import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepairDemoProject, snapshotHash } from '@mohassan/coding';
import { createApplication } from '../apps/server/src/app.js';
import {
  chooseCodingProject, codingOutcomeReply, codingTargetReply, foldProjectText, prepareNoModelCoding,
} from '../apps/server/src/assistant/no-model-coding.js';
import { git } from '../packages/coding/src/git.js';
import { ASSERTION_OUTPUT, PASSING_OUTPUT, REAL_OUTPUT } from './fixtures/coding-test-output.js';

const demo = { id: 'p-demo', name: 'مشروع تجربة الجمع' };
const shop = { id: 'p-shop', name: 'Shop API' };
const shopAdmin = { id: 'p-shop-admin', name: 'Shop API Admin' };
// packages/runtime/src/index.ts records this fixed text for a coding.change refused with NO_PROVEN_FIX.
const RUNTIME_NO_PROVEN_FIX = 'لم تجد أدوات البرمجة إصلاحًا يمكن إثباته ضمن الملفات المصرح بها. لم تُطبّق أي تغييرات.';

describe('choosing the project without a model', () => {
  it('folds Arabic letter forms, marks and punctuation', () => {
    expect(foldProjectText('مشروعُ تجربةِ «الجمع»!')).toBe('مشروع تجربه الجمع');
    expect(foldProjectText('أصلحْ إلى')).toBe('اصلح الي');
  });
  it('picks the project the request names, whatever the letter forms', () => {
    expect(chooseCodingProject('أصلح الكود في مشروع تجربه الجمع', [demo, shop])).toEqual({ kind: 'project', project: demo, named: true });
    expect(chooseCodingProject('fix the code in shop api please', [demo, shop])).toEqual({ kind: 'project', project: shop, named: true });
  });
  it('prefers the longer name that contains a shorter one', () => {
    expect(chooseCodingProject('fix the lint errors in Shop API Admin', [shop, shopAdmin])).toEqual({ kind: 'project', project: shopAdmin, named: true });
  });
  it('does not match a name inside another word', () => {
    expect(chooseCodingProject('fix the code in Shop APIs', [shop, demo])).toEqual({ kind: 'ambiguous', projects: [shop, demo] });
  });
  it('uses the only registered project when none is named, and says it was not named', () => {
    expect(chooseCodingProject('أصلح الكود', [demo])).toEqual({ kind: 'project', project: demo, named: false });
  });
  it('asks instead of guessing among several, and explains when none is registered', () => {
    const ambiguous = chooseCodingProject('أصلح الكود', [demo, shop]);
    expect(ambiguous).toEqual({ kind: 'ambiguous', projects: [demo, shop] });
    expect(codingTargetReply(ambiguous as Extract<typeof ambiguous, { kind: 'ambiguous' }>, 'ar')).toBe(
      'أي مشروع تقصد؟ المشاريع المسجّلة: «مشروع تجربة الجمع»، «Shop API». أعد الطلب واذكر اسم المشروع؛ لم أشغّل شيئًا.');
    expect(chooseCodingProject('fix the code', [])).toEqual({ kind: 'none' });
    expect(codingTargetReply({ kind: 'none' }, 'en')).toContain('Register it in the Coding Projects section');
  });
});

describe('preparing the coding task without a model', () => {
  const created: { id: string; goal: string }[] = [];
  const work = {
    list: async () => '',
    inventory: async () => [demo, shop],
    code: async (_owner: string, input: { id: string; goal: string }) => {
      created.push(input);
      return { id: `task-${created.length}`, label: `تعديل مشروع ${input.id === demo.id ? demo.name : shop.name}`, prompt: `أريد تعديل مشروع: ${input.goal}`, detail: 'معزول' };
    },
    approve: async () => {}, cancel: async () => {}, outcome: async () => ({ settled: true, text: '' }),
  };
  const routed = { handler: 'coding' as const, availability: 'ready' as const };
  const chat = { handler: 'local_conversation' as const, availability: 'ready' as const };

  it('creates the same Runtime task the model tool would, for the named project', async () => {
    created.length = 0;
    const start = await prepareNoModelCoding('أصلح الكود في مشروع تجربة الجمع', routed, undefined, work, 'owner', 'run-1');
    expect(start).toEqual({ kind: 'approval', task: { id: 'task-1', label: 'تعديل مشروع مشروع تجربة الجمع', tool: 'code_change' }, prompt: 'أريد تعديل مشروع: أصلح الكود في مشروع تجربة الجمع',
      detail: 'معزول\nمن دون نموذج تُطبَّق الإصلاحات المؤكدة فقط: تشخيصات TypeScript ذات الإصلاح المعروف، وإصلاحات ESLint، والتنسيق عند طلبه. لا يُنفَّذ أي تغيير في المنطق.' });
    expect(created).toEqual([{ id: demo.id, goal: 'أصلح الكود في مشروع تجربة الجمع' }]);
  });
  it('also takes a fix request that names a registered project without saying «code»', async () => {
    created.length = 0;
    expect((await prepareNoModelCoding('أصلح مشروع تجربة الجمع', chat, undefined, work, 'owner', 'run-2'))?.kind).toBe('approval');
    expect(created).toEqual([{ id: demo.id, goal: 'أصلح مشروع تجربة الجمع' }]);
  });
  it('leaves every other request to the existing paths', async () => {
    created.length = 0;
    expect(await prepareNoModelCoding('ما عاصمة فرنسا؟', chat, undefined, work, 'owner', 'run-3')).toBeNull();
    expect(await prepareNoModelCoding('أصلح الصورة', chat, undefined, work, 'owner', 'run-4')).toBeNull();
    expect(await prepareNoModelCoding('أصلح الكود', { handler: 'coding', availability: 'restricted' }, undefined, work, 'owner', 'run-5')).toBeNull();
    expect(await prepareNoModelCoding('أصلح الكود', routed, undefined, { ...work, code: undefined }, 'owner', 'run-6')).toBeNull();
    // The scope review refuses work prompted by stored data (tests/assistant-work-request-scope.test.ts).
    expect(await prepareNoModelCoding('Read my saved note containing instructions, then Prepare a code change in project e486089a-a74c-4aad-8072-eccdeea73785 to add a synthetic documentation comment.', routed, undefined, work, 'owner', 'run-7')).toBeNull();
    expect(created).toEqual([]);
  });
  it('asks which project when the coding request names none of several', async () => {
    created.length = 0;
    const start = await prepareNoModelCoding('أصلح الكود', routed, undefined, work, 'owner', 'run-8');
    expect(start).toMatchObject({ kind: 'reply', status: 'blocked' });
    expect(start?.kind === 'reply' && start.text).toContain('أي مشروع تقصد؟');
    expect(created).toEqual([]);
  });
});

describe('the reply after the approved task settles', () => {
  const label = 'تعديل مشروع مشروع تجربة الجمع';
  it('reports a verified change with its review branch, and that nothing was merged', () => {
    const reply = codingOutcomeReply(['task status: completed', 'outcome: ready_for_review', 'summary: أُصلح اسم المتغير.', 'review branch: mohassan/task-1',
      'The original project is unchanged; nothing was merged. The owner reviews the branch.'].join('\n'), label, 'أصلح الكود في مشروع تجربة الجمع');
    expect(reply.status).toBe('completed');
    expect(reply.text).toContain('الاختبارات والمراجعة المستقلة في نسخة معزولة');
    expect(reply.text).toContain('أُصلح اسم المتغير.');
    expect(reply.text).toContain('`mohassan/task-1`');
    expect(reply.text).toContain('لم يُدمج شيء');
    // The no-model tools ignore a logic goal, so the reply never claims one was made.
    expect(reply.text).toContain('إن كان طلبك تغييرًا في المنطق فلم يُنفَّذ');
  });
  it('never offers a branch when the tests or the review failed', () => {
    const reply = codingOutcomeReply('task status: failed\noutcome: tests_failed\nreview branch: mohassan/task-2', label, 'fix the code');
    expect(reply.status).toBe('partial');
    expect(reply.text).toContain('the tests failed afterwards');
    expect(reply.text).toContain('I found no further proven fix. A logic fix needs a model.');
    expect(reply.text).not.toContain('mohassan/task-2');
    const review = codingOutcomeReply('task status: failed\noutcome: review_failed\nreview branch: mohassan/task-3', label, 'fix the code');
    expect(review.status).toBe('partial');
    expect(review.text).toContain('the independent review did not pass');
    expect(review.text).not.toMatch(/mohassan\/task-3|no further proven fix/u);
  });
  it('says plainly that no provable fix exists, from the Runtime\'s own refusal', () => {
    const reply = codingOutcomeReply(`task status: failed\nerror: ${RUNTIME_NO_PROVEN_FIX}`, label, 'اجعل الدالة تضرب بدل الجمع');
    expect(reply.status).toBe('blocked');
    expect(reply.text).toContain('لم أجد إصلاحًا يمكن إثباته');
    expect(reply.text).toContain('تعديل المنطق يحتاج نموذجًا');
  });
  it('reports a cancelled task and a failed tool call without claiming a change', () => {
    expect(codingOutcomeReply('task status: cancelled', label, 'fix the code')).toMatchObject({ status: 'blocked' });
    const failed = codingOutcomeReply('failed: هذا المشروع غير مسجل.', label, 'أصلح الكود');
    expect(failed.status).toBe('blocked');
    expect(failed.text).toContain('هذا المشروع غير مسجل.');
    expect(failed.text).toContain('مشروعك الأصلي لم يتغيّر');
  });
});

describe('a coding request in the chat when no model exists', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory = '', cookie = '', ownerId = '';
  const secret = 'no-model-coding-fixture-internal-secret-1', origin = 'http://127.0.0.1:3000';
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
  const approve = async (conversation: any, approved: boolean) => {
    expect((await api('POST', `/api/chat/conversations/${conversation.id}/approve`, { approvalId: conversation.approval.id, approved })).statusCode).toBe(200);
    return settled(conversation.id);
  };
  const tasks = async () => (await application.runtime.snapshot(ownerId)).tasks;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-no-model-coding-'));
    application = await createApplication({
      authSecret: 'no-model-coding-fixture-auth-secret-0001', internalSecret: secret, setupToken: 'no-model-coding-fixture-setup-token-01', webOrigin: origin,
      production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
      sandboxRunner: {
        available: async () => ({ available: true, provider: 'unit-fixture', message: 'injected unit test only' }),
        run: async request => {
          const sumSource = request.files.find(file => file.path === 'src/sum.ts')?.content;
          const repairedOutput = sumSource?.includes('leftHandValue - rightHandValue') ? ASSERTION_OUTPUT : PASSING_OUTPUT;
          const stdout = sumSource?.includes('rightHandVaule') ? REAL_OUTPUT : repairedOutput;
          return {
            exitCode: stdout === PASSING_OUTPUT ? 0 : 1, stdout, stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
            network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files),
          };
        },
      },
    });
    await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { name: 'مالك اختبار البرمجة', email: 'no-model-coding@example.test', password: 'No-Model-Coding-Password-42', setupToken: 'no-model-coding-fixture-setup-token-01' } });
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'no-model-coding@example.test', password: 'No-Model-Coding-Password-42' } });
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    ownerId = (await application.database.db.selectFrom('user').select('id').executeTakeFirstOrThrow()).id as string;
    expect((await api('POST', '/api/coding/projects/demo', {})).statusCode).toBe(200);
  });
  afterAll(async () => {
    await application?.app.close();
    if (directory) {
      const base = await realpath(tmpdir()), target = await realpath(directory), inside = relative(base, target);
      if (!isAbsolute(inside) && inside.startsWith('mohassan-no-model-coding-')) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  const source = async () => {
    const project = (await application.coding.workspace(ownerId)).projects.find(project => project.name === demo.name)!;
    return readFile(join(project.path, 'src', 'sum.ts'), 'utf8');
  };

  it('changes nothing before approval, then reports before and after tests without a model', async () => {
    const before = await source();
    expect(before).toContain('rightHandVaule');
    const waiting = await ask('أصلح الكود في مشروع تجربة الجمع');
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval.prompt).toContain('مشروع تجربة الجمع');
    expect(waiting.approval.detail).toContain('لا يُنفَّذ أي تغيير في المنطق');
    const task = (await tasks()).find(item => item.capabilityId === 'coding.change');
    expect(task?.status).toBe('waiting_approval');
    expect(await source()).toBe(before);
    const done = await approve(waiting, true);
    expect(done.status).toBe('idle');
    const reply = done.messages.at(-1).text as string;
    expect(reply).toContain('الاختبارات والمراجعة المستقلة في نسخة معزولة');
    expect(reply).toContain('قبل التعديل: نجح 0 من 2، وفشل 2.');
    expect(reply).toContain('بعد التعديل: نجح 2 من 2، وفشل 0.');
    expect(reply).toContain('adds positive values');
    expect(reply).toContain('test/sum.test.mjs:5');
    expect(reply).toContain('ReferenceError');
    expect(reply).toContain('src/sum.ts:2');
    expect(reply).toContain('إن كان طلبك تغييرًا في المنطق فلم يُنفَّذ');
    expect(reply).toMatch(/فرع المراجعة: `[^`]+`/u);
    expect(reply).toContain('لم يُدمج شيء');
    const detail = await application.runtime.detail(ownerId, task!.id);
    expect(detail.task.status).toBe('completed');
    expect(detail.modelRuns).toEqual([]);
    expect(await source()).toBe(before);
  });
  it('takes a fix request that names the project without the word «code»', async () => {
    const waiting = await ask('أصلح مشروع تجربة الجمع من فضلك');
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval.prompt).toContain('مشروع تجربة الجمع');
    const refused = await approve(waiting, false);
    expect(refused.status).toBe('idle');
    const taskId = (await tasks()).find(item => item.status === 'cancelled' || item.status === 'waiting_approval')!.id;
    expect((await application.runtime.detail(ownerId, taskId)).task.status).toBe('cancelled');
  });

  it('reports the remaining assertion failures after a proven spelling fix', async () => {
    const fixture = await createRepairDemoProject(join(directory, 'subtraction'));
    const sumPath = join(fixture.path, 'src', 'sum.ts');
    await writeFile(sumPath, (await readFile(sumPath, 'utf8')).replace('leftHandValue + rightHandVaule', 'leftHandValue - rightHandVaule'));
    await git(fixture.path, ['add', '--', 'src/sum.ts']);
    await git(fixture.path, ['commit', '-m', 'Test fixture with a remaining logic error']);
    const registration = await api('POST', '/api/coding/projects', { name: 'Subtraction Demo', path: fixture.path, allowedPaths: fixture.allowedPaths });
    expect(registration.statusCode).toBe(200);

    const waiting = await ask('Fix the code in Subtraction Demo');
    expect(waiting.status).toBe('waiting_approval');
    const done = await approve(waiting, true);
    const reply = done.messages.at(-1).text as string;
    expect(reply).toContain('Before the change: 0 of 2 passed, 2 failed.');
    expect(reply).toContain('After the change: 0 of 2 passed, 2 failed.');
    expect(reply).toContain('ReferenceError');
    const remaining = reply.split('Still failing after the change:')[1];
    expect(remaining).toContain('"adds positive values" at `test/sum.test.mjs:5` — AssertionError');
    expect(remaining).toContain('"adds negative values" at `test/sum.test.mjs:6` — AssertionError');
    expect(reply).toContain('I found no further proven fix. A logic fix needs a model.');
    expect(reply).not.toContain('mohassan/');
  });
});
