import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const usage = `Usage: node scripts/release-compare.mjs
  (--deployed <ref> | --deployed-manifest <path>)
  (--candidate <ref> | --candidate-manifest <path>)`;
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const regularFile = /^100[0-7]{3}$/u;
const missingMode = '000000';

function git(...args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed (${result.error?.code ?? result.status ?? result.signal})`);
  }
  return result.stdout;
}

function resolveCommit(ref, side) {
  try {
    return git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  } catch {
    throw new Error(`Could not resolve the ${side} commit. Fetch the release history first.`);
  }
}

function releaseCommit(options, side) {
  const ref = options[side];
  const manifestPath = options[`${side}-manifest`];
  if ((ref === undefined) === (manifestPath === undefined)) {
    throw new Error(`Provide exactly one of --${side} and --${side}-manifest.`);
  }
  if (ref !== undefined) return resolveCommit(ref, side);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Could not read the ${side} manifest as JSON.`);
  }
  if (manifest?.format !== 1 || manifest.kind !== 'source-snapshot'
      || typeof manifest.sourceCommit !== 'string' || !objectId.test(manifest.sourceCommit)
      || typeof manifest.sourceTree !== 'string' || !objectId.test(manifest.sourceTree)
      || typeof manifest.dirty !== 'boolean') {
    throw new Error(`The ${side} manifest needs valid sourceCommit, sourceTree and dirty provenance.`);
  }
  if (manifest.dirty) throw new Error(`The ${side} manifest records a dirty snapshot.`);
  const commit = resolveCommit(manifest.sourceCommit, side);
  const tree = git('rev-parse', `${commit}^{tree}`).trim();
  if (commit !== manifest.sourceCommit || tree !== manifest.sourceTree) {
    throw new Error(`The ${side} manifest commit and tree do not match Git.`);
  }
  return commit;
}

function diffEntries(from, to) {
  const fields = git('diff-tree', '--no-commit-id', '--no-renames', '--ignore-submodules=none',
    '--raw', '--no-abbrev', '-r', '-z', from, to).split('\0');
  const changes = new Map();
  for (let index = 0; index < fields.length - 1; index += 2) {
    const [oldMode, newMode, oldBlob, newBlob] = fields[index].slice(1).split(' ');
    changes.set(fields[index + 1], { oldMode, newMode, oldBlob, newBlob });
  }
  return changes;
}

function hunks({ oldMode, oldBlob, newBlob }) {
  if (!regularFile.test(oldMode)) {
    // A new regular file has no old lines. Binary additions have to keep their blob ID.
    const contents = git('cat-file', 'blob', newBlob);
    if (!contents || contents.includes('\0')) return [];
    const lines = contents.replace(/\n$/u, '').split('\n');
    return [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length }];
  }
  const patch = git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-indent-heuristic',
    '--diff-algorithm=histogram', '--inter-hunk-context=0', '--unified=0', oldBlob, newBlob);
  const result = [];
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      const [, oldStart, oldCount = '1', newStart, newCount = '1'] = header;
      result.push({
        oldStart: Number(oldStart), oldCount: Number(oldCount),
        newStart: Number(newStart), newCount: Number(newCount),
      });
    }
  }
  return result;
}

function lineRange(start, count) {
  return count > 1 ? `:${start}-${start + count - 1}` : `:${start}`;
}

function changedRanges(fileHunks, side) {
  return fileHunks.flatMap(hunk => {
    const start = hunk[`${side}Start`];
    const count = hunk[`${side}Count`];
    return count > 0 ? [{ start, end: start + count }] : [];
  });
}

function unchangedRanges(changes) {
  const ranges = [];
  let start = 1;
  for (const change of changes) {
    if (start < change.start) ranges.push({ start, end: change.start });
    start = change.end;
  }
  ranges.push({ start, end: Infinity });
  return ranges;
}

