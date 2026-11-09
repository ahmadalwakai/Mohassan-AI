/** Trusted E2E infrastructure only. No application configuration is imported. */
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const prefix = 'mohassan-e2e-owned-';
export type E2EFixture = { directory: string; webDirectory: string; environment: NodeJS.ProcessEnv; cleanup(): Promise<void> };

/** Allowlist, not a spread of the parent's credentials/options/proxies/roots. */
export function isolatedE2EEnvironment(directory: string, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = ambient.SystemRoot || ambient.SYSTEMROOT || ambient.WINDIR;
  const home = path.join(directory, 'home');
  return {
    NODE_ENV: 'development', NODE_OPTIONS: '', NODE_PATH: '', NODE_EXTRA_CA_CERTS: '',
    PATH: [path.dirname(process.execPath), ...(systemRoot ? [path.join(systemRoot, 'System32'), systemRoot] : ['/usr/bin', '/bin'])].join(path.delimiter),
    ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'), TMPDIR: path.join(directory, 'tmp'),
    // Installed browser binaries are read-only dependencies, never profiles or credentials.
    PLAYWRIGHT_BROWSERS_PATH: process.platform === 'win32' ? path.join(homedir(), 'AppData', 'Local', 'ms-playwright') : path.join(homedir(), '.cache', 'ms-playwright'),
    NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', CI: '1',
    MOHASSAN_ISOLATED_TEST: 'true', MOHASSAN_E2E_ROOT: directory,
    DATA_DIR: path.join(directory, 'database'), DATABASE_URL: '',
    CODING_DATA_DIR: path.join(directory, 'coding'), CODING_ALLOWED_ROOTS: path.join(directory, 'approved-root'),
    STUDIO_AI_DATA_DIR: path.join(directory, 'studio-ai'), BROWSER_PROFILE_DIR: path.join(directory, 'browser-profile'),
    STUDIO_GATEWAY_URL: '', STUDIO_GATEWAY_SECRET: '', GROQ_API_KEY: '', MOHASSAN_LIVE_GROQ_KEY: '',
    SKILL_ENGINE_ENABLED: 'true', RUN_WORKER: 'true', WINDOWS_REMOTE_ENABLED: 'true',
    WEB_ORIGIN: 'http://127.0.0.1:3100', SERVER_PORT: '4100', SERVER_HOST: '127.0.0.1', PORT: '3100',
    MOHASSAN_SERVER_URL: 'http://127.0.0.1:4100',
    BETTER_AUTH_SECRET: 'browser-test-auth-secret-isolated-fixture-0001',
    INTERNAL_API_SECRET: 'browser-test-internal-secret-isolated-0001',
    SETUP_TOKEN: 'browser-test-setup-token-isolated-fixture-0001',
  };
}

export async function createE2EFixture(sourceWeb = path.join(repository, 'apps', 'web')): Promise<E2EFixture> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, prefix));
  const canonical = await realpath(directory);
  const webDirectory = path.join(directory, 'web');
  const environment = isolatedE2EEnvironment(directory);
  const link = path.join(webDirectory, 'node_modules');
  let linked = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix)
      || (await lstat(directory)).isSymbolicLink() || await realpath(directory) !== canonical) throw new Error('E2E_CLEANUP_PATH_CHANGED');
    // Remove the dependency junction itself before recursively deleting our copy.
    if (linked) { if (!(await lstat(link)).isSymbolicLink()) throw new Error('E2E_DEPENDENCY_LINK_CHANGED'); await unlink(link); linked = false; }
    await rm(directory, { recursive: true, force: false, maxRetries: 4, retryDelay: 200 });
    cleaned = true;
  };
  try {
    await Promise.all(['web', 'home', 'home/AppData/Local', 'home/AppData/Roaming', 'tmp', 'approved-root'].map(name => mkdir(path.join(directory, name), { recursive: true })));
    // Copy only application source/configuration. Never follow source symlinks.
    const allowed = ['app', 'components', 'hooks', 'lib', 'public', 'styles', 'next.config.ts', 'package.json', 'tsconfig.json', 'next-env.d.ts', 'AGENTS.md'];
    for (const name of allowed) {
      const source = path.join(sourceWeb, name);
      try { await lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await cp(source, path.join(webDirectory, name), { recursive: true, filter: async candidate => {
        const base = path.basename(candidate);
        if (base === 'node_modules' || base.startsWith('.env') || base === '.git' || base.startsWith('.next')) return false;
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error('E2E_SOURCE_LINK_NOT_ALLOWED');
        return true;
      } });
    }
    await symlink(path.join(repository, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true;
    return { directory, webDirectory, environment, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createServer();
    socket.once('error', () => reject(new Error(`E2E_PORT_IN_USE:${port}`)));
    socket.listen({ port, host: '127.0.0.1', exclusive: true }, () => socket.close(error => error ? reject(error) : resolve()));
  });
}

export type OwnedChild = { child: ChildProcess; closed: Promise<void>; hasClosed(): boolean };
export function spawnOwned(args: string[], cwd: string, env: NodeJS.ProcessEnv, ipc = false): OwnedChild {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'inherit', 'inherit'] });
  let finished = false;
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => { finished = true; resolve(); });
  });
  void closed.catch(() => {});
  return { child, closed, hasClosed: () => finished };
}

