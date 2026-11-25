import { z } from 'zod';
import { MonitorAlertSchema } from './monitor-feedback';

const label = z.string().trim().min(1).max(180);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const httpsUrl = z.string().max(2048).url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'Use a public HTTPS address without credentials or a fragment.');

export const MonitorSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), url: httpsUrl, anchor: label.optional() }).strict(),
  z.object({ kind: z.literal('currency'), base: currency, quote: currency }).strict(),
  z.object({ kind: z.literal('weather'), location: label, latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(), metric: z.enum(['temperature', 'precipitation', 'wind']) }).strict(),
  z.object({ kind: z.literal('search'), query: z.string().trim().min(2).max(300) }).strict(),
  z.object({ kind: z.literal('run'), runId: z.uuid() }).strict(),
]);
export const MonitorReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }).strict(),
  z.object({ kind: z.literal('number'), label: label.optional() }).strict(),
  z.object({ kind: z.literal('status'), label: label.optional() }).strict(),
  z.object({ kind: z.literal('date'), label: label.optional() }).strict(),
  z.object({ kind: z.literal('phrase'), phrase: label }).strict(),
  z.object({ kind: z.literal('items') }).strict(),
]);
const directed = { direction: z.enum(['above', 'below']), value: z.number(), hysteresis: z.number().positive() };
export const MonitorConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('change') }).strict(),
  z.object({ kind: z.literal('equals'), value: label }).strict(),
  z.object({ kind: z.literal('contains'), value: label }).strict(),
  z.object({ kind: z.literal('appears') }).strict(),
  z.object({ kind: z.literal('disappears') }).strict(),
  z.object({ kind: z.literal('threshold'), ...directed }).strict(),
  z.object({ kind: z.literal('crossing'), ...directed }).strict(),
  z.object({ kind: z.literal('percent'), direction: z.enum(['above', 'below', 'either']), value: z.number().positive() }).strict(),
  z.object({ kind: z.literal('new-item') }).strict(),
]);
export const MonitorTimingSchema = z.object({
  urgency: z.enum(['normal', 'urgent']), lifetimeMs: z.number().int().positive(), deadline: z.iso.datetime().optional(),
  initialIntervalMs: z.number().int().positive(), maxChecks: z.number().int().positive(), maxNotifications: z.number().int().positive(),
}).strict();

const minuteMs = 60_000;
const maxWindowMs = 30 * 24 * 60 * minuteMs;
const checkWindow = z.number().int().min(minuteMs).max(maxWindowMs);
export const MonitorValueTargetSchema = z.object({
  property: z.enum(['price', 'availability', 'startDate', 'eventStatus', 'productName']).optional(),
  currency: currency.optional(), unit: label.optional(),
}).strict();
export const MonitorTrendSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent-window'), direction: z.enum(['rise', 'fall']),
    percent: z.number().positive(), windowMs: checkWindow }).strict(),
  z.object({ kind: z.literal('consecutive'), direction: z.enum(['rise', 'fall']),
    checks: z.number().int().min(2).max(maxWindowMs / (6 * 60 * minuteMs) + 24) }).strict(),
]);
const monitorV2TargetOptions = {
  freshnessMs: checkWindow, target: MonitorValueTargetSchema.optional(), trend: MonitorTrendSchema.optional(),
};
export const MonitorV2TargetSchema = z.object({
  source: MonitorSourceSchema, read: MonitorReadSchema, condition: MonitorConditionSchema, ...monitorV2TargetOptions,
}).strict();
export const MonitorV2Schema = z.object({
  ...monitorV2TargetOptions,
  additional: z.array(MonitorV2TargetSchema).min(1).max(2).optional(),
  combine: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('and') }).strict(),
    z.object({ kind: z.literal('or') }).strict(),
    z.object({ kind: z.literal('sequence'), windowMs: checkWindow }).strict(),
  ]).optional(),
  delivery: z.enum(['once', 'each', 'daily']).optional(),
}).strict();

function monitorTargetIssues(
  source: z.infer<typeof MonitorSourceSchema>, read: z.infer<typeof MonitorReadSchema>,
  condition: z.infer<typeof MonitorConditionSchema>, options?: Partial<z.infer<typeof MonitorV2TargetSchema>>,
) {
  const issues: string[] = [];
  if (source.kind === 'currency' && source.base === source.quote) issues.push('Choose two different currencies.');
  if (source.kind === 'weather' && (source.latitude === undefined) !== (source.longitude === undefined)) issues.push('Supply both coordinates.');
  if ((source.kind === 'currency' || source.kind === 'weather') && read.kind !== 'number') issues.push('A live-data series yields a number.');
  if (source.kind === 'search' && read.kind !== 'items') issues.push('Search yields a list of results.');
  if (source.kind === 'run' && read.kind !== 'status') issues.push('A background run yields its status.');
  if ((condition.kind === 'threshold' || condition.kind === 'crossing' || condition.kind === 'percent') && read.kind !== 'number') issues.push('This condition requires a number.');
  if ((condition.kind === 'equals' || condition.kind === 'contains') && !['main', 'status', 'date'].includes(read.kind)) issues.push('This condition requires text.');
  if ((condition.kind === 'appears' || condition.kind === 'disappears') && read.kind !== 'phrase') issues.push('This condition requires a phrase to watch.');
  if (condition.kind === 'new-item' && read.kind !== 'items') issues.push('This condition requires an item list.');
  if (options?.trend && (read.kind !== 'number' || condition.kind !== 'change')) issues.push('A trend requires a numeric change condition.');
  if (options?.target && source.kind !== 'page') issues.push('A structured value target requires a public page.');
  if (options?.target?.property) {
    const reads = { price: 'number', availability: 'status', startDate: 'date', eventStatus: 'status', productName: 'main' } as const;
    if (reads[options.target.property] !== read.kind) issues.push('The reading is incompatible with the structured property.');
  }
  if ((options?.target?.currency || options?.target?.unit) && read.kind !== 'number') issues.push('A currency or unit requires a numeric reading.');
  return issues;
}

