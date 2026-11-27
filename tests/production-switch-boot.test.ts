import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error The deployment inventory is a dependency-free JavaScript module.
import { runtimeSwitches } from '../scripts/cloud-linux/runtime-switches.mjs';
import { isolatedE2EEnvironment } from './e2e/isolation.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const entry = join(repository, 'apps', 'server', 'src', 'index.ts');
// Dedicated loopback PostgreSQL fixture convention, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/tests/platform-wave-migrations.test.ts#L81
const postgresUrl = process.env.PLATFORM_MIGRATION_TEST_DATABASE_URL?.trim();
const switches: readonly { name: string; off?: string; on?: string }[] = runtimeSwitches;
const allOff = Object.fromEntries(switches.map(item => [item.name, item.off]));
const activations = switches.flatMap(({ name, on }) => on === undefined ? [] : [[name, on] as const]);
const variants = [
  { name: 'all switches off', enabled: {} },
  ...activations.map(([name, on]) => ({ name, enabled: { [name]: on } })),
  { name: 'all switches on', enabled: Object.fromEntries(activations) },
];
let matrixDirectory: string;

beforeAll(async () => {
  matrixDirectory = await mkdtemp(join(await realpath(tmpdir()), 'mohassan-switch-matrix-'));
  await mkdir(join(matrixDirectory, 'tmp'));
});

afterAll(async () => {
  if (matrixDirectory) await rm(matrixDirectory, { recursive: true, force: true });
});

