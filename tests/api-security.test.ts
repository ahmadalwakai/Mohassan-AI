import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskDetailSchema, TaskSchema, WorkspaceSnapshotSchema, type CreateTaskInput } from '../packages/contracts/src/index.js';
import { createApplication } from '../apps/server/src/app.js';

const webOrigin = 'http://localhost:3000';
const internalSecret = randomBytes(48).toString('hex');
const setupToken = randomBytes(48).toString('hex');
const owner = {
  name: 'مالك الاختبار',
  email: 'owner@example.test',
  password: 'Test-only-owner-password-2026!',
};
const validTask: CreateTaskInput = {
  title: 'فحص تشغيل آمن',
  goal: 'تحقق من سلامة النواة والتخزين دون آثار خارجية.',
  capabilityId: 'system.diagnostic',
  autonomy: 'scoped',
};

describe('control-plane security and authenticated task flow', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let cookie = '';

  const trustedHeaders = () => ({
    'x-mohassan-internal': internalSecret,
    origin: webOrigin,
    ...(cookie ? { cookie } : {}),
  });

  beforeAll(async () => {
    application = await createApplication({
      authSecret: randomBytes(48).toString('hex'),
      internalSecret,
      setupToken,
      webOrigin,
      production: false,
      runWorker: false,
    });
    await application.app.ready();
  });

  afterAll(async () => {
    await application?.app.close();
  });

  it('rejects direct application requests without the internal proxy secret', async () => {
    const response = await application.app.inject({ method: 'GET', url: '/api/workspace' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: expect.any(String), message: expect.any(String) } });
  });

  it('requires an authenticated session even through the trusted proxy', async () => {
    const response = await application.app.inject({
      method: 'GET', url: '/api/workspace', headers: trustedHeaders(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(internalSecret);
    expect(response.body).not.toContain(setupToken);
  });

  it('does not reveal setup secrets in the setup status', async () => {
    const response = await application.app.inject({
      method: 'GET', url: '/api/setup', headers: trustedHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(internalSecret);
    expect(response.body).not.toContain(setupToken);
  });

  it('rejects a validly shaped but incorrect setup token', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/setup', headers: trustedHeaders(),
      payload: { ...owner, setupToken: randomBytes(48).toString('hex') },
    });
    expect(response.statusCode).toBe(403);
    const users = await application.database.db.selectFrom('user').select('id').execute();
    expect(users).toHaveLength(0);
  });

  it('rejects setup from an untrusted origin even with the correct setup token', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/setup',
      headers: { ...trustedHeaders(), origin: 'https://attacker.example' },
      payload: { ...owner, setupToken },
    });
    expect(response.statusCode).toBe(403);
  });

  it('serializes concurrent bootstrap requests and prevents a second owner', async () => {
    const attempts = await Promise.all([0, 1].map(() => application.app.inject({
      method: 'POST', url: '/api/setup', headers: trustedHeaders(), payload: { ...owner, setupToken },
    })));
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const created = attempts.find((response) => response.statusCode === 200)!;
    expect(created.body).not.toContain(owner.password);
    expect(created.body).not.toContain(setupToken);

    const repeated = await application.app.inject({
      method: 'POST', url: '/api/setup', headers: trustedHeaders(),
      payload: { ...owner, email: 'second@example.test', setupToken },
    });
    expect(repeated.statusCode).toBe(409);
    const users = await application.database.db.selectFrom('user').select('id').execute();
    expect(users).toHaveLength(1);
  });

  it('keeps public registration disabled', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/auth/sign-up/email', headers: trustedHeaders(),
      payload: { ...owner, email: 'public@example.test' },
    });
    expect(response.statusCode).toBe(403);
    const users = await application.database.db.selectFrom('user').select('id').execute();
    expect(users).toHaveLength(1);
  });

  it('authenticates through Better Auth and returns the actual owner workspace', async () => {
    const signedIn = await application.app.inject({
      method: 'POST', url: '/api/auth/sign-in/email', headers: trustedHeaders(),
      payload: { email: owner.email, password: owner.password },
    });
    expect(signedIn.statusCode).toBe(200);
    cookie = signedIn.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    expect(cookie).not.toBe('');

    const response = await application.app.inject({
      method: 'GET', url: '/api/workspace', headers: trustedHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const snapshot = WorkspaceSnapshotSchema.parse(response.json());
    expect(snapshot.user.email).toBe(owner.email);
    expect(snapshot.storage).toEqual({ mode: 'embedded', healthy: true });
    expect(snapshot.tasks).toHaveLength(0);
    expect(response.body).not.toContain(owner.password);
  });

  it('rejects authenticated writes from an untrusted origin', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), origin: 'https://attacker.example', 'idempotency-key': randomUUID() },
      payload: validTask,
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects malformed task input before adding work to the queue', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': randomUUID() },
      payload: { ...validTask, title: '', capabilityId: 'shell.execute', command: 'whoami' },
    });
    expect(response.statusCode).toBe(400);
    const tasks = await application.database.db.selectFrom('tasks').select('id').execute();
    expect(tasks).toHaveLength(0);
  });

  it('requires an idempotency key for task creation', async () => {
    const response = await application.app.inject({
      method: 'POST', url: '/api/tasks', headers: trustedHeaders(), payload: validTask,
    });
    expect(response.statusCode).toBe(400);
  });

  it('reuses a task for the same key and rejects changed input under that key', async () => {
    const key = randomUUID();
    const request = {
      method: 'POST' as const, url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': key }, payload: validTask,
    };
    const first = await application.app.inject(request);
    expect(first.statusCode).toBe(200);
    const firstTask = TaskSchema.parse(first.json());
    const repeated = await application.app.inject(request);
    expect(repeated.statusCode).toBe(200);
    expect(TaskSchema.parse(repeated.json()).id).toBe(firstTask.id);

    const conflict = await application.app.inject({ ...request, payload: { ...validTask, goal: 'هدف مختلف لنفس المفتاح.' } });
    expect(conflict.statusCode).toBe(409);
  });

  it('runs and independently verifies an authorized diagnostic and records ordered events', async () => {
    const created = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': randomUUID() }, payload: validTask,
    });
    expect(created.statusCode).toBe(200);
    const task = TaskSchema.parse(created.json());
    await application.runtime.tick();
    // A previous idempotency test also enqueued one safe diagnostic.
    await application.runtime.tick();

    const response = await application.app.inject({
      method: 'GET', url: `/api/tasks/${task.id}`, headers: trustedHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const detail = TaskDetailSchema.parse(response.json());
    expect(detail.task.status).toBe('completed');
    expect(detail.task.result).not.toBeNull();
    expect(detail.task.error).toBeNull();
    expect(detail.events.length).toBeGreaterThanOrEqual(3);
    const sequences = detail.events.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(response.body).not.toContain(internalSecret);
    expect(response.body).not.toContain(setupToken);
  });

  it('holds an assisted task until approval, then executes it', async () => {
    const created = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': randomUUID() },
      payload: { ...validTask, autonomy: 'assisted' },
    });
    expect(created.statusCode).toBe(200);
    const task = TaskSchema.parse(created.json());
    expect(task.status).toBe('waiting_approval');
    await application.runtime.tick();
    const waiting = await application.app.inject({
      method: 'GET', url: `/api/tasks/${task.id}`, headers: trustedHeaders(),
    });
    expect(TaskDetailSchema.parse(waiting.json()).task.status).toBe('waiting_approval');

    const approved = await application.app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/approve`, headers: trustedHeaders(),
    });
    expect(approved.statusCode).toBe(200);
    expect(TaskSchema.parse(approved.json()).status).toBe('queued');
    await application.runtime.tick();
    const completed = await application.app.inject({
      method: 'GET', url: `/api/tasks/${task.id}`, headers: trustedHeaders(),
    });
    expect(TaskDetailSchema.parse(completed.json()).task.status).toBe('completed');
  });

  it('cancels queued work before any tool can run', async () => {
    const created = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': randomUUID() }, payload: validTask,
    });
    const task = TaskSchema.parse(created.json());
    const cancelled = await application.app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/cancel`, headers: trustedHeaders(),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(TaskSchema.parse(cancelled.json()).status).toBe('cancelled');
    await application.runtime.tick();
    const response = await application.app.inject({
      method: 'GET', url: `/api/tasks/${task.id}`, headers: trustedHeaders(),
    });
    const detail = TaskDetailSchema.parse(response.json());
    expect(detail.task.status).toBe('cancelled');
    expect(detail.task.result).toBeNull();
    expect(detail.task.attempt).toBe(0);
  });

  it('does not expose or mutate another owner task', async () => {
    const created = await application.app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { ...trustedHeaders(), 'idempotency-key': randomUUID() },
      payload: { ...validTask, autonomy: 'assisted' },
    });
    const task = TaskSchema.parse(created.json());
    // Fixture a record belonging to another account without enabling public signup.
    await application.database.db.updateTable('tasks').set({ owner_id: 'another-owner' }).where('id', '=', task.id).execute();
    const detail = await application.app.inject({
      method: 'GET', url: `/api/tasks/${task.id}`, headers: trustedHeaders(),
    });
    expect(detail.statusCode).toBe(404);
    for (const action of ['approve', 'cancel']) {
      const response = await application.app.inject({
        method: 'POST', url: `/api/tasks/${task.id}/${action}`, headers: trustedHeaders(),
      });
      expect(response.statusCode).toBe(404);
    }
    const workspace = await application.app.inject({
      method: 'GET', url: '/api/workspace', headers: trustedHeaders(),
    });
    expect(WorkspaceSnapshotSchema.parse(workspace.json()).tasks.some((entry) => entry.id === task.id)).toBe(false);
  });

  it('invalidates the server session on sign-out, including a replayed old cookie', async () => {
    const oldCookie = cookie;
    const signedOut = await application.app.inject({
      method: 'POST', url: '/api/auth/sign-out', headers: trustedHeaders(), payload: {},
    });
    expect(signedOut.statusCode).toBe(200);
    const replayed = await application.app.inject({
      method: 'GET', url: '/api/workspace', headers: { ...trustedHeaders(), cookie: oldCookie },
    });
    expect(replayed.statusCode).toBe(401);
    cookie = '';
  });
});
