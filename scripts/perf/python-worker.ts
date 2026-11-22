/**
 * Phase 0: start time and memory of the Python model worker (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §1.6, §4.5).
 *
 * Usage: npx tsx scripts/perf/python-worker.ts [--rounds 2] [--out artifacts/perf/2026-11-22/python-worker]
 *
 * Starts the same Ads model worker the lab chat starts (apps/server/src/ads-lab.ts createAdsModelWorker),
 * waits for its ready handshake, reads its memory from this process tree and the GPU from nvidia-smi,
 * then stops it. No request is sent to the model. Configurations:
 *   lab-default  what `npm run dev:lab` loads unless ADS_MODEL_RUN / ADS_CHAT_FINETUNE are set: text-b2, pointer-v3
 *   f38m-v4      the 38.3M trunk with the pointer-v4-f38m fine-tune (the Ads model browser-tested on 2026-11-20)
 * on `cuda` (the lab default) and on `cpu` (the plan's proposal for daily use).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createAdsModelWorker } from '../../apps/server/src/ads-lab.js';
import { stats } from './fixture.js';

const run = promisify(execFile);
const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const rounds = Number(argument('rounds', '2'));
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'python-worker')));
await mkdir(out, { recursive: true });
const root = process.cwd();
const python = path.join(root, '.venv-execution', 'Scripts', 'python.exe'), packageDir = path.join(root, 'packages', 'execution-pipeline');
const CONFIGS = [
  { name: 'lab-default', run: path.join(root, 'artifacts/execution-model-runs/text-b2-2026-11-12'), finetune: 'pointer-v3' },
  { name: 'f38m-v4', run: path.join(root, 'artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full'), finetune: 'pointer-v4-f38m' },
];

async function gpuUsedMiB(): Promise<number | null> {
  try { const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }); return Number(stdout.trim().split('\n')[0]); } catch { return null; }
}
async function pythonMemory(): Promise<{ count: number; workingSetMB: number; privateMB: number } | null> {
  const file = path.join(out, 'snapshots.jsonl');
  const before = await readFile(file, 'utf8').catch(() => '');
  await run('pwsh', ['-NoProfile', '-File', path.resolve('scripts/perf/resource-sampler.ps1'), '-RootPid', String(process.pid), '-OutFile', file, '-Once'], { windowsHide: true });
  const line = (await readFile(file, 'utf8')).slice(before.length).trim().split('\n').at(-1)!;
  return (JSON.parse(line) as { roles?: Record<string, { count: number; workingSetMB: number; privateMB: number }> }).roles?.python ?? null;
}

const results: Record<string, unknown>[] = [];
for (const config of CONFIGS) {
  for (const device of ['cuda', 'cpu'] as const) {
    const starts: number[] = [], memory: unknown[] = [], gpu: (number | null)[] = [], failures: string[] = [];
    let handshake: unknown = null;
    for (let round = 0; round < rounds; round++) {
      const worker = createAdsModelWorker({ run: config.run, finetune: config.finetune, python, packageDir, device, startupTimeoutMs: 240_000, requestTimeoutMs: 90_000 });
      const missing = await worker.files();
      if (missing) { failures.push(missing); break; }
      const gpuBefore = await gpuUsedMiB();
      const started = performance.now();
      try {
        await worker.start();
        starts.push(performance.now() - started);
        handshake = worker.info().model;
        await delay(1500);
        memory.push(await pythonMemory());
        const used = await gpuUsedMiB();
        gpu.push(used !== null && gpuBefore !== null ? used - gpuBefore : null);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      } finally {
        worker.stop();
        await delay(3000);
      }
      console.log(`${config.name} ${device} round ${round}: start=${starts.at(-1)?.toFixed(0) ?? '-'}ms python=${JSON.stringify(memory.at(-1) ?? null)} gpuΔ=${gpu.at(-1) ?? '-'}MiB ${failures.at(-1) ?? ''}`);
    }
    results.push({ config: config.name, run: path.relative(root, config.run), finetune: config.finetune, device, startMs: stats(starts), rawStartMs: starts, memory, gpuDeltaMiB: gpu, handshake, failures });
  }
}
await writeFile(path.join(out, 'python-worker.json'), JSON.stringify({ at: new Date().toISOString(), rounds, results }, null, 2));
console.log(JSON.stringify({ out: path.join(out, 'python-worker.json') }));
process.exit(0);
