import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-cloud.mjs', import.meta.url));
const secret = 'cloud-backup-check-fixture-secret-0001';
const session = 'fixture-session=private-test-value';
const shortWorkerDeadline = `data:text/javascript,${encodeURIComponent(`
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = milliseconds => timeout(milliseconds === 60_000 ? 500 : milliseconds);
`)}`;

function copyDownloadedHoursAgo(ageHours: number) {
  return { downloadedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString() };
}

function freshBackupStatus() {
  return {
    newestDump: { ageHours: 1 },
    lastDrill: { verdict: 'passed', ageHours: 1 },
    offServerCopy: copyDownloadedHoursAgo(1),
  };
}

async function runVerifier(options: {
  status?: object;
  session?: string;
  statusCode?: number;
  serviceBoundary?: boolean;
  expectModelWorker?: boolean;
  workerStates?: (string | undefined)[];
  shortenWorkerDeadline?: boolean;
  hangOnWorkerPoll?: boolean;
} = {}) {
  const requests: { path: string | undefined; cookie: string | undefined }[] = [];
  let healthRequests = 0;
  const server = createServer((request, response) => {
    const trusted = request.headers['x-mohassan-internal'] === secret;
    requests.push({ path: request.url, cookie: request.headers.cookie });
    let status = 404;
    let body: unknown = null;
    if (request.url === '/health') {
      const state = options.workerStates?.[healthRequests] ?? options.workerStates?.at(-1);
      healthRequests += 1;
      if (options.hangOnWorkerPoll && healthRequests > 1) return;
      status = 200;
      body = { status: 'ok', ...(state === undefined ? {} : { modelWorker: { state } }) };
    } else if (request.url === '/api/setup') {
      status = trusted || options.serviceBoundary === false ? 200 : 401;
      body = trusted ? { needsSetup: false, setupAvailable: false } : { error: { code: 'SERVICE_UNAUTHORIZED' } };
    } else if (request.url === '/api/auth/get-session' && trusted) {
      status = 200;
    } else if (request.url === '/api/workspace' && trusted) {
      status = 401;
      body = { error: { code: 'UNAUTHORIZED' } };
    } else if (request.url === '/api/ops/backup-status' && trusted && request.headers.cookie === session) {
      status = options.statusCode ?? 200;
      body = options.status;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    const arguments_ = [
      ...(options.shortenWorkerDeadline ? ['--import', shortWorkerDeadline] : []),
      script, origin, ...(options.session ? ['--owner-session-stdin'] : []),
      ...(options.expectModelWorker ? ['--expect-model-worker'] : []),
    ];
    const output = await new Promise<{ stdout: string; stderr: string; exitCode: number | string }>(resolve => {
      const child = execFile(process.execPath, arguments_, {
        env: { ...process.env, INTERNAL_API_SECRET: secret }, timeout: 15000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error?.code ?? 0 }));
      child.stdin?.end(options.session ? `${options.session}\n` : undefined);
    });
    expect(output.stdout + output.stderr).not.toContain(secret);
    expect(output.stdout + output.stderr).not.toContain(session);
    return { ...output, requests, healthRequests, report: JSON.parse(output.stdout || output.stderr) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('production verifier backup freshness', () => {
  it('warns on a stale dump and a failed and stale drill without failing the health checks', async () => {
    const result = await runVerifier({ session, status: {
      ...freshBackupStatus(), newestDump: { ageHours: 26.5 }, lastDrill: { verdict: 'failed', ageHours: 193 },
    } });
    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      'BACKUP_DUMP_STALE', 'BACKUP_DRILL_FAILED', 'BACKUP_DRILL_STALE',
    ]);
    expect(result.requests.filter(request => request.cookie)).toEqual([{ path: '/api/ops/backup-status', cookie: session }]);
  });

  it('accepts a passing drill and dump exactly at their age limits', async () => {
    const result = await runVerifier({ session, status: {
      ...freshBackupStatus(), newestDump: { ageHours: 26 }, lastDrill: { verdict: 'passed', ageHours: 8 * 24 },
    } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([]);
  });

  it.each([
    { verdict: 'failed', ageHours: 1, code: 'BACKUP_DRILL_FAILED' },
    { verdict: 'passed', ageHours: 193, code: 'BACKUP_DRILL_STALE' },
  ])('warns on a $verdict drill aged $ageHours hours', async ({ verdict, ageHours, code }) => {
    const result = await runVerifier({ session, status: { ...freshBackupStatus(), lastDrill: { verdict, ageHours } } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([expect.objectContaining({ code })]);
  });

  it('warns when the recorded backup and drill are missing', async () => {
    const result = await runVerifier({ session, status: { ...freshBackupStatus(), newestDump: null, lastDrill: null } });
    expect(result.report.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      'BACKUP_DUMP_MISSING', 'BACKUP_DRILL_MISSING',
    ]);
  });

  it.each([
    { label: 'missing', copy: null },
    { label: 'omitted', copy: undefined },
    { label: 'invalid', copy: { downloadedAt: 'invalid' } },
    { label: 'future-dated', copy: copyDownloadedHoursAgo(-1) },
  ])('warns when the verified off-server receipt is $label', async ({ copy }) => {
    const result = await runVerifier({ session, status: { ...freshBackupStatus(), offServerCopy: copy } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([expect.objectContaining({ code: 'BACKUP_OFF_SERVER_COPY_MISSING' })]);
  });

  it('warns when the off-server download is stale', async () => {
    const result = await runVerifier({ session, status: { ...freshBackupStatus(), offServerCopy: copyDownloadedHoursAgo(27) } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([expect.objectContaining({
      code: 'BACKUP_OFF_SERVER_COPY_STALE', ageHours: expect.closeTo(27),
    })]);
  });

  it('reports missing owner access and refuses to send the owner session without a verified service boundary', async () => {
    const absent = await runVerifier();
    expect(absent.exitCode).toBe(0);
    expect(absent.report.warnings).toEqual([expect.objectContaining({ code: 'BACKUP_STATUS_OWNER_SESSION_REQUIRED' })]);
    expect(absent.requests.some(request => request.path === '/api/ops/backup-status')).toBe(false);
    const rejected = await runVerifier({ session, statusCode: 401, status: {} });
    expect(rejected.exitCode).toBe(0);
    expect(rejected.report.warnings).toEqual([expect.objectContaining({ code: 'BACKUP_STATUS_UNAVAILABLE' })]);
    const untrusted = await runVerifier({ session, serviceBoundary: false });
    expect(untrusted.exitCode).toBe(1);
    expect(untrusted.requests.some(request => request.cookie)).toBe(false);
  });
});

describe('production verifier model worker readiness', () => {
  it('preserves health checks when worker readiness is not requested', async () => {
    const result = await runVerifier({ workerStates: ['degraded'] });
    expect(result.exitCode).toBe(0);
    expect(result.healthRequests).toBe(1);
    expect(result.report.checks).not.toContainEqual(expect.objectContaining({ name: 'model-worker-ready' }));
  });

  it('waits for the worker to become ready', async () => {
    const result = await runVerifier({
      session, status: freshBackupStatus(), expectModelWorker: true, workerStates: ['starting', 'starting', 'ready'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.healthRequests).toBe(3);
    expect(result.report.checks).toContainEqual({ name: 'model-worker-ready', ok: true, state: 'ready' });
    expect(result.requests.filter(request => request.cookie)).toEqual([{ path: '/api/ops/backup-status', cookie: session }]);
  });

  it.each(['failed', 'degraded'])('fails immediately when the worker is %s', async state => {
    const result = await runVerifier({ expectModelWorker: true, workerStates: [state] });
    expect(result.exitCode).toBe(1);
    expect(result.healthRequests).toBe(2);
    expect(result.report.checks).toContainEqual({ name: 'model-worker-ready', ok: false, state, error: 'MODEL_WORKER_FAILED' });
  });

  it('fails on timeout when the worker remains starting', async () => {
    const result = await runVerifier({ expectModelWorker: true, workerStates: ['starting'], shortenWorkerDeadline: true });
    expect(result.exitCode).toBe(1);
    expect(result.report.checks).toContainEqual({
      name: 'model-worker-ready', ok: false, state: 'starting', error: 'MODEL_WORKER_TIMEOUT',
    });
  });

  it('aborts an in-flight worker poll at the overall deadline', async () => {
    const result = await runVerifier({ expectModelWorker: true, hangOnWorkerPoll: true, shortenWorkerDeadline: true });
    expect(result.exitCode).toBe(1);
    expect(result.healthRequests).toBe(2);
    expect(result.report.checks).toContainEqual({ name: 'model-worker-ready', ok: false, error: 'MODEL_WORKER_TIMEOUT' });
  });
});
