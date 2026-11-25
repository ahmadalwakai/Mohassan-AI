import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  TRAINING_SPEED_GUARD_RATIO,
  type TrainingAttempt,
  type TrainingGpuLock,
  type TrainingRun,
  type TrainingRuns,
  type TrainingRunStatus,
  type TrainingSpeed,
} from '@mohassan/contracts';

const TAIL_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const RECENT_RUNS = 5;
const AVERAGE_SECONDS = 30 * 60;
const BASELINE_SECONDS = 60;
const SAMPLE_SECONDS = 5;
const RUN_STATES = new Set<string>([
  'running', 'completed', 'early_stopped', 'failed', 'paused_by_stop_file', 'paused_time_limit', 'interrupted',
]);

type JsonObject = Record<string, unknown>;
type Checkpoint = NonNullable<TrainingRun['lastCheckpoint']>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function parseObject(line: string): JsonObject | null {
  try {
    return object(JSON.parse(line));
  } catch {
    return null;
  }
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestamp(value: unknown): string | null {
  const text = string(value);
  return text === null ? null : isoDate(Date.parse(text));
}

function isoDate(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function runStatus(value: unknown): TrainingRunStatus | null {
  return typeof value === 'string' && RUN_STATES.has(value) ? value as TrainingRunStatus : null;
}

async function fileInfo(path: string) {
  return lstat(path).catch(() => null);
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function readWindow(path: string, limit: number, tail: boolean) {
  if (!(await fileInfo(path))?.isFile()) return null;
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || (!tail && info.size > limit)) return null;
      const size = Math.min(info.size, limit);
      const position = tail ? info.size - size : 0;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, position);
      return { text: buffer.toString('utf8', 0, bytesRead), position, modifiedAt: info.mtimeMs };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<JsonObject | null> {
  const file = await readWindow(path, MAX_JSON_BYTES, false);
  return file && parseObject(file.text);
}

export async function readTrainingJsonlTail(path: string): Promise<JsonObject[]> {
  const file = await readWindow(path, TAIL_BYTES, true);
  if (!file) return [];
  const start = file.position > 0 ? file.text.indexOf('\n') : -1;
  if (file.position > 0 && start === -1) return [];
  const rows: JsonObject[] = [];
  for (const line of file.text.slice(start + 1).split('\n')) {
    if (!line) continue;
    const row = parseObject(line);
    if (row) rows.push(row);
  }
  return rows;
}

function speedSample(row: JsonObject) {
  const rate = number(row.tokens_per_second);
  const time = timestamp(row.time);
  if (rate === null || time === null) return null;
  return {
    rate, time, activeSeconds: number(row.active_training_seconds),
    firstMinute: number(row.first_minute_tokens_per_second),
    consecutiveSlowSeconds: number(row.consecutive_slow_seconds),
  };
}

type SpeedSample = NonNullable<ReturnType<typeof speedSample>>;
type AccumulateSpeed = (key: string, samples: SpeedSample[]) => SpeedSample[];

function summarizeSpeed(samples: SpeedSample[]): TrainingSpeed | null {
  const latest = samples.at(-1);
  if (!latest) return null;
  const earliestTime = Date.parse(latest.time) - AVERAGE_SECONDS * 1000;
  let weightedRate = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    let weight: number;
    if (latest.activeSeconds !== null && sample.activeSeconds !== null) {
      // The trainer measures a 60-second baseline, then emits a sample every five active seconds.
      const sampleSeconds = sample.activeSeconds <= BASELINE_SECONDS ? sample.activeSeconds : SAMPLE_SECONDS;
      const secondsInsideWindow = sample.activeSeconds - Math.max(0, latest.activeSeconds - AVERAGE_SECONDS);
      weight = Math.min(sampleSeconds, secondsInsideWindow);
    } else {
      weight = Date.parse(sample.time) >= earliestTime ? 1 : 0;
    }
    if (weight <= 0) continue;
    weightedRate += sample.rate * weight;
    totalWeight += weight;
  }
  const firstMinute = latest.firstMinute && latest.firstMinute > 0 ? latest.firstMinute : null;
  const guardLine = firstMinute === null ? null : firstMinute * TRAINING_SPEED_GUARD_RATIO;
  return {
    current: latest.rate,
    average30Minutes: totalWeight > 0 ? weightedRate / totalWeight : latest.rate,
    averageWindowSeconds: latest.activeSeconds === null ? null : Math.min(AVERAGE_SECONDS, totalWeight),
    firstMinute,
    guardLine,
    distanceFromGuardLine: guardLine === null ? null : latest.rate - guardLine,
    consecutiveSlowSeconds: latest.consecutiveSlowSeconds,
    sampledAt: latest.time,
  };
}

function validation(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value) ?? {}).filter(
    (entry): entry is [string, number] => /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(entry[0]) && number(entry[1]) !== null,
  ));
}

