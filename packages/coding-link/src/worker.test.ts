import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as coding from '@mohassan/coding';
import {
  CodingFinishedResultSchema, CodingJobSchema, CodingPairRequestSchema, CodingPollRequestSchema, CodingProgressSchema,
  type CodingJobKind, type CodingJobPayloads, type CodingPollRequest,
} from './protocol.js';
import { postCodingDeviceJson, runCodingDevice } from './worker.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mohassan-coding-link-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const allowed = join(directory, 'allowed');
  const outside = join(directory, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  return { allowed, outside, dataDir: join(directory, 'data') };
}

function runner(run: coding.SandboxRunner['run'] = async () => { throw new Error('Unexpected sandbox call.'); }) {
  return {
    available: vi.fn(async () => ({ available: true, provider: 'fixture-sandbox', message: 'Fixture sandbox is available' })),
    run: vi.fn(run),
  } satisfies coding.SandboxRunner;
}

function task<K extends CodingJobKind>(kind: K, payload: CodingJobPayloads[K], durationMs = 10_000) {
  return CodingJobSchema.parse({ id: randomUUID(), kind, payload, deadlineAt: new Date(Date.now() + durationMs).toISOString() });
}

async function device(options: Pick<Parameters<typeof runCodingDevice>[0], 'dataDir' | 'allowedRoots' | 'sandbox'>,
  handle: (poll: CodingPollRequest, request: IncomingMessage) => { status?: number; job?: unknown; cancel?: string[] }) {
  const credentials = { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') };
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
      const poll = CodingPollRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      expect(request.url).toBe('/api/coding/device/poll');
      expect(request.headers.origin).toBeUndefined();
      expect(Object.keys(request.headers).some(header => header.startsWith('sec-fetch-'))).toBe(false);
      expect(request.headers.authorization).toBe(`Bearer ${credentials.deviceId}.${credentials.deviceKey}`);
      if (poll.result) {
        expect(request.headers['x-coding-device-job']).toBe(CodingFinishedResultSchema.parse(poll.result).jobId);
        expect(request.headers['x-coding-device-nonce']).toBe(poll.nonce);
        expect(request.headers['x-coding-device-sent-at']).toBe(poll.sentAt);
      }
      const { status = 200, job = null, cancel = [] } = handle(poll, request);
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ job, cancel }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Device fixture has no port.');
  const abort = new AbortController();
  const worker = runCodingDevice({ ...options, ...credentials, serverUrl: `http://127.0.0.1:${address.port}`,
    signal: abort.signal, pollIntervalMs: 100, onStatus: status => statuses.push(status),
  });
  cleanup.push(async () => {
    abort.abort();
    await worker;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(errors).toEqual([]);
  });
  return { statuses, worker };
}

