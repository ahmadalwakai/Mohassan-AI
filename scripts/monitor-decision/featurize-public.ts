import { createInterface } from 'node:readline';
import { buildMonitorContextFrame } from '../../apps/server/src/monitors/decision/frame.js';
import {
  MONITOR_DECISION_FRAME_FEATURE_KEYS,
  MONITOR_TEXT_FEATURE_BUCKETS,
  monitorDecisionFeatures,
} from '../../apps/server/src/monitors/decision/features.js';

if (process.argv[2] === '--schema') {
  console.log(JSON.stringify({
    frameFeatureKeys: MONITOR_DECISION_FRAME_FEATURE_KEYS,
    textFeatureDimensions: MONITOR_TEXT_FEATURE_BUCKETS,
  }));
} else {
  // This process receives only checksum-verified, exclusion-filtered public corpus text.
  const now = new Date(process.argv[2] ?? '');
  if (!Number.isFinite(now.getTime())) throw new Error('Expected a fixed corpus reference time.');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const text: unknown = JSON.parse(line);
    if (typeof text !== 'string') throw new Error('Expected a public corpus utterance.');
    console.log(JSON.stringify(monitorDecisionFeatures(buildMonitorContextFrame({ text, now }))));
  }
}
