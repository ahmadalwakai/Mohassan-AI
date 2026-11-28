import { spawnSync } from 'node:child_process';
import { createECDH, createHash, createPrivateKey } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync,
  realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';

const deploymentEnv = '/etc/mohassan/server.env';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const offByCutover = [
  'MOHASSAN_SMALL_TALK_MANNERS', 'MOHASSAN_CONVERSATION_REVIEW_APPLY', 'MOHASSAN_CONVERSATION_SHADOW',
  'MOHASSAN_STRUCTURED_MEMORY', 'MOHASSAN_EXTRACTIVE_WRITING', 'MOHASSAN_REASONING',
  'MOHASSAN_CLARIFY_CHOICES', 'MOHASSAN_SCRATCH_CLASSIFIERS', 'MOHASSAN_REFUSAL_POLICY',
  'MOHASSAN_QUESTION_REWRITER', 'MOHASSAN_ARITHMETIC_SEARCH', 'MOHASSAN_MODEL_WORKER',
  'MOHASSAN_REPLY_POLICY_ENABLED', 'MOHASSAN_CONTEXT_POLICY_ENABLED', 'MOHASSAN_LONG_RUN_ENABLED',
  'MOHASSAN_BACKGROUND_RESULTS_ENABLED', 'MOHASSAN_ARBITER_ROUTING', 'MOHASSAN_ARBITER_QUESTION_REWRITE',
  'MOHASSAN_ARBITER_LOCAL_COMPUTATION', 'MOHASSAN_ARBITER_COMPOUND_PLAN',
];
const arbiterKills = offByCutover.filter(name => name.startsWith('MOHASSAN_ARBITER_')).map(name => `${name}_KILL`);

function check(label, predicate) {
  let ok = false;
  try { ok = Boolean(predicate()); } catch { /* Child diagnostics and configuration values stay private. */ }
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function serviceCanUseInterpreter(configured) {
  if (!isAbsolute(configured)) return false;
  const python = realpathSync(configured);
  const file = statSync(python);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o6000)) return false;
  accessSync(python, constants.X_OK);
  const readOnly = path => {
    try { accessSync(path, constants.W_OK); return false; }
    catch (error) { return ['EACCES', 'EPERM', 'EROFS'].includes(error.code); }
  };
  if (!readOnly(python)) return false;
  for (let dir = dirname(python); ; dir = dirname(dir)) {
    if (statSync(dir).uid === process.getuid() || !readOnly(dir)) return false;
    if (dir === dirname(dir)) break;
  }
  return spawnSync(python, ['-I', '-B', '-S', '-c', [
    'import ctypes, sys',
    'assert sys.version_info >= (3, 11)',
    'ctypes.CDLL("libseccomp.so.2")',
  ].join('\n')], { env: {}, timeout: 2500, stdio: 'ignore' }).status === 0;
}

function validVapid(subject, publicKey, privateKey) {
  const url = URL.parse(subject ?? '');
  if (!url || url.hash || url.username || url.password) return false;
  if (url.protocol === 'mailto:') {
    if (url.search || !/^[^\s@]+@[^\s@]+$/.test(url.pathname)) return false;
  } else if (url.protocol !== 'https:' || url.hostname === 'localhost') return false;
  const curve = createECDH('prime256v1');
  const secret = Buffer.from(privateKey ?? '', 'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== privateKey) return false;
  curve.setPrivateKey(secret);
  return curve.getPublicKey().toString('base64url') === publicKey;
}

function pinnedModelFile({ path, sha256 }, expectedBytes) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.startsWith('//') || path.includes(':')
    || path.split('/').includes('..')) return false;
  const local = realpathSync(path);
  if (local !== resolve(path) || !relative(appRoot, local).startsWith('../')) return false;
  const fd = openSync(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size !== expectedBytes) return false;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (let length; (length = readSync(fd, buffer)) > 0;) {
      size += length;
      if (size > expectedBytes) return false;
      digest.update(buffer.subarray(0, length));
    }
    return size === expectedBytes && digest.digest('hex') === sha256;
  } finally {
    closeSync(fd);
  }
}

