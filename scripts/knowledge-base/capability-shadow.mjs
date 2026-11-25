import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDirectory = resolve(root, 'tests/fixtures/agent-capability-bench');
const benchmarkRevision = 'a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f';

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function scratchRevision() {
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, stdio: 'ignore' });
  const merge = spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (branch.status !== 1 || merge.status !== 0 || merge.stdout.trim() !== benchmarkRevision) {
    throw new Error(`Create a detached scratch worktree and merge ${benchmarkRevision} with --no-commit --no-ff.`);
  }
  return { head: git('rev-parse', 'HEAD'), mergeHead: merge.stdout.trim() };
}

async function knowledgeSourceFingerprint() {
  const source = 'packages/knowledge-base/src';
  const files = (await readdir(resolve(root, source))).filter(name => name.endsWith('.ts')).sort();
  files.unshift('scripts/knowledge-base/capability-shadow.mjs');
  const fingerprints = await Promise.all(files.map(async name => {
    const path = name.includes('/') ? name : `${source}/${name}`;
    return [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')];
  }));
  return createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
}

function summarize(rows) {
  const count = predicate => rows.filter(predicate).length;
  const statuses = ['answered', 'abstained', 'choice', 'error'];
  return {
    total: rows.length,
    baselineFullPass: count(row => row.baseline.passed),
    baselineContentPass: count(row => row.baseline.contentPass),
    shadowContentPass: count(row => row.shadow.contentPass),
    shadowDatedAnswer: count(row => row.shadow.datedEvidence),
    shadowCitedContentPass: count(row => row.shadow.contentPass && row.shadow.datedEvidence),
    shadowWrongContent: count(row => row.shadow.result.status === 'answered' && !row.shadow.contentPass),
    shadowStatuses: Object.fromEntries(statuses.map(status => [status, count(row => row.shadow.result.status === status)])),
  };
}

function grouped(rows, key) {
  return Object.fromEntries([...new Set(rows.map(key))].sort().map(value => [
    value, summarize(rows.filter(row => key(row) === value)),
  ]));
}

function hasDatedEvidence(result) {
  return result.status === 'answered' && result.facts.length > 0 && result.facts.every(fact =>
    fact.statement.property === fact.property && Array.isArray(fact.references) &&
    fact.references.length === fact.statement.references.length &&
    Array.isArray(fact.dates.qualifiers) && Array.isArray(fact.dates.references) &&
    /^https:\/\/www\.wikidata\.org\/wiki\//u.test(fact.source.url) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(fact.dates.snapshot) && fact.dates.snapshot === fact.source.dumpDate,
  );
}

async function main() {
  const { values } = parseArgs({
    options: { index: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.index || !values.output) {
    throw new Error('Expected --index PATH for the read-only Wikidata index and --output PATH for a new report.');
  }
  const revision = scratchRevision();
  const [{ loadCapabilityCorpus }, { withCapabilityHarness }, { includesLiteral, includesNumber, scoreCapabilityCase }, knowledgeApi] =
    await Promise.all([
      import('../agent-capability-bench/corpus.ts'),
      import('../agent-capability-bench/observe.ts'),
      import('../agent-capability-bench/score.ts'),
      import('../../packages/knowledge-base/src/index.ts'),
    ]);
  const { openKnowledgeBase, createKnowledgeQaShadow } = knowledgeApi;
  const corpus = await loadCapabilityCorpus({
    manifest: resolve(fixtureDirectory, 'manifest.json'),
    development: resolve(fixtureDirectory, 'development.json'),
    sealed: resolve(fixtureDirectory, 'holdout/sealed.json'),
  });
  const partitions = { development: corpus.development, sealed: corpus.sealed };
  const contentPass = (answer, expectation) => expectation.requiredContent.every(requirement => {
    const match = requirement.match === 'number' ? includesNumber : includesLiteral;
    return requirement.anyOf.some(value => match(answer, value));
  }) && expectation.forbiddenContent.every(value => !includesLiteral(answer, value));
  const knowledge = openKnowledgeBase(resolve(values.index));
  try {
    const logs = new Map();
    const shadow = createKnowledgeQaShadow({ knowledge, log: report => logs.set(report.runId, report) });
    const cases = await withCapabilityHarness(async observe => {
      const rows = [];
      for (const [split, items] of Object.entries(partitions)) {
        for (const item of items.filter(item => item.area === 'factual')) {
          if (item.turns.length !== 1) throw new Error(`Expected one turn in capability case ${item.id}.`);
          const [turn] = item.turns;
          const observation = await observe(item);
          const answer = observation.turns[0]?.answer ?? '';
          const score = scoreCapabilityCase(item, observation);
          shadow.observe({ question: turn.text, answer, runId: item.id, language: item.language });
          await shadow.flush();
          const log = logs.get(item.id);
          if (!log || log.answer !== answer) throw new Error(`Missing side-by-side shadow log for ${item.id}.`);
          rows.push({
            id: item.id, split, language: item.language, variety: item.variety,
            explicitUrl: /\bhttps?:\/\//iu.test(turn.text),
            baseline: { passed: score.passed, contentPass: contentPass(answer, turn.expect), failures: score.failures },
            shadow: {
              contentPass: log.result.status === 'answered' && contentPass(log.result.text.split('\n', 1)[0], turn.expect),
              datedEvidence: hasDatedEvidence(log.result),
              ...log,
            },
          });
          logs.delete(item.id);
        }
      }
      return rows;
    });
    const summary = {
      overall: summarize(cases),
      bySplit: grouped(cases, row => row.split),
      byLanguage: grouped(cases, row => row.language),
      bySourceRequest: grouped(cases, row => row.explicitUrl ? 'explicit-url' : 'no-url'),
    };
    const report = {
      revision,
      runtime: process.version,
      lockfileSha256: createHash('sha256').update(await readFile(resolve(root, 'package-lock.json'))).digest('hex'),
      knowledgeSourceSha256: await knowledgeSourceFingerprint(),
      capabilities: corpus.manifest,
      wikidata: knowledge.card,
      summary,
      cases,
    };
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    knowledge.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Capability shadow benchmark failed.');
  process.exitCode = 1;
}