function validationRows(rows: JsonObject[]) {
  return rows.map(row => ({ step: count(row.step), losses: validation(row.validation) }))
    .filter(row => Object.keys(row.losses).length > 0);
}

function bestValidation(results: Record<string, number>[]): Record<string, number> {
  const best: Record<string, number> = {};
  for (const result of results) {
    for (const [language, loss] of Object.entries(result)) best[language] = Math.min(best[language] ?? Infinity, loss);
  }
  return best;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

async function attemptLocation(root: string, artifacts: string, shapePath: string, reference: unknown) {
  const name = string(reference);
  if (!name) return null;
  const normalized = name.replace(/[\\/]/g, sep);
  for (const base of [root, shapePath]) {
    const path = resolve(base, normalized);
    if (!within(artifacts, path)) continue;
    const parent = await realpath(dirname(path)).catch(() => null);
    if (parent && (parent === artifacts || within(artifacts, parent))) {
      return { parent, id: basename(path) };
    }
  }
  return null;
}

async function readAttempt(parent: string, id: string, shape: string, current: boolean) {
  const path = join(parent, id);
  const info = await fileInfo(path);
  if (!info?.isDirectory()) return null;
  const start = await readJson(join(path, 'gpu-start.json'));
  const summary = await readJson(join(path, 'gpu-summary.json'));
  const speedRows = await readTrainingJsonlTail(join(path, 'training-speed.jsonl'));
  if (!current && !id.startsWith('attempt-') && !start && !summary && !speedRows.length) return null;
  const manifest = await readJson(join(path, 'manifest.json'));
  const loggedShape = string(manifest?.shape) ?? string(manifest?.arm) ?? string(speedRows.at(-1)?.run);
  if (!current && loggedShape && loggedShape !== shape) return null;
  const logs = await readTrainingJsonlTail(join(path, 'log.jsonl'));
  if (!current && !start && !manifest && !summary && !speedRows.length && !logs.length) return null;
  const opening = logs.find(row => row.event === 'start' || row.event === 'resume' || row.event === 'continuation');
  const startedAt = timestamp(start?.start_time) ?? timestamp(opening?.time);
  const endedAt = timestamp(manifest?.end_time) ?? timestamp(summary?.end_time);
  const resultState = runStatus(object(manifest?.result)?.status);
  const failure = string(manifest?.failure) ?? string(summary?.problem);
  const terminalState = resultState && resultState !== 'running' ? resultState
    : failure?.startsWith('KeyboardInterrupt:') ? 'interrupted'
    : failure ? 'failed'
    : null;
  const resumed = typeof manifest?.resumed === 'boolean' ? manifest.resumed
    : opening ? opening.event === 'resume'
    : null;
  const latestActivity = timestamp(speedRows.at(-1)?.time) ?? timestamp(logs.at(-1)?.time);
  const chronology = startedAt ?? latestActivity ?? endedAt;
  return {
    id, startedAt, endedAt, terminalState, resumed,
    stage: start?.stage ?? manifest?.stage,
    validations: validationRows(logs),
    samples: current ? speedRows.map(speedSample).filter(sample => sample !== null) : [],
    order: chronology ? Date.parse(chronology) : info.birthtimeMs,
  };
}

async function readAttempts(root: string, artifacts: string, shapePath: string, shape: string, reference: unknown) {
  const current = await attemptLocation(root, artifacts, shapePath, reference);
  if (!current) return { currentId: null, history: [] };
  const history = [];
  for (const id of await directories(current.parent)) {
    const attempt = await readAttempt(current.parent, id, shape, id === current.id);
    if (attempt) history.push(attempt);
  }
  history.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const stage = history.find(attempt => attempt.id === current.id)?.stage;
  return { currentId: current.id, history: history.filter(attempt => stage == null || attempt.stage == null || attempt.stage === stage) };
}

async function readCheckpoints(shapePath: string, reportedTokens: number | null) {
  const directory = join(shapePath, 'checkpoints');
  // A fresh status starts at zero before the first checkpoint directory is committed.
  let latest: Checkpoint | null = reportedTokens ? { tokens: reportedTokens, savedAt: null } : null;
  const results: Record<string, number>[] = [];
  if (!(await fileInfo(directory))?.isDirectory()) return { latest, results };
  for (const name of await directories(directory)) {
    const match = /^tokens-(\d{12})$/.exec(name);
    if (!match) continue;
    const tokens = Number(match[1]);
    const path = join(directory, name);
    if (!latest || tokens >= latest.tokens) {
      const info = await fileInfo(path);
      if (info?.isDirectory()) latest = { tokens, savedAt: isoDate(info.mtimeMs) };
    }
    const manifest = await readJson(join(path, 'manifest.json'));
    results.push(validation(manifest?.fixed_reference_validation_loss));
  }
  return { latest, results };
}

function nextCheckpointTokens(settings: JsonObject | null, baseline: number | null, total: number | null) {
  if (baseline === null || total === null || baseline >= total) return null;
  const interval = count(settings?.checkpoint_every_tokens);
  const milestones = Array.isArray(settings?.exact_token_milestones) ? settings.exact_token_milestones : [];
  const targets = milestones.map(count).filter((target): target is number => target !== null && target > baseline);
  if (interval) targets.push((Math.floor(baseline / interval) + 1) * interval);
  if (!targets.length) return null;
  return Math.min(total, ...targets);
}

function eta(now: number, tokens: number | null, rate: number | null): string | null {
  return tokens !== null && rate !== null && rate > 0 ? isoDate(now + Math.max(0, tokens) / rate * 1000) : null;
}

interface RunCandidate {
  run: string;
  shape: string;
  status: TrainingRunStatus;
  data: JsonObject;
  updatedAt: string | null;
  order: number;
}

async function readRun(
  root: string, artifacts: string, directory: string, candidate: RunCandidate, now: number,
  accumulate: AccumulateSpeed | null,
): Promise<TrainingRun> {
  const { run, shape, data, updatedAt } = candidate;
  const shapePath = join(directory, run, shape);
  const { currentId, history } = await readAttempts(root, artifacts, shapePath, shape, data.attempt);
  const current = history.find(attempt => attempt.id === currentId);
  const status = candidate.status === 'running' ? current?.terminalState ?? candidate.status : candidate.status;
  const attempts = history.map((attempt, index): TrainingAttempt => ({
    id: attempt.id,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt ?? (attempt.id === currentId && status !== 'running' ? updatedAt : null),
    status: attempt.id === currentId ? status
      : attempt.terminalState ?? (!attempt.endedAt && index + 1 < history.length ? 'crashed' : 'unknown'),
    resumed: attempt.resumed,
  }));
  const settings = object(data.settings);
  const step = count(data.step);
  const processedTokens = count(data.processed_tokens);
  const totalTokens = count(settings?.total_tokens) || null;
  const percentDone = processedTokens !== null && totalTokens !== null
    ? Math.min(100, processedTokens / totalTokens * 100) : null;
  const stopRequested = (await fileInfo(join(shapePath, 'STOP')))?.isFile() ?? false;
  const samples = current?.samples ?? [];
  const speed = summarizeSpeed(accumulate && current && status === 'running'
    ? accumulate(join(shapePath, current.id), samples)
    : samples);
  const rate = status === 'running' && !stopRequested ? speed?.average30Minutes ?? null : null;
  const { latest: lastCheckpoint, results: checkpointValidation } = await readCheckpoints(shapePath, count(data.last_checkpoint_tokens));
  const nextTokens = nextCheckpointTokens(settings, lastCheckpoint?.tokens ?? processedTokens, totalTokens);
  const nextCheckpoint = nextTokens !== null && status === 'running' ? {
    tokens: nextTokens, etaAt: eta(now, processedTokens === null ? null : nextTokens - processedTokens, rate),
  } : null;
  const currentRows = current?.validations ?? validationRows(await readTrainingJsonlTail(join(shapePath, 'log.jsonl')));
  const latestRow = currentRows.at(-1);
  const statusValidation = validation(data.last_validation);
  const lastValidation = latestRow?.step != null && (step === null || latestRow.step > step)
    ? { ...statusValidation, ...latestRow.losses }
    : { ...latestRow?.losses, ...statusValidation };
  const loggedValidation = currentRows.map(row => row.losses);
  const olderValidation = history.filter(attempt => attempt.id !== currentId)
    .flatMap(attempt => attempt.validations.map(row => row.losses));
  return {
    run, shape, status, step, processedTokens, totalTokens, percentDone, updatedAt,
    etaAt: eta(now, processedTokens === null || totalTokens === null ? null : totalTokens - processedTokens, rate),
    speed, lastValidation, bestValidation: bestValidation([lastValidation, ...checkpointValidation, ...loggedValidation, ...olderValidation]),
    lastCheckpoint, nextCheckpoint, stopRequested, currentAttempt: currentId, attempts,
  };
}

async function readGpuLock(root: string): Promise<TrainingGpuLock | null> {
  const directory = join(root, '.data');
  if (!(await fileInfo(directory))?.isDirectory()) return null;
  const data = await readJson(join(directory, 'gpu.lock'));
  if (!data) return null;
  const lock = { owner: string(data.owner), purpose: string(data.purpose), pid: count(data.pid), started: timestamp(data.started) };
  return Object.values(lock).some(value => value !== null) ? lock : null;
}

async function readRuns(root: string, now: number, accumulate: AccumulateSpeed): Promise<TrainingRuns | null> {
  const localRoot = await realpath(root).catch(() => null);
  if (!localRoot) return null;
  const artifacts = join(localRoot, 'artifacts');
  const directory = join(artifacts, 'execution-model-runs');
  if (!(await fileInfo(artifacts))?.isDirectory() || !(await fileInfo(directory))?.isDirectory()) return null;
  const candidates: RunCandidate[] = [];
  for (const run of await directories(directory)) {
    for (const shape of await directories(join(directory, run))) {
      const file = await readWindow(join(directory, run, shape, 'status.json'), MAX_JSON_BYTES, false);
      const data = file && parseObject(file.text);
      const status = runStatus(data?.status);
      if (!file || !data || !status) continue;
      const updatedAt = timestamp(data.updated_at);
      candidates.push({ run, shape, status, data, updatedAt, order: updatedAt ? Date.parse(updatedAt) : file.modifiedAt });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) =>
    right.order - left.order || left.run.localeCompare(right.run) || left.shape.localeCompare(right.shape));
  let active: TrainingRun | null = null;
  const recent: TrainingRun[] = [];
  for (const candidate of candidates) {
    if (recent.length >= RECENT_RUNS && (active || candidate.status !== 'running')) continue;
    const run = await readRun(localRoot, artifacts, directory, candidate, now, active ? null : accumulate);
    if (!active && run.status === 'running') active = run;
    else if (recent.length < RECENT_RUNS) recent.push(run);
  }
  return { active, recent, gpuLock: await readGpuLock(localRoot) };
}

export function createTrainingRunReader() {
  let previous: { key: string; samples: SpeedSample[] } | null = null;
  return async (root: string, now = Date.now()): Promise<TrainingRuns | null> => {
    let retained = false;
    const snapshot = await readRuns(root, now, (key, samples) => {
      const first = samples[0]?.activeSeconds;
      const latest = samples.at(-1)?.activeSeconds;
      if (first == null || latest == null) return samples;
      const prior = previous?.key === key ? previous.samples : [];
      const priorLatest = prior.at(-1)?.activeSeconds;
      // An overlapping tail extends coverage. A new or truncated attempt starts a fresh window.
      const older = priorLatest != null && priorLatest >= first && priorLatest <= latest
        ? prior.filter(sample => sample.activeSeconds !== null && sample.activeSeconds < first)
        : [];
      const window = [...older, ...samples].filter(
        sample => sample.activeSeconds !== null && sample.activeSeconds > latest - AVERAGE_SECONDS,
      ).slice(-(AVERAGE_SECONDS / SAMPLE_SECONDS + 1));
      retained = true;
      previous = { key, samples: window };
      return window;
    });
    if (!retained) previous = null;
    return snapshot;
  };
}
