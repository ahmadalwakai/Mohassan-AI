import { z } from 'zod';

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
export const MonitorSpecSchema = z.object({
  source: MonitorSourceSchema, read: MonitorReadSchema, condition: MonitorConditionSchema, timing: MonitorTimingSchema,
  language: z.enum(['ar', 'en']), message: z.string().trim().min(1).max(500), title: label,
}).strict().superRefine(({ source, read, condition }, ctx) => {
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
  for (const message of issues) ctx.addIssue({ code: 'custom', message });
});

export const MonitorObservationSchema = z.object({
  value: z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(2100)).max(100)]),
  excerpt: z.string().max(1000), observedAt: z.iso.datetime(),
}).strict();
export const MonitorOfferSchema = z.enum(['explicit', 'implicit', 'agent-initiated']);
export const MonitorCardSchema = z.object({
  id: z.uuid(), conversationId: z.uuid(), spec: MonitorSpecSchema,
  status: z.enum(['proposed', 'active', 'paused', 'stopped', 'completed', 'expired']),
  current: MonitorObservationSchema.nullable(), lastCheckedAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime(),
  offer: MonitorOfferSchema.optional(), note: z.string().max(1000).optional(),
}).strict();
export const MonitorListSchema = z.object({ monitors: z.array(MonitorCardSchema) }).strict();
export const MonitorApproveSchema = z.object({ proposalId: z.uuid() }).strict();

export type MonitorSource = z.infer<typeof MonitorSourceSchema>;
export type MonitorRead = z.infer<typeof MonitorReadSchema>;
export type MonitorCondition = z.infer<typeof MonitorConditionSchema>;
export type MonitorTiming = z.infer<typeof MonitorTimingSchema>;
export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;
export type MonitorObservation = z.infer<typeof MonitorObservationSchema>;
export type MonitorOffer = z.infer<typeof MonitorOfferSchema>;
export type MonitorCard = z.infer<typeof MonitorCardSchema>;
