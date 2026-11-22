import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, lstatSync, watch } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';

const FORMAT = 'mohassan-brain-test-snapshot-v1';
const META = '.data/brain-test-run';
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const sha = text => createHash('sha256').update(text).digest('hex');
const slash = path => path.replaceAll('\\', '/');
const exists = path => access(path).then(() => true, () => false);

function inside(base, target, allowEqual = false) {
  const part = relative(resolve(base), resolve(target));
  return (allowEqual || Boolean(part)) && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
function contained(base, target, allowEqual = false) {
  if (!inside(base, target, allowEqual)) throw new Error(`Snapshot target escapes its owned directory: ${target}`);
  return target;
}
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path)
      || /^[a-z]:/iu.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid relative source path: ${path}`);
  return path;
}
function excluded(path) {
  const parts = slash(path).toLowerCase().split('/');
  if (parts.some(part => part === '.env' || part.startsWith('.env.'))) return 'environment-file';
  if (parts.some(part => ['.git', '.data', 'node_modules', '.venv-execution', '__pycache__'].includes(part))) return 'private-or-shared-runtime';
  if (['artifacts', 'coverage', 'test-results', 'playwright-report'].includes(parts[0])) return 'generated-or-explicitly-shared';
  return null;
}
async function ownedDirectory(base, path) {
  contained(base, path, true);
  let current = base;
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error(`Owned snapshot directory is not a plain directory: ${current}`);
    if (!info) await mkdir(current);
    if (!inside(base, await realpath(current), true)) throw new Error(`Owned snapshot directory resolves outside its boundary: ${current}`);
  }
  return path;
}
function command(executable, args, cwd, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false,
    maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed (${result.status ?? result.error?.code}): ${(result.stderr || result.error?.message || '').slice(0, 1500)}`);
  return result.stdout;
}
function git(args, root, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/iu.test(key)));
  return command('git', ['-c', 'core.fsmonitor=false', ...args], root, { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, ...options });
}
function gitHead(root) {
  try { return git(['rev-parse', '--verify', 'HEAD'], root).trim(); } catch { return null; }
}
async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function mapBounded(items, work, concurrency = 8) {
  const results = Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index = cursor++; index < items.length; index = cursor++) results[index] = await work(items[index], index);
  }));
  return results;
}
function contentFingerprint(files) { return sha(JSON.stringify(files.map(({ path, hash, mode }) => ({ path, hash, mode })))); }
async function inventory(root) {
  const listed = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean))].sort();
  const omitted = listed.flatMap(path => excluded(path) ? [{ path, reason: excluded(path) }] : []);
  const paths = listed.filter(path => !excluded(path)).map(safeRelative);
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw new Error('Case-colliding source paths cannot form a Windows snapshot.');
  const files = (await mapBounded(paths, async path => {
    const absolute = contained(root, resolve(root, ...path.split('/')));
    const info = await lstat(absolute, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) return null; // A tracked deletion is represented by its absence.
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source entry must be an ordinary file; links/submodules are not silently followed: ${path}`);
    const actual = await realpath(absolute);
    if (!inside(root, actual) || excluded(slash(relative(root, actual)))) throw new Error(`Source file resolves outside ordinary repository source: ${path}`);
    const hash = await hashFile(absolute);
    const after = await stat(absolute, { bigint: true });
    if (info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) throw new Error(`Source changed while hashing: ${path}`);
    return { path, hash, size: String(info.size), mode: Number(info.mode) & 0o777,
      mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
  })).filter(Boolean);
  return { head: gitHead(root), files, omitted, fingerprint: contentFingerprint(files) };
}
function inventoriesMatch(before, after) {
  return before.head === after.head && JSON.stringify(before.files) === JSON.stringify(after.files)
    && JSON.stringify(before.omitted) === JSON.stringify(after.omitted);
}
function sourceWatcher(root) {
  const events = new Set();
  let failure = null;
  // Watch source directories themselves, not the ignored snapshot/dependency
  // trees. A recursive root watcher can overflow while this very tool copies a
  // snapshot below .data and lose the attribution needed for a safe decision.
  const directories = new Set([root]);
  for (const path of git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(path => path && !excluded(path))) {
    safeRelative(path);
    for (let parent = dirname(resolve(root, ...path.split('/'))); inside(root, parent); parent = dirname(parent)) directories.add(parent);
  }
  const watchers = [];
  try {
    for (const directory of directories) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Source watcher directory is not ordinary source: ${directory}`);
      const prefix = slash(relative(root, directory));
      const watcher = watch(directory, { recursive: false }, (_type, name) => {
        if (!name) { failure = 'The source watcher returned an unattributable change.'; return; }
        const path = [prefix, slash(String(name))].filter(Boolean).join('/');
        if (!excluded(path)) {
          events.add(path);
          if (events.size > 10_000) failure = 'The source watcher exceeded its bounded event inventory.';
        }
      });
      watcher.on('error', error => { failure = `Source watcher failed: ${error.message}`; });
      watchers.push(watcher);
    }
  } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
  return {
    close: () => { for (const watcher of watchers) watcher.close(); },
    async changes() {
      await sleep(150); // Drain OS notifications that were queued during the hash/copy pass.
      if (failure) throw new Error(failure);
      const paths = [...events];
      if (!paths.length) return [];
      const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: root, input: paths.join('\0') + '\0',
        encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      if (ignored.error || ![0, 1].includes(ignored.status)) throw new Error('Could not classify source watcher events against Git ignore policy.');
      const ignoredSet = new Set(ignored.stdout.split('\0').filter(Boolean));
      return paths.filter(path => !ignoredSet.has(path));
    },
  };
}
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'w' }); }

