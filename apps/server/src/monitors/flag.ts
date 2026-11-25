export const smartMonitorsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.MOHASSAN_MONITORS_ENABLED === '1';

export const smartMonitorsV2Enabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsEnabled(env) && env.MOHASSAN_MONITORS_V2 === '1';
