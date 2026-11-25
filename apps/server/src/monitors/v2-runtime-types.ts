import type { MonitorObservation } from './evaluation.js';
import type { MonitorPageCandidate, MonitorPageRelocation } from './page-v2.js';
import type { MonitorV2EvaluationState } from './evaluation-v2.js';
import type { MonitorScheduleState } from './schedule-v2.js';
import type { MonitorSourceCache } from './sources.js';

export interface MonitorV2Clarification {
  index: number;
  candidates: MonitorPageCandidate[];
  cache?: MonitorSourceCache;
}

export interface MonitorV2Preview {
  samples: { index: number; observation: MonitorObservation }[];
  caches: (MonitorSourceCache | null)[];
  publicationTimes?: string[];
  clarification?: MonitorV2Clarification;
  additionalClarifications?: MonitorV2Clarification[];
}

export interface MonitorV2State {
  evaluation?: MonitorV2EvaluationState;
  schedule?: MonitorScheduleState;
  caches: (MonitorSourceCache | null)[];
  cursor: number;
  failures?: number[];
  lastReads?: (number | null)[];
  clarification?: MonitorV2Clarification & { resume: 'proposed' | 'active' };
  additionalClarifications?: MonitorV2Clarification[];
  relocations?: (MonitorPageRelocation & { index: number })[];
}
