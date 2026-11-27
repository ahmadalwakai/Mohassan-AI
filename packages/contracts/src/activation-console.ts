import { z } from 'zod';

const count = z.number().int().nonnegative();

export const ActivationObservationSchema = z.object({
  eventCount: count,
  comparedCount: count,
  disagreements: count,
  errors: count,
  lastObservedAt: z.iso.datetime(),
}).strict();

export const ActivationSwitchSchema = z.object({
  name: z.string(),
  kind: z.enum(['feature', 'configuration', 'process']),
  sensitive: z.boolean(),
  readers: z.array(z.object({
    module: z.string(),
    defaultValue: z.string(),
    parsing: z.string(),
    needsRestart: z.boolean(),
  }).strict()),
  currentValue: z.string().nullable(),
  configuredValue: z.string().nullable(),
  ownerTrial: z.string().nullable(),
  dependencies: z.array(z.string()),
  preflight: z.object({ path: z.string(), args: z.array(z.string()) }).strict().nullable(),
  evidence: z.object({ path: z.string(), summary: z.string() }).strict().nullable(),
  risk: z.string(),
  sources: z.array(z.string()),
  observation: ActivationObservationSchema.nullable(),
}).strict();

export const ActivationConsoleSnapshotSchema = z.object({
  switches: z.array(ActivationSwitchSchema),
  observationWindowDays: z.number().int().positive(),
}).strict();

export type ActivationObservation = z.infer<typeof ActivationObservationSchema>;
export type ActivationSwitch = z.infer<typeof ActivationSwitchSchema>;
export type ActivationConsoleSnapshot = z.infer<typeof ActivationConsoleSnapshotSchema>;
