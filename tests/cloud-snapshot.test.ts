import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packager = fileURLToPath(new URL('../scripts/package-cloud.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/cloud-linux/verify-snapshot.mjs', import.meta.url));
const sourceFile = 'apps/example.ts';
const fixtureDirectory = 'tests/fixtures/agent-capability-bench/v2/exclusion';
const exampleFiles = [
  '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts',
  `${fixtureDirectory}/manifest.json`, `${fixtureDirectory}/dev.jsonl`, `${fixtureDirectory}/sealed.jsonl`,
  sourceFile, 'packages/example.ts',
];

let repo: string;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function run(script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { code: result.status, report: JSON.parse(result.stdout || result.stderr) };
}

function packageSnapshot(...args: string[]) {
  return run(path.join(repo, 'scripts/package-cloud.mjs'), ...args);
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'cloud-snapshot-'));
  for (const file of exampleFiles) {
    const filename = path.join(repo, file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `Fixture for ${file}\n`);
  }
  await writeFile(path.join(repo, '.gitignore'), '/artifacts/\n*.local\n');
  await mkdir(path.join(repo, 'scripts'));
  await copyFile(packager, path.join(repo, 'scripts/package-cloud.mjs'));
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Snapshot Test');
  git('config', 'user.email', 'snapshot@example.invalid');
  git('add', '--all');
  git('commit', '--no-gpg-sign', '-qm', 'Initial source');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('cloud snapshot provenance', () => {
  it.each(['unstaged', 'staged', 'untracked'])('refuses %s changes before producing a snapshot', async state => {
    const changed = state === 'untracked' ? 'apps/new.ts' : sourceFile;
    await writeFile(path.join(repo, changed), 'Changed source\n');
    if (state === 'staged') git('add', changed);

    const result = packageSnapshot();
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ ok: false, error: 'DIRTY_WORKTREE' });
    await expect(stat(path.join(repo, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records the commit and tree and copies committed bytes even when Git status misses a local change', async () => {
    const expectedBytes = Buffer.from(git('show', `HEAD:${sourceFile}`));
    git('update-index', '--assume-unchanged', sourceFile);
    await writeFile(path.join(repo, sourceFile), 'Local change hidden from status\n');
    await writeFile(path.join(repo, 'apps/workstation.local'), 'Ignored workbench configuration\n');

    const result = packageSnapshot();
    expect(result.code).toBe(0);
    const manifest = JSON.parse(await readFile(result.report.manifest, 'utf8'));
    expect(manifest).toMatchObject({
      sourceCommit: git('rev-parse', 'HEAD').trim(),
      sourceTree: git('rev-parse', 'HEAD^{tree}').trim(),
      dirty: false,
    });
    expect(await readFile(path.join(result.report.source, sourceFile))).toEqual(expectedBytes);
    expect(manifest.files).toContainEqual({
      path: sourceFile,
      bytes: expectedBytes.length,
      sha256: createHash('sha256').update(expectedBytes).digest('hex'),
    });
    await expect(readFile(path.join(result.report.source, 'apps/workstation.local'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks an explicitly allowed dirty snapshot and includes tracked and unignored edits', async () => {
    const changed = 'Changed tracked source\n';
    const added = 'New untracked source\n';
    await writeFile(path.join(repo, sourceFile), changed);
    await writeFile(path.join(repo, 'apps/new.ts'), added);
    await writeFile(path.join(repo, 'apps/workstation.local'), 'Ignored workbench configuration\n');

    const result = packageSnapshot('--allow-dirty');
    expect(result.code).toBe(0);
    const manifest = JSON.parse(await readFile(result.report.manifest, 'utf8'));
    expect(manifest).toMatchObject({
      sourceCommit: git('rev-parse', 'HEAD').trim(),
      sourceTree: git('rev-parse', 'HEAD^{tree}').trim(),
      dirty: true,
    });
    expect(await readFile(path.join(result.report.source, sourceFile), 'utf8')).toBe(changed);
    expect(await readFile(path.join(result.report.source, 'apps/new.ts'), 'utf8')).toBe(added);
    await expect(readFile(path.join(result.report.source, 'apps/workstation.local'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unknown command-line options', () => {
    expect(packageSnapshot('--allow-uncommitted')).toMatchObject({ code: 1, report: { error: 'INVALID_ARGUMENTS' } });
  });
});

describe('transferred cloud snapshot verification', () => {
  it('verifies an intact snapshot and reports altered, extra and missing files together', async () => {
    const packaged = packageSnapshot();
    expect(packaged.code).toBe(0);
    const { source, manifest, sourceCommit, sourceTree, dirty } = packaged.report;
    expect(run(verifier, source, manifest)).toEqual({ code: 0, report: {
      ok: true, sourceCommit, sourceTree, dirty, altered: [], extra: [], missing: [],
    } });

    const altered = path.join(source, sourceFile);
    const bytes = await readFile(altered);
    bytes[0] ^= 1;
    await writeFile(altered, bytes);
    await writeFile(path.join(source, 'apps/extra.ts'), 'Extra source\n');
    await rm(path.join(source, 'packages/example.ts'));
    expect(run(verifier, source, manifest)).toEqual({ code: 1, report: {
      ok: false, sourceCommit, sourceTree, dirty,
      altered: [sourceFile], extra: ['apps/extra.ts'], missing: ['packages/example.ts'],
    } });
  });

  it.skipIf(process.platform === 'win32')('flags a symlink in place of an expected file', async () => {
    const packaged = packageSnapshot();
    expect(packaged.code).toBe(0);
    const { source, manifest } = packaged.report;
    const filename = path.join(source, sourceFile);
    await rm(filename);
    await symlink(path.join(repo, sourceFile), filename);

    expect(run(verifier, source, manifest)).toMatchObject({ code: 1, report: { altered: [sourceFile] } });
  });

  it('can verify a historical snapshot manifest without Git provenance', async () => {
    const packaged = packageSnapshot();
    expect(packaged.code).toBe(0);
    const { source, manifest } = packaged.report;
    const record = JSON.parse(await readFile(manifest, 'utf8'));
    delete record.sourceCommit;
    delete record.sourceTree;
    delete record.dirty;
    await writeFile(manifest, JSON.stringify(record));

    expect(run(verifier, source, manifest)).toEqual({ code: 0, report: { ok: true, altered: [], extra: [], missing: [] } });
  });

  it('rejects malformed manifest entries', async () => {
    const packaged = packageSnapshot();
    expect(packaged.code).toBe(0);
    const { source, manifest } = packaged.report;
    const record = JSON.parse(await readFile(manifest, 'utf8'));
    record.files[0].path = '../outside';
    await writeFile(manifest, JSON.stringify(record));

    expect(run(verifier, source, manifest)).toMatchObject({ code: 1, report: { error: 'SNAPSHOT_VERIFY_FAILED' } });
  });
});
