import { z } from 'zod';

const clientId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const ChromeBindingSchema = z.object({
  clientId, tabId: z.number().int().positive(), customerId: z.string().regex(/^\d{10}$/),
  currency: z.string().regex(/^[A-Z]{3}$/), extensionVersion: z.string().trim().min(1).max(40),
}).strict();
export type ChromeBinding = z.infer<typeof ChromeBindingSchema>;
export const ChromeCampaignSchema = z.object({
  campaignName: z.string().trim().min(1).max(160), goal: z.enum(['calls', 'bookings', 'leads']), type: z.literal('search'),
  customerId: z.string().regex(/^\d{10}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  dailyBudget: z.string().regex(/^\d{1,6}(?:\.\d{1,2})?$/).refine(value => Number(value) > 0),
  locations: z.array(z.string().trim().min(2).max(80)).min(1).max(10), countryCode: z.string().regex(/^[A-Z]{2}$/), adLanguage: z.string().regex(/^[a-z]{2}$/),
  keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(50), negativeKeywords: z.array(z.string().trim().min(1).max(120)).max(50),
  headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15), descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(4),
  finalUrl: z.string().url().max(1000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }),
  paths: z.array(z.string().trim().min(1).max(15)).max(2),
}).strict();
export type ChromeCampaign = z.infer<typeof ChromeCampaignSchema>;
export const ChromeStepSchema = z.object({ stage: z.string().trim().min(1).max(80), message: z.string().trim().min(1).max(1000), fields: z.array(z.string().max(120)).max(100) }).strict();
export const ChromeJobSchema = z.object({
  id: z.uuid(), clientId, tabId: z.number().int().positive(), customerId: z.string().regex(/^\d{10}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  leaseId: z.uuid().nullable(), status: z.enum(['queued', 'running', 'awaiting_review', 'needs_attention', 'stopped']),
  campaign: ChromeCampaignSchema, message: z.string().max(2000), steps: z.array(ChromeStepSchema).max(50), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type ChromeJob = z.infer<typeof ChromeJobSchema>;
export const ChromeExtensionStatusSchema = z.object({
  connected: z.boolean(), binding: ChromeBindingSchema.nullable(), lastSeenAt: z.iso.datetime().nullable(), latestJob: ChromeJobSchema.nullable(), preferredTransport: z.enum(['chrome', 'api']),
}).strict();
export type ChromeExtensionStatus = z.infer<typeof ChromeExtensionStatusSchema>;
export const ChromeClientSchema = z.object({ clientId }).strict();
export const ChromeResultSchema = z.object({ clientId, leaseId: z.uuid(), status: z.enum(['awaiting_review', 'needs_attention', 'stopped']), message: z.string().trim().min(1).max(2000), steps: z.array(ChromeStepSchema).max(50) }).strict();
export const ChromePreferenceSchema = z.object({ transport: z.enum(['chrome', 'api']) }).strict();
