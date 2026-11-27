import { headers } from "next/headers";
import { backupStatusPath, requestBackupStatus } from "./backup-status-data";
import { BackupStatusPanel } from "./backup-status-panel";
import { ProductionMetrics } from "./production-metrics";
import { metricsPath, requestMetrics } from "./metrics-data";

export default async function ProductionMetricsPage() {
  // Use the same internal Fastify connection and cookie as the API proxy.
  const secret = process.env.INTERNAL_API_SECRET;
  const cookie = (await headers()).get("cookie");
  const serverUrl = process.env.MOHASSAN_SERVER_URL || "http://127.0.0.1:4000";
  const options = secret ? {
    headers: { "x-mohassan-internal": secret, cookie: cookie ?? "" },
    signal: AbortSignal.timeout(15_000),
  } : null;
  const error = { kind: "error" } as const;
  const [metrics, backupStatus] = options
    ? await Promise.all([
      requestMetrics(new URL(metricsPath, serverUrl), options),
      requestBackupStatus(new URL(backupStatusPath, serverUrl), options),
    ])
    : [error, error];

  return <ProductionMetrics initialState={metrics} backupStatus={<BackupStatusPanel state={backupStatus} />} />;
}
