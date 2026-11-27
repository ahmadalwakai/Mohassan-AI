import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatConversation } from '@mohassan/contracts';
import { modelRegistry, resolveModel } from '../../packages/model-relations/src/registry.js';
import { FixtureClient, observeRun, startMeasureFixture } from '../perf/fixture.js';
import { councilCorrect, readCouncilCases } from './council-cases.js';
import { directChildren, processFields } from './council-resources.js';

const protectedPath = /(?:^|\/)(?:artifacts\/brain-lab\/holdout-v1|artifacts\/chat-training\/conversation-v1\/holdout)(?:\/|$)/iu;
const support = new Set(['reading-v3-last', 'reading-v4-hn-last', 'chat-v4']);

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function stageOwnModel(source: string, target: string, id: string) {
  const selected = modelRegistry.find(entry => entry.id === id);
  if (!selected || !support.has(id) || selected.runtime !== 'python-worker' || selected.resources.gpu) {
    throw new Error('This council adapter needs a registered CPU reader or chat-v4.');
  }
  const entries = [selected];
  const files = new Map<string, number>();
  for (const entry of entries) {
    for (const dependency of entry.dependencies) {
      const item = modelRegistry.find(candidate => candidate.id === dependency.id && candidate.version === dependency.version);
      if (!item || !support.has(item.id) || item.runtime !== 'python-worker' || item.resources.gpu) {
        throw new Error('Unsupported council model dependency.');
      }
      if (!entries.includes(item)) entries.push(item);
    }
    for (const artifact of entry.artifacts) {
      const original = path.resolve(source, artifact.path);
      const destination = path.resolve(target, artifact.path);
      if (artifact.env || artifact.workerConfigField || artifact.pin || protectedPath.test(original)
        || !within(source, original) || !within(target, destination)) throw new Error('Unsupported model artifact reference.');
      if (files.has(artifact.path)) continue;
      const local = await realpath(original);
      if (!within(source, local) || protectedPath.test(local)) throw new Error('Model artifacts must stay in the local model store.');
      const info = await stat(local);
      if (!info.isFile()) throw new Error('Expected a regular local model artifact.');
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(local, destination, 'file');
      files.set(artifact.path, info.size);
    }
  }
  const pins = [];
  for (const entry of entries) {
    const resolved = await resolveModel(entry, target, {}, true);
    if (resolved.state === 'absent' || resolved.artifacts.some(item => !item.sha256 || item.matchesPin === false)) {
      throw new Error('Could not verify selected council model artifacts.');
    }
    pins.push({ model: entry.id, version: entry.version, artifacts: resolved.artifacts.map(item => ({ role: item.role, sha256: item.sha256 })) });
  }
  return { bytes: [...files.values()].reduce((sum, value) => sum + value, 0), pins };
}

async function cpuTicks(pid: number | undefined): Promise<number | null> {
  if (!pid || process.platform !== 'linux') return null;
  const fields = await processFields(pid);
  // Fields 14 and 15 are utime and stime.
  // https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (retrieved 2026-11-27).
  const ticks = Number(fields[11]) + Number(fields[12]);
  if (!Number.isFinite(ticks)) throw new Error('Could not sample API CPU usage.');
  return ticks;
}

async function memoryBytes(pid: number | undefined, key: 'VmHWM' | 'VmRSS'): Promise<number | null> {
  if (!pid || process.platform !== 'linux') return null;
  const source = await readFile(`/proc/${pid}/status`, 'utf8');
  const kb = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'mu').exec(source)?.[1];
  // https://man7.org/linux/man-pages/man5/proc_pid_status.5.html (retrieved 2026-11-27).
  return kb ? Number(kb) * 1024 : null;
}

