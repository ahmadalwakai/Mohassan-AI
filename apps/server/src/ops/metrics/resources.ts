import { monitorEventLoopDelay } from 'node:perf_hooks';

const SAMPLE_INTERVAL_MS = 30_000;

export interface ProcessResources {
  eventLoopDelayMs?: number;
  heapUsedBytes: number;
  rssBytes: number;
  openHandles: number;
}

export function sampleProcessResources(record: (sample: ProcessResources) => void) {
  // This monitor reports event-loop delay in nanoseconds.
  // https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions (retrieved 2026-11-25)
  const delay = monitorEventLoopDelay();
  delay.enable();
  const timer = setInterval(() => {
    try {
      // https://nodejs.org/api/process.html#processmemoryusage (retrieved 2026-11-25)
      const { heapUsed, rss } = process.memoryUsage();
      record({
        ...(delay.count > 0 ? { eventLoopDelayMs: delay.percentile(99) / 1_000_000 } : {}),
        heapUsedBytes: heapUsed,
        rssBytes: rss,
        // https://nodejs.org/api/process.html#processgetactiveresourcesinfo (retrieved 2026-11-25)
        openHandles: process.getActiveResourcesInfo().length,
      });
    } catch {
      // Resource observations are best effort.
    } finally {
      delay.reset();
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