function checkOwnerV5Config(path) {
  let model;
  if (!check('v5 worker config exists with the expected identity and model settings', () => {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 16 * 1024 * 1024) return false;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const expected = JSON.parse(readFileSync(new URL('./model-worker.v5.example.json', import.meta.url), 'utf8'));
    model = config.model;
    // Permit other absolute external artifact locations with the same pins.
    return isDeepStrictEqual(config.identity, expected.identity) && isDeepStrictEqual({
      ...model,
      checkpoint: { ...model.checkpoint, path: expected.model.checkpoint.path },
      tokenizer: { ...model.tokenizer, path: expected.model.tokenizer.path },
    }, expected.model);
  })) return;
  check('v5 checkpoint matches the pinned size and SHA-256', () => pinnedModelFile(model.checkpoint, 1_021_749_913));
  check('v5 tokenizer matches the pinned size and SHA-256', () => pinnedModelFile(model.tokenizer, 284_174));
}

async function runtimeChecks() {
  if (!check('runtime uses an unprivileged service account', () => process.getuid() !== 0)) return;
  const { python, apnsKeyPath, metricsDirectory, v5ConfigPath } = JSON.parse(readFileSync(0, 'utf8'));
  check('trusted Python 3.11+ and libseccomp.so.2 under the service account', () => serviceCanUseInterpreter(python));
  const { chromium } = await import('playwright').catch(() => ({}));
  check('locked Playwright Chromium is installed and executable by the service account', () => {
    const executable = chromium.executablePath();
    accessSync(executable, constants.X_OK);
    return statSync(executable).isFile();
  });
  if (apnsKeyPath) check('APNs signing key is a readable P-256 private key', () => {
    if (!isAbsolute(apnsKeyPath) || !statSync(apnsKeyPath).isFile()) return false;
    const key = createPrivateKey(readFileSync(apnsKeyPath));
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  });
  if (metricsDirectory) check('production metrics directory or its parent is writable by the service account', () => {
    if (!isAbsolute(metricsDirectory)) return false;
    const directory = existsSync(metricsDirectory) ? metricsDirectory : dirname(metricsDirectory);
    accessSync(directory, constants.W_OK | constants.X_OK);
    return statSync(directory).isDirectory();
  });
  if (v5ConfigPath) checkOwnerV5Config(v5ConfigPath);
}

