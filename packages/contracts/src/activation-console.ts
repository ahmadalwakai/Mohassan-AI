import { z } from 'zod';

export const ACTIVATION_DEFAULT_DAYS = 7;
export const ACTIVATION_MAX_DAYS = 90;
export const ACTIVATION_GATE_MAX_BYTES = 64 * 1024;
export const ACTIVATION_REASON_MAX_LENGTH = 500;

const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const reviews = z.object({ better: count, worse: count, same: count });

export const ActivationLabelSchema = z.enum(['better', 'worse', 'same']);
export const ActivationReviewInputSchema = z.object({
  sampleId: z.string().min(1).max(128),
  label: ActivationLabelSchema,
  trainingAllowed: z.boolean().optional(),
}).strict();

export const ActivationStateInputSchema = z.object({
  capabilityId: z.string().min(1).max(100),
  enabled: z.boolean(),
  reason: z.string().trim().min(1).max(ACTIVATION_REASON_MAX_LENGTH).optional(),
  gate: z.object({
    record: z.string().min(1).max(ACTIVATION_GATE_MAX_BYTES).refine(value => new TextEncoder().encode(value).length <= ACTIVATION_GATE_MAX_BYTES),
    sha256: sha256.transform(value => value.toLowerCase()),
  }).strict().optional(),
}).strict();

export const ActivationConsoleSnapshotSchema = z.object({
  window: z.object({ days: z.number().int().min(1).max(ACTIVATION_MAX_DAYS), from: z.iso.datetime(), to: z.iso.datetime() }),
  minimumReviews: z.number().int().positive(),
  capabilities: z.array(z.object({
    id: z.string(),
    nameAr: z.string(),
    flag: z.string().nullable(),
    runtimeReady: z.boolean(),
    gateRequired: z.boolean(),
    gateSha256: sha256.nullable(),
    enabled: z.boolean(),
    eventCount: count,
    comparedCount: count,
    disagreements: count,
    disagreementRate: z.number().min(0).max(1).nullable(),
    categories: z.array(z.object({ category: z.string(), count })),
    latency: z.object({ count, meanMs: z.number().nonnegative().nullable() }),
    errors: count,
    reviews,
    canEnable: z.boolean(),
  })),
  samples: z.array(z.object({
    id: z.string(),
    capabilityId: z.string(),
    occurredAt: z.iso.datetime(),
    category: z.string().nullable(),
    baselineKind: z.enum(['reply', 'decision']),
    baseline: z.string(),
    shadow: z.string(),
  })),
  audit: z.array(z.object({
    capabilityId: z.string(),
    enabled: z.boolean(),
    actorId: z.string(),
    at: z.iso.datetime(),
    reason: z.string(),
    gateSha256: sha256.nullable(),
    evidence: reviews.extend({ minimumReviews: z.number().int().positive() }),
  })),
});
export const ActivationActionResultSchema = z.object({ ok: z.literal(true) });

export type ActivationLabel = z.infer<typeof ActivationLabelSchema>;
export type ActivationReviewInput = z.infer<typeof ActivationReviewInputSchema>;
export type ActivationStateInput = z.infer<typeof ActivationStateInputSchema>;
export type ActivationConsoleSnapshot = z.infer<typeof ActivationConsoleSnapshotSchema>;
