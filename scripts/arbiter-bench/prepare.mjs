import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const v1 = 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f';
const v2 = '12cedfe592aab40cdd47ee00d05ea86a6d2bae89';
const audit = 'a1e1cb020b7ba093885edbf501149e7b8252c0cb';
const observer = '0dfff7c54d3658a02cf878ff11faac7f630a6c10';
const bench = 'scripts/agent-capability-bench';
const fixtures = 'tests/fixtures/agent-capability-bench';
const v1Dev = `${fixtures}/development.json`;
const v2Dev = `${fixtures}/v2/dev`;
const root = fileURLToPath(new URL('../../', import.meta.url));

const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readPinned = (revision, file) => git('show', `${revision}:${file}`);

function put(target, path, bytes) {
  const destination = resolve(target, path);
  if (existsSync(destination) && !readFileSync(destination).equals(Buffer.from(bytes))) {
    throw new Error(`Conflicting worktree file: ${path}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('Frozen observer no longer matches the replay adapter.');
  return source.replace(from, to);
}

async function main(target, option) {
  if (!target || (option !== undefined && option !== '--capture')) {
    throw new Error('Usage: node scripts/arbiter-bench/prepare.mjs DETACHED_WORKTREE [--capture]');
  }
  target = resolve(target);
  const state = execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
  if (branch !== 'HEAD' || state) throw new Error('Prepare an initially clean detached worktree.');
  const observedDev = readPinned(v1, v1Dev);
  if (digest(observedDev) !== '712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b') {
    throw new Error('V1 development checksum mismatch.');
  }
  git('diff', '--exit-code', v2, audit, '--', v2Dev);
  put(target, v1Dev, observedDev);
  put(target, `${fixtures}/manifest.json`, readPinned(v1, `${fixtures}/manifest.json`));
  const devFiles = git('ls-tree', '-rz', '--name-only', v2, '--', v2Dev).toString().split('\0').filter(Boolean);
  for (const path of devFiles) put(target, path, readPinned(v2, path));

  const byBranch = resolve(target, 'scripts/arbiter-bench-v1/by-branch.mjs');
  put(target, 'scripts/arbiter-bench-v1/by-branch.mjs', readPinned(observer, `${bench}/by-branch.mjs`));
  const { adaptObserver } = await import(pathToFileURL(byBranch).href);
  for (const [version, revision] of [[1, v1], [2, v2]]) {
    const destination = `scripts/arbiter-bench-v${version}`;
    const imports = ['corpus.ts', 'score.ts'];
    if (version === 2) imports.push('v2/dev.ts', 'v2/sealed.ts', 'v2/mapping.ts');
    for (const path of imports) put(target, `${destination}/${path}`, readPinned(revision, `${bench}/${path}`));
    const adapters = ['review', 'memory', ...(version === 2 ? ['clarification'] : [])];
    let source = adaptObserver(readPinned(revision, `${bench}/observe.ts`).toString(), adapters.map(adapter => ({ adapter })), 'on');
    if (option === '--capture') {
      source = "import { beginArbiterReplayTurn } from '../../apps/server/src/assistant/model-relations-arbiter.js';\n" + source;
      source = replaceOnce(source, 'for (const turn of item.turns) {',
        'for (const turn of item.turns) {\n      beginArbiterReplayTurn();');
    }
    put(target, `${destination}/observe.ts`, source);
  }
  console.log(`Prepared pinned v1 and v2 development tooling in ${target}; capture ${option === '--capture' ? 'enabled' : 'disabled'}.`);
}

await main(...process.argv.slice(2));