async function forceOwnedTree(owned: OwnedChild): Promise<void> {
  if (owned.hasClosed()) return;
  const pid = owned.child.pid;
  if (!pid) { await owned.closed; return; }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => code === 0 || owned.hasClosed() ? resolve() : reject(new Error('E2E_CHILD_TREE_STOP_FAILED')));
    });
  } else owned.child.kill('SIGTERM');
  await Promise.race([owned.closed, delay(10_000, undefined, {ref:false}).then(() => { throw new Error('E2E_CHILD_EXIT_NOT_CONFIRMED'); })]);
}

/** Caller must await this before touching the owned directories. */
export async function stopOwnedChildren(children: OwnedChild[]): Promise<void> {
  for (const owned of children) if (!owned.hasClosed() && owned.child.connected) owned.child.send({ type: 'e2e.shutdown' });
  await Promise.all(children.map(async owned => {
    if (owned.child.connected) await Promise.race([owned.closed, delay(8_000, undefined, {ref:false})]);
    await forceOwnedTree(owned);
    await owned.closed;
  }));
}

export async function startIsolatedE2E(): Promise<{ directory: string; stop(): Promise<void> }> {
  // Never reuse, kill, or contact an existing local server on these fixture ports.
  await requireFreePort(4100); await requireFreePort(3100);
  const fixture = await createE2EFixture();
  const children: OwnedChild[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { await stopOwnedChildren(children); await fixture.cleanup(); })();
  const ready = async (url: string, child: OwnedChild, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child.hasClosed()) throw new Error('E2E_CHILD_EXITED_BEFORE_READY');
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { await response.body?.cancel(); if(!child.hasClosed())return; }
        else await response.body?.cancel();
      } catch { /* Owned service is still starting. */ }
      await delay(200);
    }
    throw new Error('E2E_READINESS_TIMEOUT');
  };
  try {
    const api = spawnOwned(['--import', pathToFileURL(path.join(repository, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, path.join(repository, 'tests', 'e2e', 'server-entry.ts')], fixture.directory, fixture.environment, true);
    children.push(api);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('E2E_API_READY_TIMEOUT')),180_000);
      api.child.once('message',message=>{clearTimeout(timer);const receipt=message as {type?:string;root?:string};if(receipt.type==='e2e.ready'&&receipt.root===fixture.directory)resolve();else reject(new Error('E2E_API_READY_INVALID'));});
      void api.closed.then(()=>{clearTimeout(timer);reject(new Error('E2E_API_EXITED_BEFORE_READY'));},reject);
    });
    await ready('http://127.0.0.1:4100/health', api, 5000);
    const web = spawnOwned([path.join(repository, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3100'], fixture.webDirectory, fixture.environment);
    children.push(web);
    await ready('http://127.0.0.1:3100/api/setup', web, 120_000);
    console.log(`Isolated E2E ready: ${fixture.directory}`);
    return { directory: fixture.directory, stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error,cleanupError],'E2E_START_AND_CLEANUP_FAILED'); }
    throw error;
  }
}
