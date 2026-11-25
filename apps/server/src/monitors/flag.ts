export const smartMonitorsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.MOHASSAN_MONITORS_ENABLED === '1';

export const smartMonitorsV2Enabled = (env: NodeJS.ProcessEnv = process.env) =>
  smartMonitorsEnabled(env) && env.MOHASSAN_MONITORS_V2 === '1';

export function monitorSourceFlags(env: NodeJS.ProcessEnv = process.env) {
  const v2 = smartMonitorsV2Enabled(env);
  return {
    github: v2 && env.MOHASSAN_MONITORS_GITHUB === '1',
    pdf: v2 && env.MOHASSAN_MONITORS_PDF === '1',
    visual: v2 && env.MOHASSAN_MONITORS_VISUAL === '1',
  };
}

export type MonitorSourceFlags = ReturnType<typeof monitorSourceFlags>;
