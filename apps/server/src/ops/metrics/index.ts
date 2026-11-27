import { delimiter, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { registerChatMetricsRefresh } from './chat-refresh.js';
import type { MetricWindow } from '@mohassan/contracts';
import { metricsCsv } from './csv.js';
import { registerMonitorMetrics } from './monitor-events.js';
import { readMonitorFeedbackMetrics } from './monitor-feedback.js';
import { readReplyQualityMetrics } from './reply-quality.js';
import { METRICS_CSV_PATH, METRICS_PATH, registerRequestMetrics } from './request.js';
import { sampleProcessResources } from './resources.js';
import { MetricsSnapshots } from './snapshots.js';
import { hourMs, MetricsStore, minuteMs, type V5ChatObservation } from './store.js';

const v5Metrics = new WeakMap<FastifyInstance, MetricsStore>();

export function recordV5ChatMetrics(app: FastifyInstance, observation: V5ChatObservation): void {
  v5Metrics.get(app)?.recordV5Chat(observation);
}

export function productionMetricsSettings(production: boolean, env: NodeJS.ProcessEnv) {
  return {
    enabled: env.PRODUCTION_METRICS_ENABLED === undefined ? production : env.PRODUCTION_METRICS_ENABLED === 'true',
    directory: resolve(env.PRODUCTION_METRICS_DIR || resolve(env.STATE_DIRECTORY?.split(delimiter)[0] || '.data', 'production-metrics')),
  };
}

export async function registerProductionMetrics(
  app: FastifyInstance,
  production: boolean,
  cachedRole: Parameters<typeof registerRequestMetrics>[1],
  db: Kysely<any>,
  v5ChatEnabled = false,
) {
  const { enabled, directory } = productionMetricsSettings(production, process.env);
  const store = new MetricsStore();
  const snapshots = enabled ? new MetricsSnapshots(store, directory, { restoreChat: false, restoreV5Chat: v5ChatEnabled }) : undefined;
  const chatAvailable = enabled ? registerChatMetricsRefresh(app, db, store) : () => false;
  if (snapshots) {
    await snapshots.load();
    if (v5ChatEnabled) v5Metrics.set(app, store);
    registerRequestMetrics(app, cachedRole, (role, route, status, durationMs) => store.recordRequest(role, route, status, durationMs));
    const stopMonitorMetrics = registerMonitorMetrics(db, event => store.recordMonitor(event));
    const stopSampling = sampleProcessResources(sample => store.recordResources(sample));
    let flushTimer: ReturnType<typeof setTimeout>;
    let closed = false;
    const scheduleFlush = () => {
      const untilNextHour = hourMs - Date.now() % hourMs;
      flushTimer = setTimeout(async () => {
        if (!snapshots.healthy) await snapshots.load();
        await snapshots.flush();
        if (!closed) scheduleFlush();
      }, snapshots.healthy ? untilNextHour : Math.min(untilNextHour, minuteMs));
      flushTimer.unref();
    };
    scheduleFlush();
    app.addHook('onClose', async () => {
      closed = true;
      v5Metrics.delete(app);
      stopSampling();
      stopMonitorMetrics();
      clearTimeout(flushTimer);
      await snapshots.flush({ includeCurrentHour: true });
    });
  }

  async function view() {
    const report = { ...store.view(), enabled, snapshotAvailable: snapshots?.healthy ?? false, chatAvailable: chatAvailable() };
    if (!enabled) return report;
    const chatWindows = Object.values(report.windows);
    const monitorWindows: Pick<MetricWindow, 'startMs' | 'endMs' | 'monitors'>[] = [...chatWindows];
    if (report.completedMonitorWeek) monitorWindows.push(report.completedMonitorWeek);
    const [monitorFeedback, replyQuality] = await Promise.allSettled([
      readMonitorFeedbackMetrics(db, monitorWindows),
      readReplyQualityMetrics(db, chatWindows),
    ]);
    if (monitorFeedback.status === 'fulfilled') {
      monitorWindows.forEach((window, index) => {
        if (window.monitors) window.monitors.alerts = monitorFeedback.value[index];
      });
    }
    if (replyQuality.status === 'fulfilled') {
      chatWindows.forEach(({ roles }, index) => {
        const quality = replyQuality.value[index];
        if (quality?.council) roles.owner.chat.council = quality.council;
        if (quality?.feedback) {
          roles.owner.chat.feedback = quality.feedback.owner;
          roles.member.chat.feedback = quality.feedback.member;
        }
      });
    }
    return report;
  }

  return {
    // Register after the application's normal session and member gate, which default-denies both routes.
    registerRoutes() {
      app.get(METRICS_PATH, async () => view());
      app.get(METRICS_CSV_PATH, async (_request, reply) => reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="production-metrics.csv"')
        .send(metricsCsv(await view())));
    },
  };
}
