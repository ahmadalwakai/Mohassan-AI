import { execFile } from 'node:child_process';
import { constants, getPriority, setPriority } from 'node:os';
import type { TrainingGpuSample } from '@mohassan/contracts';

const SAMPLE_INTERVAL_MS = 30_000;
const SAMPLE_TIMEOUT_MS = 5_000;

function queryNvidiaGpu(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('nvidia-smi', [
      '--query-gpu=temperature.gpu,utilization.gpu,memory.used',
      '--format=csv,noheader,nounits',
    ], { timeout: SAMPLE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16_384, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (child.pid === undefined) return;

    // Only adjust the telemetry child, and preserve an already lower priority.
    try {
      const belowNormal = constants.priority.PRIORITY_BELOW_NORMAL;
      if (getPriority(child.pid) < belowNormal) setPriority(child.pid, belowNormal);
    } catch (error) {
      child.kill('SIGKILL');
      reject(error);
    }
  });
}

function parseSample(stdout: string): TrainingGpuSample | null {
  const [firstGpu = ''] = stdout.trim().split('\n', 1);
  const fields = firstGpu.split(',').map(field => field.trim());
  if (fields.length !== 3 || !fields.every(field => /^-?\d+$/.test(field))) return null;

  const [temperatureC, utilizationPercent, memoryUsedMiB] = fields.map(Number);
  if (![temperatureC, utilizationPercent, memoryUsedMiB].every(Number.isSafeInteger) ||
      utilizationPercent < 0 || utilizationPercent > 100 || memoryUsedMiB < 0) return null;
  return { temperatureC, utilizationPercent, memoryUsedMiB };
}

export function createGpuSampler(
  query: () => Promise<string> = queryNvidiaGpu,
  now: () => number = () => performance.now(),
): () => Promise<TrainingGpuSample | null> {
  let cached: Promise<TrainingGpuSample | null> | undefined;
  let expiresAt = 0;

  return () => {
    if (!cached || now() >= expiresAt) {
      expiresAt = Infinity;
      cached = Promise.resolve().then(query).then(parseSample).catch(() => null).finally(() => {
        expiresAt = now() + SAMPLE_INTERVAL_MS;
      });
    }
    return cached;
  };
}
