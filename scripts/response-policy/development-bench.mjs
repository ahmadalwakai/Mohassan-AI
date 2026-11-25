import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../', import.meta.url));
const bench = 'scripts/agent-capability-bench';
const fixtures = 'tests/fixtures/agent-capability-bench';
const revisions = {
  v1: 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f',
  v2: '12cedfe592aab40cdd47ee00d05ea86a6d2bae89',
  audit: 'a1e1cb020b7ba093885edbf501149e7b8252c0cb',
  adapters: '0dfff7c54d3658a02cf878ff11faac7f630a6c10',
};
const commonSources = ['corpus.ts', 'observe.ts', 'score.ts'];
const versions = ['v1', 'v2'];
const policyFlags = ['MOHASSAN_REPLY_POLICY_ENABLED', 'MOHASSAN_CONTEXT_POLICY_ENABLED', 'MOHASSAN_LONG_RUN_ENABLED'];

function git(...args) {
  return execFileSync('git', args, { cwd: source, maxBuffer: 12_000_000 });
}

function extract(directory, revision, paths) {
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: git('archive', revision, '--', ...paths) });
}

async function prepare(output) {
  const v2Development = `${fixtures}/v2/dev`;
  assert.equal(git('rev-parse', `${revisions.v2}:${v2Development}`).toString().trim(),
    git('rev-parse', `${revisions.audit}:${v2Development}`).toString().trim());
  for (const version of versions) {
    const directory = join(output, version);
    await mkdir(directory, { recursive: true });
    const common = commonSources.map(file => `${bench}/${file}`);
    if (version === 'v1') {
      extract(directory, revisions.v1, [...common, `${fixtures}/manifest.json`, `${fixtures}/development.json`]);
    } else {
      extract(directory, revisions.audit, [...common, `${bench}/v2/dev.ts`, `${bench}/v2/sealed.ts`, `${bench}/v2/mapping.ts`]);
      extract(directory, revisions.v2, [v2Development]);
    }
    extract(directory, revisions.adapters, [`${bench}/by-branch.mjs`]);
    for (const directoryEntry of ['apps', 'node_modules', 'package.json']) {
      await symlink(join(source, directoryEntry), join(directory, directoryEntry));
    }
    const { adaptObserver } = await import(pathToFileURL(join(directory, bench, 'by-branch.mjs')).href);
    const path = join(directory, bench, 'observe.ts');
    const adapters = ['review', 'memory', ...(version === 'v2' ? ['clarification'] : [])];
    await writeFile(path, adaptObserver(await readFile(path, 'utf8'), adapters.map(adapter => ({ adapter })), 'on'));
  }
}

function workerEnvironment(mode) {
  const enabled = mode === 'on' ? '1' : '0';
  return {
    PATH: process.env.PATH,
    HOME: homedir(),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    TZ: 'UTC',
    VITEST: '1',
    MOHASSAN_SCRATCH_CLASSIFIERS: '0',
    MOHASSAN_SMALL_TALK_MANNERS: '1',
    MOHASSAN_CONVERSATION_REVIEW_APPLY: '1',
    MOHASSAN_CONVERSATION_SHADOW: 'decide',
    MOHASSAN_STRUCTURED_MEMORY: '1',
    MOHASSAN_EXTRACTIVE_WRITING: '1',
    MOHASSAN_PLAN_COMPILER: 'on',
    MOHASSAN_REASONING: '1',
    MOHASSAN_CLARIFY_CHOICES: '1',
    MOHASSAN_REFUSAL_POLICY: '1',
    TEST_DRIVEN_CODING_ENABLED: 'true',
    MOHASSAN_QUESTION_REWRITER: '1',
    ...Object.fromEntries(policyFlags.map(flag => [flag, enabled])),
  };
}

async function loadHarness(directory, version) {
  const load = file => import(pathToFileURL(join(directory, bench, file)).href);
  const { withCapabilityHarness } = await load('observe.ts');
  const scorer = await load('score.ts');
  const fixtureDirectory = join(directory, fixtures);
  if (version === 'v1') {
    const { loadCapabilityCorpus } = await load('corpus.ts');
    const { development, manifest } = await loadCapabilityCorpus({ manifest: join(fixtureDirectory, 'manifest.json'),
      development: join(fixtureDirectory, 'development.json') });
    return { cases: development, payloadSha256: manifest.development.sha256, withCapabilityHarness, ...scorer };
  }
  const { loadDevelopmentCapabilityCorpus } = await load('v2/dev.ts');
  const { cases, manifest } = await loadDevelopmentCapabilityCorpus(join(fixtureDirectory, 'v2/dev'));
  return { cases, payloadSha256: manifest.development.sha256, withCapabilityHarness, ...scorer };
}

