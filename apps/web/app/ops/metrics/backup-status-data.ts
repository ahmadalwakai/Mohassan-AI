import { BackupStatusResponseSchema, type BackupStatusResponse } from "@mohassan/contracts";

export const backupStatusPath = "/api/ops/backup-status";

// Freshness limits from the production verifier, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/check-cloud.mjs#L4-L5
export const dumpLimitHours = 26;
export const drillLimitHours = 8 * 24;

// Give the daily off-server pull the same allowance as the daily dump. Schedule retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/backup-pull/task-scheduler.xml#L8-L14
export const copyLimitHours = dumpLimitHours;

export type BackupStatusState =
  | { kind: "error" | "signin" | "forbidden" }
  | { kind: "ready"; report: BackupStatusResponse; copyAgeHours: number | null };

export async function requestBackupStatus(path: URL, options: RequestInit): Promise<BackupStatusState> {
  try {
    const response = await fetch(path, { ...options, cache: "no-store", redirect: "error" });
    if (response.status === 401) return { kind: "signin" };
    if (response.status === 403) return { kind: "forbidden" };
    if (!response.ok) return { kind: "error" };

    const parsed = BackupStatusResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: "error" };
    const report = parsed.data;
    const copyAgeHours = report.offServerCopy === null
      ? null
      : Math.max(0, (Date.now() - Date.parse(report.offServerCopy.downloadedAt)) / (60 * 60 * 1000));
    return { kind: "ready", report, copyAgeHours };
  } catch {
    return { kind: "error" };
  }
}
