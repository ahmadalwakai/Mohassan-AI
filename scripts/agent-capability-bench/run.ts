import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capabilityBaselineCommit, CapabilityCorpusError, isWithin, loadCapabilityCorpus } from './corpus.js';
import { withCapabilityHarness } from './observe.js';
import { failureStages, scoreCapabilityCase, summarizeCapability } from './score.js';
import { loadDevelopmentCapabilityCorpus } from './v2/dev.js';
import { loadSealedCapabilityCorpus } from './v2/sealed.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = resolve(root, 'tests/fixtures/agent-capability-bench');
const v2DevBundlePath = 'tests/fixtures/agent-capability-bench/v2/dev';
const git = promisify(execFile);

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--v2-dev' && !values.has(name)) {
      values.set(name, 'true');
      continue;
    }
    const value = args[++index];
    if (!['--version', '--development', '--manifest', '--sealed', '--output', '--baseline'].includes(name)
      || values.has(name) || !value || value.startsWith('--')) {
      throw new Error('Expected v1 options --manifest PATH --development PATH --output PATH and optional --sealed PATH, --version 2 --sealed PATH --output PATH with optional --baseline true, or --v2-dev with optional --output PATH and --baseline true.');
    }
    values.set(name, value);
  }
  const path = (name: string) => values.has(name) ? resolve(values.get(name)!) : undefined;
  const defaultOutput = () => resolve(root, 'artifacts/agent-capability-bench', `${randomUUID()}.json`);
  const baseline = values.has('--baseline');
  if (values.has('--v2-dev')) {
    if (['--version', '--development', '--manifest', '--sealed'].some(name => values.has(name))) {
      throw new Error('--v2-dev uses the committed development bundle and accepts only --output PATH and --baseline true.');
    }
    if (baseline && values.get('--baseline') !== 'true') throw new Error('Expected --baseline true.');
    return { version: '2', split: 'development', output: path('--output') ?? defaultOutput(), baseline } as const;
  }
  const version = values.get('--version') ?? '1';
  if (version !== '1' && version !== '2') throw new Error('The capability benchmark version must be 1 or 2.');
  if (version === '2') {
    const sealed = path('--sealed');
    const output = path('--output');
    if (!sealed || !output || values.has('--development') || values.has('--manifest')) {
      throw new Error('Capability v2 requires --sealed PATH and --output PATH and uses the pinned manifest.');
    }
    if (baseline && values.get('--baseline') !== 'true') throw new Error('Expected --baseline true.');
    return { version, split: 'sealed', sealed, output, baseline } as const;
  }
  if (baseline) throw new Error('--baseline is available only for capability v2.');
  return {
    version,
    manifest: path('--manifest') ?? resolve(fixtureDir, 'manifest.json'),
    development: path('--development') ?? resolve(fixtureDir, 'development.json'),
    sealed: path('--sealed'),
    output: path('--output') ?? defaultOutput(),
  } as const;
}

async function sourceRevision(baseline = false, development = false) {
  const [revision, status, lockfile] = await Promise.all([
    git('git', ['rev-parse', 'HEAD'], { cwd: root }),
    git('git', ['status', '--porcelain=v1', '-z', `--untracked-files=${baseline ? 'all' : 'normal'}`], { cwd: root }),
    readFile(resolve(root, 'package-lock.json')),
  ]);
  const gitCommit = revision.stdout.trim();
  const changes = status.stdout.split('\0').filter(Boolean);
  const allowedImports = ['?? scripts/agent-capability-bench/'];
  if (development) allowedImports.push(`?? ${v2DevBundlePath}/`);
  if (baseline && (gitCommit !== capabilityBaselineCommit || changes.some(change => !allowedImports.some(prefix => change.startsWith(prefix))))) {
    throw new CapabilityCorpusError(development
      ? 'Capability v2 development baseline requires the pinned commit with only untracked benchmark tooling and development fixtures.'
      : 'Capability v2 baseline requires the pinned commit with only untracked benchmark tooling.');
  }
  return {
    source: { gitCommit, worktreeClean: changes.length === 0, lockfileSha256: createHash('sha256').update(lockfile).digest('hex') },
    trackedWorktreeClean: changes.every(change => change.startsWith('?? ')),
  };
}

type Summary = ReturnType<typeof summarizeCapability>;

function table(summary: Summary, crossTab = false) {
  const percentage = (value: number) => `${(100 * value).toFixed(1)}%`;
  const milliseconds = (value: number | null) => value === null ? '–' : value.toFixed(1);
  const rows = [
    ['All', summary.overall] as const,
    ...Object.entries(summary.byArea).map(([key, row]) => [`Area / ${key}`, row] as const),
    ...Object.entries(summary.byLanguage).map(([key, row]) => [`Language / ${key}`, row] as const),
    ...Object.entries(summary.byVariety).map(([key, row]) => [`Variety / ${key}`, row] as const),
    ...(crossTab ? Object.entries(summary.byAreaAndLanguage).map(([key, row]) => [`Area / language / ${key}`, row] as const) : []),
  ];
  return [
    '| Group | Passed | Pass rate | Wilson 95% CI | p50 ms | p95 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([label, row]) => `| ${label} | ${row.passed}/${row.total} | ${row.rate === null ? '–' : percentage(row.rate)} | ${row.wilson95?.map(percentage).join('–') ?? '–'} | ${milliseconds(row.p50Ms)} | ${milliseconds(row.p95Ms)} |`),
  ].join('\n');
}

