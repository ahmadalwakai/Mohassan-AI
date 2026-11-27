import { readFile } from 'node:fs/promises';
import type { ModelAdapter } from './runtime.js';

export interface WorkerMemoryPeaks {
  readonly peakRssKiB: number;
  readonly peakAddressSpaceKiB: number;
}

export interface MeasurableModelAdapter extends ModelAdapter {
  workerMemoryPeaks?(): Promise<WorkerMemoryPeaks>;
}

// VmHWM and VmPeak are maintained by Linux across the lifetime of the worker.
export async function readWorkerMemoryPeaks(pid: number): Promise<WorkerMemoryPeaks> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const peakRssKiB = Number(/^VmHWM:[ \t]+(\d+) kB$/mu.exec(status)?.[1]);
  const peakAddressSpaceKiB = Number(/^VmPeak:[ \t]+(\d+) kB$/mu.exec(status)?.[1]);
  if (!(peakRssKiB > 0) || !(peakAddressSpaceKiB >= peakRssKiB)) throw new Error('Worker memory peaks are unavailable.');
  return { peakRssKiB, peakAddressSpaceKiB };
}
