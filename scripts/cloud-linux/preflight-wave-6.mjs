import { spawnSync } from 'node:child_process';
import { createECDH, createPrivateKey } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const deploymentEnv = '/etc/mohassan/server.env';
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

async function runtimeChecks() {
  if (!check('runtime uses an unprivileged service account', () => process.getuid() !== 0)) return;
  const { python, apnsKeyPath, metricsDirectory } = JSON.parse(readFileSync(0, 'utf8'));
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
}

async function preflight() {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string', default: deploymentEnv },
    'service-user': { type: 'string', default: 'mohassan' },
    'owner-trial': { type: 'boolean' },
  } });
  const envFile = values['env-file'];
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
  check('new runtime switches are off', () => [...offByCutover, ...arbiterKills].every(name => !env[name] || env[name] === '0')
    && (!env.MOHASSAN_PLAN_COMPILER || env.MOHASSAN_PLAN_COMPILER === 'off')
    && env.MOHASSAN_MODEL_RELATIONS === 'off' && (!env.TEST_DRIVEN_CODING_ENABLED || env.TEST_DRIVEN_CODING_ENABLED === 'false')
    && !env.MOHASSAN_DESKTOP_SHELL && !env.MOHASSAN_ROUTER_SHADOW && !env.EXECUTOR_EXPERIMENT);
  if (!values['owner-trial']) check('queue worker is off during cutover', () => env.RUN_WORKER === 'false');
  check(values['owner-trial'] ? 'owner-only monitors and production metrics are enabled' : 'monitors and production metrics are off', () =>
    values['owner-trial'] ? env.MOHASSAN_MONITORS_ENABLED === 'owner' && env.PRODUCTION_METRICS_ENABLED === 'true'
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
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/var/lib/mohassan/ms-playwright' },
    input: JSON.stringify({ python: env.TEST_DRIVEN_CODING_PYTHON || '/usr/bin/python3',
      apnsKeyPath: apns.every(Boolean) ? apns[2] : undefined,
      metricsDirectory: values['owner-trial'] ? env.PRODUCTION_METRICS_DIR || '/var/lib/mohassan/production-metrics' : undefined }),
    timeout: 10_000, encoding: 'utf8',
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
