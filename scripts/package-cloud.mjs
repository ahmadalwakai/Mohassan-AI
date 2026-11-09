import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
  'playwright.config.ts', '.env.example',
];
const sourceDirectories = ['apps', 'packages', 'scripts'];
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

async function copySource(relativePath) {
  if (excluded(path.basename(relativePath))) return;
  const originalPath = path.join(root, relativePath);
  const info = await lstat(originalPath);
  if (info.isSymbolicLink()) {
    skippedSymlinks += 1;
    return;
  }
  if (info.isDirectory()) {
    const entries = await readdir(originalPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) await copySource(path.join(relativePath, entry.name));
    return;
  }
  if (!info.isFile()) return;
  const contents = await readFile(originalPath);
  const destination = path.join(sourceRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, { flag: 'wx', mode: info.mode & 0o777 });
  files.push({
    path: relativePath.split(path.sep).join('/'),
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

try {
  await mkdir(path.dirname(snapshotRoot), { recursive: true });
  await mkdir(snapshotRoot);
  await mkdir(sourceRoot);
  for (const relativePath of [...rootFiles, ...sourceDirectories]) await copySource(relativePath);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: 1,
    kind: 'source-snapshot',
    createdAt,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    skippedSymlinks,
    files,
  };
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, source: sourceRoot, manifest: manifestPath,
    fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, skippedSymlinks }));
} catch {
  console.error(JSON.stringify({ ok: false, error: 'SOURCE_SNAPSHOT_FAILED',
    message: 'Could not complete the source snapshot. An incomplete snapshot may remain under artifacts/cloud-deployment.' }));
  process.exitCode = 1;
}
