import { spawnSync } from 'node:child_process';
import { createECDH, createHash, createPrivateKey } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync,
  realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { runtimeSwitches } from './runtime-switches.mjs';

const deploymentEnv = '/etc/mohassan/server.env';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const switchNames = new Set(runtimeSwitches.map(({ name }) => name));
const inactiveValues = new Set(runtimeSwitches.filter(item => item.kind === 'switch' && item.off).map(item => item.off));
const defaultOcrDirectory = runtimeSwitches.find(({ name }) => name === 'MOHASSAN_OCR_MODEL_DIR').default;

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
  const { python, apnsKeyPath, metricsDirectory, v5ConfigPath, ownerCouncil, modelEnv } = JSON.parse(readFileSync(0, 'utf8'));
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
  const ocrDirectory = modelEnv.MOHASSAN_OCR_MODEL_DIR ?? join(appRoot, defaultOcrDirectory);
  const ocrEnabled = Boolean(modelEnv.MOHASSAN_OCR_MODEL_DIR) ||
    (existsSync(join(ocrDirectory, 'manifest.json')) && existsSync(join(ocrDirectory, 'weights.bin')));
  if (ownerCouncil || ocrEnabled) {
    const { tsImport } = await import('tsx/esm/api');
    const { checkModelStores } = await tsImport('./preflight-model-stores.ts', import.meta.url);
    await checkModelStores(appRoot, modelEnv, ownerCouncil, ocrEnabled ? ocrDirectory : undefined, check);
  }
}

function checkSwitchProfiles(env, { ownerTrial, ownerV5, ownerCouncil }) {
  const unexpected = [];
  const trial = [];
  const v5 = [];
  const council = [];
  for (const item of runtimeSwitches.filter(({ kind }) => kind === 'switch')) {
    const actual = env[item.name] || undefined;
    if (ownerV5 && item.ownerV5 !== undefined) v5.push(actual === item.ownerV5);
    else if (ownerCouncil && item.ownerCouncil !== undefined) council.push(actual === item.ownerCouncil);
    else if (ownerTrial && item.ownerTrial === null) continue;
    else if (ownerTrial && item.ownerTrial !== item.production) trial.push(actual === item.ownerTrial);
    else if (actual !== item.production && !item.allowed?.includes(actual) && (item.required || actual !== undefined)) {
      unexpected.push(item.name);
    }
  }
  const unlisted = Object.entries(env).some(([name, value]) =>
    name.startsWith('MOHASSAN_') && !switchNames.has(name) && value && !inactiveValues.has(value));
  const valid = check('new runtime switches are off', () => unexpected.length === 0 && !unlisted);
  if (!valid && unexpected.length) console.log(`Unexpected switches: ${unexpected.join(', ')}`);
  if (unlisted) console.log('An unlisted MOHASSAN_* variable is enabled');
  if (ownerTrial) check('owner-only monitors and production metrics are enabled', () => trial.every(Boolean));
  if (ownerCouncil) check('owner-only model council is enabled', () => council.every(Boolean));
  return ownerV5 && check('worker and owner-only v5 chat are enabled', () => v5.every(Boolean));
}

async function preflight() {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string', default: deploymentEnv },
    'service-user': { type: 'string', default: 'mohassan' },
    'owner-trial': { type: 'boolean' },
    'owner-v5': { type: 'boolean' },
    'owner-council': { type: 'boolean' },
  } });
  const envFile = values['env-file'];
  const ownerV5 = values['owner-v5'];
  const ownerTrial = values['owner-trial'] || ownerV5;
  const ownerCouncil = values['owner-council'];
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
  const v5Enabled = checkSwitchProfiles(env, { ownerTrial, ownerV5, ownerCouncil });

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
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', TSX_DISABLE_CACHE: '1',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/var/lib/mohassan/ms-playwright' },
    input: JSON.stringify({ python: env.TEST_DRIVEN_CODING_PYTHON || '/usr/bin/python3',
      apnsKeyPath: apns.every(Boolean) ? apns[2] : undefined,
      metricsDirectory: ownerTrial ? env.PRODUCTION_METRICS_DIR || '/var/lib/mohassan/production-metrics' : undefined,
      v5ConfigPath: v5Enabled ? resolve(appRoot, env.MOHASSAN_MODEL_WORKER_CONFIG?.trim() || '.data/model-worker.json') : undefined,
      ownerCouncil: Boolean(ownerCouncil),
      // Registry path overrides only. Authentication and database settings remain in the caller.
      // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/model-relations/src/registry.ts (retrieved 2026-11-27).
      modelEnv: { MOHASSAN_MODELS_ROOT: env.MOHASSAN_MODELS_ROOT, MOHASSAN_OCR_MODEL_DIR: env.MOHASSAN_OCR_MODEL_DIR,
        MOHASSAN_MODEL_WORKER_CONFIG: env.MOHASSAN_MODEL_WORKER_CONFIG, EXECUTOR_CHECKPOINT: env.EXECUTOR_CHECKPOINT,
        ADS_MODEL_RUN: env.ADS_MODEL_RUN, ADS_CHAT_FINETUNE: env.ADS_CHAT_FINETUNE } }),
    timeout: ownerCouncil || v5Enabled ? 120_000 : 10_000, encoding: 'utf8',
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
