import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseRef = 'feat/agent-capability-bench';
const bench = 'scripts/agent-capability-bench';
const observer = `${bench}/observe.ts`;
const fixtures = 'tests/fixtures/agent-capability-bench';

const known = [
  [23, 'arabic-understanding-core', 'MOHASSAN_ARABIC_UNDERSTANDING', '0', '1'],
  [24, 'plan-compiler', 'MOHASSAN_PLAN_COMPILER', 'off', 'on'],
  [25, 'answer-selection', 'MOHASSAN_ANSWER_SELECTION', '0', '1'],
  [26, 'reasoning-engine-2', 'MOHASSAN_REASONING', '0', '1'],
  [27, 'truth-checks', 'MOHASSAN_JUDGE_TRUTH', '0', '1', 'truth'],
  [28, 'conversation-reviewer', 'MOHASSAN_CONVERSATION_REVIEW_APPLY', '0', '1', 'review'],
  [30, 'feedback-loop'],
  [31, 'structured-memory', 'MOHASSAN_STRUCTURED_MEMORY', '0', '1', 'memory'],
  [32, 'clarify-choices', 'MOHASSAN_CLARIFY_CHOICES', '0', '1', 'clarification'],
  [33, 'extractive-writing', 'MOHASSAN_EXTRACTIVE_WRITING', '0', '1'],
  [34, 'browser-hands-2', 'CommandChatConfig.browserHands', 'unset', 'on', 'browser'],
  [35, 'conversation-state-decides', 'MOHASSAN_CONVERSATION_SHADOW', '0', 'decide'],
].map(([pr, name, flag, off, on, adapter]) => ({ pr, branch: `feat/${name}`, flag, off, on, adapter }));

const optional = new Map([
  ['feat/deliberation-core', {
    pr: 37, flag: 'CommandChatConfig.deliberationEnabled', off: 'false', on: 'true', adapter: 'deliberation',
  }],
  ['feat/offline-knowledge', { pr: 38 }],
  ['feat/refusal-policy', { pr: 39, flag: 'MOHASSAN_REFUSAL_POLICY', off: '0', on: '1' }],
  ['feat/small-talk-manners', null],
]);

const fetchArgs = ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'];
const refsArgs = ['for-each-ref', '--format=%(refname:strip=3) %(objectname)', 'refs/remotes/origin/'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function call(program, args, cwd, env, input) {
  const result = spawnSync(program, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not start ${program} (${result.error.code}).`);
  if (result.status === null) throw new Error(`${program} stopped (${result.signal}).`);
  return result;
}

function runChild(program, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', error => reject(new Error(`Could not start ${program} (${error.code}).`)));
    child.once('close', (status, signal) => {
      if (status === null) reject(new Error(`${program} stopped (${signal}).`));
      else resolve({ status, log: Buffer.concat([...stdout, ...stderr]) });
    });
  });
}

function git(cwd, args, env, input) {
  const result = call('git', args, cwd, env, input);
  if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}.`);
  return result.stdout.trim();
}

export function inspectMerge(cwd, left, right) {
  const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', left, right];
  const result = call('git', args, cwd);
  const [tree, ...files] = result.stdout.trimEnd().split('\n');
  if (![0, 1].includes(result.status) || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`git merge-tree exited ${result.status} for ${left} and ${right}.`);
  }
  if (result.status === 1 && !files.length) throw new Error('Merge conflict did not report any paths.');
  return { left, right, tree, files, command: ['git', ...args] };
}

function commitMerge(cwd, merge, env) {
  const args = ['commit-tree', merge.tree, '-p', merge.left, '-p', merge.right];
  const message = 'Local capability benchmark scratch merge\n';
  return { ...merge, commit: git(cwd, args, env, message), commitCommand: ['git', ...args], message };
}