async function workspaceDirectories(root) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const patterns = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : packageJson.workspaces?.packages ?? [];
  const directories = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !/^[\w.-]+\/\*$/u.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = join(root, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(parent, entry.name);
      if (await exists(join(path, 'package.json'))) directories.push(path);
    }
  }
  return directories;
}
async function directoryLink(target, destination) { await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); }
async function dependencies(source, snapshot) {
  const links = [], workspaces = [];
  const sourceWorkspaces = await workspaceDirectories(snapshot);
  for (const path of sourceWorkspaces) {
    const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    const exportsRoot = typeof metadata.exports === 'string' ? metadata.exports : metadata.exports?.['.'];
    workspaces.push({ name: metadata.name, path: slash(relative(snapshot, path)), rootExport: typeof exportsRoot === 'string' ? exportsRoot : null });
  }
  async function packageLink(original, destination, name) {
    const target = await realpath(original);
    const part = slash(relative(source, target));
    let actual = target;
    if (inside(source, target) && !part.split('/').includes('node_modules')) {
      if (excluded(part)) throw new Error(`Dependency points at excluded source data: ${name}`);
      actual = contained(snapshot, resolve(snapshot, ...part.split('/')));
      if (!await exists(actual)) throw new Error(`Workspace dependency is absent from snapshot: ${name}`);
    } else if (name.startsWith('@mohassan/')) throw new Error(`Mohassan dependency was not mapped to snapshot source: ${name}`);
    await directoryLink(actual, destination);
    const packageFile = join(actual, 'package.json');
    links.push({ name, path: slash(relative(snapshot, destination)), target: actual, shared: !inside(snapshot, actual),
      packageJsonHash: await exists(packageFile) ? await hashFile(packageFile) : null });
  }
  async function nodeModules(original, destination) {
    if (!await exists(original)) return;
    await ownedDirectory(snapshot, destination);
    for (const entry of await readdir(original, { withFileTypes: true })) {
      const from = join(original, entry.name), to = join(destination, entry.name);
      if (entry.name === '.bin') {
        await ownedDirectory(snapshot, to);
        for (const bin of await readdir(from, { withFileTypes: true })) {
          const input = join(from, bin.name), output = contained(snapshot, join(to, bin.name));
          if ((await lstat(input)).isSymbolicLink()) {
            const target = await realpath(input);
            if (inside(source, target) && excluded(slash(relative(source, target))) && !slash(relative(source, target)).split('/').includes('node_modules')) throw new Error(`Dependency command points to private source data: ${bin.name}`);
            const logical = inside(source, target) ? contained(snapshot, resolve(snapshot, relative(source, target))) : target;
            await symlink(logical, output, 'file');
          } else if (bin.isFile()) {
            const text = await readFile(input, 'utf8');
            const livePrefixes = [source, slash(source), source.replaceAll('\\', '\\\\')].map(value => value.toLowerCase());
            if (livePrefixes.some(prefix => text.toLowerCase().includes(prefix))) throw new Error(`Command shim contains an absolute live-repository path: ${bin.name}`);
            await copyFile(input, output);
          }
          else throw new Error(`Unexpected dependency command entry: ${input}`);
        }
      } else if (entry.name.startsWith('.')) {
        if (entry.isFile() && entry.name === '.package-lock.json') await copyFile(from, to);
        // Vite/Vitest caches are intentionally recreated inside the snapshot.
      } else if (entry.name.startsWith('@')) {
        await ownedDirectory(snapshot, to);
        for (const scoped of await readdir(from, { withFileTypes: true })) await packageLink(join(from, scoped.name), join(to, scoped.name), `${entry.name}/${scoped.name}`);
      } else if (entry.isFile()) await copyFile(from, to);
      else await packageLink(from, to, entry.name);
    }
  }
  await nodeModules(join(source, 'node_modules'), join(snapshot, 'node_modules'));
  for (const workspace of workspaces) await nodeModules(join(source, workspace.path, 'node_modules'), join(snapshot, workspace.path, 'node_modules'));
  for (const workspace of workspaces.filter(item => item.name?.startsWith('@mohassan/'))) {
    const link = join(snapshot, 'node_modules', ...workspace.name.split('/'));
    if (!await exists(link)) {
      await ownedDirectory(snapshot, dirname(link));
      const target = join(snapshot, workspace.path);
      await directoryLink(target, link);
      links.push({ name: workspace.name, path: slash(relative(snapshot, link)), target, shared: false,
        packageJsonHash: await hashFile(join(target, 'package.json')), addedLocalWorkspaceAlias: true });
    }
    if (await exists(link) && await realpath(link) !== await realpath(join(snapshot, workspace.path))) throw new Error(`Workspace alias resolves outside its snapshot: ${workspace.name}`);
  }
  return { links, workspaces, note: 'Third-party dependency bytes are shared junctions; Mohassan source and command wrappers belong to this snapshot.' };
}

