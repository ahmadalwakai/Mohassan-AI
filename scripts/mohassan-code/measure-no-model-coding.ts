/**
 * Measures the chat's coding route with no chat model (docs/MOHASSAN-CODE-2026-11-27.md).
 *
 * Fixed set, written before either arm ran (2026-11-27): the same 10 requests (9 coding requests and one control
 * question), no chat model, the demo project registered, and a sandbox stub that fails the tests while src/sum.ts
 * still has its misspelling. Each request runs in a fresh conversation; an approval card is approved once. Records the
 * first reply, the final reply and the time per request. The real AppContainer sandbox is not exercised.
 *
 * Usage: npx tsx scripts/mohassan-code/measure-no-model-coding.ts [checkout] [out.json]
 * `checkout` (default: the current directory) is the repository to measure, so one copy of this file measures a base
 * checkout too. That checkout needs its own installed node_modules.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkoutArgument, out] = process.argv.slice(2);
const checkout = resolve(checkoutArgument ?? process.cwd());
const { createApplication } = await import(pathToFileURL(join(checkout, 'apps/server/src/app.ts')).href);
const { snapshotHash } = await import(pathToFileURL(join(checkout, 'packages/coding/src/index.ts')).href);

const REQUESTS = [
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
];

const directory = await mkdtemp(join(tmpdir(), 'mohassan-measure-coding-'));
const secret = 'measure-coding-fixture-internal-secret-01', origin = 'http://127.0.0.1:3000';
const headers = { 'x-mohassan-internal': secret, origin };
const application = await createApplication({
  authSecret: 'measure-coding-fixture-auth-secret-000001', internalSecret: secret, setupToken: 'measure-coding-fixture-setup-token-001', webOrigin: origin,
  production: false, runWorker: true, testRequestLimit: 2000, codingDataDir: directory, codingAllowedRoots: [directory], browserChannel: null,
  sandboxRunner: {
    available: async () => ({ available: true, provider: 'unit-fixture', message: 'measurement stub' }),
    run: async (request: { files: { path: string; content: string }[] }) => ({
      exitCode: request.files.some(file => file.path === 'src/sum.ts' && file.content.includes('rightHandVaule')) ? 1 : 0,
      stdout: 'measurement stub', stderr: '', timedOut: false, durationMs: 1, provider: 'unit-fixture',
      network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(request.files),
    }),
  },
});
let cookie = '';
const api = (method: 'GET' | 'POST', url: string, payload?: unknown) => application.app.inject({ method, url, headers: { ...headers, cookie }, ...(payload === undefined ? {} : { payload }) });
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function settled(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const detail = (await api('GET', `/api/chat/conversations/${id}`)).json();
    if (detail.status !== 'running') return detail;
    // 150 ms keeps 300 polls under the harness's own request limit.
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
  const rows: Record<string, unknown>[] = [];
  for (const goal of REQUESTS) {
    const started = Date.now();
    const first = await settled((await application.chat.create(ownerId, { goal })).id);
    const row: Record<string, unknown> = { goal, first: first.status, firstText: first.messages?.at(-1)?.text?.slice(0, 160) ?? null };
    if (first.status === 'waiting_approval' && first.approval) {
      await api('POST', `/api/chat/conversations/${first.id}/approve`, { approvalId: first.approval.id, approved: true });
      const done = await settled(first.id);
      row.final = done.status;
      row.finalText = done.messages?.at(-1)?.text?.slice(0, 300) ?? null;
    }
    row.ms = Date.now() - started;
    rows.push(row);
  }
  const tasks = (await application.runtime.snapshot(ownerId)).tasks.map((task: { capabilityId: string; status: string }) => `${task.capabilityId}:${task.status}`);
  if (out) await writeFile(out, JSON.stringify({ rows, tasks }, null, 1));
  console.log(JSON.stringify(rows.map(row => [row.goal, row.first, row.final ?? '-', row.ms]), null, 0));
  console.log(tasks.join(' '));
} finally {
  await application.app.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