export function combinedOrder(branches, conflicts) {
  const blocked = new Set(conflicts.map(({ first, second }) => `${first}\0${second}`));
  let largest = [];
  function search(from, selected) {
    if (selected.length > largest.length) largest = selected;
    for (let index = from; index < branches.length; index++) {
      if (selected.length + branches.length - index <= largest.length) break;
      const candidate = branches[index];
      if (selected.every(branch => !blocked.has(`${branch.branch}\0${candidate.branch}`))) {
        search(index + 1, [...selected, candidate]);
      }
    }
  }
  search(0, []);
  return [...largest, ...branches.filter(branch => !largest.includes(branch))];
}

export function experimentPlan(branches, combined) {
  return [
    { name: 'baseline', branches: [], setting: 'off', sealed: true },
    ...branches.flatMap(branch => [
      ...(branch.flag ? [{ name: `pr-${branch.pr ?? branch.branch.slice(5)}-off`, branches: [branch], setting: 'off', sealed: false }] : []),
      { name: `pr-${branch.pr ?? branch.branch.slice(5)}-on`, branches: [branch], setting: 'on', sealed: true },
    ]),
    ...(combined.length ? [{ name: 'combined', branches: combined, setting: 'on', sealed: true }] : []),
  ];
}

export function flagValues(branches, setting) {
  return Object.fromEntries(branches.filter(branch => branch.flag).map(branch => [branch.flag, branch[setting]]));
}

function replaceLine(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('The frozen observer no longer matches a configuration adapter.');
  return source.replace(from, () => to);
}

export function adaptObserver(source, branches, setting) {
  const adapters = new Set(branches.map(branch => branch.adapter));
  let adapted = source;
  if (adapters.has('truth')) {
    adapted = replaceLine(adapted, "judgeShadow: { logFile: '', observe: judge",
      "judgeShadow: { logFile: '', truthEnabled: process.env.MOHASSAN_JUDGE_TRUTH === '1', observe: judge");
  }
  if (adapters.has('review')) {
    adapted = "import { conversationReviewForJudge } from '../../apps/server/src/assistant/review/publication.js';\n" + adapted;
    adapted = replaceLine(adapted, 'observe: judge, async flush() {}', `observe(input) {
        const verdict = judge(input);
        const applied = Boolean(input.applyFix && verdict.decision === 'fix' && verdict.fixedReply?.trim())
          || Boolean(input.applyWithhold && verdict.decision === 'withhold' && verdict.withholdText?.trim());
        conversationReviewForJudge(input, verdict, applied);
        return verdict;
      }, async flush() {}`);
  }
  if (adapters.has('memory')) {
    adapted = "import { migrateStructuredMemory } from '../../apps/server/src/assistant/structured-memory-migration.js';\n" + adapted;
    adapted = replaceLine(adapted, 'await memoryMigration(database.db);',
      'await memoryMigration(database.db);\n    await migrateStructuredMemory(database.db);');
  }
  if (adapters.has('clarification')) {
    adapted = "import { clarifyDesktopFile } from '../../apps/server/src/assistant/clarify/host.js';\n" + adapted;
    adapted = replaceLine(adapted, 'parse: parseDesktopCommand, describe: describeDesktopCommand,',
      'parse: text => clarifyDesktopFile(text, parseDesktopCommand), describe: describeDesktopCommand,');
  }
  if (adapters.has('browser') && setting === 'on') {
    adapted = replaceLine(adapted, '...web, tools, recordExperiences:',
      "...web, browserHands: 'on', tools, recordExperiences:");
  }
  if (adapters.has('deliberation')) {
    adapted = "import { createMemoryHitReader } from '../../apps/server/src/assistant/deliberation/memory-evidence.js';\n" + adapted;
    adapted = replaceLine(adapted, 'tools, recordExperiences:',
      `tools, deliberationEnabled: ${setting === 'on'}, deliberationMemoryHit: createMemoryHitReader(memory), recordExperiences:`);
  }
  return adapted;
}