async function residentModelBytes(pid: number | undefined): Promise<number | null> {
  if (!pid || process.platform !== 'linux') return null;
  const children = await directChildren(pid);
  const measurements = await Promise.all(children.map(async child => {
    try {
      const argv = await readFile(`/proc/${child}/cmdline`, 'utf8');
      return argv.split('\0').some(arg => arg.endsWith('/packages/execution-integration/model_worker/worker.py'))
        ? await memoryBytes(Number(child), 'VmRSS') : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }));
  const found = measurements.filter((bytes): bytes is number => bytes !== null);
  return found.length ? found.reduce((sum, bytes) => sum + bytes, 0) : null;
}

interface Settings {
  cases: string;
  family: string;
  output: string;
  store: string;
  apiPort: number;
  ticksPerSecond: number | null;
  environment: Record<string, string>;
  inputs: Record<string, string>;
  model?: { id: string; root: string; python: string };
}

const input = process.argv[2];
if (!input) throw new Error('Missing council scorecard settings.');
const settings: Settings = JSON.parse(await readFile(input, 'utf8'));
const cases = readCouncilCases(await readFile(settings.cases, 'utf8'));
const model = settings.model ? await stageOwnModel(settings.model.root, settings.store, settings.model.id) : null;
const switches = { ...settings.environment, RUN_WORKER: 'false', DESKTOP_ENGINE: 'false', MOHASSAN_MODEL_WORKER: '0',
  MOHASSAN_V5_CHAT: 'off', MOHASSAN_ROUTER_SHADOW: '0',
  MOHASSAN_MODEL_COUNCIL: model ? 'owner' : settings.environment.MOHASSAN_MODEL_COUNCIL ?? 'off',
};
const fixture = await startMeasureFixture({ withWeb: false, apiPort: settings.apiPort, webPort: settings.apiPort - 1000,
  environment: { ...switches,
    ...(settings.model ? { MOHASSAN_MODELS_ROOT: settings.store, EXECUTOR_PYTHON: settings.model.python } : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
  } });
const rows = [];
let peakRss: number | null = null;
let resident: number | null = null;
try {
  const client = new FixtureClient(fixture);
  await client.signIn();
  for (const [index, item] of cases.entries()) {
    // Use the same pacing, observation interval and deadline as the original council questions runner.
    if (index) await delay(8_000);
    const before = settings.ticksPerSecond ? await cpuTicks(fixture.apiPid) : null;
    const observation = await observeRun(client, { text: item.text }, { pollMs: 300, timeoutMs: 180_000 });
    const after = settings.ticksPerSecond ? await cpuTicks(fixture.apiPid) : null;
    const rss = await memoryBytes(fixture.apiPid, 'VmHWM');
    if (rss !== null) peakRss = Math.max(peakRss ?? 0, rss);
    const worker = model ? await residentModelBytes(fixture.apiPid) : null;
    if (worker !== null) resident = Math.max(resident ?? 0, worker);
    const detail = await client.call<ChatConversation>('GET', `/api/chat/conversations/${observation.conversationId}`);
    const message = detail.messages.findLast(item => item.role === 'assistant');
    const members = message?.council?.members.map(item => ({ model: item.model, outcome: item.outcome, round: item.round })) ?? [];
    rows.push({ case_id: item.id, family: settings.family, language: item.language,
      correct: !observation.timedOut && councilCorrect(item.expected, observation.answer), status: observation.status,
      first_progress_ms: observation.progress[0]?.firstSeenMs ?? null,
      final_answer_ms: observation.answer !== null && !observation.timedOut ? observation.settleMs : null,
      cpu_ms_per_turn: before !== null && after !== null && settings.ticksPerSecond ? (after - before) * 1000 / settings.ticksPerSecond : null,
      members,
    });
  }
} finally {
  await fixture.stop();
  await writeFile(settings.output, JSON.stringify({ rows, inputs: settings.inputs, switches, peak_rss_bytes: peakRss, model, resident_worker_bytes: resident,
    machine: { platform: platform(), kernel: release(), architecture: process.arch, cpu: cpus()[0]?.model ?? 'unknown',
      cpu_count: availableParallelism(), memory_bytes: totalmem(), node: process.version,
      latency_scope: 'isolated API, observation at HTTP boundary', cpu_scope: 'isolated API process only',
      rss_scope: 'isolated API process high-water mark', worker_scope: 'maximum sampled resident model worker RSS after a turn' },
  }, null, 2), { flag: 'wx', mode: 0o600 });
}
