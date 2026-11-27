import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { snapshotHash, type SandboxRunner } from '@mohassan/coding';
import type { ChatConversation, CodingWorkspace } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { git } from '../packages/coding/src/git.js';

const conversations = '/api/chat/conversations';
const projectList = '/api/coding/projects';
const origin = 'http://127.0.0.1:3000';
const internalSecret = randomUUID(), setupToken = randomUUID();
const source = 'export const total = 4;\n';
const testSource = 'import test from "node:test";\ntest("loads", () => {});\n';
const sourceFile = 'src/total.mjs';
const testFile = 'test/total.test.mjs';
const defaultFiles = { 'package.json': '{"scripts":{"test":"node --test"}}\n', [sourceFile]: source, [testFile]: testSource };

async function commitFiles(path: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const target = join(path, ...file.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    const oid = (await git(path, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).stdout.trim();
    await git(path, ['update-index', '--add', '--cacheinfo', '100644', oid, file]);
  }
  const parent = await git(path, ['rev-parse', '--verify', 'HEAD'], { allowedExitCodes: [0, 128] });
  const tree = (await git(path, ['write-tree'])).stdout.trim();
  const commit = (await git(path, ['commit-tree', tree, ...(parent.exitCode === 0 ? ['-p', parent.stdout.trim()] : []), '-m', 'Project registration fixture'])).stdout.trim();
  await git(path, ['update-ref', 'refs/heads/main', commit]);
  return commit;
}

async function repository(root: string, files: Record<string, string> = defaultFiles) {
  const path = await mkdtemp(join(root, 'project fixture-'));
  await git(path, ['init', '--initial-branch=main', '--template=', '.']);
  return { path, baseCommit: await commitFiles(path, files) };
}

const registerArabic = (path: string, name: string) => `سجّل مشروع "${path}" باسم ${name}`;
const registerEnglish = (path: string, name: string, files: readonly string[]) => `register project "${path}" as ${name} with files ${files.join(', ')}`;
const reply = (conversation: ChatConversation) => conversation.messages.findLast(message => message.role === 'assistant')?.text;

describe('owner-only coding project registration and inventory in chat', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory: string, allowed: string, ownerCookie: string, memberCookie: string, ownerId: string;
  const run = vi.fn<SandboxRunner['run']>(async request => ({
    // The counts printed by the repair demo in Windows AppContainer, recorded in assistant-no-model-code-read.test.ts.
    exitCode: 1, stdout: 'ℹ tests 2\nℹ suites 0\nℹ pass 0\nℹ fail 2\n', stderr: '', timedOut: false, durationMs: 1,
    provider: 'unit-fixture', network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files),
  }));
  const aiFetch = vi.fn(async (): Promise<never> => { throw new Error('This fixture has no model.'); });
  const api = (method: 'GET' | 'POST', url: string, cookie: string = ownerCookie, payload?: object) => application.app.inject({
    method, url, headers: { origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}),
  });

  async function signIn(account: { email: string; password: string }) {
    const response = await api('POST', '/api/auth/sign-in/email', '', { email: account.email, password: account.password });
    expect(response.statusCode).toBe(200);
    return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }

  async function settled(id: string, cookie: string) {
    // Keep the fixture below the conversation endpoint's 400 polls per minute.
    return vi.waitFor(async () => {
      const response = await api('GET', `${conversations}/${id}`, cookie);
      expect(response.statusCode).toBe(200);
      const detail = response.json<ChatConversation>();
      expect(detail.status).not.toBe('running');
      return detail;
    }, { timeout: 20_000, interval: 200 });
  }

  async function ask(goal: string, cookie = ownerCookie) {
    const response = await api('POST', conversations, cookie, { goal });
    expect(response.statusCode).toBe(200);
    return settled(response.json<ChatConversation>().id, cookie);
  }

  async function choose(conversation: ChatConversation, optionId: string) {
    expect(conversation.status).toBe('waiting_user');
    expect(conversation.question?.options.map(option => option.id)).toContain(optionId);
    const response = await api('POST', `${conversations}/${conversation.id}/respond`, ownerCookie, { questionId: conversation.question!.id, optionId });
    expect(response.statusCode).toBe(200);
    return settled(conversation.id, ownerCookie);
  }

  async function approve(conversation: ChatConversation, approved: boolean) {
    expect(conversation.status).toBe('waiting_approval');
    expect(conversation.approval).toBeTruthy();
    const response = await api('POST', `${conversations}/${conversation.id}/approve`, ownerCookie, { approvalId: conversation.approval!.id, approved });
    expect(response.statusCode).toBe(200);
    return settled(conversation.id, ownerCookie);
  }

  async function registeredAt(path: string) {
    const result = await api('GET', projectList);
    expect(result.statusCode).toBe(200);
    return result.json<CodingWorkspace>().projects.filter(project => project.path === path);
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), 'mohassan-code-projects-chat-'));
    allowed = join(directory, 'allowed');
    const codingDataDir = join(directory, 'coding');
    await mkdir(allowed);
    application = await createApplication({
      authSecret: randomUUID(), internalSecret, setupToken, webOrigin: origin, production: false, runWorker: false, testRequestLimit: 2000,
      memberDailyRuns: 100, dataDir: join(directory, 'server'), codingDataDir, codingAllowedRoots: [allowed],
      browserProfileDir: join(directory, 'browser'), documentsDir: join(directory, 'documents'), browserChannel: null, aiFetch,
      browser: { searchProvider: { name: 'Offline projects fixture', search: async () => [] } },
      sandboxRunner: { available: async () => ({ available: true, provider: 'unit-fixture', message: 'Test adapter' }), run },
    });
    const owner = { name: 'Projects owner', email: 'owner-projects@example.test', password: randomUUID() };
    expect((await api('POST', '/api/setup', '', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    ownerId = (await application.database.db.selectFrom('user').select('id').where('email', '=', owner.email).executeTakeFirstOrThrow()).id;

    const member = { name: 'Projects member', email: 'member-projects@example.test', password: randomUUID() };
    const invited = await api('POST', '/api/members/invites', ownerCookie, { name: member.name, email: member.email });
    expect(invited.statusCode).toBe(200);
    const token = new URL(invited.json<{ url: string }>().url).hash.replace(/^#invite=/u, '');
    expect((await api('POST', '/api/invites/accept', '', { token, name: member.name, password: member.password })).statusCode).toBe(200);
    memberCookie = await signIn(member);
    expect((await api('GET', '/api/access', memberCookie)).json().role).toBe('member');
  });

  afterEach(() => {
    expect(run).not.toHaveBeenCalled();
    expect(aiFetch).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('lists the registered editable scope and inspected tests in both languages and gives the reason a project cannot be read', async () => {
    const ready = await repository(allowed, { ...defaultFiles, 'src/other.mjs': 'export {};\n' });
    const unavailableTest = 'test/unavailable.test.mjs';
    const unavailable = await repository(allowed, { [sourceFile]: source, [unavailableTest]: testSource });
    expect((await api('POST', projectList, ownerCookie, { name: 'Ledger Sandbox', path: ready.path, allowedPaths: [sourceFile] })).statusCode).toBe(200);
    expect((await api('POST', projectList, ownerCookie, { name: 'Unfinished Ledger', path: unavailable.path, allowedPaths: [sourceFile] })).statusCode).toBe(200);
    await appendFile(join(unavailable.path, sourceFile), '\n// A local edit.\n');

    const requests = [
      ['ما مشاريعي البرمجية؟', 'الملفات القابلة للتعديل', 'ملفات الاختبار'],
      ['list my coding projects', 'Editable files', 'Test files'],
    ] as const;
    for (const [goal, editable, tests] of requests) {
      const listed = await ask(goal);
      expect(listed.status).toBe('idle');
      for (const value of ['Ledger Sandbox', 'Unfinished Ledger', editable, tests, sourceFile, testFile, 'ملفات المشروع تختلف عن HEAD']) {
        expect(reply(listed)).toContain(value);
      }
      expect(reply(listed)).not.toContain('src/other.mjs');
      expect(reply(listed)).not.toContain(unavailableTest);
    }
  });

  it('lists the current tests of a clean project and notes that its saved commit is older', async () => {
    const project = await repository(allowed);
    expect((await api('POST', projectList, ownerCookie, { name: 'Advancing project', path: project.path, allowedPaths: [sourceFile] })).statusCode).toBe(200);
    const addedTest = 'test/new-total.test.mjs';
    await commitFiles(project.path, { [addedTest]: testSource });

    const listed = await ask('list my coding projects');
    expect(listed.status).toBe('idle');
    expect(reply(listed)).toContain('Advancing project');
    expect(reply(listed)).toContain(addedTest);
    expect(reply(listed)).toMatch(/HEAD.*(?:old|changed|outdated)|(?:old|changed|outdated).*HEAD/iu);
    expect(await registeredAt(project.path)).toEqual([expect.objectContaining({ baseCommit: project.baseCommit })]);
  });

  it.each([
    { label: 'a project outside the allowed roots', root: 'outside', reason: 'المشروع خارج الجذور المصرح بها' },
    { label: 'a dirty project', dirty: true, reason: 'ملفات المشروع تختلف عن HEAD' },
    { label: 'a project without Node tests', files: { [sourceFile]: source }, reason: 'يلزم اختبار Node مدمج محفوظ ضمن المشروع' },
    { label: 'an unsupported test script', files: { ...defaultFiles, 'package.json': '{"scripts":{"test":"vitest run"}}\n' }, reason: 'سكربت test المدعوم هو node --test' },
    { label: 'unsupported dependencies', files: { ...defaultFiles, 'package.json': '{"dependencies":{"example-package":"1.0.0"}}\n' }, reason: 'تدعم بيئة العزل أدوات Node وTypeScript وESLint' },
  ])('refuses $label with the inspection reason before presenting any card', async ({ root, dirty, files, reason }) => {
    const project = await repository(root === 'outside' ? directory : allowed, files);
    if (dirty) await appendFile(join(project.path, sourceFile), '\n// A local edit.\n');

    const refused = await ask(registerArabic(project.path, 'مشروع جديد'));
    expect(refused.status).toBe('idle');
    expect(refused.question).toBeNull();
    expect(refused.approval).toBeNull();
    expect(reply(refused)).toContain(reason);
    expect(await registeredAt(project.path)).toEqual([]);
  });

  it('explains an out-of-scope folder in English and keeps the Arabic inspection diagnosis', async () => {
    const project = await repository(directory);
    const refused = await ask(`register project "${project.path}" as Outside Project`);
    expect(refused.status).toBe('idle');
    expect(refused.approval).toBeNull();
    expect(reply(refused)).toContain('The project is outside the allowed folders. المشروع خارج الجذور المصرح بها.');
    expect(await registeredAt(project.path)).toEqual([]);
  });

  it('moves from file choices to approval and registers only the approved files', async () => {
    const project = await repository(allowed, { ...defaultFiles, 'src/a.mjs': 'export {};\n', 'src/b.mjs': 'export {};\n', 'src/z.mjs': 'export {};\n' });
    const requested = await ask(registerArabic(project.path, 'تطبيق الحسابات'));
    expect(requested.status).toBe('waiting_user');
    expect(requested.question?.prompt).toContain('اختر من ملف واحد إلى 5');
    expect(requested.question?.options).toEqual(expect.arrayContaining([
      { id: 'file-1', label: 'src/a.mjs' }, { id: 'file-2', label: 'src/b.mjs' }, { id: 'file-3', label: sourceFile },
    ]));
    expect(requested.approval).toBeNull();
    expect(await registeredAt(project.path)).toEqual([]);

    const nextPage = await choose(requested, 'more-files');
    expect(nextPage.question?.options).toContainEqual({ id: 'file-4', label: 'src/z.mjs' });
    const firstPage = await choose(nextPage, 'more-files');
    const first = await choose(firstPage, 'file-1');
    const remaining = first.question?.options.find(option => option.label === sourceFile);
    expect(remaining).toBeDefined();
    const second = await choose(first, remaining!.id);
    const waiting = await choose(second, 'confirm-files');
    expect(waiting.status).toBe('waiting_approval');
    const card = `${waiting.approval?.prompt}\n${waiting.approval?.detail}`;
    for (const value of ['تطبيق الحسابات', project.path, 'src/a.mjs', sourceFile]) expect(card).toContain(value);
    expect(card).not.toContain('src/b.mjs');
    expect(await registeredAt(project.path)).toEqual([]);

    const done = await approve(waiting, true);
    expect(done.status).toBe('idle');
    expect(reply(done)).toContain('سُجّل مشروع');
    expect(await registeredAt(project.path)).toEqual([
      expect.objectContaining({ name: 'تطبيق الحسابات', allowedPaths: ['src/a.mjs', sourceFile], baseCommit: project.baseCommit }),
    ]);
    const replay = await api('POST', `${conversations}/${waiting.id}/approve`, ownerCookie, { approvalId: waiting.approval!.id, approved: true });
    expect(replay.statusCode).toBe(409);
    expect(await registeredAt(project.path)).toHaveLength(1);
    expect((await application.runtime.snapshot(ownerId)).tasks).toEqual([]);
    expect(await readFile(join(project.path, sourceFile), 'utf8')).toBe(source);
    expect((await git(project.path, ['for-each-ref', '--format=%(refname)'])).stdout.trim()).toBe('refs/heads/main');
  });

  it('uses the files in an English request and leaves the project unregistered after refusal', async () => {
    const project = await repository(allowed);
    const waiting = await ask(registerEnglish(project.path, 'Declined project', [sourceFile]));
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.question).toBeNull();
    expect(waiting.approval?.detail).toContain(sourceFile);
    expect(await registeredAt(project.path)).toEqual([]);

    const refused = await approve(waiting, false);
    expect(refused.status).toBe('idle');
    expect(reply(refused)).not.toContain('Registered coding project');
    expect(await registeredAt(project.path)).toEqual([]);
    expect(await readFile(join(project.path, sourceFile), 'utf8')).toBe(source);
  });

  it('respects a request that includes an instruction against saving', async () => {
    const project = await repository(allowed);
    const rejected = await ask(`register project "${project.path}" as Example, do not save`);
    expect(rejected.question).toBeNull();
    expect(rejected.approval).toBeNull();
    expect(await registeredAt(project.path)).toEqual([]);
  });

  it('keeps the question open for an invalid typed answer and approves a valid typed selection', async () => {
    const other = 'src/a.mjs';
    const project = await repository(allowed, { ...defaultFiles, [other]: 'export {};\n' });
    const question = await ask(`register project "${project.path}" as Typed choices`);
    expect(question.status).toBe('waiting_user');

    const answer = async (conversation: ChatConversation, text: string) => {
      const response = await api('POST', `${conversations}/${conversation.id}/messages`, ownerCookie, { questionId: conversation.question!.id, text });
      expect(response.statusCode).toBe(200);
      return settled(conversation.id, ownerCookie);
    };
    const retried = await answer(question, testFile);
    expect(retried.status).toBe('waiting_user');
    expect(retried.question?.id).not.toBe(question.question?.id);
    expect(retried.question?.prompt).toContain('distinct files from the list');
    expect(retried.approval).toBeNull();

    const waiting = await answer(retried, `1, ${sourceFile}`);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.approval?.detail).toContain(`${other}, ${sourceFile}`);
    expect(await registeredAt(project.path)).toEqual([]);
    const done = await approve(waiting, true);
    expect(done.status).toBe('idle');
    expect(reply(done)).toContain('Registered coding project');
    expect(await registeredAt(project.path)).toEqual([expect.objectContaining({ name: 'Typed choices', allowedPaths: [other, sourceFile] })]);
  });

  it('rejects explicit selections outside the editable scope or beyond five files', async () => {
    const extraSources = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'];
    const project = await repository(allowed, { ...defaultFiles, ...Object.fromEntries(extraSources.map(file => [file, 'export {};\n'])) });
    for (const files of [[testFile], [sourceFile, ...extraSources]]) {
      const rejected = await ask(registerEnglish(project.path, 'Invalid selection', files));
      expect(rejected.status).toBe('idle');
      expect(rejected.approval).toBeNull();
      expect(await registeredAt(project.path)).toEqual([]);
    }
  });

  it('rejects approval when the inspected Git commit changes before the write', async () => {
    const project = await repository(allowed);
    const waiting = await ask(registerEnglish(project.path, 'Changed project', [sourceFile]));
    expect(waiting.status).toBe('waiting_approval');
    const newCommit = await commitFiles(project.path, { [sourceFile]: 'export const total = 8;\n' });
    expect(newCommit).not.toBe(project.baseCommit);

    const result = await approve(waiting, true);
    expect(result.status).toBe('idle');
    expect(reply(result)).toMatch(/HEAD|commit/iu);
    expect(await registeredAt(project.path)).toEqual([]);
  });

  it('denies a member the inventory, registration cards, and access to the owner’s approval', async () => {
    const existing = await repository(allowed);
    expect((await api('POST', projectList, ownerCookie, { name: 'OwnerOnlyProject', path: existing.path, allowedPaths: [sourceFile] })).statusCode).toBe(200);
    const project = await repository(allowed);
    const request = registerEnglish(project.path, 'Owner-only registration', [sourceFile]);
    const listed = await ask('list my coding projects', memberCookie);
    const rejected = await ask(request, memberCookie);
    expect(listed.status).toBe('idle');
    expect(reply(listed)).not.toContain('OwnerOnlyProject');
    expect(reply(listed)).not.toContain(testFile);
    expect(rejected.question).toBeNull();
    expect(rejected.approval).toBeNull();
    expect(reply(rejected)).not.toContain('Registered coding project');

    const waiting = await ask(request);
    expect(waiting.status).toBe('waiting_approval');
    const response = await api('POST', `${conversations}/${waiting.id}/approve`, memberCookie, { approvalId: waiting.approval!.id, approved: true });
    expect(response.statusCode).toBe(404);
    expect(await registeredAt(project.path)).toEqual([]);
    await approve(waiting, false);
  });
});