export function snapshotTestEnvironment(snapshot, inherited = process.env) {
  const allowed = new Set(['systemroot', 'windir', 'programdata', 'temp', 'tmp', 'userprofile', 'home', 'localappdata', 'appdata', 'comspec', 'pathext', 'lang', 'lc_all', 'number_of_processors', 'processor_architecture', 'playwright_browsers_path']);
  const environment = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'));
  const originalPath = Object.entries(inherited).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  environment.PATH = [dirname(process.execPath), join(snapshot, 'node_modules', '.bin'), originalPath].filter(Boolean).join(delimiter);
  Object.assign(environment, { NODE_ENV: 'test', MOHASSAN_ISOLATED_TEST: 'true', DATABASE_URL: '', RUN_WORKER: 'false', MOHASSAN_ROUTER_SHADOW: '0' });
  return environment;
}

export async function verifySnapshotResolution(snapshot, dependencyManifest) {
  if (!dependencyManifest.workspaces.length) return [];
  const checks = dependencyManifest.workspaces.map(workspace => ({ ...workspace,
    alias: join(snapshot, 'node_modules', ...workspace.name.split('/')) }));
  const script = `import{realpathSync}from'node:fs';const checks=JSON.parse(process.argv[1]);console.log(JSON.stringify(checks.map(item=>({name:item.name,path:realpathSync(item.alias),resolved:item.rootExport?import.meta.resolve(item.name):null}))));`;
  const output = command(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(checks)], snapshot,
    { env: snapshotTestEnvironment(snapshot) });
  const results = JSON.parse(output);
  for (const result of results) {
    if (!inside(snapshot, result.path)) throw new Error(`Child module alias escapes snapshot: ${result.name}`);
    if (result.resolved && (!result.resolved.startsWith('file:') || !inside(snapshot, fileURLToPath(result.resolved)))) throw new Error(`Child import resolves live source: ${result.name}`);
  }
  return results;
}

