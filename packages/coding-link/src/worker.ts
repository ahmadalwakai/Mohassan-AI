import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodingEngine, CodingError, createRepairDemoProject, generateDeterministicEdits, inspectProject, lookupImports, searchProjectFiles, type CodingCheckResult, type SandboxRunner } from '@mohassan/coding';
import { canonicalDirectory, containsPath } from '@mohassan/coding/security';
import { WindowsAppContainerSandbox } from '@mohassan/sandbox';
import type { CodingResult, SandboxStatus } from '@mohassan/contracts';
import {
  CODING_DEVICE_POLL_BODY_LIMIT, CODING_DEVICE_PROTOCOL_VERSION, CODING_JOB_DEADLINES_MS, CODING_RESULT_HEADERS, CodingFinishedResultSchema,
  CodingJobResultSchemas, CodingPollResponseSchema, CodingProgressSchema,
  type CodingFinishedResult, type CodingJob, type CodingJobKind, type CodingJobResults, type CodingProgress,
} from './protocol.js';

type Endpoint = '/api/coding/device/pair' | '/api/coding/device/poll';
interface PostOptions {
  signal?: AbortSignal;
  authorization?: string;
  result?: { jobId: string; nonce: string; sentAt: string };
}

/** A native request avoids Fetch Metadata headers and declines redirects carrying the device key. */
export function postCodingDeviceJson(serverUrl: string, path: Endpoint, body: string, options: PostOptions = {}) {
  const url = new URL(path, serverUrl);
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('The coding device needs HTTPS or an HTTP loopback address.');
  }
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const requestOptions = { method: 'POST', signal, agent: false as const, rejectUnauthorized: true, headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.result ? {
        [CODING_RESULT_HEADERS.jobId]: options.result.jobId,
        [CODING_RESULT_HEADERS.nonce]: options.result.nonce,
        [CODING_RESULT_HEADERS.sentAt]: options.result.sentAt,
      } : {}),
    } };
    const outgoing = request(url, requestOptions, async incoming => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of incoming as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (bytes > CODING_DEVICE_POLL_BODY_LIMIT) throw new Error('Coding device response exceeded its limit.');
          chunks.push(chunk);
        }
        const status = incoming.statusCode ?? 500;
        const value = status >= 200 && status < 300 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : null;
        resolve({ status, body: value });
      } catch (error) {
        reject(error);
      }
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

type WorkerStatus = 'online' | 'offline' | 'revoked';
export interface CodingDeviceWorkerOptions {
  serverUrl: string;
  deviceId: string;
  deviceKey: string;
  pollIntervalMs: number;
  dataDir: string;
  allowedRoots: readonly string[];
  sandbox?: SandboxRunner;
  signal?: AbortSignal;
  onStatus?: (status: WorkerStatus) => void;
}

