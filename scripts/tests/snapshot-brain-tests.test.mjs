import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrainTestSnapshot, snapshotTestEnvironment } from '../snapshot-brain-tests.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const fixtureBase = join(repository, '.data', 'brain-test-snapshots', 'harness-fixtures');
const run = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
async function fixture() {
  const base = join(fixtureBase, randomUUID()), source = join(base, 'source');
  await mkdir(join(source, 'packages', 'probe', 'src'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'snapshot-fixture', private: true, type: 'module', workspaces: ['packages/*'] }));
  await writeFile(join(source, '.gitignore'), 'node_modules/\n.data/\n.env*\nartifacts/\n');
  await writeFile(join(source, 'packages', 'probe', 'package.json'), JSON.stringify({ name: '@mohassan/probe', type: 'module', exports: './src/index.mjs' }));
  await writeFile(join(source, 'packages', 'probe', 'src', 'index.mjs'), "export const value = 'snapshot-A';\n");
  await mkdir(join(source, 'node_modules', '@mohassan'), { recursive: true });
  await symlink(join(source, 'packages', 'probe'), join(source, 'node_modules', '@mohassan', 'probe'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(source, 'node_modules', '.bin'));
  await writeFile(join(source, 'node_modules', '.bin', 'probe.cmd'), '@node "%~dp0..\\@mohassan\\probe\\src\\index.mjs"\r\n');
  const external = join(base, 'shared-package'); await mkdir(external);
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external-fixture', type: 'module', exports: './index.mjs' }));
  await writeFile(join(external, 'index.mjs'), 'export const thirdParty = 17;\n');
  await symlink(external, join(source, 'node_modules', 'external-fixture'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(source, '.env'), 'SYNTHETIC_PRIVATE_VALUE=do-not-copy\n');
  await writeFile(join(source, '.env.example'), 'SYNTHETIC_EXAMPLE=also-omitted\n');
  await mkdir(join(source, '.data'), { recursive: true }); await writeFile(join(source, '.data', 'private.txt'), 'SYNTHETIC_PRIVATE_DATA');
  run(['init', '--quiet', '--template='], source);
  run(['add', 'package.json', '.gitignore', 'packages'], source);
  run(['add', '--force', '.env', '.env.example'], source);
  return { source, base, external };
}
function probe(snapshot, descendant = false) {
  const inner = "import{value}from'@mohassan/probe';import{thirdParty}from'external-fixture';console.log(JSON.stringify({value,thirdParty,resolved:import.meta.resolve('@mohassan/probe')}));";
  const script = descendant ? `import{spawnSync}from'node:child_process';const child=spawnSync(process.execPath,['--input-type=module','--eval',${JSON.stringify(inner)}],{cwd:process.cwd(),env:process.env,encoding:'utf8',windowsHide:true,shell:false});process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exitCode=child.status;` : inner;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: snapshot,
    env: snapshotTestEnvironment(snapshot), encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('freezes source, maps workspace imports and descendant aliases, shares only declared dependencies', async () => {
  const { source, external } = await fixture();
  const created = await createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, maxAttempts: 1 });
  assert.equal(created.manifest.status, 'consistent');
  assert.ok(created.manifest.snapshotHead);
  assert.equal(await realpath(join(created.snapshot, 'node_modules', '@mohassan', 'probe')), join(created.snapshot, 'packages', 'probe'));
  assert.equal(await realpath(join(created.snapshot, 'node_modules', 'external-fixture')), external);
  assert.ok(created.manifest.omittedListedFiles.some(item => item.path === '.env'));
  assert.ok(created.manifest.omittedListedFiles.some(item => item.path === '.env.example'));
  assert.ok(!created.manifest.files.some(item => item.path.startsWith('.data/') || item.path.startsWith('.env')));
  assert.equal(await readFile(join(created.snapshot, 'node_modules', '.bin', 'probe.cmd'), 'utf8'), '@node "%~dp0..\\@mohassan\\probe\\src\\index.mjs"\r\n');
  await writeFile(join(source, 'packages', 'probe', 'src', 'index.mjs'), "export const value = 'live-B';\n");
  for (const descendant of [false, true]) {
    const result = probe(created.snapshot, descendant);
    assert.equal(result.value, 'snapshot-A'); assert.equal(result.thirdParty, 17);
    assert.ok(fileURLToPath(result.resolved).startsWith(created.snapshot));
    assert.ok(!fileURLToPath(result.resolved).startsWith(join(source, 'packages')));
  }
  assert.equal(probe(source).value, 'live-B');
  assert.equal(resolve(run(['rev-parse', '--show-toplevel'], created.snapshot)), created.snapshot);
});

test('refuses a mixed snapshot and retries boundedly without deleting the rejected attempt', async () => {
  const { source } = await fixture();
  const created = await createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, maxAttempts: 2,
    async onStage(stage, { attempt }) {
      if (stage === 'after-copy' && attempt === 1) await writeFile(join(source, 'packages', 'probe', 'src', 'index.mjs'), "export const value = 'retry-B';\n");
    } });
  assert.equal(created.manifest.attempt, 2);
  assert.equal(created.manifest.rejectedAttempts.length, 1);
  const rejected = JSON.parse(await readFile(created.manifest.rejectedAttempts[0].manifestPath, 'utf8'));
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error, /Concurrent source changes rejected/u);
  assert.equal(probe(created.snapshot).value, 'retry-B');
});

