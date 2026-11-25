import {
  monitorDeliveryChannels, monitorPauseReasons, type MonitorHealthMetrics,
} from '@mohassan/contracts';
import { createHistogram, histogramPercentiles, mergeHistograms, type Histogram } from './histogram.js';

export type MonitorMetricBucket = Pick<MonitorHealthMetrics, 'delivered' | 'pauses'> & {
  checked: number;
  succeeded: number;
  lateness?: Histogram;
};

export function createMonitorMetricBucket(): MonitorMetricBucket {
  return {
    checked: 0, succeeded: 0,
    delivered: { conversation: 0, tab: 0, webPush: 0, apns: 0 },
    pauses: { manual: 0, missing: 0, unreachable: 0 },
  };
}

export function mergeMonitorMetricBucket(target: MonitorMetricBucket, source: MonitorMetricBucket,
  allocate = createHistogram as () => Histogram | undefined) {
  target.checked += source.checked;
  target.succeeded += source.succeeded;
  for (const channel of monitorDeliveryChannels) target.delivered[channel] += source.delivered[channel];
  for (const reason of monitorPauseReasons) target.pauses[reason] += source.pauses[reason];
  if (source.lateness) {
    target.lateness ??= allocate();
    if (target.lateness) mergeHistograms(target.lateness, source.lateness);
  }
}

export function summarizeMonitorMetrics(bucket: MonitorMetricBucket): MonitorHealthMetrics {
  const { checked, succeeded, lateness } = bucket;
  const [p50 = null, p95 = null] = histogramPercentiles(lateness, [0.5, 0.95]);
  return {
    checkLatenessMs: { samples: lateness?.samples ?? 0, p50, p95 },
    checks: { attempted: checked, succeeded, successRate: checked ? succeeded / checked : null },
    delivered: { ...bucket.delivered },
    pauses: { ...bucket.pauses },
  };
}
