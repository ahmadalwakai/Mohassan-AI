import { z } from 'zod';

export const decisionRoutes = [
  'web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing',
  'planning', 'coding', 'chat', 'unsupported', 'image', 'media', 'reply', 'clarify', 'skill', 'capture',
  'document', 'compound', 'site', 'knowledge', 'inventory', 'resume',
] as const;
const DecisionRouteSchema = z.enum(decisionRoutes);
export type DecisionRoute = z.infer<typeof DecisionRouteSchema>;

export const evidenceCodes = [
  'cascade_match', 'cascade_weak_match', 'route_decision', 'router_top', 'follow_up', 'memory_hit',
  'pending_card', 'missing_context', 'restricted', 'missing_capability', 'unresolved', 'explicit_destination',
  'request_scope', 'clarified_choice', 'no_supported_candidate', 'unsupported_operation',
] as const;
const EvidenceCodeSchema = z.enum(evidenceCodes);
export type EvidenceCode = z.infer<typeof EvidenceCodeSchema>;

export const decisionReasons = [
  'lowest_expected_cost', 'missing_context', 'restricted', 'missing_capability', 'no_supported_candidate',
  'pending_card', 'clarified_choice', 'scope_conflict',
] as const;
const DecisionReasonSchema = z.enum(decisionReasons);
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

const HandlerSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/u);
const DecisionOutcomeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('act'), route: DecisionRouteSchema, handler: HandlerSchema.optional() }),
  z.strictObject({ action: z.literal('ask') }),
  z.strictObject({ action: z.literal('abstain') }),
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const reviewFindingCodes = [
  'decision_mismatch', 'missing_part', 'unverified_part', 'wrong_entity', 'unsupported_answer',
  'format_language', 'format_sentences', 'format_brief', 'format_fields', 'format_json',
] as const;
const ReviewFindingSchema = z.enum(reviewFindingCodes);
export type ReviewFindingCode = z.infer<typeof ReviewFindingSchema>;
const partCount = z.number().int().min(0).max(9);
export const DeliberationReviewSchema = z.strictObject({
  checkedParts: partCount,
  answeredParts: partCount,
  initialFindings: z.array(ReviewFindingSchema).max(reviewFindingCodes.length),
  findings: z.array(ReviewFindingSchema).max(reviewFindingCodes.length),
  revision: z.enum(['none', 'format', 'read']),
});
export type DeliberationReview = z.infer<typeof DeliberationReviewSchema>;

// References use offsets only. Request text, entity names, memory values, and tool output never go on the wire.
const TurnSpanSchema = z.strictObject({
  turn: z.enum(['current', 'previous']),
  start: z.number().int().min(0).max(100_000),
  end: z.number().int().min(0).max(100_000),
}).refine(span => span.start <= span.end);

export const ThoughtRecordSchema = z.strictObject({
  version: z.literal(1),
  candidates: z.array(z.strictObject({
    route: DecisionRouteSchema,
    handler: HandlerSchema,
    score: z.number(),
    evidence: z.array(EvidenceCodeSchema).max(evidenceCodes.length),
  })).max(128),
  chosen: DecisionOutcomeSchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(DecisionReasonSchema).max(decisionReasons.length),
  changeEvidence: z.array(EvidenceCodeSchema).max(evidenceCodes.length),
  readings: z.array(z.strictObject({
    route: DecisionRouteSchema,
    scope: z.enum(['public', 'private', 'unknown']),
    spans: z.array(TurnSpanSchema).max(8),
  })).max(4),
  legacy: DecisionOutcomeSchema.optional(),
  legacyObserved: z.boolean().optional(),
  disagrees: z.boolean().optional(),
  enforced: z.boolean().optional(),
  review: DeliberationReviewSchema.optional(),
});
export type ThoughtRecord = z.infer<typeof ThoughtRecordSchema>;
export const MAX_EARLIER_THOUGHT_RECORDS = 8;
