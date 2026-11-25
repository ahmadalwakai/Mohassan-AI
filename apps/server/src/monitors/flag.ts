import { smartMonitorsEnabled } from '../monitors-phase1/rollout.js';

export { monitorRollout, smartMonitorsEnabled } from '../monitors-phase1/rollout.js';

export const smartMonitorsV2Enabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsEnabled(env) && env.MOHASSAN_MONITORS_V2 === '1';