async function freeLoopbackPort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(error => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('No fixture port'));
        else resolve(address.port);
      });
    });
  });
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function boot(enabled: NodeJS.ProcessEnv, databaseUrl?: string, corruptOcr = false): Promise<void> {
  const directory = await mkdtemp(join(matrixDirectory, 'case-'));
  try {
    // Keep the server's cwd-dependent paths in the fixture while resolving the real tsx loader.
    await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await Promise.all(['home', 'tmp', 'approved-root', 'model-store'].map(name => mkdir(join(directory, name))));
    const port = await freeLoopbackPort();
    const env: NodeJS.ProcessEnv = {
      ...isolatedE2EEnvironment(directory),
      ...allOff,
      ...enabled,
      // Reuse compiled modules across boots. Application data, home and cwd remain case-local.
      TMPDIR: join(matrixDirectory, 'tmp'),
      NODE_COMPILE_CACHE: join(matrixDirectory, 'compile-cache'),
      MOHASSAN_ISOLATED_TEST: 'true',
      SERVER_PORT: String(port),
      MOHASSAN_MODELS_ROOT: join(directory, 'model-store'),
      MOHASSAN_JUDGE_LOG_DIR: join(directory, 'judge'),
      PRODUCTION_METRICS_DIR: join(directory, 'metrics'),
      EXECUTOR_PYTHON: join(directory, 'missing-python'),
      ...(databaseUrl ? { NODE_ENV: 'production', DATABASE_URL: databaseUrl, WEB_ORIGIN: 'https://127.0.0.1' } : {}),
    };
    if (env.MOHASSAN_MODEL_WORKER === '1') {
      const config = join(directory, 'worker.json');
      await writeFile(config, JSON.stringify({ identity: { modelId: 'fixture', tokenizerId: 'fixture', checkpointId: 'fixture' } }));
      env.MOHASSAN_MODEL_WORKER_CONFIG = config;
    }
    if (corruptOcr) {
      const ocr = join(directory, 'ocr');
      await mkdir(ocr);
      await writeFile(join(ocr, 'manifest.json'), '{');
      await writeFile(join(ocr, 'weights.bin'), 'invalid OCR fixture');
      env.MOHASSAN_OCR_MODEL_DIR = ocr;
    }

    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    let closed = false;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    child.on('error', error => { stderr = String(error); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    const ready = new Promise<void>(resolve => {
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout = (stdout + chunk).slice(-8000);
        if (stdout.includes(`Mohassan API ready on port ${port}\n`)) resolve();
      });
    });
    // The optional PostgreSQL fixture has a caller-provided URL. Only report error codes from it.
    const diagnostics = () => databaseUrl ? (stderr.match(/\b(?:FST_ERR|ERR)_[A-Z0-9_]+\b/g) ?? []).join(' ') : stderr || stdout;
    try {
      await within(Promise.race([ready, exited.then(({ code, signal }) => {
        throw new Error(`Server exited (${code ?? signal}) before readiness. ${diagnostics()}`);
      })]), 90_000, () => `Server readiness timed out. ${diagnostics()}`);
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      const health = await response.json();
      expect(health).toMatchObject({ status: 'ok' });
      if (env.MOHASSAN_MODEL_WORKER === '1') {
        expect(health).toHaveProperty('modelWorker.state', expect.stringMatching(/^(starting|degraded)$/));
      }
      expect(child.kill('SIGTERM')).toBe(true);
      const stopped = await within(exited, 10_000, () => `Server did not stop after SIGTERM. ${diagnostics()}`);
      expect(stopped, diagnostics()).toEqual({ code: 0, signal: null });
    } finally {
      if (!closed) {
        child.kill('SIGKILL');
        await within(exited, 5000, () => 'Fixture server did not exit after SIGKILL');
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withPostgresFixture(url: string, run: (url: string) => Promise<void>): Promise<void> {
  const target = URL.parse(url);
  if (!target || !['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1'
      || target.pathname !== '/postgres' || ['host', 'database', 'dbname'].some(key => target.searchParams.has(key))) {
    throw new Error('Use the dedicated loopback PostgreSQL instance and its postgres maintenance database.');
  }
  const { createDatabase, sql } = await import('@mohassan/database');
  const maintenance = await createDatabase({ connectionString: target.href });
  const name = `switch_boot_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await sql`CREATE DATABASE ${sql.id(name)} TEMPLATE template0`.execute(maintenance.db).catch(() => {
      throw new Error('Could not create the isolated PostgreSQL boot database.');
    });
    try {
      target.pathname = `/${name}`;
      await run(target.href);
    } finally {
      await sql`DROP DATABASE ${sql.id(name)}`.execute(maintenance.db).catch(() => {
        throw new Error('Could not drop the isolated PostgreSQL boot database.');
      });
    }
  } finally {
    await maintenance.close();
  }
}

// Startup, shutdown and health responses from the deployed revision, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/index.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/app.ts#L273
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/model-worker.ts#L78-L87
describe.skipIf(process.platform === 'win32')('production switch boot with PGlite', () => {
  it.concurrent.each(variants)('boots with $name', async ({ enabled }) => boot(enabled), 120_000);
  it.concurrent('boots with a corrupt OCR store', async () => boot({}, undefined, true), 120_000);
});

describe.skipIf(process.platform === 'win32' || !postgresUrl)('production switch boot with PostgreSQL', () => {
  it.concurrent.each(variants)('boots with $name in NODE_ENV=production', async ({ enabled }) => {
    await withPostgresFixture(postgresUrl!, url => boot(enabled, url));
  }, 150_000);
});

const variable = /^MOHASSAN_[A-Z0-9_]+$/;
// Sandbox completion messages, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/sandbox/src/index.ts#L310-L323
const sandboxMessages = new Set(['MOHASSAN_BOUNDARY_PROVEN', 'MOHASSAN_NODE_RESTRICTIONS_PROVEN']);

function sourceVariables(file: string, text: string): string[] {
  if (file.endsWith('.py')) return text.match(/\bMOHASSAN_[A-Z0-9_]+\b/g) ?? [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    // Includes alias tables and registry keys whose reads use computed property access.
    if (ts.isIdentifier(node) && variable.test(node.text)) names.add(node.text);
    if (ts.isStringLiteralLike(node) && variable.test(node.text)
        && !(sandboxMessages.has(node.text) && ts.isCallExpression(node.parent))) names.add(node.text);
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      // Sandbox helpers also contain environment reads in embedded child scripts.
      for (const match of node.text.matchAll(/\bprocess\.env(?:\.|\[['"])(MOHASSAN_[A-Z0-9_]+)\b/g)) names.add(match[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (text.includes('this.env[`${flag}_KILL`]')) {
    for (const flag of [...names].filter(name => name.startsWith('MOHASSAN_ARBITER_'))) names.add(`${flag}_KILL`);
  }
  return [...names];
}

it('lists every MOHASSAN environment variable read in server and package sources', async () => {
  const packages = join(repository, 'packages');
  const directories = [join(repository, 'apps', 'server', 'src'), ...
    (await readdir(packages, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => join(packages, item.name, 'src'))];
  const inventory = new Set(switches.map(item => item.name));
  expect(inventory.size).toBe(switches.length);
  const missing: string[] = [];
  for (const directory of directories) {
    const files = await readdir(directory, { recursive: true, withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT' && directory.startsWith(packages)) return [];
      throw error;
    });
    for (const item of files) {
      if (!item.isFile() || !/\.(?:[cm]?[jt]sx?|py)$/.test(item.name)) continue;
      const file = join(item.parentPath, item.name);
      const text = await readFile(file, 'utf8');
      if (!text.includes('MOHASSAN_')) continue;
      for (const name of sourceVariables(file, text)) {
        if (!inventory.has(name)) missing.push(`${name} in ${relative(repository, file)}`);
      }
    }
  }
  expect(missing.sort()).toEqual([]);
});
