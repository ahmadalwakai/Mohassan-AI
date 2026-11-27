import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getModelEntry, modelRegistry } from '../packages/model-relations/src/registry.js';
import { modelStatus } from '../scripts/cloud-linux/preflight-model-stores.js';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const script = join(appRoot, 'scripts/cloud-linux/preflight-wave-6.mjs');
const linuxNode24 = process.platform === 'linux' && process.versions.node.split('.')[0] === '24';
const runtimeAvailable = process.getuid?.() !== 0;
const cutoverCheck = 'new runtime switches are off';
const modelStoreCheck = 'MOHASSAN_MODELS_ROOT is an absolute, readable, service-read-only directory outside the app';
const ocrStoreCheck = 'MOHASSAN_OCR_MODEL_DIR is an absolute, readable, service-read-only directory outside the app';
let scratch: string;

beforeEach(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mohassan-preflight-'))); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function preflight(settings: Record<string, string>, ...flags: string[]) {
  // The baseline matches the cutover contract at https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/docs/DEPLOY-WAVE-6-2026-11-25.md#environment-changes
  // and the local database/HTTPS origin contract at https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/cloud-linux/preflight-wave-6.mjs (retrieved 2026-11-27).
  const env = {
    DATABASE_URL: 'postgresql://127.0.0.1/mohassan',
    WEB_ORIGIN: 'https://example.test',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    INTERNAL_API_SECRET: randomBytes(32).toString('hex'),
    MOHASSAN_MODEL_RELATIONS: 'off', RUN_WORKER: 'false', PRODUCTION_METRICS_ENABLED: 'false',
    ...settings,
  };
  const envFile = join(scratch, 'server.env');
  writeFileSync(envFile, Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 });
  const child = spawnSync(process.execPath, [script, '--env-file', envFile, '--service-user', userInfo().username, ...flags], {
    cwd: appRoot, encoding: 'utf8', timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toContain('OK environment file is private, regular and readable');
  expect(child.stdout).not.toContain(env.BETTER_AUTH_SECRET);
  expect(child.stdout).not.toContain(env.INTERNAL_API_SECRET);
  return child;
}

function protectedEmptyStore() {
  // System directories offer read-only fixtures without requiring root to create an owned store.
  return ['/usr/share', '/usr/lib', '/etc'].map(path => realpathSync(path)).find(path =>
    !existsSync(join(path, 'manifest.json')) && !existsSync(join(path, 'weights.bin')))!;
}

describe.skipIf(!linuxNode24)('Wave 6 preflight CLI', () => {
  it('allows cutover settings, including an unlisted switch explicitly set to off and known non-switch settings', () => {
    const result = preflight({ MOHASSAN_TEST_UNKNOWN_SWITCH: '0', MOHASSAN_JUDGE_LOG_DIR: scratch });
    // Host prerequisites have independent failures on machines without the deployment's Python or Chromium.
    expect(result.stdout).toContain(`OK ${cutoverCheck}`);
  });

  it.each([
    ['MOHASSAN_TEST_UNKNOWN_SWITCH', 'owner'], ['MOHASSAN_MODEL_COUNCIL', 'owner'],
    ['MOHASSAN_MONITOR_CONTEXT_SHADOW', '1'], ['MOHASSAN_ARBITER_MONITOR_CONTEXT', '1'], ['MOHASSAN_ISOLATED_TEST', 'true'],
  ])('rejects %s=%s at cutover', (name, value) => {
    const result = preflight({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${cutoverCheck}`);
  });

  it('requires explicit cutover values and permits the owner profiles together', () => {
    expect(preflight({ RUN_WORKER: '' }).stdout).toContain(`FAIL ${cutoverCheck}`);
    const result = preflight({
      MOHASSAN_MONITORS_ENABLED: 'owner', PRODUCTION_METRICS_ENABLED: 'true', PRODUCTION_METRICS_DIR: scratch,
      RUN_WORKER: 'true', MOHASSAN_MODEL_COUNCIL: 'owner', MOHASSAN_MODEL_WORKER: '1', MOHASSAN_V5_CHAT: 'owner',
    }, '--owner-trial', '--owner-v5', '--owner-council');
    expect(result.stdout).toContain(`OK ${cutoverCheck}`);
    expect(result.stdout).toContain('OK owner-only monitors and production metrics are enabled');
    expect(result.stdout).toContain('OK worker and owner-only v5 chat are enabled');
    expect(result.stdout).toContain('OK owner-only model council is enabled');
    expect(preflight({}, '--owner-council').stdout).toContain('FAIL owner-only model council is enabled');
  });

  it.skipIf(!runtimeAvailable).each([
    ['unconfigured', () => ''], ['relative', () => 'models'], ['missing', () => join(scratch, 'missing')],
    ['service-writable', () => scratch], ['in-app', () => appRoot],
    ['symlink', () => { const link = join(scratch, 'outside'); symlinkSync(protectedEmptyStore(), link); return link; }],
    ['service-owned', () => { const dir = join(scratch, 'read-only'); mkdirSync(dir); chmodSync(dir, 0o555); return dir; }],
  ])('rejects a %s council store as the service user', (_kind, modelRoot) => {
    const result = preflight({ MOHASSAN_MODEL_COUNCIL: 'owner', MOHASSAN_MODELS_ROOT: modelRoot() }, '--owner-council');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('OK runtime uses an unprivileged service account');
    expect(result.stdout).toContain(`FAIL ${modelStoreCheck}`);
  });

  it.skipIf(!runtimeAvailable)('accepts a protected council store and reports every registry entry', () => {
    const result = preflight({ MOHASSAN_MODEL_COUNCIL: 'owner', MOHASSAN_MODELS_ROOT: protectedEmptyStore() }, '--owner-council');
    expect(result.stdout).toContain(`OK ${modelStoreCheck}`);
    const ids = Array.from(result.stdout.matchAll(/model ([\w-]+): (present|absent|hash mismatch)/g), match => match[1]);
    expect(ids.sort()).toEqual(modelRegistry.map(entry => entry.id).sort());
  });

  it.skipIf(!runtimeAvailable).each([
    ['relative', () => 'ocr'], ['missing', () => join(scratch, 'missing')],
    ['service-writable', () => scratch], ['in-app', () => appRoot],
  ])('rejects a configured %s OCR store even without the council profile', (_kind, ocrDirectory) => {
    const result = preflight({ MOHASSAN_OCR_MODEL_DIR: ocrDirectory() });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${ocrStoreCheck}`);
  });

  it.skipIf(!runtimeAvailable)('requires the configured OCR export to be present', () => {
    const result = preflight({ MOHASSAN_OCR_MODEL_DIR: protectedEmptyStore() });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`OK ${ocrStoreCheck}`);
    expect(result.stdout).toContain('FAIL model ocr: absent');
  });
});

it('reports absent, present, and mismatched models using the runtime root order and manifest pins', async () => {
  const entry = getModelEntry('router-b0')!;
  const [manifest, weights] = ['manifest', 'weights'].map(role => entry.artifacts.find(item => item.role === role)!);
  const firstRoot = join(scratch, 'store');
  const secondRoot = join(scratch, 'app');
  const roots = [firstRoot, secondRoot];
  const content = 'synthetic bytes for an integrity check';
  const digest = createHash('sha256').update(content).digest('hex');
  const write = (root: string, path: string, bytes: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };

  await expect(modelStatus(entry, roots, {})).resolves.toBe('absent');
  write(secondRoot, manifest.path, JSON.stringify({ sha256: digest }));
  write(secondRoot, weights.path, content);
  await expect(modelStatus(entry, roots, {})).resolves.toBe('present');
  write(firstRoot, manifest.path, JSON.stringify({ sha256: digest }));
  write(firstRoot, weights.path, `${content} modified`);
  await expect(modelStatus(entry, roots, {})).resolves.toBe('hash mismatch');
  write(firstRoot, manifest.path, '{}');
  await expect(modelStatus(entry, roots, {})).resolves.toBe('hash mismatch');
});

it('reports mismatched OCR weights at the explicitly configured export location', async () => {
  const entry = getModelEntry('ocr')!;
  const root = join(scratch, 'ocr');
  const env = { MOHASSAN_OCR_MODEL_DIR: root };
  const placeholder = 'OCR integrity fixture';
  mkdirSync(root);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ weights: {
    sha256: createHash('sha256').update(placeholder).digest('hex'),
  } }));
  writeFileSync(join(root, 'weights.bin'), `${placeholder} modified`);
  await expect(modelStatus(entry, [appRoot], env)).resolves.toBe('hash mismatch');
});
