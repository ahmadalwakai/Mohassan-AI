import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/release-compare.mjs', import.meta.url));
const repositories: string[] = [];

afterEach(() => {
  for (const directory of repositories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-compare-'));
  repositories.push(cwd);
  function git(...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function write(path: string, contents: string | Buffer) {
    const absolutePath = join(cwd, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  function commit(message: string) {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }
  function compare(...args: string[]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }
  function manifest(commit: string) {
    return {
      format: 1, kind: 'source-snapshot', dirty: false, sourceCommit: commit,
      sourceTree: git('rev-parse', `${commit}^{tree}`),
    };
  }

  git('init', '-q', '--initial-branch=base');
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(cwd, 'unused-hooks'));
  return { git, write, commit, compare, manifest };
}

const browserPath = 'src/browser.mjs';
const readerPath = 'src/text reader.mjs';
const returnCredentials = '  return headers;';
const scrubCredentials = '  return selectReadHeaders(headers);';
function reader(contents: string) {
  return ['export function read(headers) {', contents, '}', ''].join('\n');
}
function lineNumber(contents: string, line: string) {
  return contents.split('\n').indexOf(line) + 1;
}

function hotfixRepository({ portReader }: { portReader: boolean }) {
  const repo = setupRepository();
  repo.write(browserPath, reader(returnCredentials));
  repo.write(readerPath, reader(returnCredentials));
  const base = repo.commit('Base');
  repo.git('switch', '-qc', 'deployed');
  repo.write(browserPath, reader(scrubCredentials));
  const deployedFirst = repo.commit('Filter browser headers');
  const deployedReader = reader(scrubCredentials);
  repo.write(readerPath, deployedReader);
  const deployed = repo.commit('Filter text-reader headers');

  repo.git('switch', '-qc', 'candidate', base);
  repo.write(browserPath, `// The integration branch adds transport tracing here.\n${reader(scrubCredentials)}`);
  if (portReader) repo.write(readerPath, `// The reader now dispatches public lookups.\n${deployedReader}`);
  const candidate = repo.commit('Integrate the release port');
  return { ...repo, deployedFirst, deployed, candidate, deployedReader };
}

describe('release comparison', () => {
  it('blocks a candidate containing only half of a deployed two-commit hotfix', () => {
    const repo = hotfixRepository({ portReader: false });
    const result = repo.compare('--deployed', 'deployed', '--candidate', 'candidate');
    expect(result.status).toBe(1);
    expect(result.output).toContain(repo.deployedFirst);
    expect(result.output).toContain(repo.deployed);
    expect(result.output).toContain(`Missing ${readerPath}:${lineNumber(repo.deployedReader, scrubCredentials)} (deployed lines missing)`);
    expect(result.output).not.toContain(`Missing ${browserPath}`);
  });

  it('accepts a manual port with unrelated nearby changes and no matching patch IDs', () => {
    const repo = hotfixRepository({ portReader: true });
    expect(repo.git('cherry', repo.candidate, repo.deployed).split('\n')).toEqual([
      `+ ${repo.deployedFirst}`, `+ ${repo.deployed}`,
    ]);
    const result = repo.compare('--deployed', repo.deployed, '--candidate', repo.candidate);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Release comparison passed');
  });

  it('blocks a deletion-only hunk when the candidate leaves one of the old lines in place', () => {
    const repo = setupRepository();
    const before = ['before();', 'oldRuleA();', 'oldRuleB();', 'after();', ''].join('\n');
    repo.write(readerPath, before);
    const base = repo.commit('Base');
    repo.git('switch', '-qc', 'deployed');
    repo.write(readerPath, 'before();\nafter();\n');
    const deployed = repo.commit('Remove obsolete rules');
    repo.git('switch', '-qc', 'candidate', base);
    repo.write(readerPath, 'before();\noldRuleB();\nafter();\n');
    const candidate = repo.commit('Remove the first rule only');

    const result = repo.compare('--deployed', deployed, '--candidate', candidate);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`Missing ${readerPath}:${lineNumber(before, 'oldRuleB();')} (removed merge-base lines present)`);
  });

  it('reports missing release notes and tests as advisories while requiring new runtime files', () => {
    const repo = setupRepository();
    repo.write('start.mjs', '// Startup\n');
    const base = repo.commit('Base');
    repo.git('switch', '-qc', 'deployed');
    repo.write('docs/release.md', 'Release notes\n');
    repo.write('src/guard.test.ts', '// Regression test\n');
    repo.write('src/guard.mjs', '// Production guard\n');
    const deployed = repo.commit('Add boundary guard and its supporting files');

    const result = repo.compare('--deployed', deployed, '--candidate', base);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Warning docs/release.md:1 (deployed file missing)');
    expect(result.output).toContain('Warning src/guard.test.ts:1 (deployed file missing)');
    expect(result.output).toContain('Missing src/guard.mjs:1 (deployed file missing)');
  });

  it('requires a deployed binary blob and a deleted path to have their deployed state', () => {
    const repo = setupRepository();
    repo.write('src/old-config.mjs', '// Replaced\n');
    const base = repo.commit('Base');
    repo.git('switch', '-qc', 'deployed');
    repo.git('rm', '-q', 'src/old-config.mjs');
    repo.write('src/config.bin', Buffer.from('fixture\0deployed'));
    const deployed = repo.commit('Replace old configuration');
    repo.git('switch', '-qc', 'candidate', base);
    repo.write('src/config.bin', Buffer.from('fixture\0candidate'));
    const candidate = repo.commit('Add different configuration');

    const result = repo.compare('--deployed', deployed, '--candidate', candidate);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Missing src/config.bin (deployed blob is different)');
    expect(result.output).toContain('Missing src/old-config.mjs (deleted in the deployed release, present in the candidate)');
  });

  it('requires a deployed executable bit even when file bytes match', () => {
    const repo = setupRepository();
    const path = 'scripts/start.sh';
    repo.write(path, '#!/bin/sh\n');
    const base = repo.commit('Base');
    repo.git('update-index', '--chmod=+x', path);
    repo.git('commit', '-qm', 'Make the startup hook executable');

    const result = repo.compare('--deployed', 'HEAD', '--candidate', base);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`Missing ${path} (deployed file mode missing)`);
  });

  it('checks the Git commits named by valid clean manifests', () => {
    const repo = hotfixRepository({ portReader: true });
    repo.write('deployed.json', JSON.stringify(repo.manifest(repo.deployed)));
    repo.write('candidate.json', JSON.stringify(repo.manifest(repo.candidate)));
    const result = repo.compare('--deployed-manifest', 'deployed.json', '--candidate-manifest', 'candidate.json');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`Deployed ${repo.deployed}`);
    expect(result.output).toContain(`Candidate ${repo.candidate}`);
  });

  it('rejects dirty, inconsistent, incomplete, or ambiguous release provenance', () => {
    const repo = hotfixRepository({ portReader: true });
    const candidate = repo.manifest(repo.candidate);
    const cases = [
      { manifest: { ...candidate, dirty: true }, expected: 'candidate manifest records a dirty snapshot' },
      { manifest: { ...candidate, sourceTree: repo.manifest(repo.deployed).sourceTree }, expected: 'candidate manifest commit and tree do not match Git' },
      { manifest: { format: 1, kind: 'source-snapshot' }, expected: 'candidate manifest needs valid sourceCommit, sourceTree and dirty provenance' },
    ];
    for (const { manifest, expected } of cases) {
      repo.write('candidate.json', JSON.stringify(manifest));
      const result = repo.compare('--deployed', repo.deployed, '--candidate-manifest', 'candidate.json');
      expect(result).toEqual({ status: 2, output: expect.stringContaining(expected) });
    }
    const ambiguous = repo.compare('--deployed', repo.deployed, '--candidate', repo.candidate, '--candidate-manifest', 'candidate.json');
    expect(ambiguous).toEqual({ status: 2, output: expect.stringContaining('Provide exactly one of --candidate and --candidate-manifest') });
  });
});
