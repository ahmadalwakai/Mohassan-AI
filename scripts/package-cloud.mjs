import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
  'playwright.config.ts', '.env.example',
  ...['manifest.json', 'dev.jsonl', 'sealed.jsonl'].map(file => `tests/fixtures/agent-capability-bench/v2/exclusion/${file}`),
];
const sourceDirectories = ['apps', 'packages', 'scripts'];
const sourcePaths = [...rootFiles, ...sourceDirectories];
const excludedNames = new Set([
  'node_modules', '.git', '.data', '.next', '.next-e2e', 'artifacts',
  'test-results', 'playwright-report', 'coverage', '.claude', '.vercel',
]);

function excluded(name) {
  const normalized = name.toLowerCase();
  return excludedNames.has(normalized) ||
    ((normalized === '.env' || normalized.startsWith('.env.')) && normalized !== '.env.example') ||
    normalized.endsWith('.log') || normalized.endsWith('.tsbuildinfo');
}

const createdAt = new Date().toISOString();
const snapshotRoot = path.join(root, 'artifacts', 'cloud-deployment', createdAt.replace(/[:.]/g, '-'));
const sourceRoot = path.join(snapshotRoot, 'source');
const files = [];
let skippedSymlinks = 0;

function git(args, maxBuffer = 16 * 1024 * 1024) {
  return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', ...args], {
    cwd: root, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
}

async function writeSource(relativePath, contents, mode) {
  const destination = path.join(sourceRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, { flag: 'wx', mode });
  files.push({
    path: relativePath,
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

async function copyCommittedSource(sourceCommit) {
  const entries = git(['ls-tree', '-rlz', sourceCommit, '--', ...sourcePaths]).toString('utf8');
  for (const entry of entries.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const [mode, type, objectId, size] = entry.slice(0, separator).split(/\s+/);
    const relativePath = entry.slice(separator + 1);
    if (relativePath.split('/').some(excluded)) continue;
    if (mode === '120000') {
      skippedSymlinks += 1;
      continue;
    }
    if (type !== 'blob') throw new Error('Expected a committed file');
    const contents = git(['cat-file', 'blob', objectId], Number(size) + 1);
    await writeSource(relativePath, contents, Number.parseInt(mode.slice(-3), 8));
  }
}

function workingSourcePaths() {
  const entries = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard',
    '--', ...sourcePaths]).toString('utf8');
  const includedPaths = new Set();
  for (const entry of entries.split('\0').filter(Boolean)) {
    let relativePath = entry;
    while (relativePath !== '.' && !includedPaths.has(relativePath)) {
      includedPaths.add(relativePath);
      relativePath = path.posix.dirname(relativePath);
    }
  }
  return includedPaths;
}

async function copyWorkingSource(relativePath, includedPaths) {
  if (excluded(path.basename(relativePath)) || !includedPaths.has(relativePath)) return;
  const originalPath = path.join(root, relativePath);
  const info = await lstat(originalPath);
  if (info.isSymbolicLink()) {
    skippedSymlinks += 1;
    return;
  }
  if (info.isDirectory()) {
    const entries = await readdir(originalPath, { withFileTypes: true });
    for (const entry of entries) await copyWorkingSource(`${relativePath}/${entry.name}`, includedPaths);
    return;
  }
  if (!info.isFile()) return;
  await writeSource(relativePath, await readFile(originalPath), info.mode & 0o777);
}

async function createSnapshot({ sourceCommit, sourceTree, dirty }) {
  await mkdir(path.dirname(snapshotRoot), { recursive: true });
  await mkdir(snapshotRoot);
  await mkdir(sourceRoot);
  if (dirty) {
    const includedPaths = workingSourcePaths();
    for (const relativePath of sourcePaths) await copyWorkingSource(relativePath, includedPaths);
  } else {
    await copyCommittedSource(sourceCommit);
  }
  if (sourcePaths.some(sourcePath => !files.some(file =>
    file.path === sourcePath || file.path.startsWith(`${sourcePath}/`)))) {
    throw new Error('Missing required snapshot source');
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: 1,
    kind: 'source-snapshot',
    createdAt,
    sourceCommit,
    sourceTree,
    dirty,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    skippedSymlinks,
    files,
  };
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, source: sourceRoot, manifest: manifestPath,
    sourceCommit, sourceTree, dirty, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, skippedSymlinks }));
}

try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.some(argument => argument !== '--allow-dirty')) {
    console.error(JSON.stringify({ ok: false, error: 'INVALID_ARGUMENTS',
      message: 'Usage: node scripts/package-cloud.mjs [--allow-dirty]' }));
    process.exitCode = 1;
  } else {
    if (git(['rev-parse', '--show-prefix']).toString('utf8').trim()) throw new Error('Expected a Git checkout at the source root');
    const sourceCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
    const sourceTree = git(['rev-parse', '--verify', `${sourceCommit}^{tree}`]).toString('utf8').trim();
    const dirty = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none']).length > 0;
    if (dirty && !arguments_.includes('--allow-dirty')) {
      console.error(JSON.stringify({ ok: false, error: 'DIRTY_WORKTREE',
        message: 'Commit or remove local changes before creating a release snapshot. Use --allow-dirty only for local testing.' }));
      process.exitCode = 1;
    } else {
      await createSnapshot({ sourceCommit, sourceTree, dirty });
    }
  }
} catch {
  console.error(JSON.stringify({ ok: false, error: 'SOURCE_SNAPSHOT_FAILED',
    message: 'Could not complete the source snapshot. An incomplete snapshot may remain under artifacts/cloud-deployment.' }));
  process.exitCode = 1;
}