async function preflight() {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string', default: deploymentEnv },
    'service-user': { type: 'string', default: 'mohassan' },
    'owner-trial': { type: 'boolean' },
    'owner-v5': { type: 'boolean' },
    'owner-coding-link': { type: 'boolean' },
  } });
  const envFile = values['env-file'];
  const ownerV5 = values['owner-v5'];
  const ownerCodingLink = values['owner-coding-link'];
  const ownerTrial = values['owner-trial'] || ownerV5;
  if (!check('Linux with Node 24', () => process.platform === 'linux' && process.versions.node.split('.')[0] === '24')) return;
  let env;
  if (!check('environment file is private, regular and readable', () => {
    const file = lstatSync(envFile);
    if (!file.isFile() || file.uid !== (envFile === deploymentEnv ? 0 : process.getuid()) || (file.mode & 0o077)) return false;
    env = parseEnv(readFileSync(envFile, 'utf8'));
    return true;
  })) return;

  check('DATABASE_URL names the local PostgreSQL service', () => {
    const url = URL.parse(env.DATABASE_URL ?? '');
    return url && ['postgresql:', 'postgres:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && (!url.port || url.port === '5432') && url.pathname === '/mohassan' && !url.searchParams.has('host');
  });
  check('WEB_ORIGIN is an HTTPS origin', () => {
    const url = URL.parse(env.WEB_ORIGIN ?? '');
    return url?.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  });
  check('API binds to the loopback listener used by Caddy', () =>
    (env.SERVER_HOST || '127.0.0.1') === '127.0.0.1' && (env.SERVER_PORT || '4000') === '4000');
  for (const name of ['BETTER_AUTH_SECRET', 'INTERNAL_API_SECRET']) {
    check(`${name} is present and at least 32 characters`, () => (env[name]?.trim().length ?? 0) >= 32);
  }
  const inactiveSwitches = [...offByCutover, ...arbiterKills].filter(name => !ownerV5 || name !== 'MOHASSAN_MODEL_WORKER');
  check(ownerV5 ? 'other new runtime switches are off' : 'new runtime switches are off', () =>
    inactiveSwitches.every(name => !env[name] || env[name] === '0')
    && (ownerV5 || !env.MOHASSAN_V5_CHAT || env.MOHASSAN_V5_CHAT === 'off')
    && (ownerCodingLink || !env.CODING_DEVICE_LINK || env.CODING_DEVICE_LINK === 'off')
    && (!env.MOHASSAN_PLAN_COMPILER || env.MOHASSAN_PLAN_COMPILER === 'off')
    && env.MOHASSAN_MODEL_RELATIONS === 'off' && (!env.TEST_DRIVEN_CODING_ENABLED || env.TEST_DRIVEN_CODING_ENABLED === 'false')
    && !env.MOHASSAN_DESKTOP_SHELL && !env.MOHASSAN_ROUTER_SHADOW && !env.EXECUTOR_EXPERIMENT);
  const v5Enabled = ownerV5 && check('worker and owner-only v5 chat are enabled', () =>
    env.MOHASSAN_MODEL_WORKER === '1' && env.MOHASSAN_V5_CHAT === 'owner');
  // The owner's coding device link stays off unless the deploy names it, and then it must be exactly 'owner'.
  if (ownerCodingLink) check('owner coding device link is enabled', () => env.CODING_DEVICE_LINK === 'owner');
  if (!ownerTrial) check('queue worker is off during cutover', () => env.RUN_WORKER === 'false');
  check(ownerTrial ? 'owner-only monitors and production metrics are enabled' : 'monitors and production metrics are off', () =>
    ownerTrial ? env.MOHASSAN_MONITORS_ENABLED === 'owner' && env.PRODUCTION_METRICS_ENABLED === 'true'
      : (!env.MOHASSAN_MONITORS_ENABLED || env.MOHASSAN_MONITORS_ENABLED === '0') && env.PRODUCTION_METRICS_ENABLED === 'false');

  const vapid = [env.WEB_PUSH_VAPID_SUBJECT, env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY];
  if (vapid.some(Boolean)) check('optional VAPID contact and matching signing keys', () => validVapid(...vapid));
  else console.log('OK optional VAPID is unset');
  const apns = [env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_KEY_PATH, env.APNS_BUNDLE_ID].map(value => value?.trim());
  const apnsConfigured = apns.some(Boolean);
  check(apnsConfigured ? 'all optional APNs settings are present' : 'optional APNs is unset', () => !apnsConfigured || apns.every(Boolean));

  const script = fileURLToPath(import.meta.url);
  const args = [process.execPath, script, '--check-runtime'];
  const user = values['service-user'];
  const runtime = user === userInfo().username ? args : ['/usr/sbin/runuser', '-u', user, '--', ...args];
  const child = spawnSync(runtime[0], runtime.slice(1), {
    cwd: appRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/var/lib/mohassan/ms-playwright' },
    input: JSON.stringify({ python: env.TEST_DRIVEN_CODING_PYTHON || '/usr/bin/python3',
      apnsKeyPath: apns.every(Boolean) ? apns[2] : undefined,
      metricsDirectory: ownerTrial ? env.PRODUCTION_METRICS_DIR || '/var/lib/mohassan/production-metrics' : undefined,
      v5ConfigPath: v5Enabled ? resolve(appRoot, env.MOHASSAN_MODEL_WORKER_CONFIG?.trim() || '.data/model-worker.json') : undefined }),
    timeout: v5Enabled ? 120_000 : 10_000, encoding: 'utf8',
  });
  if (child.stdout) process.stdout.write(child.stdout);
  // Runtime diagnostics contain fixed check names. Other stderr may mention private paths.
  check('all service-account runtime checks passed', () => child.status === 0);
}

try {
  await (process.argv[2] === '--check-runtime' ? runtimeChecks() : preflight());
} catch {
  console.error('FAIL unable to complete the preflight');
  process.exitCode = 1;
}
