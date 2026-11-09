import { z } from 'zod';

/** FreeLLMAPI model ids are printable ASCII (catalog ids may contain `/` and `:`). */
export const InferenceModelIdSchema = z.string().trim().min(1).max(300).regex(/^[\x21-\x7e]+$/);

export const AIProviderSettingsInputSchema = z.object({
  enabled: z.boolean(),
  /** Priority order: the router tries these FreeLLMAPI models first to last. */
  models: z.array(InferenceModelIdSchema).min(1).max(8).refine(list => new Set(list).size === list.length, 'duplicate model'),
  automaticFallback: z.boolean(),
  freeOnly: z.boolean(),
}).strict();
export type AIProviderSettingsInput = z.infer<typeof AIProviderSettingsInputSchema>;

const Iso = z.string().max(40);
const Count = z.number().int().nonnegative();

export const InferenceModelSchema = z.object({
  id: InferenceModelIdSchema, name: z.string().max(300).nullable(), ownedBy: z.string().max(100),
  contextWindow: z.number().int().positive().nullable(), router: z.boolean(), available: z.boolean(),
  executionStatus: z.enum(['ready', 'needsKey', 'exhausted']).nullable(),
  supportsTools: z.boolean(), supportsStructuredOutput: z.boolean(), supportsStreaming: z.boolean(),
});

export const InferenceEventSchema = z.object({
  at: Iso, kind: z.enum(['success', 'rate_limited', 'quota_exhausted', 'failure', 'fallback', 'paid_fallback_blocked', 'non_free_route', 'retry']),
  provider: z.string().max(60), model: z.string().max(300), code: z.string().max(60).optional(), to: z.string().max(320).optional(), detail: z.string().max(300).optional(),
});

export const KnownQuotaSchema = z.object({
  provider: z.string().max(60), model: z.string().max(300).nullable(), metric: z.enum(['tokens', 'requests']),
  remaining: z.number().nullable(), limit: z.number().nullable(), resetAt: Iso.nullable(),
  source: z.enum(['verified', 'estimated']), observedAt: Iso, note: z.string().max(300),
});

export const ModelCountersSchema = z.object({
  provider: z.string().max(60), model: z.string().max(300), day: z.string().max(10), requests: Count, failures: Count,
  inputTokens: Count, outputTokens: Count, estimatedTokens: Count, estimatedCostUsd: z.number().nonnegative().nullable(),
});

export const AIProvidersStatusSchema = z.object({
  freellmapi: z.object({
    configured: z.boolean(),
    baseUrl: z.string().max(400).nullable(),
    settings: AIProviderSettingsInputSchema,
    allowPaidFallback: z.boolean(),
    health: z.object({
      status: z.enum(['unknown', 'reachable', 'error']),
      checkedAt: Iso.nullable(), code: z.string().max(60).nullable(), message: z.string().max(400),
      readyModels: Count.nullable(),
    }),
    models: z.array(InferenceModelSchema).max(400),
    modelsTruncated: z.boolean(),
    /** The gateway's own monthly ledger (`GET /v1/usage`): verified, not an estimate. */
    gatewayUsage: z.object({ month: z.string().max(20), resetsAt: Iso.nullable(), requests: Count, tokens: Count, byPlatform: z.array(z.object({ platform: z.string().max(80), requests: Count, tokens: Count })).max(200) }).nullable(),
  }),
  groq: z.object({ configured: z.boolean(), models: z.array(z.string().max(300)).max(10) }),
  usage: z.object({
    since: Iso,
    active: z.object({ provider: z.string().max(60), model: z.string().max(300), at: Iso }).nullable(),
    requestsLastMinute: Count,
    today: z.array(ModelCountersSchema).max(500),
    totals: z.object({ inputTokens: Count, outputTokens: Count, totalTokens: Count, requests: Count, failures: Count, estimatedCostUsd: z.number().nonnegative().nullable() }),
    quotas: z.array(KnownQuotaSchema).max(100),
    events: z.array(InferenceEventSchema).max(50),
    /** Assistant decisions recorded in SQL today (UTC); survives restarts. */
    recorded: z.array(z.object({ model: z.string().max(320), requests: Count, failures: Count, inputTokens: Count, outputTokens: Count })).max(100),
  }),
});
export type AIProvidersStatus = z.infer<typeof AIProvidersStatusSchema>;