function failureTable(summary: Summary) {
  const { primaryFailureStages, anyFailureStages } = summary.overall;
  return [
    '| Stage | First failing stage | Cases with any failed check |',
    '| --- | ---: | ---: |',
    ...failureStages.map(stage => `| ${stage} | ${primaryFailureStages[stage]} | ${anyFailureStages[stage]} |`),
  ].join('\n');
}

function runtime() {
  return { node: process.version, platform: process.platform, architecture: process.arch,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function canonicalOutput(path: string): Promise<string> {
  const parent = dirname(path);
  const canonicalParent = await realpath(parent).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return canonicalOutput(parent);
  });
  return resolve(canonicalParent, basename(path));
}

async function checkDevelopmentOutput(path: string): Promise<void> {
  const [output, ...fixtures] = await Promise.all([
    canonicalOutput(path),
    ...['dev', 'sealed'].map(split => {
      const dir = resolve(fixtureDir, 'v2', split);
      return realpath(dir).catch(() => dir);
    }),
  ]);
  if (fixtures.some(directory => isWithin(directory, output))) {
    throw new CapabilityCorpusError('Capability v2 development reports require a path outside both fixture directories.');
  }
}

async function runV2(paths: Extract<ReturnType<typeof parseArgs>, { version: '2' }>, startedAt: string) {
  const development = paths.split === 'development';
  const { source, trackedWorktreeClean } = await sourceRevision(paths.baseline, development);
  if (development) await checkDevelopmentOutput(paths.output);
  const corpus = development ? await loadDevelopmentCapabilityCorpus(resolve(root, v2DevBundlePath)) : await loadSealedCapabilityCorpus({
    manifest: resolve(root, 'scripts/agent-capability-bench/v2/manifest.json'), sealed: paths.sealed,
  });
  if ('sealed' in corpus.manifest && corpus.manifest.sealed.caseCount !== 1_200) {
    throw new CapabilityCorpusError('The capability v2 release requires 1,200 sealed cases.');
  }
  const harnessFiles = ['run.ts', 'corpus.ts', 'observe.ts', 'score.ts', 'v2/mapping.ts', 'v2/sealed.ts'];
  if (development) harnessFiles.push('v2/dev.ts');
  const harnessSha256 = Object.fromEntries(await Promise.all(harnessFiles.map(async file => {
    const bytes = await readFile(resolve(root, 'scripts/agent-capability-bench', file));
    return [file, createHash('sha256').update(bytes).digest('hex')];
  })));
  harnessSha256[development ? `${v2DevBundlePath}/manifest.json` : 'v2/manifest.json'] = corpus.manifestSha256;
  await mkdir(dirname(paths.output), { recursive: true });
  const receipt = await open(paths.output, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CapabilityCorpusError('The capability v2 receipt already exists.');
    }
    throw error;
  });
  const reportControllerError = console.error;
  try {
    // Controller diagnostics can include details beyond the scored checks.
    console.error = () => {};
    const scores = await withCapabilityHarness(async observe => {
      const scores = [];
      for (const item of corpus.cases) scores.push(scoreCapabilityCase(item, await observe(item)));
      return scores;
    });
    const summary = summarizeCapability(scores);
    const report = {
      schemaVersion: 2, startedAt, finishedAt: new Date().toISOString(),
      source: { ...source, trackedWorktreeClean, baselineVerified: paths.baseline, harnessSha256 },
      manifest: corpus.manifest, runtime: runtime(), summary,
      ...(development ? { split: paths.split, scores } : {}),
    };
    await receipt.writeFile(JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });
    console.log(`${table(summary, true)}\n\n${failureTable(summary)}`);
  } finally {
    console.error = reportControllerError;
    await receipt.close();
  }
  console.log(development ? `\nDevelopment JSON report with per-case checks: ${paths.output}` : '\nAggregate JSON report written.');
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
    if (paths.version === '2') {
      await runV2(paths, startedAt);
      return 0;
    }
    const corpus = await loadCapabilityCorpus(paths);
    const { source } = await sourceRevision();
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
      runtime: runtime(),
      summary, splits: results,
    };
    await mkdir(dirname(paths.output), { recursive: true });
    await writeFile(paths.output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`${table(summary)}\n\n${failureTable(summary)}`);
    if (corpus.sealed) {
      for (const result of results) console.log(`\n${result.name}\n${table(result.summary)}\n\n${failureTable(result.summary)}`);
    }
    console.log(`\nJSON report with per-case checks: ${paths.output}`);
    return 0;
  } catch (error) {
    console.error(error instanceof CapabilityCorpusError ? error.message : 'Capability benchmark could not run or write its report.');
    return 1;
  }
}

process.exitCode = await main();
