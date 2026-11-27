import { z } from 'zod';

/**
 * The owner's models page: every registered model with where it is used, and a run of one model on the owner's input
 * (apps/server/src/models-routes.ts). Owner only; never in MEMBER_ROUTES.
 */
export const ModelInputKindSchema = z.enum(['text', 'reading', 'image', 'none']);
export type ModelInputKind = z.infer<typeof ModelInputKindSchema>;

export const ModelUseSchema = z.enum(['chat', 'council', 'page']);
export type ModelUse = z.infer<typeof ModelUseSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1).max(64),
  version: z.string().max(120),
  task: z.string().max(240),
  runtime: z.enum(['node-cpu', 'python-worker', 'gpu']),
  /** Whether every required file is on this server. */
  present: z.boolean(),
  input: ModelInputKindSchema,
  /** Why the page cannot run it (not trained here, needs its own runner, needs structured input). */
  unavailable: z.string().max(240).optional(),
  gates: z.array(z.string().max(240)).max(8),
  measured: z.string().max(240).optional(),
  uses: z.array(ModelUseSchema).max(3),
}).strict();
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

const count = z.number().int().nonnegative();
/** In-memory member council outcomes since server start, with one count per attempt. */
const MemberCouncilMetricsSchema = z.object({
  /** The council completed and kept the pipeline's reply. */
  completed: count,
  /** The council completed and selected a model's reply. */
  changed: count,
  skippedLoad: count,
  skippedDeadline: count,
  failed: count,
}).strict();
export type MemberCouncilMetrics = z.infer<typeof MemberCouncilMetricsSchema>;

export const ModelListSchema = z.object({
  models: z.array(ModelInfoSchema).max(128),
  council: z.boolean(),
  memberCouncil: MemberCouncilMetricsSchema.optional(),
}).strict();
export type ModelList = z.infer<typeof ModelListSchema>;

export const ModelRunRequestSchema = z.object({
  text: z.string().trim().min(1).max(4_000).optional(),
  /** Reading models: the passage the question is answered from. */
  passage: z.string().trim().min(1).max(6_000).optional(),
  image: z.object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    data: z.string().min(16).max(7_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict().optional(),
}).strict();
export type ModelRunRequest = z.infer<typeof ModelRunRequestSchema>;

export const ModelRunResponseSchema = z.object({
  ok: z.boolean(),
  elapsedMs: z.number().int().min(0),
  /** The model's own output as JSON text, shortened. */
  output: z.string().max(20_000).optional(),
  /** The readable part of the output (generated text, label or reading), when there is one. */
  text: z.string().max(4_000).optional(),
  reason: z.string().max(80).optional(),
  detail: z.string().max(300).optional(),
}).strict();
export type ModelRunResponse = z.infer<typeof ModelRunResponseSchema>;
