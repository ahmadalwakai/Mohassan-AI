import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { adaptCapabilityObserver } from './by-branch-adapters.js';
import { candidates, optionalBranches, type Candidate } from './by-branch-candidates.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const toolDir = 'scripts/agent-capability-bench';
const collector = `${toolDir}/collect-paired-outcomes.ts`;
const runner = `${toolDir}/measure-by-branch.ts`;
const sealDirectory = 'tests/fixtures/agent-capability-bench/v2/sealed';
const seal = `${sealDirectory}/payload.json`;
const baselineCommit = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b';
const baseRef = 'test/capability-bench-v2-human';
const expectedPayload = '6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf';
const expectedManifest = 'c7ab3fbe2340053fca18ed892da1f248fc5fb92ffbc76d14cf2d2300aa20daf6';
const npmArgs = ['ci', '--no-audit', '--no-fund', '--prefer-offline'];
const toolFiles = [collector, `${toolDir}/by-branch-adapters.ts`];

export type FrozenLane = {
  name: string;
  commit: string;
  mergeCommit: string;
  candidate?: Candidate;
};
export type FrozenStudy = {
  baseCommit: string;
  releaseCommit: string;
  absentBranches: string[];
  commands: string[];
  collectorHashes: Record<string, string>;
  lanes: FrozenLane[];
};
export type LaneRecord = {
  commands: string[];
  receiptSha256?: string;
  failure?: string;
};

export type MeasureOptions = { mode: 'measure' | 'report'; directory: string; jobs: number; browsers?: string; output?: string; checks?: string };

export function parseMeasureArgs(args: string[]): MeasureOptions {
  const [mode, ...settings] = args;
  const values = new Map<string, string>();
  for (let index = 0; index < settings.length; index += 2) {
    const key = settings[index]!, value = settings[index + 1];
    if (!['--directory', '--jobs', '--browsers', '--output', '--checks'].includes(key) || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('Invalid or repeated measurement option.');
    }
    values.set(key, value);
  }
  const directory = values.get('--directory');
  const output = values.get('--output');
  const checks = values.get('--checks');
  const browsers = values.get('--browsers');
  const jobs = Number(values.get('--jobs') ?? '1');
  if (!directory || !Number.isSafeInteger(jobs) || jobs < 1 || (mode === 'measure' && (!browsers || output || checks))
    || (mode === 'report' && (!output || browsers || values.has('--jobs'))) || (mode !== 'measure' && mode !== 'report')) {
    throw new Error('Use measure --directory PATH --browsers PATH [--jobs N], or report --directory PATH --output PATH [--checks PATH].');
  }
  return { mode, directory: resolve(directory), jobs, browsers: browsers && resolve(browsers), output: output && resolve(output), checks: checks && resolve(checks) };
}

export function originHeads(output: string): Map<string, string> {
  return new Map(output.trim().split('\n').flatMap(line => {
    const [hash, ref] = line.split('\t');
    return hash && /^[a-f0-9]{40}$/u.test(hash) && ref?.startsWith('refs/heads/') ? [[ref.slice(11), hash]] : [];
  }));
}

export function listedCandidates(heads: ReadonlyMap<string, string>) {
  const absentBranches: string[] = [];
  for (const branch of optionalBranches) {
    if (heads.has(branch)) throw new Error(`Origin has ${branch}. Record its verified PR flags and setup in the candidate list before freezing.`);
    absentBranches.push(branch);
  }
  const available = candidates.flatMap(candidate => {
    const commit = heads.get(candidate.branch);
    if (commit) return [{ candidate, commit }];
    if (!candidate.optional) throw new Error(`Required candidate is absent on origin: ${candidate.branch}`);
    absentBranches.push(candidate.branch);
    return [];
  });
  if (new Set(available.map(({ commit }) => commit)).size !== available.length) {
    throw new Error('Two candidate refs point to the same commit. Resolve duplicate frozen tips before measuring.');
  }
  return { available, absentBranches };
}

const shell = (value: string) => /^[\w./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const spell = (argv: readonly string[]) => argv.map(shell).join(' ');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashFile = async (path: string) => sha256(await readFile(path));
const isInside = (directory: string, path: string) => {
  const suffix = relative(directory, path);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
};
const git = async (args: string[], cwd = root) => (await exec('git', args, { cwd })).stdout.trim();
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

export async function reserveAttempt(directory: string, commit: string) {
  const path = join(directory, `${commit}.attempt`);
  const marker = await open(path, 'wx', 0o600);
  try { await marker.writeFile(`${new Date().toISOString()}\n`); }
  finally { await marker.close(); }
}

async function withLog(command: string, args: string[], cwd: string, path: string, env?: NodeJS.ProcessEnv) {
  const log = await open(path, 'wx', 0o600);
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) done();
        else reject(new Error(`${command} exited ${code ?? signal}`));
      });
    });
  } finally { await log.close(); }
}

