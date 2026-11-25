import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { readPersistedChatMetrics, type ChatMetricsCursor } from './chat.js';
import { enableChatProgressMarkers } from './chat-progress.js';
import { bucketStart, hourlySlots, hourMs, type MetricsStore } from './store.js';

const CHAT_REFRESH_MS = 15_000;
// A row can commit after its application timestamp has passed the previous cutoff.
const CHAT_COMMIT_OVERLAP_MS = 30_000;

type Query = Parameters<typeof readPersistedChatMetrics>[1];
type ReadPage = (query: Query) => ReturnType<typeof readPersistedChatMetrics>;
type Scan = { fromMs: number; toMs: number; cursor?: ChatMetricsCursor };

export function createChatMetricsRefresh(read: ReadPage, record: MetricsStore['recordPersistedChat'], now: () => number) {
  let scan: Scan | undefined;
  let readThrough: number | undefined;
  let available = false;
  // Keys exist only in the overlap buffer. The store receives numeric observations and role classes.
  const recent = new Map<string, number>();
  const appliedPage = new Set<string>();

  async function refreshPage(): Promise<boolean> {
    if (!scan) {
      const toMs = now();
      const earliest = bucketStart(toMs, hourMs) - (hourlySlots - 1) * hourMs;
      const fromMs = readThrough === undefined ? earliest : Math.max(earliest, readThrough - CHAT_COMMIT_OVERLAP_MS);
      for (const [key, at] of recent) if (at < fromMs) recent.delete(key);
      scan = { fromMs, toMs };
    }
    try {
      const { samples, nextCursor } = await read(scan);
      for (const { key, atMs, role, observation } of samples) {
        if (recent.has(key) || appliedPage.has(key)) continue;
        record(role, observation, atMs);
        appliedPage.add(key);
        if (atMs >= scan.toMs - CHAT_COMMIT_OVERLAP_MS) recent.set(key, atMs);
      }
      appliedPage.clear();
      if (nextCursor) {
        scan.cursor = nextCursor;
        return true;
      }
      readThrough = scan.toMs;
      scan = undefined;
      available = true;
    } catch {
      // Keep the last aggregate and retry the failed page without delaying any request.
      available = false;
    }
    return false;
  }

  return { refreshPage, isAvailable: () => available };
}

export function registerChatMetricsRefresh(app: FastifyInstance, db: Kysely<any>, store: MetricsStore) {
  const disableProgressMarkers = enableChatProgressMarkers(db);
  const { refreshPage, isAvailable } = createChatMetricsRefresh(query => readPersistedChatMetrics(db, query),
    (role, observation, atMs) => store.recordPersistedChat(role, observation, atMs), () => store.nowMs());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let inFlight: Promise<boolean> | undefined;

  function schedule(delayMs: number) {
    timer = setTimeout(async () => {
      inFlight = refreshPage();
      const hasMore = await inFlight;
      inFlight = undefined;
      if (!stopped) schedule(hasMore ? 0 : CHAT_REFRESH_MS);
    }, delayMs);
    timer.unref();
  }

  // Chat creates its existing tables during application assembly. Stop before database shutdown.
  app.addHook('onReady', async () => { schedule(0); });
  app.addHook('preClose', async () => {
    stopped = true;
    disableProgressMarkers();
    clearTimeout(timer);
    await inFlight;
  });
  return isAvailable;
}
