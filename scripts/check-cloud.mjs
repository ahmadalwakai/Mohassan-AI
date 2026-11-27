import { setTimeout as delay } from 'node:timers/promises';

const timeoutMs = 10000;
const maxResponseBytes = 65536;
const maxCookieBytes = 8192;
// Both the dump and the off-server pull are scheduled daily (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/backup-pull/README.md#schedule-the-pull
const dailyBackupLimitHours = 26;
const drillLimitHours = 8 * 24;
// Match the permanent worker's startup timeout (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/execution-integration/src/permanent-worker.ts#L79
const modelWorkerTimeoutMs = 60_000;
const modelWorkerPollMs = 1_000;
const modelWorkerStates = ['starting', 'ready', 'degraded', 'failed', 'stopping', 'stopped'];

async function configuration() {
  let origin, readOwnerSession = false, expectModelWorker = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === '--owner-session-stdin' && !readOwnerSession) {
      readOwnerSession = true;
    } else if (argument === '--expect-model-worker' && !expectModelWorker) {
      expectModelWorker = true;
    } else if (!origin && !argument.startsWith('-')) {
      origin = argument;
    } else {
      throw new Error('Usage: check-cloud.mjs [backend-origin] [--owner-session-stdin] [--expect-model-worker].');
    }
  }
  const input = origin || process.env.MOHASSAN_SERVER_URL;
  if (!input) throw new Error('Provide the backend origin or set MOHASSAN_SERVER_URL.');
  let target;
  try { target = new URL(input); } catch { throw new Error('The backend origin is not a valid URL.'); }
  const loopback = target.hostname === 'localhost' || target.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash ||
      !(target.protocol === 'https:' || (target.protocol === 'http:' && loopback))) {
    throw new Error('Use an HTTPS origin without credentials, path, query, or fragment; HTTP is allowed only on loopback.');
  }
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < 32 || /[\r\n]/.test(secret)) {
    throw new Error('Set INTERNAL_API_SECRET in the process environment to a valid service secret.');
  }
  return { target, secret, expectModelWorker, ownerSession: readOwnerSession ? await readOwnerCookie() : null };
}

async function readOwnerCookie() {
  const parts = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxCookieBytes) throw new Error('The owner session Cookie header is too large.');
    parts.push(chunk);
  }
  const cookie = Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
  if (!/^[\x20-\x7e]+$/.test(cookie) || !cookie.includes('=')) {
    throw new Error('Provide a single owner session Cookie header value on stdin.');
  }
  return cookie;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new Error('RESPONSE_TOO_LARGE');
      }
      parts.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function check(target, name, pathname, expectedStatus, verifyBody, secret) {
  let status;
  try {
    const response = await get(target, pathname, secret ? { 'x-mohassan-internal': secret } : {});
    status = response.status;
    const body = await readJson(response);
    return { name, ok: status === expectedStatus && verifyBody(body), status, expectedStatus };
  } catch {
    // Response bodies, URLs with credentials, and low-level errors never enter the report.
    return { name, ok: false, ...(status === undefined ? {} : { status }), expectedStatus,
      error: 'REQUEST_OR_RESPONSE_FAILED' };
  }
}

function get(target, pathname, headers, signal = AbortSignal.timeout(timeoutMs)) {
  return fetch(new URL(pathname, target), {
    method: 'GET', redirect: 'error', signal,
    headers: { accept: 'application/json', ...headers },
  });
}

async function checkModelWorker(target) {
  const name = 'model-worker-ready';
  const deadline = AbortSignal.timeout(modelWorkerTimeoutMs);
  let state;
  while (!deadline.aborted) {
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]);
      const response = await get(target, '/health', {}, signal);
      const body = await readJson(response);
      if (response.status === 200 && body?.status === 'ok') {
        const reportedState = body.modelWorker?.state;
        state = modelWorkerStates.includes(reportedState) ? reportedState : undefined;
        if (state === 'ready') return { name, ok: true, state };
        if (state === 'failed' || state === 'degraded') {
          return { name, ok: false, state, error: 'MODEL_WORKER_FAILED' };
        }
      }
    } catch {
      // Retry transient health errors within the same deadline without logging response details.
    }
    await delay(modelWorkerPollMs, undefined, { signal: deadline }).catch(() => {});
  }
  return { name, ok: false, state, error: 'MODEL_WORKER_TIMEOUT' };
}