async function freezeStudy(directory: string, browsers: string, invocation: string): Promise<FrozenStudy> {
  const branches = [baseRef, ...candidates.map(candidate => candidate.branch), ...optionalBranches];
  const ls = ['ls-remote', '--heads', 'origin', ...branches];
  const heads = originHeads(await git(ls));
  const releaseCommit = heads.get(baseRef);
  if (!releaseCommit) throw new Error(`Origin does not have ${baseRef}.`);
  const { available, absentBranches } = listedCandidates(heads);
  const fetch = ['fetch', '--no-tags', 'origin', releaseCommit, ...available.map(({ commit }) => commit)];
  await git(fetch);
  const baseCommit = await git(['rev-parse', 'HEAD']);
  await git(['merge-base', '--is-ancestor', releaseCommit, baseCommit]);
  await git(['diff', '--quiet', releaseCommit, baseCommit, '--', sealDirectory, toolDir,
    `:(exclude)${toolDir}/by-branch-*.ts`, `:(exclude)${collector}`, `:(exclude)${runner}`,
    `:(exclude)${toolDir}/write-by-branch-report.ts`]);
  const date = await git(['show', '-s', '--format=%cI', baseCommit]);
  const stamp = {
    GIT_AUTHOR_NAME: 'Capability benchmark', GIT_AUTHOR_EMAIL: 'capability-benchmark@example.invalid', GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'Capability benchmark', GIT_COMMITTER_EMAIL: 'capability-benchmark@example.invalid', GIT_COMMITTER_DATE: date,
  };
  const commands = [invocation, spell(['git', ...ls]), spell(['git', ...fetch])];
  const lanes: FrozenLane[] = [{ name: 'baseline', commit: baselineCommit, mergeCommit: baselineCommit }];
  for (const { candidate, commit } of available) {
    let tree: string;
    try { tree = await git(['merge-tree', '--write-tree', baseCommit, commit]); }
    catch { throw new Error(`Scratch merge conflicted before sealed evaluation: ${candidate.branch}`); }
    await git(['diff', '--quiet', baseCommit, tree, '--', toolDir, 'tests/fixtures/agent-capability-bench']);
    const args = ['commit-tree', tree, '-p', baseCommit, '-p', commit, '-m', `Scratch capability v2: ${candidate.branch}`];
    const mergeCommit = (await exec('git', args, { cwd: root, env: { ...process.env, ...stamp } })).stdout.trim();
    commands.push(spell(['git', 'merge-tree', '--write-tree', baseCommit, commit]));
    commands.push(spell(['env', ...Object.entries(stamp).map(([key, value]) => `${key}=${value}`), 'git', ...args]));
    lanes.push({ name: `pr-${candidate.pr}`, candidate, commit, mergeCommit });
  }
  const collectorHashes = Object.fromEntries(await Promise.all(toolFiles.map(async file => [file, await hashFile(join(root, file))])));
  const study = { baseCommit, releaseCommit, absentBranches, commands, collectorHashes, lanes };
  await save(join(directory, 'study.json'), { ...study, browsers });
  return study;
}

