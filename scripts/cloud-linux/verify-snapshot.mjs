import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const gitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256 = /^[0-9a-f]{64}$/;

function validateManifest(manifest) {
  if (manifest?.format !== 1 || manifest.kind !== 'source-snapshot' ||
      !Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length) {
    throw new Error('Invalid snapshot manifest');
  }

  const { sourceCommit, sourceTree, dirty } = manifest;
  // Older manifests can still verify a transfer, but have no source provenance.
  if ([sourceCommit, sourceTree, dirty].some(value => value !== undefined) &&
      (typeof sourceCommit !== 'string' || !gitId.test(sourceCommit) ||
        typeof sourceTree !== 'string' || !gitId.test(sourceTree) ||
        sourceCommit.length !== sourceTree.length || typeof dirty !== 'boolean')) {
    throw new Error('Invalid snapshot provenance');
  }

  const files = new Map();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || /[\\\0]/.test(file.path) ||
        file.path.split('/').some(part => part === '' || part === '.' || part === '..') ||
        files.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        typeof file.sha256 !== 'string' || !sha256.test(file.sha256)) {
      throw new Error('Invalid snapshot file entry');
    }
    files.set(file.path, file);
    totalBytes += file.bytes;
  }
  if (!Number.isSafeInteger(totalBytes) || manifest.totalBytes !== totalBytes) {
    throw new Error('Invalid snapshot byte count');
  }
  return files;
}

async function fileMatches(filename, record) {
  const info = await lstat(filename);
  if (!info.isFile() || info.size !== record.bytes) return false;
  const contents = await readFile(filename);
  return contents.length === record.bytes && createHash('sha256').update(contents).digest('hex') === record.sha256;
}

async function checkDirectory(directory, prefix, expected, differences) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix + entry.name;
    const filename = path.join(directory, entry.name);
    const record = expected.get(relativePath);
    expected.delete(relativePath);
    if (entry.isDirectory()) {
      if (record) differences.altered.push(relativePath);
      await checkDirectory(filename, `${relativePath}/`, expected, differences);
    } else if (!record) {
      differences.extra.push(relativePath);
    } else if (!entry.isFile() || !await fileMatches(filename, record)) {
      differences.altered.push(relativePath);
    }
  }
}

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2) {
  console.error('Usage: node scripts/cloud-linux/verify-snapshot.mjs <source-directory> <manifest-file>');
  process.exitCode = 1;
} else {
  try {
    const [source, manifestPath] = arguments_;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const expected = validateManifest(manifest);
    if (!(await lstat(source)).isDirectory()) throw new Error('Expected a source directory');
    const differences = { altered: [], extra: [] };
    await checkDirectory(source, '', expected, differences);
    const { sourceCommit, sourceTree, dirty } = manifest;
    const altered = differences.altered.sort();
    const extra = differences.extra.sort();
    const missing = [...expected.keys()].sort();
    const ok = altered.length === 0 && extra.length === 0 && missing.length === 0;
    const report = { ok, sourceCommit, sourceTree, dirty, altered, extra, missing };
    if (ok) {
      console.log(JSON.stringify(report));
    } else {
      console.error(JSON.stringify(report));
      process.exitCode = 1;
    }
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'SNAPSHOT_VERIFY_FAILED',
      message: 'Could not read the source directory or validate its manifest.' }));
    process.exitCode = 1;
  }
}