async function disableLearnedRefusal() {
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    assert.ok(!/\/assistant\/refusal\/learned-model\.json$/u.test(result.url), 'The learned refusal weights must stay unloaded');
    if (!/\/assistant\/refusal\/learned-classifier\.[jt]s$/u.test(result.url)) return result;
    return { url: 'data:text/javascript,export const classifyLearnedRefusal = () => null; export const weightFree = true;', shortCircuit: true };
  } });
  const modulePath = join(source, 'apps/server/src/assistant/refusal/learned-classifier.ts');
  const replacement = await import(pathToFileURL(modulePath).href);
  assert.equal(replacement.weightFree, true);
}

async function worker(directory, version, lane, lanes, output, limit) {
  assert.ok(process.env.VITEST && process.env.MOHASSAN_SCRATCH_CLASSIFIERS === '0', 'Weight-free profile required');
  await disableLearnedRefusal();
  const { cases, payloadSha256, withCapabilityHarness, scoreCapabilityCase } = await loadHarness(directory, version);
  const { scoreReplyQuality } = await import('./reply-quality.ts');
  const rows = await withCapabilityHarness(async observe => {
    const rows = [];
    const scheduled = limit === 0 ? cases : cases.slice(0, limit);
    for (let index = lane; index < scheduled.length; index += lanes) {
      const item = scheduled[index];
      const observation = await observe(item);
      const previousReplies = [];
      const quality = [];
      for (const [turn, observed] of observation.turns.entries()) {
        assert.equal(observed.modelCalls, 0, 'Benchmark observer recorded a model call');
        assert.ok(!observed.boundaryCalls.some(call => call.tool === 'unexpected_fetch'), 'Benchmark observer recorded a network attempt');
        quality.push(scoreReplyQuality({ request: item.turns[turn].text, reply: observed.answer, previousReplies }));
        if (observed.answer.trim()) previousReplies.push(observed.answer);
      }
      rows.push({ index, score: scoreCapabilityCase(item, observation), quality });
    }
    return rows;
  });
  await writeFile(output, JSON.stringify({ payloadSha256, rows }), { mode: 0o600, flag: 'wx' });
}

function startWorker(directory, version, lane, lanes, output, mode, limit) {
  return new Promise((done, fail) => {
    const filename = join(output, `${mode}-${version}-${lane}`);
    const log = openSync(`${filename}.log`, 'wx', 0o600);
    const child = spawn(process.execPath, ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering', '--import', 'tsx',
      fileURLToPath(import.meta.url), 'worker', directory, version, String(lane), String(lanes), `${filename}.json`, String(limit)],
    { cwd: source, env: workerEnvironment(mode), stdio: ['ignore', log, log] });
    closeSync(log);
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (code === 0) done(readFile(`${filename}.json`, 'utf8').then(JSON.parse));
      else fail(new Error(`${mode} ${version} lane ${lane} exited ${code ?? signal}. See ${filename}.log.`));
    });
  });
}

function qualitySummary(rows, checks) {
  const groups = Object.fromEntries(['overall', 'ar', 'en'].map(language => [language, rows
    .filter(row => language === 'overall' || row.score.language === language).flatMap(row => row.quality)]));
  return Object.fromEntries(Object.entries(groups).map(([language, turns]) => [language,
    Object.fromEntries(checks.map(check => [check, {
      passed: turns.filter(turn => turn[check] === true).length,
      measured: turns.filter(turn => turn[check] !== null).length,
      skipped: turns.filter(turn => turn[check] === null).length,
    }]))]));
}