async function pinTree(path) {
  const files = [];
  async function visit(current, prefix) {
    if (prefix.split('/').some(part => part.toLowerCase() === '.data' || part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))) {
      throw new Error(`Explicit shared input contains private runtime data: ${current}`);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Explicit shared input contains an unpinned link: ${current}`);
    if (info.isFile()) files.push({ path: prefix || '.', hash: await hashFile(current), size: info.size });
    else if (info.isDirectory()) for (const entry of (await readdir(current)).sort()) await visit(join(current, entry), prefix ? `${prefix}/${entry}` : entry);
    else throw new Error(`Unsupported shared input: ${current}`);
  }
  await visit(path, '');
  return { files, fingerprint: sha(JSON.stringify(files)) };
}
async function sharedInputs(source, snapshot, artifactPaths, shareVenv) {
  const artifacts = [];
  for (const item of artifactPaths) {
    const path = safeRelative(slash(item));
    if (!path.startsWith('artifacts/') || path.split('/').some(part => part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))) throw new Error(`Only explicit non-private artifacts may be shared: ${path}`);
    const original = contained(source, resolve(source, ...path.split('/')));
    const target = await realpath(original);
    if (!inside(join(source, 'artifacts'), target)) throw new Error(`Shared artifact escapes artifacts: ${path}`);
    const pin = await pinTree(target);
    const destination = contained(snapshot, resolve(snapshot, ...path.split('/')));
    await ownedDirectory(snapshot, dirname(destination));
    const materialization = (await stat(target)).isDirectory() ? 'shared-directory' : 'copied-file';
    if (materialization === 'shared-directory') await directoryLink(target, destination);
    else {
      await copyFile(target, destination);
      if ((await pinTree(destination)).fingerprint !== pin.fingerprint) throw new Error(`Artifact copy changed: ${path}`);
    }
    artifacts.push({ path, target, materialization, ...pin });
  }
  let venv = { shared: false, sourceIsolation: 'not-present' };
  const originalVenv = join(source, '.venv-execution');
  if (shareVenv && await exists(originalVenv)) {
    const target = await realpath(originalVenv);
    await directoryLink(target, contained(snapshot, join(snapshot, '.venv-execution')));
    const candidates = [join(target, 'Lib', 'site-packages')];
    const references = [];
    for (const directory of candidates) if (await exists(directory)) {
      for (const entry of await readdir(directory)) if (entry.endsWith('.pth') || /^__editable__.*\.py$/u.test(entry)) {
        const file = join(directory, entry), text = await readFile(file, 'utf8');
        references.push({ path: file, hash: sha(text), mentionsOriginalRoot: text.toLowerCase().includes(source.toLowerCase()) || text.includes(slash(source)) });
      }
    }
    venv = { shared: true, target, sourceIsolation: 'shared-or-unknown', editableInputs: references,
      note: 'Python executable/dependencies are shared. Editable import mappings can still use live original Python source; this is not an isolated Python source environment.' };
  }
  return { artifacts, venv };
}

async function initializeSnapshotGit(snapshot) {
  const hooks = join(snapshot, '.git', 'disabled-hooks');
  git(['init', '--quiet', '--template='], snapshot);
  await ownedDirectory(snapshot, join(snapshot, '.git', 'info'));
  await writeFile(join(snapshot, '.git', 'info', 'exclude'), '\n.data/\nnode_modules/\nartifacts/\n', { flag: 'a' });
  git(['-c', `core.hooksPath=${hooks}`, 'add', '--all'], snapshot);
  git(['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Brain snapshot harness',
    '-c', 'user.email=brain-snapshot@invalid.local', 'commit', '--quiet', '--no-verify', '-m', 'Isolated source snapshot'], snapshot);
  return gitHead(snapshot);
}

/** No deletion/move occurs: rejected attempts are retained with an explicit manifest. */
export async function createBrainTestSnapshot(options = {}) {
  const source = await realpath(resolve(options.sourceRoot ?? fileURLToPath(new URL('..', import.meta.url))));
  if (resolve(git(['rev-parse', '--show-toplevel'], source).trim()).toLowerCase() !== source.toLowerCase()) throw new Error('Snapshot source must be its Git repository root.');
  const base = join(source, '.data', 'brain-test-snapshots');
  await ownedDirectory(source, base);
  const maxAttempts = Number.isInteger(options.maxAttempts) ? Math.max(1, Math.min(5, options.maxAttempts)) : 3;
  const rejected = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const snapshot = contained(base, join(base, id));
    await mkdir(snapshot);
    const metadata = await ownedDirectory(snapshot, join(snapshot, META));
    const manifestPath = join(metadata, 'snapshot-manifest.json');
    const manifest = { format: FORMAT, id, source, snapshot, createdAt: new Date().toISOString(), attempt,
      status: 'creating', exclusions: ['all .env and .env.* files, including examples', 'all private .data', 'Git metadata', 'dependency caches', 'artifacts unless explicitly shared'],
      reportPath: join(metadata, 'vitest-report.json'), rejectedAttempts: [...rejected], testRun: { status: 'not-run' } };
    let watcher;
    try {
      watcher = sourceWatcher(source);
      const before = await inventory(source);
      await options.onStage?.('before-copy', { source, snapshot, attempt });
      for (const file of before.files) {
        const destination = contained(snapshot, resolve(snapshot, ...file.path.split('/')));
        await ownedDirectory(snapshot, dirname(destination));
        await copyFile(join(source, ...file.path.split('/')), destination);
        await chmod(destination, file.mode);
      }
      await options.onStage?.('after-copy', { source, snapshot, attempt });
      const snapshotHead = await initializeSnapshotGit(snapshot);
      const dependencyManifest = await dependencies(source, snapshot);
      const shared = await sharedInputs(source, snapshot, options.shareArtifacts ?? [], options.shareVenv !== false);
      const resolution = await verifySnapshotResolution(snapshot, dependencyManifest);
      const after = await inventory(source);
      const copied = await mapBounded(before.files, async file => ({ ...file, hash: await hashFile(join(snapshot, ...file.path.split('/'))) }));
      const changes = await watcher.changes();
      if (!inventoriesMatch(before, after) || contentFingerprint(copied) !== before.fingerprint || changes.length) {
        throw new Error(`Concurrent source changes rejected (files=${!inventoriesMatch(before, after)}, copied=${contentFingerprint(copied) !== before.fingerprint}, watch=${changes.slice(0, 12).join(',')}).`);
      }
      for (const artifact of shared.artifacts) if ((await pinTree(artifact.target)).fingerprint !== artifact.fingerprint
        || artifact.materialization === 'copied-file' && (await pinTree(join(snapshot, ...artifact.path.split('/')))).fingerprint !== artifact.fingerprint) throw new Error(`Artifact changed during snapshot: ${artifact.path}`);
      watcher.close(); watcher = null;
      Object.assign(manifest, { status: 'consistent', sourceHead: before.head, snapshotHead, sourceFingerprint: before.fingerprint,
        files: before.files, omittedListedFiles: before.omitted, dependencies: dependencyManifest, sharedInputs: shared, resolution,
        consistency: 'Source before/after hashes, file lists, metadata, copied bytes and source watcher agree. Shared third-party dependencies and Python are explicitly not source-isolated.' });
      await json(manifestPath, manifest);
      return { snapshot, manifestPath, manifest };
    } catch (error) {
      watcher?.close();
      Object.assign(manifest, { status: 'rejected', error: error instanceof Error ? error.message : String(error) });
      await json(manifestPath, manifest);
      rejected.push({ snapshot, manifestPath, error: manifest.error });
      if (attempt < maxAttempts) await sleep(150);
    }
  }
  const error = new Error(`No consistent source snapshot after ${maxAttempts} attempts. Rejected manifests: ${rejected.map(item => item.manifestPath).join(', ')}`);
  error.rejectedAttempts = rejected;
  throw error;
}

export async function runBrainSnapshotTests(created, options = {}) {
  const { snapshot, manifestPath } = created;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== FORMAT || manifest.status !== 'consistent' || manifest.snapshot !== snapshot) throw new Error('Only a consistent owned snapshot may run tests.');
  if (manifest.testRun?.status !== 'not-run') throw new Error('This snapshot already has a test run. Create a new unique snapshot to retain its original report.');
  contained(join(manifest.source, '.data', 'brain-test-snapshots'), snapshot);
  const selected = options.tests ?? [];
  if (selected.some(path => typeof path !== 'string' || path.startsWith('-') || isAbsolute(path) || path.split(/[\\/]/u).includes('..'))) throw new Error('Test selectors must be relative paths, not flags or outside targets.');
  const runner = join(snapshot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!await exists(runner)) throw new Error('Installed Vitest is absent; the harness never installs dependencies.');
  const metadata = join(snapshot, META), stdoutPath = join(metadata, 'vitest.stdout.log'), stderrPath = join(metadata, 'vitest.stderr.log');
  const args = [runner, 'run', ...selected, '--reporter=default', '--reporter=json', `--outputFile=${manifest.reportPath}`];
  manifest.testRun = { status: 'running', startedAt: new Date().toISOString(), node: process.execPath, args, cwd: snapshot,
    tests: selected.length ? selected : ['<full Vitest suite>'], stdoutPath, stderrPath, environmentPolicy: 'Allowlisted OS/browser paths only; no inherited production credentials or .env loading.' };
  await json(manifestPath, manifest);
  const watcher = sourceWatcher(snapshot);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' }), stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const streamResults = Promise.allSettled([finished(stdout), finished(stderr)]);
  let closing;
  const closeLogs = () => closing ??= (async () => {
    stdout.end(); stderr.end();
    const results = await streamResults;
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  })();
  try {
    const before = await inventory(snapshot);
    if (before.fingerprint !== manifest.sourceFingerprint || (await watcher.changes()).length) throw new Error('Snapshot source changed before test execution; no tests were started.');
    await verifySnapshotResolution(snapshot, manifest.dependencies);
    for (const artifact of manifest.sharedInputs.artifacts) if ((await pinTree(artifact.target)).fingerprint !== artifact.fingerprint
      || artifact.materialization === 'copied-file' && (await pinTree(join(snapshot, ...artifact.path.split('/')))).fingerprint !== artifact.fingerprint) throw new Error(`Artifact changed before test execution: ${artifact.path}`);
    const exitCode = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, args, { cwd: snapshot, env: snapshotTestEnvironment(snapshot), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      manifest.testRun.pid = child.pid;
      process.stdout.write(JSON.stringify({ testChildPid: child.pid, snapshot }) + '\n');
      child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false });
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      child.once('error', reject);
      child.once('close', code => accept(code ?? 1));
    });
    const after = await inventory(snapshot);
    const changed = manifest.files.filter(file => !after.files.some(item => item.path === file.path && item.hash === file.hash && item.mode === file.mode)).map(file => file.path);
    const watched = await watcher.changes();
    const artifactsChanged = [];
    for (const artifact of manifest.sharedInputs.artifacts) if ((await pinTree(artifact.target)).fingerprint !== artifact.fingerprint
      || artifact.materialization === 'copied-file' && (await pinTree(join(snapshot, ...artifact.path.split('/')))).fingerprint !== artifact.fingerprint) artifactsChanged.push(artifact.path);
    const valid = inventoriesMatch(before, after) && !changed.length && !watched.length && !artifactsChanged.length;
    Object.assign(manifest.testRun, { status: valid ? exitCode === 0 ? 'passed' : 'failed' : 'invalidated', exitCode,
      finishedAt: new Date().toISOString(), changedSnapshotFiles: changed, watchedSourceChanges: watched.slice(0, 100), changedSharedArtifacts: artifactsChanged });
    await closeLogs(); await json(manifestPath, manifest);
    return { exitCode: valid ? exitCode : 2, manifest, manifestPath, reportPath: manifest.reportPath };
  } catch (error) {
    Object.assign(manifest.testRun, { status: 'error', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    await closeLogs().catch(() => {}); await json(manifestPath, manifest);
    throw error;
  } finally { watcher.close(); }
}

function argumentsFrom(argv) {
  const options = { tests: [], shareArtifacts: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--run') options.run = true;
    else if (argument === '--no-share-venv') options.shareVenv = false;
    else if (['--source-root', '--max-attempts', '--tests', '--share-artifact'].includes(argument)) {
      const value = argv[++index]; if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === '--source-root') options.sourceRoot = value;
      if (argument === '--max-attempts') options.maxAttempts = Number(value);
      if (argument === '--tests') options.tests.push(value);
      if (argument === '--share-artifact') options.shareArtifacts.push(value);
    } else throw new Error(`Unknown snapshot argument: ${argument}`);
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFrom(process.argv.slice(2));
    const created = await createBrainTestSnapshot(options);
    console.log(JSON.stringify({ snapshot: created.snapshot, manifestPath: created.manifestPath, sourceFingerprint: created.manifest.sourceFingerprint, status: created.manifest.status }));
    if (options.run) { const result = await runBrainSnapshotTests(created, options); console.log(JSON.stringify({ manifestPath: result.manifestPath, reportPath: result.reportPath, status: result.manifest.testRun.status })); process.exitCode = result.exitCode; }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
