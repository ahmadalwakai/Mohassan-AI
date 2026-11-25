import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CapabilityCaseOutcome } from './by-branch-statistics.js';
import { capabilityBaselineCommit, CapabilityCorpusError } from './corpus.js';
import type { CapabilityCase } from './corpus.js';
import type { CapabilityCaseObservation } from './observe.js';
import { scoreCapabilityCase, summarizeCapability } from './score.js';
import { loadSealedCapabilityCorpus } from './v2/sealed.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = promisify(execFile);
const usage = 'Expected --sealed PATH --output PATH with optional --baseline true, or --preflight true --output PATH. Both modes support --adapted-observer true except when --baseline true is set.';

export function parseCollectorArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!['--sealed', '--output', '--baseline', '--preflight', '--adapted-observer'].includes(name)
      || values.has(name) || !value || value.startsWith('--')) {
      throw new CapabilityCorpusError(usage);
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const sealed = values.get('--sealed');
  const baseline = values.get('--baseline');
  const preflight = values.get('--preflight');
  const adapted = values.get('--adapted-observer');
  if (adapted !== undefined && (adapted !== 'true' || baseline !== undefined)) throw new CapabilityCorpusError(usage);
  const observer = adapted ? 'by-branch-observe.ts' : 'observe.ts';
  if (output && sealed && preflight === undefined && (baseline === undefined || baseline === 'true')) {
    return { mode: 'sealed', sealed: resolve(sealed), output: resolve(output), baseline: baseline === 'true', observer } as const;
  }
  if (output && preflight === 'true' && sealed === undefined && baseline === undefined) {
    return { mode: 'preflight', output: resolve(output), observer } as const;
  }
  throw new CapabilityCorpusError(usage);
}

export async function collectOutcomes(
  cases: readonly CapabilityCase[],
  observe: (item: CapabilityCase) => Promise<CapabilityCaseObservation>,
) {
  const scores = [];
  for (const item of cases) scores.push(scoreCapabilityCase(item, await observe(item)));
  const outcomes: CapabilityCaseOutcome[] = scores.map(({ id, area, language, passed }) => ({ id, area, language, passed }));
  return { outcomes, summary: summarizeCapability(scores) };
}

async function hash(path: string) {
  return createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
}

async function sourceRevision(verifyBaseline: boolean, observer: 'observe.ts' | 'by-branch-observe.ts') {
  const harnessFiles = ['collect-paired-outcomes.ts', observer, 'corpus.ts', 'score.ts', 'v2/mapping.ts', 'v2/sealed.ts', 'v2/manifest.json'];
  const [revision, status, lockfileSha256, harnessHashes] = await Promise.all([
    git('git', ['rev-parse', 'HEAD'], { cwd: root }),
    git('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root }),
    hash('package-lock.json'),
    Promise.all(harnessFiles.map(async file => [file, await hash(`scripts/agent-capability-bench/${file}`)] as const)),
  ]);
  const gitCommit = revision.stdout.trim();
  const changes = status.stdout.split('\0').filter(Boolean);
  const trackedWorktreeClean = changes.every(change => change.startsWith('?? '));
  if (verifyBaseline && (gitCommit !== capabilityBaselineCommit
    || changes.some(change => !change.startsWith('?? scripts/agent-capability-bench/')))) {
    throw new CapabilityCorpusError('The baseline requires the pinned product commit with only untracked benchmark tooling.');
  }
  return {
    gitCommit, trackedWorktreeClean, worktreeClean: changes.length === 0, baselineVerified: verifyBaseline,
    lockfileSha256, harnessSha256: Object.fromEntries(harnessHashes),
  };
}

export async function writeUnusedReceipt(path: string, collect: () => Promise<unknown>) {
  await mkdir(dirname(path), { recursive: true });
  const receipt = await open(path, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CapabilityCorpusError('The paired outcome receipt already exists.');
    }
    throw error;
  });
  try {
    await receipt.writeFile(`${JSON.stringify(await collect(), null, 2)}\n`, 'utf8');
  } finally {
    await receipt.close();
  }
}

type WithCapabilityHarness = typeof import('./observe.js').withCapabilityHarness;

async function withoutDiagnostics<T>(observer: string, collect: (harness: WithCapabilityHarness) => Promise<T>) {
  const { debug, error, info, log, warn } = console;
  // Controller diagnostics may include inputs or responses. Keep both modes quiet.
  console.debug = console.error = console.info = console.log = console.warn = () => {};
  try {
    const observerModule = `./${observer.replace(/\.ts$/u, '.js')}`;
    const { withCapabilityHarness } = await import(observerModule) as { withCapabilityHarness: WithCapabilityHarness };
    return await collect(withCapabilityHarness);
  } finally {
    Object.assign(console, { debug, error, info, log, warn });
  }
}

export type PairedOutcomeReceipt = Awaited<ReturnType<typeof collectOutcomes>> & {
  schemaVersion: 1;
  partition: 'v2-sealed';
  startedAt: string;
  finishedAt: string;
  source: Awaited<ReturnType<typeof sourceRevision>>;
  runtime: { node: string; platform: NodeJS.Platform; architecture: string; timeZone: string };
  payloadSha256: string;
  manifestSha256: string;
};

async function runCollector(args: readonly string[]) {
  const options = parseCollectorArgs(args);
  const startedAt = new Date().toISOString();
  const runtime = { node: process.version, platform: process.platform, architecture: process.arch,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const source = await sourceRevision(options.mode === 'sealed' && options.baseline, options.observer);
  if (options.mode === 'sealed' && !source.trackedWorktreeClean) {
    throw new CapabilityCorpusError('Paired sealed measurement requires a clean tracked worktree.');
  }

  await writeUnusedReceipt(options.output, async () => {
    if (options.mode === 'preflight') {
      await withoutDiagnostics(options.observer, harness => harness(async observe => {
        // Exercise per-case controller setup without sending any input or loading a corpus.
        const { turns } = await observe({ id: 'setup-probe', turns: [] });
        if (turns.length !== 0) throw new CapabilityCorpusError('The capability harness controller setup failed.');
      }));
      return { schemaVersion: 1, partition: 'setup-preflight', startedAt, finishedAt: new Date().toISOString(), runtime, source };
    }

    const corpus = await loadSealedCapabilityCorpus({
      manifest: resolve(root, 'scripts/agent-capability-bench/v2/manifest.json'), sealed: options.sealed,
    });
    const { caseCount, arabicCount, sha256: payloadSha256 } = corpus.manifest.sealed;
    if (caseCount !== 1_200 || arabicCount !== 600) {
      throw new CapabilityCorpusError('Paired measurement requires the 1,200-case capability v2 release.');
    }
    const results = await withoutDiagnostics(options.observer, harness => harness(observe => collectOutcomes(corpus.cases, observe)));
    return { schemaVersion: 1, partition: 'v2-sealed', startedAt, finishedAt: new Date().toISOString(),
      runtime, source, payloadSha256, manifestSha256: corpus.manifestSha256, ...results } satisfies PairedOutcomeReceipt;
  });
  console.log('Paired outcome receipt written.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCollector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof CapabilityCorpusError ? error.message : 'Could not collect paired outcomes.');
    process.exitCode = 1;
  }
}
