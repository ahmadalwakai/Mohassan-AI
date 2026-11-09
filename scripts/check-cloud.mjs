const timeoutMs = 10000;
const maxResponseBytes = 65536;

function configuration() {
  if (process.argv.length > 3) throw new Error('Provide only the backend origin as an optional argument.');
  const input = process.argv[2] || process.env.MOHASSAN_SERVER_URL;
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
  return { target, secret };
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
    const response = await fetch(new URL(pathname, target), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...(secret ? { 'x-mohassan-internal': secret } : {}) },
    });
    status = response.status;
    const body = await readJson(response);
    return { name, ok: status === expectedStatus && verifyBody(body), status, expectedStatus };
  } catch {
    // Response bodies, URLs with credentials, and low-level errors never enter the report.
    return { name, ok: false, ...(status === undefined ? {} : { status }), expectedStatus,
      error: 'REQUEST_OR_RESPONSE_FAILED' };
  }
}

try {
  const { target, secret } = configuration();
  const checks = await Promise.all([
    check(target, 'public-health', '/health', 200, (body) => body?.status === 'ok'),
    check(target, 'internal-auth-required', '/api/setup', 401,
      (body) => body?.error?.code === 'SERVICE_UNAUTHORIZED'),
  ]);
  // Verify the expected service boundary before transmitting its internal credential.
  if (checks.every((result) => result.ok)) {
    checks.push(...await Promise.all([
      check(target, 'production-owner-ready', '/api/setup', 200,
        (body) => body?.needsSetup === false && body?.setupAvailable === false, secret),
      check(target, 'anonymous-session', '/api/auth/get-session', 200, (body) => body === null, secret),
      check(target, 'workspace-session-required', '/api/workspace', 401,
        (body) => body?.error?.code === 'UNAUTHORIZED', secret),
    ]));
  } else {
    for (const name of ['production-owner-ready', 'anonymous-session', 'workspace-session-required']) {
      checks.push({ name, ok: false, skipped: true, reason: 'SERVICE_BOUNDARY_NOT_VERIFIED' });
    }
  }
  const ok = checks.every((result) => result.ok);
  console.log(JSON.stringify({ ok, origin: target.origin, checks }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: 'INVALID_CONFIGURATION', message: error.message }));
  process.exitCode = 1;
}