async function measureLane(study: FrozenStudy, lane: FrozenLane, directory: string, browsers: string) {
  const results = join(directory, 'receipts');
  const attempts = join(directory, 'attempts');
  const record = join(results, `${lane.name}.json`);
  const receipt = join(results, `${lane.name}.paired.json`);
  const commands: string[] = [];
  const scratch = join(directory, 'worktrees', lane.name);
  const flags = Object.entries(lane.candidate?.flags ?? {});
  const environment = [['TZ', 'Europe/London'], ['PLAYWRIGHT_BROWSERS_PATH', browsers], ...flags];
  const env = { PATH: process.env.PATH, ...Object.fromEntries(environment) };
  const runArgs = ['--import', 'tsx', collector];
  const adapterArgs = lane.candidate?.adapter ? ['--adapted-observer', 'true'] : [];
  const invokeCollector = async (args: string[], log: string) => {
    const command = spell([...environment.map(([key, value]) => `${key}=${value}`), 'node', ...runArgs, ...args]);
    commands.push(`(cd ${shell(scratch)} && env -i PATH="$PATH" ${command})`);
    await withLog('node', [...runArgs, ...args], scratch, join(results, `${lane.name}.${log}.log`), env);
  };
  let failure = 'scratch preparation';
  try {
    const add = ['worktree', 'add', '--detach', scratch, lane.mergeCommit];
    commands.push(spell(['git', ...add]));
    await git(add);
    if (!lane.candidate) {
      const archive = ['archive', study.releaseCommit, toolDir];
      const tar = ['-x', '-C', scratch];
      commands.push(`${spell(['git', ...archive])} | ${spell(['tar', ...tar])}`);
      const { stdout } = await exec('git', archive, { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      const tarProcess = spawn('tar', tar, { stdio: ['pipe', 'ignore', 'inherit'] });
      const closed = new Promise<void>((done, reject) => {
        tarProcess.once('error', reject);
        tarProcess.once('close', code => code === 0 ? done() : reject(new Error('Benchmark tooling extraction failed.')));
      });
      tarProcess.stdin.end(stdout);
      await closed;
    }
    const target = join(scratch, collector);
    await copyFile(join(root, collector), target, constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (await hashFile(target) !== study.collectorHashes[collector]) throw new Error('Collector changed after freeze.');
    if (lane.candidate?.adapter) {
      const observer = await readFile(join(scratch, toolDir, 'observe.ts'), 'utf8');
      const adapted = adaptCapabilityObserver(observer, [lane.candidate.adapter]);
      await writeFile(join(scratch, toolDir, 'by-branch-observe.ts'), adapted, { flag: 'wx' });
    }
    failure = 'locked dependency install';
    const install = [...npmArgs, '--cache', join(directory, 'npm-cache')];
    commands.push(`(cd ${shell(scratch)} && ${spell(['npm', ...install])})`);
    await withLog('npm', install, scratch, join(results, `${lane.name}.install.log`));
    failure = 'offline harness preflight';
    await invokeCollector(['--preflight', 'true', '--output', join(results, `${lane.name}.preflight.json`), ...adapterArgs], 'preflight');
    failure = 'frozen input verification';
    if (await git(['rev-parse', 'HEAD'], scratch) !== lane.mergeCommit) throw new Error('Scratch commit changed.');
    await git(['diff', '--quiet', 'HEAD', '--'], scratch);
    if (await hashFile(target) !== study.collectorHashes[collector]) throw new Error('Collector changed after preflight.');
    const manifest = join(scratch, toolDir, 'v2/manifest.json');
    if (await hashFile(manifest) !== expectedManifest) throw new Error('The release manifest pin changed.');
    failure = 'sealed attempt reservation';
    await reserveAttempt(attempts, lane.commit);
    failure = 'sealed collector';
    const sealed = join(root, seal);
    await invokeCollector(['--sealed', sealed, '--output', receipt, ...adapterArgs, ...(!lane.candidate ? ['--baseline', 'true'] : [])], 'sealed');
    await save(record, { commands, receiptSha256: await hashFile(receipt) } satisfies LaneRecord);
    console.log(`${lane.name} complete`);
  } catch {
    await save(record, { commands, failure } satisfies LaneRecord);
    console.log(`${lane.name} failed during ${failure}. See private study logs.`);
  }
}

async function measure(options: MeasureOptions, invocation: string) {
  const directory = options.directory;
  const browsers = await realpath(options.browsers!);
  await mkdir(directory, { mode: 0o700 });
  const privateDirectory = await realpath(directory);
  if (isInside(root, privateDirectory)) throw new Error('Put the private study directory outside the repository.');
  const study = await freezeStudy(privateDirectory, browsers, invocation);
  if (await hashFile(join(root, seal)) !== expectedPayload) throw new Error('The release payload pin changed.');
  await Promise.all(['worktrees', 'receipts', 'attempts'].map(name => mkdir(join(privateDirectory, name), { mode: 0o700 })));
  const pending = [...study.lanes];
  await Promise.all(Array.from({ length: Math.min(options.jobs, pending.length) }, async () => {
    while (pending.length) await measureLane(study, pending.shift()!, privateDirectory, browsers);
  }));
  const records = await Promise.all(study.lanes.map(lane => json<LaneRecord>(join(directory, 'receipts', `${lane.name}.json`))));
  if (records.some(record => record.failure)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = parseMeasureArgs(args);
    const invocation = spell(['node', '--import', 'tsx', runner, ...args]);
    if (options.mode === 'measure') await measure(options, invocation);
    else await (await import('./write-by-branch-report.js')).writeStudyReport(options, invocation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Capability branch measurement failed.');
    process.exitCode = 1;
  }
}
