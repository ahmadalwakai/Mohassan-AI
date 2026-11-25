import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-cloud.mjs', import.meta.url));
const secret = 'cloud-backup-check-fixture-secret-0001';
const session = 'fixture-session=private-test-value';

async function runVerifier(options: {
  status?: object;
  session?: string;
  statusCode?: number;
  serviceBoundary?: boolean;
} = {}) {
  const requests: { path: string | undefined; cookie: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const trusted = request.headers['x-mohassan-internal'] === secret;
    requests.push({ path: request.url, cookie: request.headers.cookie });
    let status = 404;
    let body: unknown = null;
    if (request.url === '/health') {
      status = 200;
      body = { status: 'ok' };
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
    const arguments_ = [script, origin, ...(options.session ? ['--owner-session-stdin'] : [])];
    const output = await new Promise<{ stdout: string; stderr: string; exitCode: number | string }>(resolve => {
      const child = execFile(process.execPath, arguments_, {
        env: { ...process.env, INTERNAL_API_SECRET: secret }, timeout: 15000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error?.code ?? 0 }));
      child.stdin?.end(options.session ? `${options.session}\n` : undefined);
    });
    expect(output.stdout + output.stderr).not.toContain(secret);
    expect(output.stdout + output.stderr).not.toContain(session);
    return { ...output, requests, report: JSON.parse(output.stdout || output.stderr) };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('production verifier backup freshness', () => {
  it('warns on a stale dump and a failed and stale drill without failing the health checks', async () => {
    const result = await runVerifier({ session, status: { newestDump: { ageHours: 26.5 }, lastDrill: { verdict: 'failed', ageHours: 193 } } });
    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      'BACKUP_DUMP_STALE', 'BACKUP_DRILL_FAILED', 'BACKUP_DRILL_STALE',
    ]);
    expect(result.requests.filter(request => request.cookie)).toEqual([{ path: '/api/ops/backup-status', cookie: session }]);
  });

  it('accepts a passing drill and dump exactly at their age limits', async () => {
    const result = await runVerifier({ session, status: { newestDump: { ageHours: 26 }, lastDrill: { verdict: 'passed', ageHours: 8 * 24 } } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([]);
  });

  it.each([
    { verdict: 'failed', ageHours: 1, code: 'BACKUP_DRILL_FAILED' },
    { verdict: 'passed', ageHours: 193, code: 'BACKUP_DRILL_STALE' },
  ])('warns on a $verdict drill aged $ageHours hours', async ({ verdict, ageHours, code }) => {
    const result = await runVerifier({ session, status: { newestDump: { ageHours: 1 }, lastDrill: { verdict, ageHours } } });
    expect(result.exitCode).toBe(0);
    expect(result.report.warnings).toEqual([expect.objectContaining({ code })]);
  });

  it('warns when the recorded backup and drill are missing', async () => {
    const result = await runVerifier({ session, status: { newestDump: null, lastDrill: null } });
    expect(result.report.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      'BACKUP_DUMP_MISSING', 'BACKUP_DRILL_MISSING',
    ]);
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