export const MonitorSpecSchema = z.object({
  source: MonitorSourceSchema, read: MonitorReadSchema, condition: MonitorConditionSchema, timing: MonitorTimingSchema,
  language: z.enum(['ar', 'en']), message: z.string().trim().min(1).max(500), title: label,
  v2: MonitorV2Schema.optional(),
}).strict().superRefine(({ source, read, condition, v2 }, ctx) => {
  for (const message of monitorTargetIssues(source, read, condition, v2)) ctx.addIssue({ code: 'custom', message });
  if (!v2) return;
  function issue(message: string, path: (string | number)[] = []) {
    ctx.addIssue({ code: 'custom', message, path: ['v2', ...path] });
  }
  if (Boolean(v2.additional) !== Boolean(v2.combine)) issue('Choose how to combine the additional sources.', ['combine']);
  if (v2.combine?.kind === 'sequence' && v2.additional?.length !== 1) issue('A sequence requires exactly two sources.', ['additional']);
  const additional = v2.additional ?? [];
  for (const [index, item] of additional.entries()) {
    for (const message of monitorTargetIssues(item.source, item.read, item.condition, item)) issue(message, ['additional', index]);
  }
  if (v2.delivery && v2.delivery !== 'once' && ![condition, ...additional.map(item => item.condition)].some(item => item.kind === 'new-item')) {
    issue('Recurring delivery requires a new-item condition.', ['delivery']);
  }
});

const observationValue = z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(2100)).max(100)]);
export const MonitorObservationSchema = z.object({
  value: observationValue,
  excerpt: z.string().max(1000), observedAt: z.iso.datetime(),
}).strict();
export const MonitorOfferSchema = z.enum(['explicit', 'implicit', 'agent-initiated']);
export const MonitorClarificationSchema = z.object({
  question: z.string().trim().min(1).max(500),
  choices: z.array(z.object({ id: z.string().min(1).max(128), label, value: observationValue }).strict()).min(2).max(4),
}).strict();
export const MonitorCardSchema = z.object({
  id: z.uuid(), conversationId: z.uuid(), spec: MonitorSpecSchema,
  status: z.enum(['proposed', 'active', 'paused', 'stopped', 'completed', 'expired']),
  current: MonitorObservationSchema.nullable(), lastCheckedAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime(),
  offer: MonitorOfferSchema.optional(), note: z.string().max(1000).optional(), clarification: MonitorClarificationSchema.optional(),
  alerts: z.array(MonitorAlertSchema).optional(),
}).strict();
export const MonitorListSchema = z.object({ monitors: z.array(MonitorCardSchema) }).strict();
export const MonitorApproveSchema = z.object({ proposalId: z.uuid() }).strict();

export type MonitorSource = z.infer<typeof MonitorSourceSchema>;
export type MonitorRead = z.infer<typeof MonitorReadSchema>;
export type MonitorCondition = z.infer<typeof MonitorConditionSchema>;
export type MonitorValueTarget = z.infer<typeof MonitorValueTargetSchema>;
export type MonitorTrend = z.infer<typeof MonitorTrendSchema>;
export type MonitorV2Target = z.infer<typeof MonitorV2TargetSchema>;
export type MonitorV2Spec = z.infer<typeof MonitorV2Schema>;
export type MonitorClarification = z.infer<typeof MonitorClarificationSchema>;
export type MonitorTiming = z.infer<typeof MonitorTimingSchema>;
export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;
export type MonitorObservation = z.infer<typeof MonitorObservationSchema>;
export type MonitorOffer = z.infer<typeof MonitorOfferSchema>;
export type MonitorCard = z.infer<typeof MonitorCardSchema>;

// A maximum quiet interval plus one scheduler poll.
export const MONITOR_V2_DEFAULT_FRESHNESS_MS = (6 * 60 * 60 + 30) * 1000;

export function monitorV2Targets(spec: MonitorSpec): MonitorV2Target[] {
  const { source, read, condition, v2 } = spec;
  return [{ source, read, condition, freshnessMs: v2?.freshnessMs ?? MONITOR_V2_DEFAULT_FRESHNESS_MS,
    ...(v2?.target && { target: v2.target }), ...(v2?.trend && { trend: v2.trend }) }, ...(v2?.additional ?? [])];
}
