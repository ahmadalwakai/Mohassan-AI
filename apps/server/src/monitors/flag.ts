export const smartMonitorsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.MOHASSAN_MONITORS_ENABLED === '1';

export const smartMonitorsV2Enabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsEnabled(env) && env.MOHASSAN_MONITORS_V2 === '1';

export const monitorContextEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsV2Enabled(env) && env.MOHASSAN_MONITOR_CONTEXT === '1';

export const monitorContextShadowEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsV2Enabled(env) && env.MOHASSAN_MONITOR_CONTEXT_SHADOW === '1';
