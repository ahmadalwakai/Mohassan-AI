import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CapabilityCorpusError, loadCapabilityCorpus } from './corpus.js';
import { withCapabilityHarness } from './observe.js';
import { scoreCapabilityCase, summarizeCapability } from './score.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = resolve(root, 'tests/fixtures/agent-capability-bench');
const git = promisify(execFile);

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!['--development', '--manifest', '--sealed', '--output'].includes(name) || values.has(name) || !value || value.startsWith('--')) {
      throw new Error('Expected --manifest PATH --development PATH --output PATH and optional --sealed PATH.');
    }
    values.set(name, resolve(value));
  }
  return {
    manifest: values.get('--manifest') ?? resolve(fixtureDir, 'manifest.json'),
    development: values.get('--development') ?? resolve(fixtureDir, 'development.json'),
    sealed: values.get('--sealed'),
    output: values.get('--output') ?? resolve(root, 'artifacts/agent-capability-bench', `${randomUUID()}.json`),
  };
}

async function sourceRevision() {
  const [revision, status, lockfile] = await Promise.all([
    git('git', ['rev-parse', 'HEAD'], { cwd: root }),
    git('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root }),
    readFile(resolve(root, 'package-lock.json')),
  ]);
  return { gitCommit: revision.stdout.trim(), worktreeClean: !status.stdout.trim(),
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex') };
}

type Summary = ReturnType<typeof summarizeCapability>;

function table(summary: Summary) {
  const percentage = (value: number) => `${(100 * value).toFixed(1)}%`;
  const milliseconds = (value: number | null) => value === null ? '–' : value.toFixed(1);
  const rows = [
    ['All', summary.overall] as const,
    ...Object.entries(summary.byArea).map(([key, row]) => [`Area / ${key}`, row] as const),
    ...Object.entries(summary.byLanguage).map(([key, row]) => [`Language / ${key}`, row] as const),
    ...Object.entries(summary.byVariety).map(([key, row]) => [`Variety / ${key}`, row] as const),
  ];
  return [
    '| Group | Passed | Pass rate | Wilson 95% CI | p50 ms | p95 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([label, row]) => `| ${label} | ${row.passed}/${row.total} | ${row.rate === null ? '–' : percentage(row.rate)} | ${row.wilson95?.map(percentage).join('–') ?? '–'} | ${milliseconds(row.p50Ms)} | ${milliseconds(row.p95Ms)} |`),
  ].join('\n');
}

async function main() {
  let paths: ReturnType<typeof parseArgs>;
  try { paths = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  try {
    const startedAt = new Date().toISOString();
    const corpus = await loadCapabilityCorpus(paths);
    const source = await sourceRevision();
    const partitions = [
      { name: 'development', cases: corpus.development },
      ...(corpus.sealed ? [{ name: 'sealed', cases: corpus.sealed }] : []),
    ];
    const results = await withCapabilityHarness(async observe => {
      const results = [];
      for (const { name, cases } of partitions) {
        const scores = [];
        for (const item of cases) scores.push(scoreCapabilityCase(item, await observe(item)));
        results.push({ name, scores, summary: summarizeCapability(scores) });
      }
      return results;
    });
    const summary = summarizeCapability(results.flatMap(({ scores }) => scores));
    const report = {
      schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
      source, manifest: corpus.manifest, sealedIncluded: !!corpus.sealed,
      runtime: { node: process.version, platform: process.platform, architecture: process.arch,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      summary, splits: results,
    };
    await mkdir(dirname(paths.output), { recursive: true });
    await writeFile(paths.output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(table(summary));
    if (corpus.sealed) for (const result of results) console.log(`\n${result.name}\n${table(result.summary)}`);
    console.log(`\nJSON report with per-case checks: ${paths.output}`);
    return 0;
  } catch (error) {
    console.error(error instanceof CapabilityCorpusError ? error.message : 'Capability benchmark could not run or write its report.');
    return 1;
  }
}

process.exitCode = await main();
