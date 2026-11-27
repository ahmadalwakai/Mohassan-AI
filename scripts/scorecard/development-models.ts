import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createModelCouncil } from '../../apps/server/src/assistant/model-council.js';
import { getModelEntry, modelRegistry, modelRoots, resolveModelInRoots } from '../../packages/model-relations/src/registry.js';
import { createModelRuntime } from '../../packages/model-relations/src/runtime.js';

const protectedPaths = ['/artifacts/brain-lab/holdout-v1', '/artifacts/chat-training/conversation-v1/holdout'];
const childrenPath = `/proc/${process.pid}/task/${process.pid}/children`;

// Kernel process stat fields 4 and 14–17 are parent PID and self/child CPU ticks.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (retrieved 2026-11-27)
function processFields(pid: string) {
  const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return value.slice(value.lastIndexOf(')') + 2).split(' ');
}

function directChildren() {
  if (existsSync(childrenPath)) return readFileSync(childrenPath, 'utf8').trim().split(/\s+/u).filter(Boolean);
  return readdirSync('/proc').filter(pid => {
    if (!/^\d+$/u.test(pid)) return false;
    try { return Number(processFields(pid)[1]) === process.pid; }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  });
}

function assertOutsideHoldout(path: string) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  if (protectedPaths.some(directory => `${normalized}/`.includes(`${directory}/`))) {
    throw new Error('The scorecard cannot access a sealed holdout');
  }
}

async function assertLocalPath(path: string) {
  assertOutsideHoldout(path);
  const canonical = await realpath(path).catch(error => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (canonical) assertOutsideHoldout(canonical);
}

async function artifactSize(selectedId: string | null, roots: string[], env: NodeJS.ProcessEnv) {
  const active = modelRegistry.filter(entry => entry.id === selectedId || entry.activationFlag && env[entry.activationFlag] === '1');
  const entries = new Map(active.map(entry => [entry.id, entry]));
  for (const entry of entries.values()) for (const dependency of entry.dependencies) {
    const required = getModelEntry(dependency.id);
    if (!required || required.version !== dependency.version) throw new Error('The registered model dependency is unavailable');
    entries.set(required.id, required);
  }
  const files = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.runtime === 'gpu' || entry.resources.gpu) throw new Error('The development scorecard requires CPU models');
    for (const root of roots) for (const artifact of entry.artifacts) {
      await assertLocalPath(resolve(root, artifact.path));
      if (artifact.pin) await assertLocalPath(resolve(root, artifact.pin.reference));
    }
    const model = await resolveModelInRoots(entry, roots, env, false);
    if (model.state === 'absent') {
      if (entry.id === selectedId) throw new Error(`Model artifacts unavailable for ${selectedId}`);
      return null;
    }
    for (const artifact of model.artifacts) if (artifact.present) {
      await assertLocalPath(artifact.path);
      // The chat-v5 worker config can override the device and checkpoint. This fixture accepts the native CPU files.
      if (entry.id === selectedId && artifact.role === 'worker-config') {
        throw new Error('Use the registered native CPU artifacts without a model worker config');
      }
      files.add(await realpath(artifact.path));
    }
  }
  let bytes = 0;
  for (const file of files) bytes += (await stat(file)).size;
  return bytes;
}

/** Sum the current RSS of local resident model processes, separate from the harness process RSS. */
export async function residentModelBytes(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  let total = 0;
  for (const pid of directChildren()) {
    try {
      const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (!cmdline.some(arg => basename(arg) === 'worker.py' && arg.includes('model_worker/'))) continue;
      const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
      if (!rss) return null;
      total += Number(rss[1]) * 1024;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

function childCpuSampler() {
  if (process.platform !== 'linux') return () => null;
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(clockTicks) || clockTicks <= 0) throw new Error('Unable to measure Linux child CPU usage');
  const fields = (pid: string) => processFields(pid).slice(11, 15).map(Number);
  const reaped = () => fields('self').slice(2).reduce((sum, ticks) => sum + ticks, 0);
  return () => {
    const before = reaped();
    let ticks = before;
    for (const pid of directChildren()) {
      try { ticks += fields(pid).reduce((sum, value) => sum + value, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    return reaped() === before ? ticks * 1000 / clockTicks : null;
  };
}

/** Connect only the selected registry ID through the product's council. Other requests remain disabled. */
export async function createDevelopmentModels(selectedId: string | null) {
  const roots = modelRoots(process.cwd());
  for (const root of roots) await assertLocalPath(root);
  // Only these inputs may redirect the worker or its files. Ignore owner process settings for all other paths.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MOHASSAN_') && key !== 'MOHASSAN_MODEL_WORKER_CONFIG')),
    EXECUTOR_PYTHON: process.env.EXECUTOR_PYTHON, EXECUTOR_DEVICE: 'cpu', ADS_MODEL_DEVICE: 'cpu' };
  if (env.EXECUTOR_PYTHON) await assertLocalPath(env.EXECUTOR_PYTHON);
  if (selectedId && !getModelEntry(selectedId)) throw new Error(`Unknown registered model ${selectedId}`);
  const diskBytes = await artifactSize(selectedId, roots, env);
  const runtime = selectedId ? createModelRuntime({ artifactRoots: roots, env }) : null;
  let attempts = 0;
  let succeeded = 0;
  const council = runtime && createModelCouncil({ runner: {
    async run(id, input) {
      if (id !== selectedId) return { ok: false, reason: 'absent', elapsedMs: 0 };
      attempts++;
      const result = await runtime.run(id, input);
      if (result.ok) succeeded++;
      return result;
    },
  } });
  return {
    council: council || undefined, diskBytes,
    childCpuMs: childCpuSampler(),
    sample: async () => ({ attempts, succeeded, residentBytes: await residentModelBytes() }),
    async close() { await runtime?.close(); },
  };
}