export function extractSummaries(report, expected) {
  const { commit, sealed, manifest, lockfileSha256, adapted } = expected;
  const splitNames = sealed ? ['development', 'sealed'] : ['development'];
  if (report.schemaVersion !== 1 || report.source.gitCommit !== commit
    || report.source.worktreeClean !== !adapted || report.source.lockfileSha256 !== lockfileSha256
    || report.sealedIncluded !== sealed || report.splits.map(split => split.name).join() !== splitNames.join()
    || report.manifest.baselineCommit !== manifest.baselineCommit) {
    throw new Error('Runner report does not match the planned revision, instrumentation or splits.');
  }
  return Object.fromEntries(report.splits.map(({ name, summary }) => {
    if (report.manifest[name].sha256 !== manifest[name].sha256 || summary.overall.total !== manifest[name].caseCount
      || summary.byLanguage.ar?.total !== manifest[name].arabicCount) {
      throw new Error('Runner report does not match the frozen corpus.');
    }
    return [name, summary];
  }));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function measure(cwd, output, experiment, commit, manifest, runtimeEnv) {
  const path = join(cwd, observer);
  const original = readFileSync(path, 'utf8');
  const adapted = adaptObserver(original, experiment.branches, experiment.setting);
  const flags = flagValues(experiment.branches, experiment.setting);
  const env = { ...runtimeEnv, ...Object.fromEntries(Object.entries(flags).filter(([flag]) => flag.startsWith('MOHASSAN_'))) };
  const reportPath = join(output, `${experiment.name}.json`);
  const args = ['--import', 'tsx', `${bench}/run.ts`, '--output', reportPath];
  if (experiment.sealed) args.push('--sealed', `${fixtures}/holdout/sealed.json`);
  const record = {
    name: experiment.name, commit, sealed: experiment.sealed, flags, command: ['node', ...args],
    environment: { ...env }, observerSha256: sha256(adapted), observerAdapted: adapted !== original,
  };

  if (adapted !== original) writeFileSync(path, adapted);
  try {
    const started = performance.now();
    const result = await runChild('node', args, cwd, env);
    record.wallMs = performance.now() - started;
    record.exitCode = result.status;
    writeFileSync(join(output, `${experiment.name}.log`), result.log);
    if (result.status !== 0) return record;
    const report = readJson(reportPath);
    record.splits = extractSummaries(report, {
      commit, sealed: experiment.sealed, manifest, lockfileSha256: sha256(readFileSync(join(cwd, 'package-lock.json'))),
      adapted: adapted !== original,
    });
    record.lockfileSha256 = report.source.lockfileSha256;
    record.startedAt = report.startedAt;
    record.finishedAt = report.finishedAt;
    record.runtime = report.runtime;
    return record;
  } finally {
    if (adapted !== original) writeFileSync(path, original);
  }
}

function parseArgs(args) {
  const extend = args[0] === '--extend';
  const [output, browsers, cache, ...extras] = args.slice(extend ? 1 : 0);
  if (!output || !browsers || !cache || extras.length % 4) {
    throw new Error('Usage: node scripts/agent-capability-bench/by-branch.mjs [--extend] OUTPUT BROWSERS NPM_CACHE [OPTIONAL_BRANCH ENV OFF ON]...');
  }
  const overrides = new Map();
  for (let i = 0; i < extras.length; i += 4) {
    const [branch, flag, off, on] = extras.slice(i, i + 4);
    if (!optional.has(branch) || optional.get(branch) || !/^MOHASSAN_[A-Z0-9_]+$/.test(flag) || off === on
      || known.some(item => item.flag === flag) || overrides.has(branch)
      || [...overrides.values()].some(item => item.flag === flag)) {
      throw new Error('Invalid or duplicate optional feature flag.');
    }
    overrides.set(branch, { branch, flag, off, on });
  }
  return { output: resolve(output), browsers: resolve(browsers), cache: resolve(cache), overrides, extend };
}

export function pendingExperiments(plan, existingRuns) {
  return plan.filter(experiment => {
    const existing = existingRuns.find(run => run.name === experiment.name);
    if (!existing) return true;
    if (existing.commit !== experiment.commit || existing.sealed !== experiment.sealed
      || JSON.stringify(existing.flags) !== JSON.stringify(flagValues(experiment.branches, experiment.setting))) {
      throw new Error(`Recorded run ${experiment.name} does not match the pinned experiment.`);
    }
    return false;
  });
}

async function main(args) {
  const options = parseArgs(args);
  if (!options.extend) mkdirSync(options.output, { mode: 0o700 });
  const lock = join(options.output, '.running');
  mkdirSync(lock);
  try {
    return await runBatch(options, args);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

async function runBatch({ output, browsers, cache, overrides, extend }, args) {
  const previous = extend ? readJson(join(output, 'results.json')) : undefined;
  const pinned = new Map(previous?.branches.map(branch => [branch.branch, branch]));
  if (previous && (previous.schemaVersion !== 1 || !previous.runs.some(run => run.name === 'baseline' && run.splits))) {
    throw new Error('Extension requires a measurement ledger with a completed baseline.');
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  git(root, fetchArgs);
  const refs = new Map(git(root, refsArgs).split('\n').map(line => line.split(' ')));
  const base = previous?.base ?? refs.get(baseRef);
  if (!base) throw new Error(`Missing origin/${baseRef}.`);
  const features = [...known];
  const absent = [];
  for (const [branch, feature] of optional) {
    if (pinned.has(branch)) features.push(pinned.get(branch));
    else if (!refs.has(branch)) absent.push(branch);
    else if (feature) features.push({ branch, ...feature });
    else if (overrides.has(branch)) features.push(overrides.get(branch));
    else throw new Error(`Provide the documented flag settings for origin/${branch}.`);
  }
  const branches = features.map(feature => {
    const head = pinned.get(feature.branch)?.head ?? refs.get(feature.branch);
    if (!head) throw new Error(`Missing origin/${feature.branch}.`);
    return { ...feature, head };
  });
  const frozenFiles = [observer, `${bench}/run.ts`, `${bench}/corpus.ts`, `${bench}/score.ts`, fixtures];
  const frozen = git(root, ['ls-tree', '-r', base, '--', ...frozenFiles]);
  const manifest = JSON.parse(git(root, ['show', `${base}:${fixtures}/manifest.json`]));
  const date = git(root, ['show', '-s', '--format=%cI', base]);
  const identity = {
    GIT_AUTHOR_NAME: 'Capability benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
    GIT_COMMITTER_NAME: 'Capability benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  };
  const mergeEnv = { ...process.env, ...identity };
  const merges = Object.fromEntries(branches.map(branch => {
    const merge = inspectMerge(root, base, branch.head);
    return [branch.branch, merge.files.length ? merge : commitMerge(root, merge, mergeEnv)];
  }));
  const clean = branches.filter(branch => merges[branch.branch].commit);
  const pairwise = clean.flatMap((first, i) => clean.slice(i + 1).map(second => ({
    first: first.branch, second: second.branch, ...inspectMerge(root, first.head, second.head),
  })));
  const combined = [];
  const combinedMerges = [];
  let combinedCommit = base;
  for (const branch of combinedOrder(clean, pairwise.filter(pair => pair.files.length))) {
    const merge = inspectMerge(root, combinedCommit, branch.head);
    const attempt = merge.files.length ? merge : commitMerge(root, merge, mergeEnv);
    combinedMerges.push({ branch: branch.branch, ...attempt });
    if (attempt.commit) {
      combined.push(branch);
      combinedCommit = attempt.commit;
    }
  }

  const combinedRun = previous
    ? (previous.combinedCommit === combinedCommit ? previous.combinedRun ?? 'combined' : `combined-${combinedCommit.slice(0, 12)}`)
    : 'combined';
  const plan = experimentPlan(clean, combined).map(experiment => {
    const commit = experiment.name === 'baseline' ? base : experiment.name === 'combined'
      ? combinedCommit : merges[experiment.branches[0].branch].commit;
    const name = experiment.name === 'combined' ? combinedRun : experiment.name;
    return { ...experiment, name, commit };
  });
  const pending = pendingExperiments(plan, previous?.runs ?? []);
  const groups = [
    pending.filter(item => item.name === 'baseline'),
    ...clean.map(branch => pending.filter(item => item.branches[0] === branch && item.name !== combinedRun)),
    pending.filter(item => item.name === combinedRun),
  ].filter(group => group.length);
  const scratch = mkdtempSync(join(tmpdir(), 'capability-by-branch-'));
  const jobs = Math.min(4, groups.length);
  const runtimeEnv = { PATH: process.env.PATH, TZ: 'UTC', PLAYWRIGHT_BROWSERS_PATH: browsers, TMPDIR: scratch };
  const installArgs = ['ci', '--no-audit', '--no-fund', '--cache', cache];
  const installEnv = { ...runtimeEnv, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  const ledger = {
    schemaVersion: 1, base, branches, absent, manifest, identity,
    jobs: Math.max(jobs, previous?.jobs ?? 0),
    launchCommands: [...(previous?.launchCommands ?? []), ['node', `${bench}/by-branch.mjs`, ...args]],
    gitVersion: git(root, ['--version']), fetchCommand: ['git', ...fetchArgs], refsCommand: ['git', ...refsArgs],
    merges, pairwise, combinedMerges, combined: combined.map(branch => branch.branch), combinedCommit,
    combinedRun, installs: previous?.installs ?? [], runs: previous?.runs ?? [],
  };
  const save = () => {
    writeFileSync(join(output, 'results.tmp'), JSON.stringify(ledger, null, 2) + '\n');
    renameSync(join(output, 'results.tmp'), join(output, 'results.json'));
  };
  save();
  let next = 0;
  async function worker(lane) {
    const cwd = join(scratch, `checkout-${lane}`);
    git(root, ['worktree', 'add', '--detach', cwd, base]);
    try {
      let installedTree;
      while (next < groups.length) {
        for (const experiment of groups[next++]) {
          const { commit } = experiment;
          if (git(root, ['ls-tree', '-r', commit, '--', ...frozenFiles]) !== frozen) {
            throw new Error(`Frozen benchmark files changed on ${experiment.name}.`);
          }
          git(cwd, ['checkout', '--detach', commit]);
          const dependencies = git(cwd, ['ls-tree', '-r', commit]).split('\n')
            .filter(line => /[\t/](?:package\.json|package-lock\.json)$/.test(line)).join('\n');
          if (dependencies !== installedTree) {
            const install = await runChild('npm', installArgs, cwd, installEnv);
            ledger.installs.push({ cwd, commit, command: ['npm', ...installArgs], environment: installEnv, exitCode: install.status });
            writeFileSync(join(output, `install-${ledger.installs.length}.log`), install.log);
            save();
            if (install.status !== 0) throw new Error(`Dependency install exited ${install.status} in lane ${lane}.`);
            installedTree = dependencies;
          }
          const record = await measure(cwd, output, experiment, commit, manifest, runtimeEnv);
          ledger.runs.push({ cwd, lane, ...record });
          save();
          console.log(`${record.name} exited ${record.exitCode}`);
        }
      }
    } finally {
      git(root, ['worktree', 'remove', '--force', cwd]);
    }
  }
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: jobs }, (_, lane) => worker(lane + 1)));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failures.length) throw new Error(failures.map(outcome => outcome.reason.message).join(' '));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return Number(ledger.runs.some(run => run.exitCode !== 0) || clean.length !== branches.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
