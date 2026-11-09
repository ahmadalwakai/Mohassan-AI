import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const explicitEnvironment = new Set(Object.keys(process.env));
dotenv.config({ path: path.join(root, '.env'), quiet: true, override: false });

// Host-specific production settings override .env, but never the service environment.
try {
  const settings = dotenv.parse(await readFile(path.join(root, '.data', 'production.env')));
  for (const [key, value] of Object.entries(settings)) {
    if (!explicitEnvironment.has(key)) process.env[key] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Unable to read .data/production.env.');
}

async function existingSecret(variable, filename) {
  let value = process.env[variable]?.trim();
  if (!value) {
    try {
      value = (await readFile(path.join(root, '.data', filename), 'utf8')).trim();
    } catch {
      throw new Error(`Configure ${variable} or restore its existing .data secret file.`);
    }
  }
  if (value.length < 32) throw new Error(`${variable} must contain at least 32 characters.`);
  return value;
}

let webOrigin;
try {
  webOrigin = new URL(process.env.WEB_ORIGIN ?? '');
} catch {
  throw new Error('Configure WEB_ORIGIN with the public HTTPS origin.');
}
if (webOrigin.protocol !== 'https:' || webOrigin.username || webOrigin.password ||
    webOrigin.pathname !== '/' || webOrigin.search || webOrigin.hash) {
  throw new Error('WEB_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment.');
}
if (!process.env.DATABASE_URL?.trim()) throw new Error('Configure DATABASE_URL before starting the production server.');

const env = {
  ...process.env,
  NODE_ENV: 'production',
  WEB_ORIGIN: webOrigin.origin,
  SERVER_HOST: process.env.SERVER_HOST || '127.0.0.1',
  SERVER_PORT: process.env.SERVER_PORT || '4000',
  DATA_DIR: process.env.DATA_DIR || path.join(root, '.data', 'postgres'),
  BETTER_AUTH_SECRET: await existingSecret('BETTER_AUTH_SECRET', 'auth-secret'),
  INTERNAL_API_SECRET: await existingSecret('INTERNAL_API_SECRET', 'server-secret'),
  SETUP_TOKEN: '',
};

const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
let stopping = false;
child.once('error', () => {
  console.error('Unable to start the production API process.');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = stopping ? 0 : (code ?? 1);
});

function stop(signal) {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  stopping = true;
  if (process.platform === 'win32' && child.pid) {
    // Windows does not deliver POSIX signals; terminate this API's process tree.
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => { child.kill(); });
    killer.once('exit', (code) => { if (code && child.exitCode === null) child.kill(); });
  } else {
    child.kill(signal);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