function hasAge(value) {
  return Number.isFinite(value?.ageHours) && value.ageHours >= 0;
}

async function backupWarnings(target, secret, ownerSession) {
  if (!ownerSession) {
    return [{ code: 'BACKUP_STATUS_OWNER_SESSION_REQUIRED', message: 'Use --owner-session-stdin to verify backup freshness.' }];
  }
  const unavailable = [{ code: 'BACKUP_STATUS_UNAVAILABLE', message: 'Could not read backup status with the supplied owner session.' }];
  try {
    const response = await get(target, '/api/ops/backup-status', { 'x-mohassan-internal': secret, cookie: ownerSession });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable;
    }
    const body = await readJson(response);
    const dump = body?.newestDump;
    const drill = body?.lastDrill;
    if ((dump !== null && !hasAge(dump)) ||
        (drill !== null && !(hasAge(drill) && ['passed', 'failed'].includes(drill.verdict)))) return unavailable;
    const warnings = [];
    if (!dump) {
      warnings.push({ code: 'BACKUP_DUMP_MISSING', message: 'No completed backup is recorded.' });
    } else if (dump.ageHours > dailyBackupLimitHours) {
      warnings.push({ code: 'BACKUP_DUMP_STALE', message: 'The newest dump is older than 26 hours.', ageHours: dump.ageHours });
    }
    if (!drill) {
      warnings.push({ code: 'BACKUP_DRILL_MISSING', message: 'No restore drill is recorded.' });
    } else {
      if (drill.verdict === 'failed') warnings.push({ code: 'BACKUP_DRILL_FAILED', message: 'The last restore drill failed.' });
      if (drill.ageHours > drillLimitHours) {
        warnings.push({ code: 'BACKUP_DRILL_STALE', message: 'The last restore drill is older than 8 days.', ageHours: drill.ageHours });
      }
    }
    const copy = body?.offServerCopy;
    const downloadedAt = typeof copy?.downloadedAt === 'string' ? Date.parse(copy.downloadedAt) : NaN;
    const ageHours = (Date.now() - downloadedAt) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) {
      warnings.push({ code: 'BACKUP_OFF_SERVER_COPY_MISSING', message: 'No verified off-server backup receipt is recorded.' });
    } else if (ageHours > dailyBackupLimitHours) {
      warnings.push({ code: 'BACKUP_OFF_SERVER_COPY_STALE', message: 'The last verified off-server download is older than 26 hours.', ageHours });
    }
    return warnings;
  } catch {
    return unavailable;
  }
}

try {
  const { target, secret, ownerSession, expectModelWorker } = await configuration();
  let warnings = [];
  const checks = await Promise.all([
    check(target, 'public-health', '/health', 200, (body) => body?.status === 'ok'),
    check(target, 'internal-auth-required', '/api/setup', 401,
      (body) => body?.error?.code === 'SERVICE_UNAUTHORIZED'),
  ]);
  // Verify the expected service boundary before transmitting its internal credential.
  if (checks.every((result) => result.ok)) {
    const modelWorkerCheck = expectModelWorker ? checkModelWorker(target) : null;
    checks.push(...await Promise.all([
      check(target, 'production-owner-ready', '/api/setup', 200,
        (body) => body?.needsSetup === false && body?.setupAvailable === false, secret),
      check(target, 'anonymous-session', '/api/auth/get-session', 200, (body) => body === null, secret),
      check(target, 'workspace-session-required', '/api/workspace', 401,
        (body) => body?.error?.code === 'UNAUTHORIZED', secret),
    ]));
    warnings = await backupWarnings(target, secret, ownerSession);
    if (modelWorkerCheck) checks.push(await modelWorkerCheck);
  } else {
    const skippedChecks = ['production-owner-ready', 'anonymous-session', 'workspace-session-required'];
    if (expectModelWorker) skippedChecks.push('model-worker-ready');
    for (const name of skippedChecks) {
      checks.push({ name, ok: false, skipped: true, reason: 'SERVICE_BOUNDARY_NOT_VERIFIED' });
    }
  }
  const ok = checks.every((result) => result.ok);
  console.log(JSON.stringify({ ok, origin: target.origin, checks, warnings }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: 'INVALID_CONFIGURATION', message: error.message }));
  process.exitCode = 1;
}
