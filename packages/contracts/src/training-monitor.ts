export const TRAINING_SPEED_GUARD_RATIO = 0.7;
export const TRAINING_SPEED_GUARD_SECONDS = 120;

export type TrainingRunStatus =
  | 'running'
  | 'completed'
  | 'early_stopped'
  | 'failed'
  | 'paused_by_stop_file'
  | 'paused_time_limit'
  | 'interrupted';

export interface TrainingSpeed {
  current: number;
  average30Minutes: number;
  averageWindowSeconds: number | null;
  firstMinute: number | null;
  guardLine: number | null;
  distanceFromGuardLine: number | null;
  consecutiveSlowSeconds: number | null;
  sampledAt: string;
}

export interface TrainingAttempt {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  status: TrainingRunStatus | 'crashed' | 'unknown';
  resumed: boolean | null;
}

export interface TrainingRun {
  run: string;
  shape: string;
  status: TrainingRunStatus;
  step: number | null;
  processedTokens: number | null;
  totalTokens: number | null;
  percentDone: number | null;
  updatedAt: string | null;
  etaAt: string | null;
  speed: TrainingSpeed | null;
  lastValidation: Record<string, number>;
  bestValidation: Record<string, number>;
  lastCheckpoint: { tokens: number; savedAt: string | null } | null;
  nextCheckpoint: { tokens: number; etaAt: string | null } | null;
  stopRequested: boolean;
  currentAttempt: string | null;
  attempts: TrainingAttempt[];
}

export interface TrainingGpuLock {
  owner: string | null;
  purpose: string | null;
  pid: number | null;
  started: string | null;
}

export interface TrainingRuns {
  active: TrainingRun | null;
  recent: TrainingRun[];
  gpuLock: TrainingGpuLock | null;
}

export interface TrainingGpuSample {
  temperatureC: number;
  utilizationPercent: number;
  memoryUsedMiB: number;
}

export interface TrainingMonitorSnapshot extends TrainingRuns {
  gpu: TrainingGpuSample | null;
  sampledAt: string;
}
