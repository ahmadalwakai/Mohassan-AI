import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepairDemoProject, snapshotHash } from '@mohassan/coding';
import { CodingResultSchema, type ChatConversation, type CodingResult, type Project } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { answerCodeChangeView, readCodeChangeView } from '../apps/server/src/assistant/code-change-view.js';
import { git } from '../packages/coding/src/git.js';
import {
  REPAIR_DEMO_ASSERTION_FAILURE_OUTPUT, REPAIR_DEMO_FAILURE_OUTPUT, REPAIR_DEMO_SUCCESS_OUTPUT,
} from './fixtures/coding-repair-demo-output.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const origin = 'http://127.0.0.1:3000';
const internalSecret = 'coding-view-test-internal-fixture';
const setupToken = 'coding-view-test-setup-fixture-0001';
const owner = { name: 'Code change owner', email: 'code-view-owner@example.test', password: 'Code-View-Owner-Fixture-42' };
const member = { name: 'Code change member', email: 'code-view-member@example.test', password: 'Code-View-Member-Fixture-42' };

describe('the last coding change in owner chat', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory = '', ownerId = '', ownerCookie = '';
  let completeProject: Project, emptyProject: Project, failingProject: Project;
  let completed: CodingResult, failed: CodingResult, earlier: CodingResult;
  let sandboxRuns = 0;

  const api = (method: 'GET' | 'POST', url: string, payload?: object, cookie = ownerCookie) => application!.app.inject({
    method, url, headers: { 'x-mohassan-internal': internalSecret, origin, cookie }, ...(payload ? { payload } : {}),
  });

  async function login({ email, password }: { email: string; password: string }) {
    const response = await api('POST', '/api/auth/sign-in/email', { email, password }, '');
    expect(response.statusCode).toBe(200);
    return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }

  async function ask(goal: string, cookie = ownerCookie): Promise<ChatConversation> {
    const response = await api('POST', '/api/chat/conversations', { goal }, cookie);
    expect(response.statusCode).toBe(200);
    const { id } = response.json<ChatConversation>();
    for (let count = 0; count < 200; count++) {
      const current = await api('GET', `/api/chat/conversations/${id}`, undefined, cookie);
      expect(current.statusCode).toBe(200);
      const detail = current.json<ChatConversation>();
      if (detail.status !== 'running') return detail;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Chat did not settle');
  }

  async function register(name: string, variant: 'empty' | 'broken') {
    const fixture = await createRepairDemoProject(join(directory, variant));
    if (variant === 'broken') {
      const sourcePath = join(fixture.path, 'src', 'sum.ts');
      const source = await readFile(sourcePath, 'utf8');
      await writeFile(sourcePath, source.replace('leftHandValue + rightHandVaule', 'leftHandValue - rightHandVaule'));
      await git(fixture.path, ['add', '--', 'src/sum.ts']);
      await git(fixture.path, ['commit', '-m', 'Set up a failing repaired fixture']);
    }
    return application!.coding.register(ownerId, { name, path: fixture.path, allowedPaths: fixture.allowedPaths });
  }

  async function executeApprovedChange(project: Project, status: 'completed' | 'failed') {
    const { runtime } = application!;
    const task = await runtime.createTask(ownerId, {
      title: 'Repair the demo', goal: 'Fix the misspelling in src/sum.ts', capabilityId: 'coding.change',
      autonomy: 'assisted', projectId: project.id,
    }, randomUUID());
    expect(task.status).toBe('waiting_approval');
    await runtime.approve(ownerId, task.id);
    await runtime.tick();
    const detail = await runtime.detail(ownerId, task.id);
    expect(detail.task.status).toBe(status);
    expect(detail.modelRuns).toEqual([]);
    return CodingResultSchema.parse(detail.task.result);
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-code-view-')));
    application = await createApplication({
      authSecret: 'coding-view-test-auth-fixture-0001', internalSecret, setupToken, webOrigin: origin,
      production: false, runWorker: false, testRequestLimit: 2000, codingDataDir: directory, browserChannel: null,
      sandboxRunner: {
        available: async () => ({ available: true, provider: 'unit-fixture', message: 'injected test runner' }),
        run: async ({ files }) => {
          sandboxRuns++;
          const source = files.find(file => file.path === 'src/sum.ts')!.content;
          const stdout = source.includes('rightHandVaule') ? REPAIR_DEMO_FAILURE_OUTPUT
            : source.includes('leftHandValue - rightHandValue') ? REPAIR_DEMO_ASSERTION_FAILURE_OUTPUT : REPAIR_DEMO_SUCCESS_OUTPUT;
          return {
            exitCode: stdout === REPAIR_DEMO_SUCCESS_OUTPUT ? 0 : 1, stdout, stderr: '', timedOut: false, durationMs: 1,
            provider: 'unit-fixture', network: 'denied', isolation: 'appcontainer', isolationVerified: true,
            snapshotHash: snapshotHash(files),
          };
        },
      },
    });
    expect((await api('POST', '/api/setup', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await login(owner);
    const access = await api('GET', '/api/access');
    expect(access.json().role).toBe('owner');
    ownerId = access.json().user.id;
    completeProject = await application.coding.demo(ownerId);
    emptyProject = await register('Empty Project', 'empty');
    failingProject = await register('Failing Project', 'broken');
    earlier = await executeApprovedChange(completeProject, 'completed');
    completed = await executeApprovedChange(completeProject, 'completed');
    failed = await executeApprovedChange(failingProject, 'failed');
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('re-verifies the newest matching result and shows its files, diff and manual merge commands', async () => {
    const goal = `show the last change in ${completeProject.name}`;
    const source = join(completeProject.path, 'src', 'sum.ts');
    const original = await readFile(source, 'utf8');
    const beforeRuns = sandboxRuns;
    const detail = await ask(goal);
    const text = detail.messages.at(-1)!.text;
    expect(detail.status).toBe('idle');
    expect(detail.configured).toBe(false);
    expect(text).toContain('Re-verified the saved result');
    expect(text).toContain(`Review branch: \`${completed.branch}\``);
    expect(text).not.toContain(earlier.branch);
    expect(text).toContain('src/sum.ts');
    expect(text).toContain(completed.changes[0]!.beforeHash.slice(0, 7));
    expect(text).toContain(completed.changes[0]!.afterHash.slice(0, 7));
    expect(text).not.toContain(completed.changes[0]!.beforeHash);
    expect(text).not.toContain(completed.changes[0]!.afterHash);
    expect(text).toContain('-  return leftHandValue + rightHandVaule;');
    expect(text).toContain('+  return leftHandValue + rightHandValue;');
    expect(text).toContain(`git merge --ff-only -- ${completed.checkpoint}`);
    expect(sandboxRuns).toBe(beforeRuns);
    expect((await git(completeProject.path, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(completeProject.baseCommit);
    expect(await readFile(source, 'utf8')).toBe(original);
  });

  it('shows a failed task and its diff without showing a branch or merge command', async () => {
    const text = (await ask(`show the last change in ${failingProject.name}`)).messages.at(-1)!.text;
    expect(text.toLowerCase()).toContain('tests failed');
    expect(text).toContain('Re-verified the saved result');
    expect(text).toContain('+  return leftHandValue - rightHandValue;');
    expect(text).not.toContain(failed.branch);
    expect(text).not.toContain('git merge');
  });

  it('says there is no matching task for a registered project', async () => {
    const text = (await ask(`اعرض التعديل الأخير في مشروع ${emptyProject.name}`)).messages.at(-1)!.text;
    expect(text).toContain('لا توجد مهمة تعديل');
    expect(text).toContain(emptyProject.name);
  });

  it('keeps a member on the ordinary chat path and does not query the projects', async () => {
    const invitation = await api('POST', '/api/members/invites', { name: member.name, email: member.email });
    expect(invitation.statusCode).toBe(200);
    const token = new URL(invitation.json().url).hash.replace('#invite=', '');
    expect((await api('POST', '/api/invites/accept', { name: member.name, password: member.password, token }, '')).statusCode).toBe(200);
    const cookie = await login(member);
    expect((await api('GET', '/api/access', undefined, cookie)).json().role).toBe('member');
    const workspace = vi.spyOn(application!.coding, 'workspace');
    try {
      const detail = await ask(`show the last change in ${completeProject.name}`, cookie);
      const text = detail.messages.at(-1)!.text;
      expect(workspace).not.toHaveBeenCalled();
      expect(text).not.toContain(completed.branch);
      expect(text).not.toContain('rightHandVaule');
    } finally {
      workspace.mockRestore();
    }
  });

  async function render(codeChangeView: NonNullable<Parameters<typeof answerCodeChangeView>[1]>['codeChangeView']) {
    return (await answerCodeChangeView(`show the last change in ${completeProject.name}`, {
      inventory: async () => [completeProject], codeChangeView,
    }, ownerId, new AbortController().signal, async () => {}))!.text;
  }

  const renderDiff = (diff: string) => render(async () => ({
    status: 'completed', reverified: true, result: { ...completed, diff, diffHash: digest(diff) },
  }));

  it('keeps the first 120 diff lines and notes the truncation', async () => {
    const lines = ['diff --git a/src/sum.ts b/src/sum.ts', ...Array.from({ length: 124 }, (_, index) => `+line-${index + 2}-end`)];
    const text = await renderDiff(`${lines.join('\n')}\n`);
    const fencedDiff = /^(`{3,}|~{3,})diff\n([\s\S]*?)^\1$/m.exec(text)?.[2];
    expect(fencedDiff?.trimEnd().split('\n')).toEqual(lines.slice(0, 120));
    expect(text).not.toContain('+line-121-end');
    expect(text).toMatch(/(?:truncat|first|limit)[^\n]*120|120[^\n]*(?:truncat|first|limit)/i);
  });

  it('hides credential-like added, removed and context lines without hiding the surrounding diff', async () => {
    const fixtureValue = ['example', 'redaction', 'test', 'string'].join('-');
    const text = await renderDiff([
      'diff --git a/src/sum.ts b/src/sum.ts', '-  return leftHandValue + rightHandVaule;',
      ...['+', '-', ' '].map(prefix => `${prefix}const password = "${fixtureValue}";`),
      '+  return leftHandValue + rightHandValue;', '',
    ].join('\n'));
    expect(text.includes(fixtureValue)).toBe(false);
    expect(text).toContain('-  return leftHandValue + rightHandVaule;');
    expect(text).toContain('+  return leftHandValue + rightHandValue;');
  });

  it('shows the saved result and states that it could not be re-verified when the engine is unavailable', async () => {
    const verify = vi.fn(async () => null);
    const text = await render(readCodeChangeView(application!.runtime, { available: false, verify }));
    expect(verify).not.toHaveBeenCalled();
    expect(text).toContain('The saved result could not be re-verified.');
    expect(text).toContain(completed.branch);
    expect(text).toContain('+  return leftHandValue + rightHandValue;');
  });
});