function pathDenied() {
  return new CodingError('CODING_DEVICE_PATH_DENIED', 'مسار المشروع خارج المجلدات المسموحة على هذا الجهاز.');
}

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function allowedProjectRoot(path: string, roots: readonly string[], demos: string) {
  // Validate raw components before node:path can normalize away traversal or device aliases.
  const components = path.split(/[\\/]/);
  const windowsAlias = process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')
    || components.some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)));
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\0-\x1f]/.test(path)
    || components.some(part => part === '.' || part === '..') || windowsAlias) {
    throw pathDenied();
  }
  const demoPath = containsPath(demos, path) && /^[a-f0-9]{20}[\\/]repair-demo-project$/.test(relative(demos, path));
  const matching = roots.filter(root => isAbsolute(root) && containsPath(root, path));
  if (demoPath) matching.push(demos);
  if (!matching.length) throw pathDenied();
  for (const root of matching) {
    try {
      // This checks all path components for symlinks and junctions and checks real containment before Git reads.
      await canonicalDirectory(path, [root]);
      return root;
    } catch (error) {
      if (['SYMLINK_REJECTED', 'PROJECT_OUTSIDE_ROOTS', 'ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) continue;
      throw error;
    }
  }
  throw pathDenied();
}

async function inspect(path: string, root: string): Promise<CodingJobResults['inspect']> {
  const { path: canonical, baseCommit, candidateEditablePaths, testFiles } = await inspectProject(path, [root]);
  return { path: canonical, baseCommit, candidateEditablePaths, testFiles };
}

async function runJob(job: CodingJob, options: CodingDeviceWorkerOptions, sandbox: SandboxRunner, signal: AbortSignal,
  onProgress: (stage: string, message: string) => Promise<void>,
): Promise<CodingJobResults[Exclude<CodingJobKind, 'check' | 'execute' | 'verify'>] | CodingCheckResult | CodingResult | null> {
  signal.throwIfAborted();
  const demos = join(options.dataDir, 'demos');
  if (job.kind === 'demo') {
    const ownerKey = createHash('sha256').update(job.payload.ownerId).digest('hex').slice(0, 20);
    const demo = await createRepairDemoProject(join(demos, ownerKey));
    return { ...await inspect(demo.path, demos), allowedPaths: demo.allowedPaths };
  }
  if (job.kind === 'inspect') {
    const root = await allowedProjectRoot(job.payload.path, options.allowedRoots, demos);
    signal.throwIfAborted();
    return inspect(job.payload.path, root);
  }
  const { project } = job.payload;
  const root = await allowedProjectRoot(project.path, options.allowedRoots, demos);
  signal.throwIfAborted();
  switch (job.kind) {
    case 'check': case 'execute': case 'verify': {
      const engine = new CodingEngine({ dataDir: options.dataDir, allowedRoots: [root], sandbox, generateEdits: generateDeterministicEdits });
      if (job.kind === 'check') return engine.check({ ownerId: project.ownerId, project, signal });
      if (job.kind === 'execute') return engine.execute({ ownerId: project.ownerId, project, taskId: job.payload.taskId, goal: job.payload.goal, signal, onProgress });
      return engine.verify(job.payload.result, { taskId: job.payload.taskId, project, signal });
    }
    case 'search': return searchProjectFiles((await inspectProject(project.path, [root])).files, job.payload.query);
    case 'imports': return lookupImports((await inspectProject(project.path, [root])).files, job.payload.reference);
    case 'instructions': {
      const inspected = await inspectProject(project.path, [root]);
      if (job.payload.baseCommit && job.payload.baseCommit !== inspected.baseCommit) {
        throw new CodingError('PROJECT_HEAD_CHANGED', 'تغير HEAD منذ الفحص.');
      }
      return inspected.instructions ?? null;
    }
    case 'trackedPaths': {
      if (project.baseCommit !== job.payload.baseCommit) return [];
      const inspected = await inspectProject(project.path, [root]);
      return inspected.baseCommit === job.payload.baseCommit ? inspected.files.map(file => file.path) : [];
    }
  }
}

function monitorSandbox(injected?: SandboxRunner) {
  const makeRunner = () => injected ?? new WindowsAppContainerSandbox();
  let current = makeRunner();
  let status: SandboxStatus = { available: false, provider: null, message: 'يُتحقق من بيئة العزل على الجهاز.' };
  let probe: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  function refresh(runner: SandboxRunner) {
    if (probe) return probe;
    current = runner;
    status = { available: false, provider: status.provider, message: 'يُتحقق من بيئة العزل على الجهاز.' };
    probe = Promise.resolve().then(() => runner.available()).then(result => { status = result; }, () => {
      status = { available: false, provider: status.provider, message: 'تعذر التحقق من بيئة العزل على الجهاز.' };
    }).finally(() => { probe = undefined; });
    return probe;
  }
  const restart = (runner: SandboxRunner) => { if (current === runner && !probe) void refresh(makeRunner()); };
  async function invoke<T>(runner: SandboxRunner, signal: AbortSignal | undefined, operation: () => Promise<T>) {
    signal?.throwIfAborted();
    const result = operation();
    inFlight.add(result);
    try {
      return await result;
    } catch (error) {
      if (!signal?.aborted) restart(runner);
      throw error;
    } finally {
      inFlight.delete(result);
    }
  }
  const sandbox: SandboxRunner = {
    available: async () => status,
    run: input => { const runner = current; return invoke(runner, input.signal, () => runner.run(input)); },
    ...(current.lintFix ? { lintFix: input => { const runner = current; return invoke(runner, input.signal, () => runner.lintFix!(input)); } } : {}),
  };
  return { sandbox, start: () => refresh(current), restart: () => restart(current), status: () => status,
    drain: () => Promise.allSettled(inFlight),
  };
}

type Work = { id: string; abort: AbortController; done: Promise<void> };
const idleBackoffLimit = 30_000;

export async function runCodingDevice(options: CodingDeviceWorkerOptions): Promise<void> {
  const stopping = options.signal;
  const monitor = monitorSandbox(options.sandbox);
  // Publish an honest not-ready status while the first AppContainer probe runs.
  void monitor.start();
  const started = new Set<string>();
  let running: Work | undefined;
  let finished: CodingFinishedResult | null = null;
  let progress: CodingProgress[] = [];
  let status: WorkerStatus | undefined;
  const publish = (next: WorkerStatus) => {
    if (next !== status) options.onStatus?.(next);
    status = next;
  };
  function start(job: CodingJob) {
    if (running || started.has(job.id)) return;
    started.add(job.id);
    const abort = new AbortController();
    const remaining = Math.min(Date.parse(job.deadlineAt) - Date.now(), CODING_JOB_DEADLINES_MS[job.kind]);
    if (remaining <= 0) abort.abort();
    const timer = setTimeout(() => abort.abort(), Math.max(0, remaining));
    let seq = 0;
    const done = runJob(job, options, monitor.sandbox, abort.signal, async (stage, message) => {
      progress.push(CodingProgressSchema.parse({ jobId: job.id, seq: ++seq, stage, message }));
    }).then<CodingFinishedResult, CodingFinishedResult>(value => {
      const result = { jobId: job.id, status: 'succeeded' as const, value };
      if (Buffer.byteLength(JSON.stringify(result)) > CODING_DEVICE_POLL_BODY_LIMIT) {
        return { jobId: job.id, status: 'failed', code: 'CODING_DEVICE_RESULT_TOO_LARGE' };
      }
      // Results are schema-checked again across the server's trust boundary.
      const parsed = CodingJobResultSchemas[job.kind].safeParse(value);
      return parsed.success ? { ...result, value: parsed.data }
        : { jobId: job.id, status: 'failed', code: 'CODING_DEVICE_BAD_RESULT' };
    }, error => {
      const code = errorCode(error) ?? 'CODING_FAILED';
      if (code === 'UNVERIFIED_SANDBOX') monitor.restart();
      const failure = CodingFinishedResultSchema.safeParse({ jobId: job.id, status: 'failed', code,
        ...(code === 'NO_PROVEN_FIX' && error instanceof CodingError ? { message: error.message } : {}),
      });
      return failure.success ? failure.data : { jobId: job.id, status: 'failed', code: 'CODING_FAILED' };
    }).then(async result => {
      // The engine can return from an abort before AppContainer has finished stopping its process.
      await monitor.drain();
      clearTimeout(timer);
      finished = abort.signal.aborted ? { jobId: job.id, status: 'cancelled', code: 'CODING_DEVICE_CANCELLED' } : result;
      running = undefined;
    });
    running = { id: job.id, abort, done };
  }

  let wait = options.pollIntervalMs;
  try {
    while (!stopping?.aborted) {
      const nonce = randomUUID(), sentAt = new Date().toISOString();
      const currentResult = finished as CodingFinishedResult | null;
      const batch = progress.slice(0, 32);
      const poll = { nonce, sentAt, activeJobId: running?.id ?? null,
        status: { protocolVersion: CODING_DEVICE_PROTOCOL_VERSION, platform: process.platform === 'win32' ? 'win32' : 'linux', sandbox: monitor.status() },
        progress: batch, result: currentResult,
      };
      let body = JSON.stringify(poll);
      if (currentResult && Buffer.byteLength(body) > CODING_DEVICE_POLL_BODY_LIMIT) {
        body = JSON.stringify({ ...poll, result: { jobId: currentResult.jobId, status: 'failed', code: 'CODING_DEVICE_RESULT_TOO_LARGE' } });
      }
      try {
        const response = await postCodingDeviceJson(options.serverUrl, '/api/coding/device/poll', body, {
          authorization: `Bearer ${options.deviceId}.${options.deviceKey}`, signal: stopping,
          ...(currentResult ? { result: { jobId: currentResult.jobId, nonce, sentAt } } : {}),
        });
        if (response.status === 401) { publish('revoked'); return; }
        if (response.status !== 200) throw new Error('Coding device poll failed.');
        const received = CodingPollResponseSchema.safeParse(response.body);
        if (!received.success) throw new Error('Coding device poll returned an invalid response.');
        publish('online');
        wait = options.pollIntervalMs;
        if (finished === currentResult) finished = null;
        progress = progress.slice(batch.length);
        if (running && received.data.cancel.includes(running.id)) running.abort.abort();
        if (received.data.job) start(received.data.job);
      } catch {
        if (stopping?.aborted) break;
        publish('offline');
        wait = Math.min(idleBackoffLimit, wait * 2);
      }
      await delay(wait, undefined, { signal: stopping }).catch(() => {});
    }
  } finally {
    if (running) { running.abort.abort(); await running.done; }
  }
}