function overlappingRanges(left, right) {
  const ranges = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const first = left[leftIndex];
    const second = right[rightIndex];
    const start = Math.max(first.start, second.start);
    const end = Math.min(first.end, second.end);
    if (start < end) ranges.push(lineRange(start, end - start));
    if (first.end <= second.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return ranges;
}

function compareFile(expected, actual) {
  if (expected.newMode === missingMode) {
    return [' (deleted in the deployed release, present in the candidate)'];
  }

  if (actual.newMode === missingMode) {
    const missingLines = regularFile.test(expected.newMode)
      ? hunks(expected).filter(hunk => hunk.newCount > 0).map(hunk => lineRange(hunk.newStart, hunk.newCount))
      : [];
    return (missingLines.length ? missingLines : ['']).map(range => `${range} (deployed file missing)`);
  }
  if (expected.newMode.slice(0, 3) !== actual.newMode.slice(0, 3)) {
    return [' (deployed file type missing)'];
  }
  const losses = [];
  if (expected.newMode !== expected.oldMode && expected.newMode !== actual.newMode) {
    losses.push(' (deployed file mode missing)');
  }

  if (expected.newBlob === actual.newBlob || expected.newBlob === expected.oldBlob) return losses;

  const expectedHunks = regularFile.test(expected.newMode) ? hunks(expected) : [];
  if (expectedHunks.length === 0) {
    losses.push(' (deployed blob is different)');
    return losses;
  }

  const actualHunks = hunks(actual);
  if (actualHunks.length === 0) {
    losses.push(' (candidate content cannot be compared as text)');
    return losses;
  }

  // Compare in two coordinate spaces. Deployed-to-candidate catches lost
  // additions and base-to-candidate catches removed base lines that survive.
  const missing = overlappingRanges(changedRanges(expectedHunks, 'new'), changedRanges(actualHunks, 'old'));
  losses.push(...missing.map(range => `${range} (deployed lines missing)`));
  const deployedRemovals = changedRanges(expectedHunks, 'old');
  if (deployedRemovals.length > 0) {
    const candidateFromBase = hunks({ ...expected, newBlob: actual.newBlob });
    const surviving = unchangedRanges(changedRanges(candidateFromBase, 'old'));
    const restored = overlappingRanges(deployedRemovals, surviving);
    losses.push(...restored.map(range => `${range} (removed merge-base lines present)`));
  }
  return losses;
}

function isAdvisory(file) {
  return file.startsWith('docs/') || /\.test\.[cm]?[jt]sx?$/u.test(file);
}

function displayPath(file) {
  return /[\u0000-\u001f\u007f]/u.test(file) ? JSON.stringify(file) : file;
}

function main() {
  const { values } = parseArgs({
    options: {
      deployed: { type: 'string' }, 'deployed-manifest': { type: 'string' },
      candidate: { type: 'string' }, 'candidate-manifest': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const deployed = releaseCommit(values, 'deployed');
  const candidate = releaseCommit(values, 'candidate');
  let bases;
  try {
    bases = git('merge-base', '--all', deployed, candidate).trim().split('\n');
  } catch {
    throw new Error('The releases have no available common ancestor. Fetch their full histories.');
  }
  if (bases.length !== 1) throw new Error('The releases have multiple merge bases. A unique common ancestor is required.');
  const [base] = bases;
  const commits = git('rev-list', '--reverse', `${candidate}..${deployed}`).trim().split('\n').filter(Boolean);
  const deployedChanges = diffEntries(base, deployed);
  const candidateChanges = diffEntries(deployed, candidate);
  console.log(`Deployed ${deployed}\nCandidate ${candidate}\nMerge base ${base}`);
  console.log(`Deployed-only commits (${commits.length})${commits.length ? `\n${commits.join('\n')}` : ''}`);

  let missing = 0;
  let warnings = 0;
  for (const [file, expected] of deployedChanges) {
    const actual = candidateChanges.get(file);
    if (!actual) continue;
    const losses = compareFile(expected, actual);
    for (const loss of new Set(losses)) {
      if (isAdvisory(file)) {
        warnings += 1;
        console.log(`Warning ${displayPath(file)}${loss}`);
      } else {
        missing += 1;
        console.error(`Missing ${displayPath(file)}${loss}`);
      }
    }
  }
  const summary = `${missing} missing production changes, ${warnings} advisory differences`;
  if (missing) {
    console.error(`Release comparison failed (${summary}).`);
    process.exitCode = 1;
  } else {
    console.log(`Release comparison passed (${summary}).`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Release comparison could not run. ${error.message}\n${usage}`);
  process.exitCode = 2;
}