async function evaluate(output, version, mode, lanes, limit) {
  const sourceCommit = git('rev-parse', 'HEAD').toString().trim();
  const cleanBefore = git('status', '--porcelain').length === 0;
  const directory = join(output, version);
  const { summarizeCapability } = await import(pathToFileURL(join(directory, bench, 'score.ts')).href);
  const { replyQualityChecks } = await import('./reply-quality.ts');
  const parts = await Promise.all(Array.from({ length: lanes }, (_, lane) => startWorker(directory, version, lane, lanes, output, mode, limit)));
  assert.ok(parts.every(part => part.payloadSha256 === parts[0].payloadSha256));
  const rows = parts.flatMap(part => part.rows).sort((left, right) => left.index - right.index);
  assert.equal(rows.length, limit || (version === 'v1' ? 240 : 2400));
  assert.ok(rows.every((row, index) => row.index === index));
  const scores = rows.map(row => row.score);
  const receipt = {
    version, mode, sourceCommit, sourceClean: cleanBefore && git('status', '--porcelain').length === 0
      && git('rev-parse', 'HEAD').toString().trim() === sourceCommit,
    lockfileSha256: createHash('sha256').update(await readFile(join(source, 'package-lock.json'))).digest('hex'),
    payloadSha256: parts[0].payloadSha256, summary: summarizeCapability(scores), caseIds: scores.map(score => score.id),
    requiredContentFailures: scores.flatMap(score => score.failures
      .filter(failure => failure.stage === 'answer' && failure.check.startsWith('required-content-'))
      .map(failure => `${score.id}/${failure.turn}/${failure.check}`)),
    quality: qualitySummary(rows, replyQualityChecks),
  };
  await writeFile(join(output, `${mode}-${version}.json`), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`${mode} ${version}: ${receipt.summary.overall.passed}/${scores.length}`);
}

async function gate(output) {
  const results = [];
  for (const version of versions) {
    const [off, on] = await Promise.all(['off', 'on'].map(mode => readFile(join(output, `${mode}-${version}.json`), 'utf8').then(JSON.parse)));
    for (const field of ['version', 'sourceCommit', 'lockfileSha256', 'payloadSha256', 'caseIds']) assert.deepEqual(off[field], on[field]);
    assert.ok(off.sourceClean && on.sourceClean, 'Measure a clean checkout of one commit for both settings');
    assert.equal(off.caseIds.length, version === 'v1' ? 240 : 2400);
    const groups = [['Overall', { all: off.summary.overall }, { all: on.summary.overall }],
      ...['byArea', 'byLanguage', 'byAreaAndLanguage'].map(group => [group, off.summary[group], on.summary[group]])];
    const comparisons = groups.flatMap(([group, before, after]) => {
      assert.deepEqual(Object.keys(before), Object.keys(after));
      return Object.keys(before).map(name => {
        assert.equal(before[name].total, after[name].total);
        return { group, name, total: before[name].total, off: before[name].passed, on: after[name].passed };
      });
    });
    const previousContentFailures = new Set(off.requiredContentFailures);
    const newRequiredContentFailures = on.requiredContentFailures.filter(failure => !previousContentFailures.has(failure));
    results.push({ version, groups: comparisons, newRequiredContentFailures,
      latencyMs: Object.fromEntries([off, on].map(({ mode, summary: { overall } }) => [mode, { median: overall.p50Ms, p95: overall.p95Ms }])),
      quality: { off: off.quality, on: on.quality },
    });
  }
  console.log(JSON.stringify(results, null, 2));
  return results.some(({ groups, newRequiredContentFailures }) => newRequiredContentFailures.length > 0
    || groups.some(group => group.on < group.off)) ? 1 : 0;
}

const [command, directoryArg, ...args] = process.argv.slice(2);
assert.ok(directoryArg, 'Usage: development-bench.mjs {prepare|off|on|gate} OUTPUT_DIRECTORY [LANES]');
const directory = resolve(directoryArg);
if (command === 'prepare') await prepare(directory);
else if (command === 'worker') await worker(directory, args[0], Number(args[1]), Number(args[2]), args[3], Number(args[4]));
else if (command === 'gate') process.exitCode = await gate(directory);
else {
  assert.ok(command === 'off' || command === 'on', 'Expected off or on');
  const lanes = Number(args[0] ?? 4);
  const limit = Number(args[1] ?? 0);
  assert.ok(Number.isInteger(lanes) && lanes >= 1 && lanes <= 8);
  assert.ok(Number.isInteger(limit) && limit >= 0 && limit <= 240);
  for (const version of versions) await evaluate(directory, version, command, lanes, limit);
}
