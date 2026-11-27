import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const ageHours = z.number().nonnegative();

export const BackupStatusResponseSchema = z.object({
  newestDump: z.object({
    snapshotAt: timestamp,
    finishedAt: timestamp,
    ageHours,
    sizeBytes: z.int().positive().optional(),
  }).nullable(),
  lastDrill: z.object({
    finishedAt: timestamp,
    verdict: z.enum(["passed", "failed"]),
    ageHours,
  }).nullable(),
  offServerCopy: z.object({ downloadedAt: timestamp }).nullable(),
});

export type BackupStatusResponse = z.infer<typeof BackupStatusResponseSchema>;