describe('coding device worker trust boundary', () => {
  it('denies outside, traversal, and junction or symlink paths before project inspection or sandbox execution', async () => {
    const { allowed, outside, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(outside);
    const link = join(allowed, 'through-link');
    await symlink(project.path, link, process.platform === 'win32' ? 'junction' : 'dir');
    const inspect = vi.spyOn(coding, 'inspectProject');
    const sandbox = runner();
    const paths = [project.path, `${allowed}${sep}..${sep}outside${sep}repair-demo-project`, link];
    const jobs = paths.map(path => task('inspect', { path }));
    const results: unknown[] = [];
    let dispatched = 0;
    await device({ dataDir, allowedRoots: [allowed], sandbox }, poll => {
      if (poll.result) results.push(poll.result);
      return { job: poll.activeJobId ? null : jobs[dispatched++] ?? null };
    });
    await vi.waitFor(() => expect(results).toEqual(jobs.map(job => ({
      jobId: job.id, status: 'failed', code: 'CODING_DEVICE_PATH_DENIED',
    }))), { timeout: 5_000 });
    expect(inspect).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(sandbox.available).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown job kinds and extra command fields without reading the project', async () => {
    const { allowed, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(allowed);
    const inspect = vi.spyOn(coding, 'inspectProject');
    const sandbox = runner();
    const job = task('inspect', { path: project.path });
    const unsafe = [{ ...job, kind: 'shell' }, { ...job, payload: { path: project.path, command: 'git status' } }];
    let requested = 0;
    const connection = await device({ dataDir, allowedRoots: [allowed], sandbox }, () => ({ job: unsafe[requested++] ?? null }));
    await vi.waitFor(() => expect(connection.statuses).toEqual(['offline', 'online']), { timeout: 5_000 });
    expect(inspect).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it('backs off while offline, accepts a valid inspect once and stops on an unauthorized poll', async () => {
    const { allowed, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(allowed);
    const inspect = vi.spyOn(coding, 'inspectProject');
    const sandbox = runner();
    const job = task('inspect', { path: project.path });
    const attempts: { at: number; nonce: string }[] = [];
    const results: unknown[] = [];
    let afterResult = 0;
    const connection = await device({ dataDir, allowedRoots: [allowed], sandbox }, poll => {
      attempts.push({ at: Date.now(), nonce: poll.nonce });
      if (attempts.length < 3) return { status: 503 };
      if (poll.result) results.push(poll.result);
      return results.length && ++afterResult >= 3 ? { status: 401 } : { job };
    });
    await connection.worker;
    expect(connection.statuses).toEqual(['offline', 'online', 'revoked']);
    expect(attempts[2]!.at - attempts[1]!.at).toBeGreaterThanOrEqual(350);
    expect(new Set(attempts.map(attempt => attempt.nonce)).size).toBe(attempts.length);
    expect(results).toMatchObject([{ jobId: job.id, status: 'succeeded', value: { path: project.path, baseCommit: project.baseCommit } }]);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(sandbox.available).toHaveBeenCalledTimes(1);
  });

  it.each(['server cancellation', 'deadline'] as const)('aborts an active sandbox job on %s', async reason => {
    const { allowed, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(allowed);
    let cleaning = false;
    const sandbox = runner(async ({ signal }) => new Promise((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => {
        cleaning = true;
        setTimeout(() => { cleaning = false; reject(signal.reason); }, 300);
      }, { once: true });
    }));
    const job = task('check', { project: { id: randomUUID(), ownerId: 'owner', name: 'Demo project', ...project,
      createdAt: new Date().toISOString() } }, reason === 'deadline' ? 4_000 : undefined);
    let dispatched = false;
    let polledDuringCleanup = false;
    const results: unknown[] = [];
    await device({ dataDir, allowedRoots: [allowed], sandbox }, poll => {
      if (poll.result) results.push(poll.result);
      if (!dispatched && poll.status.sandbox.available) { dispatched = true; return { job }; }
      if (cleaning) {
        polledDuringCleanup = true;
        expect(poll.activeJobId).toBe(job.id);
        expect(poll.result).toBeNull();
      }
      return reason === 'server cancellation' && poll.activeJobId && sandbox.run.mock.calls.length > 0 ? { cancel: [job.id] } : {};
    });
    await vi.waitFor(() => expect(results).toEqual([{ jobId: job.id, status: 'cancelled', code: 'CODING_DEVICE_CANCELLED' }]), { timeout: 8_000 });
    expect(sandbox.run).toHaveBeenCalledTimes(1);
    expect(sandbox.run.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(sandbox.available).toHaveBeenCalledTimes(1);
    expect(polledDuringCleanup).toBe(true);
  });

  it('reports a failed job and re-probes only after the sandbox fails', async () => {
    const { allowed, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(allowed);
    const sandbox = runner(async () => { throw new coding.CodingError('SANDBOX_UNAVAILABLE', 'Fixture sandbox failed.'); });
    sandbox.available.mockResolvedValueOnce({ available: true, provider: 'fixture-sandbox', message: 'Fixture ready.' })
      .mockResolvedValueOnce({ available: false, provider: 'fixture-sandbox', message: 'Fixture no longer ready.' });
    const job = task('check', { project: { id: randomUUID(), ownerId: 'owner', name: 'Demo project', ...project,
      createdAt: new Date().toISOString() } });
    let dispatched = false;
    const results: unknown[] = [];
    const ready: boolean[] = [];
    await device({ dataDir, allowedRoots: [allowed], sandbox }, poll => {
      ready.push(poll.status.sandbox.available);
      if (poll.result) results.push(poll.result);
      if (!dispatched && poll.status.sandbox.available) { dispatched = true; return { job }; }
      return {};
    });
    await vi.waitFor(() => expect(results).toEqual([{ jobId: job.id, status: 'failed', code: 'SANDBOX_UNAVAILABLE' }]), { timeout: 5_000 });
    expect(ready).toContain(true);
    expect(ready.at(-1)).toBe(false);
    expect(sandbox.available).toHaveBeenCalledTimes(2);
  });

  it('sends a bounded failure when a full engine result would exceed the poll body limit', async () => {
    const { allowed, dataDir } = await setup();
    const project = await coding.createRepairDemoProject(allowed);
    // JSON escaping can exceed the wire limit even with valid per-field sandbox output lengths.
    const output = '\u0001'.repeat(65_536);
    const sandbox = runner(async request => ({
      exitCode: 0, stdout: output, stderr: output, timedOut: false, durationMs: 0, provider: 'fixture-sandbox',
      network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: coding.snapshotHash(request.files),
    }));
    const job = task('execute', { goal: 'Fix the checked failure', taskId: randomUUID(),
      project: { id: randomUUID(), ownerId: 'owner', name: 'Demo project', ...project, createdAt: new Date().toISOString() } }, 25_000);
    let dispatched = false;
    const results: unknown[] = [];
    await device({ dataDir, allowedRoots: [allowed], sandbox }, poll => {
      if (poll.result) results.push(poll.result);
      if (!dispatched && poll.status.sandbox.available) { dispatched = true; return { job }; }
      return {};
    });
    await vi.waitFor(() => expect(results).toEqual([{ jobId: job.id, status: 'failed', code: 'CODING_DEVICE_RESULT_TOO_LARGE' }]), { timeout: 20_000 });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });
});

describe('coding device protocol', () => {
  it('limits pair fields, rejects caller-provided commands or paths, and permits deterministic progress only', () => {
    expect(CodingPairRequestSchema.safeParse({ code: randomBytes(12).toString('base64url'), name: 'a'.repeat(81) }).success).toBe(false);
    expect(CodingJobSchema.safeParse({ ...task('demo', { ownerId: 'owner' }), payload: { ownerId: 'owner', path: '/tmp' } }).success).toBe(false);
    const progress = { jobId: randomUUID(), seq: 1, stage: 'edits_requested', message: 'Model progress.' };
    expect(CodingProgressSchema.safeParse(progress).success).toBe(false);
    expect(CodingProgressSchema.safeParse({ ...progress, stage: 'repair_requested', message: 'a'.repeat(1_201) }).success).toBe(false);
  });

  it('rejects plaintext remote URLs before sending any device credentials', () => {
    expect(() => postCodingDeviceJson('http://192.0.2.1', '/api/coding/device/poll', '{}', { authorization: 'Bearer example' }))
      .toThrow('The coding device needs HTTPS');
  });
});