for (const variant of ['restored-content', 'new-file']) test(`detects concurrent ${variant} instead of trusting final content alone`, async () => {
  const { source } = await fixture();
  await assert.rejects(createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, maxAttempts: 1,
    async onStage(stage) {
      if (stage === 'after-copy') {
        if (variant === 'restored-content') {
          const file = join(source, 'packages', 'probe', 'src', 'index.mjs'), previous = await readFile(file);
          await writeFile(file, "export const value = 'temporary-B';\n"); await writeFile(file, previous);
        } else await writeFile(join(source, 'new-source.mjs'), 'export const fresh = 1;\n');
      }
    } }), error => {
    assert.match(error.message, /No consistent source snapshot/u);
    assert.match(error.rejectedAttempts[0].error, /Concurrent source changes rejected|Source changed while hashing/u);
    return true;
  });
});

test('refuses command wrappers containing an absolute live source path', async () => {
  const { source } = await fixture();
  await writeFile(join(source, 'node_modules', '.bin', 'live.cmd'), `@node "${join(source, 'packages', 'probe', 'src', 'index.mjs')}"\r\n`);
  await assert.rejects(createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, maxAttempts: 1 }), error => {
    assert.match(error.rejectedAttempts[0].error, /absolute live-repository path/u); return true;
  });
});

test('records explicit artifact and shared-Python limitations without copying private data', async () => {
  const { source } = await fixture();
  await mkdir(join(source, 'artifacts', 'router'), { recursive: true });
  await writeFile(join(source, 'artifacts', 'router', 'weights.bin'), 'SYNTHETIC_WEIGHTS');
  await mkdir(join(source, '.venv-execution', 'Lib', 'site-packages'), { recursive: true });
  await writeFile(join(source, '.venv-execution', 'Lib', 'site-packages', 'editable.pth'), join(source, 'packages') + '\n');
  const created = await createBrainTestSnapshot({ sourceRoot: source, shareArtifacts: ['artifacts/router'], maxAttempts: 1 });
  assert.equal(created.manifest.sharedInputs.artifacts.length, 1);
  assert.equal(created.manifest.sharedInputs.artifacts[0].files.length, 1);
  assert.equal(created.manifest.sharedInputs.venv.sourceIsolation, 'shared-or-unknown');
  assert.equal(created.manifest.sharedInputs.venv.editableInputs[0].mentionsOriginalRoot, true);
  assert.equal(await realpath(join(created.snapshot, 'artifacts', 'router')), join(source, 'artifacts', 'router'));
  await assert.rejects(createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, shareArtifacts: ['.data/private.txt'], maxAttempts: 1 }), /No consistent source snapshot/u);
  await writeFile(join(source, 'artifacts', 'router', '.ENV.private'), 'SYNTHETIC_PRIVATE_ARTIFACT');
  await assert.rejects(createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, shareArtifacts: ['artifacts/router'], maxAttempts: 1 }), error => {
    assert.match(error.rejectedAttempts[0].error, /private runtime data/u); return true;
  });
});

test('copies a pinned individual artifact without requiring a file-symlink privilege', async () => {
  const { source } = await fixture();
  await mkdir(join(source, 'artifacts', 'public'), { recursive: true });
  const original = join(source, 'artifacts', 'public', 'vocabulary.json');
  await writeFile(original, '["SYNTHETIC_PUBLIC_WORD"]');
  const created = await createBrainTestSnapshot({ sourceRoot: source, shareVenv: false, shareArtifacts: ['artifacts/public/vocabulary.json'], maxAttempts: 1 });
  const copied = join(created.snapshot, 'artifacts', 'public', 'vocabulary.json');
  assert.equal(await realpath(copied), copied);
  assert.equal(await readFile(copied, 'utf8'), '["SYNTHETIC_PUBLIC_WORD"]');
  assert.equal(created.manifest.sharedInputs.artifacts[0].materialization, 'copied-file');
  await writeFile(original, '["LATER_PUBLIC_EDIT"]');
  assert.equal(await readFile(copied, 'utf8'), '["SYNTHETIC_PUBLIC_WORD"]');
});

test('does not inherit production credentials, Node hooks, proxy routes or a parent Git worktree', () => {
  const environment = snapshotTestEnvironment(resolve(fixtureBase, 'env-only'), {
    PATH: 'synthetic-original-path', SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData', TEMP: 'synthetic-temp',
    DATABASE_URL: 'postgres://SYNTHETIC_SECRET', GROQ_API_KEY: 'SYNTHETIC_KEY', HTTP_PROXY: 'http://SYNTHETIC_PROXY',
    NODE_OPTIONS: '--require=SYNTHETIC_HOOK', GIT_DIR: 'SYNTHETIC_GIT', BETTER_AUTH_SECRET: 'SYNTHETIC_AUTH',
  });
  assert.equal(environment.DATABASE_URL, ''); assert.equal(environment.MOHASSAN_ISOLATED_TEST, 'true');
  assert.equal(environment.ProgramData, 'C:\\ProgramData');
  for (const key of ['GROQ_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'GIT_DIR', 'BETTER_AUTH_SECRET']) assert.equal(environment[key], undefined);
  const pathEntries = environment.PATH.split(delimiter);
  assert.equal(pathEntries[0], dirname(process.execPath));
  assert.equal(pathEntries[1], join(resolve(fixtureBase, 'env-only'), 'node_modules', '.bin'));
});
