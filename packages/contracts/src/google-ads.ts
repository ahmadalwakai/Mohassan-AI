import { z } from 'zod';

/**
 * Contracts shared by the web section, the API and the assistant.
 * Money stays in integer micros as strings: JSON numbers lose precision above 2^53.
 */

export const GoogleAdsMicrosSchema = z.string().regex(/^\d{1,18}$/);
export const GoogleAdsCustomerIdSchema = z.string().regex(/^\d{10}$/);

/** Every figure says where it came from, so an estimate never reads as a measurement. */
export const GoogleAdsBasisSchema = z.enum(['observed', 'estimate', 'assumption']);
export type GoogleAdsBasis = z.infer<typeof GoogleAdsBasisSchema>;

export const GoogleAdsConnectionStateSchema = z.enum(['not_configured', 'disconnected', 'needs_account', 'connected', 'unauthorized', 'rate_limited', 'failed']);
export type GoogleAdsConnectionState = z.infer<typeof GoogleAdsConnectionStateSchema>;

export const GoogleAdsGateSchema = z.object({ id: z.string(), passed: z.boolean(), detail: z.string() }).strict();
export type GoogleAdsGate = z.infer<typeof GoogleAdsGateSchema>;

export const GoogleAdsPublishingSchema = z.object({ available: z.boolean(), gates: z.array(GoogleAdsGateSchema) }).strict();
export type GoogleAdsPublishing = z.infer<typeof GoogleAdsPublishingSchema>;

export const GoogleAdsStatusSchema = z.object({
  state: GoogleAdsConnectionStateSchema,
  message: z.string(),
  missingSettings: z.array(z.string()),
  retryAfterSeconds: z.number().int().nullable(),
  account: z.object({ customerId: GoogleAdsCustomerIdSchema, name: z.string(), currency: z.string(), timeZone: z.string(), testAccount: z.boolean(), loginCustomerId: GoogleAdsCustomerIdSchema.nullable() }).strict().nullable(),
  connectedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  publishing: GoogleAdsPublishingSchema,
}).strict();
export type GoogleAdsStatus = z.infer<typeof GoogleAdsStatusSchema>;

export const GoogleAdsAccountOptionSchema = z.object({
  customerId: GoogleAdsCustomerIdSchema, name: z.string(), currency: z.string(), timeZone: z.string(),
  manager: z.boolean(), testAccount: z.boolean(), status: z.string(), loginCustomerId: GoogleAdsCustomerIdSchema.nullable(),
}).strict();
export type GoogleAdsAccountOption = z.infer<typeof GoogleAdsAccountOptionSchema>;

export const GoogleAdsSelectAccountSchema = z.object({ customerId: GoogleAdsCustomerIdSchema, loginCustomerId: GoogleAdsCustomerIdSchema.nullable().default(null) }).strict();

export const GoogleAdsMismatchSchema = z.object({
  kind: z.enum(['ad_language_vs_language_criterion', 'ad_language_vs_location', 'no_location_target', 'location_interest_targeting']),
  campaignId: z.string(), campaignName: z.string(), basis: GoogleAdsBasisSchema, message: z.string(),
}).strict();
export type GoogleAdsMismatch = z.infer<typeof GoogleAdsMismatchSchema>;

export const GoogleAdsCampaignRowSchema = z.object({
  id: z.string(), name: z.string(), status: z.string(), channel: z.string(), bidding: z.string(),
  dailyBudgetMicros: GoogleAdsMicrosSchema.nullable(), impressions: z.number(), clicks: z.number(), costMicros: GoogleAdsMicrosSchema,
  conversions: z.number(), conversionsValue: z.number(), searchImpressionShare: z.number().nullable(),
  budgetLostImpressionShare: z.number().nullable(), rankLostImpressionShare: z.number().nullable(),
}).strict();
export type GoogleAdsCampaignRow = z.infer<typeof GoogleAdsCampaignRowSchema>;

export const GoogleAdsConversionActionSchema = z.object({
  resourceName: z.string(), name: z.string(), status: z.string(), category: z.string(), primaryForGoal: z.boolean(),
  includedInConversions: z.boolean(), recordedConversions: z.number(),
}).strict();
export type GoogleAdsConversionAction = z.infer<typeof GoogleAdsConversionActionSchema>;

export const GoogleAdsServiceBookingsSchema = z.object({
  service: z.string(), status: z.enum(['measured', 'no_conversions_recorded']), completedBookings: z.number(),
  actions: z.array(z.object({ name: z.string(), conversions: z.number() }).strict()),
}).strict();
export type GoogleAdsServiceBookings = z.infer<typeof GoogleAdsServiceBookingsSchema>;

export const GoogleAdsBookingRuleSchema = z.object({ service: z.string().trim().min(2).max(80), conversionActions: z.array(z.string().regex(/^customers\/\d{10}\/conversionActions\/\d+$/)).min(1).max(20) }).strict();
export const GoogleAdsBookingMapSchema = z.object({ rules: z.array(GoogleAdsBookingRuleSchema).max(30) }).strict();
export type GoogleAdsBookingRule = z.infer<typeof GoogleAdsBookingRuleSchema>;

export const GoogleAdsReportSchema = z.object({
  customerId: GoogleAdsCustomerIdSchema, currency: z.string(), timeZone: z.string(),
  range: z.object({ start: z.string(), end: z.string(), days: z.number().int() }).strict(),
  fetchedAt: z.string(), basis: z.literal('observed'), empty: z.boolean(),
  totals: z.object({ impressions: z.number(), clicks: z.number(), costMicros: GoogleAdsMicrosSchema, conversions: z.number(), conversionsValue: z.number() }).strict(),
  campaigns: z.array(GoogleAdsCampaignRowSchema),
  conversionActions: z.array(GoogleAdsConversionActionSchema),
  bookings: z.object({ mapped: z.boolean(), services: z.array(GoogleAdsServiceBookingsSchema), unmappedActions: z.array(z.string()) }).strict(),
  mismatches: z.array(GoogleAdsMismatchSchema),
  notes: z.array(z.string()),
}).strict();
export type GoogleAdsReport = z.infer<typeof GoogleAdsReportSchema>;

export const GoogleAdsRecommendationSchema = z.object({
  id: z.string(), type: z.enum(['fix_conversion_tracking', 'add_negative_keyword', 'review_budget', 'review_ad_rank', 'review_no_impressions', 'review_mismatch', 'collect_more_data']),
  title: z.string(), reason: z.string(), basis: GoogleAdsBasisSchema, campaignId: z.string().nullable(),
  observed: z.record(z.string(), z.union([z.string(), z.number()])), requiresApproval: z.literal(true),
}).strict();
export type GoogleAdsRecommendation = z.infer<typeof GoogleAdsRecommendationSchema>;

export const GoogleAdsMarketInputSchema = z.object({
  seeds: z.array(z.string().trim().min(2).max(80)).min(1).max(10),
  locations: z.array(z.string().trim().min(2).max(80)).max(5).default([]),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
}).strict();
export type GoogleAdsMarketInput = z.input<typeof GoogleAdsMarketInputSchema>;

export const GoogleAdsMarketSchema = z.object({
  fetchedAt: z.string(),
  keywordIdeas: z.object({
    status: z.enum(['available', 'unavailable']), basis: z.literal('estimate'), source: z.string(), reason: z.string().nullable(),
    items: z.array(z.object({ text: z.string(), avgMonthlySearches: z.number().nullable(), competition: z.string().nullable(), lowTopOfPageBidMicros: GoogleAdsMicrosSchema.nullable(), highTopOfPageBidMicros: GoogleAdsMicrosSchema.nullable() }).strict()),
  }).strict(),
  searchTerms: z.object({
    basis: z.literal('observed'), source: z.string(),
    items: z.array(z.object({ term: z.string(), campaignId: z.string(), impressions: z.number(), clicks: z.number(), costMicros: GoogleAdsMicrosSchema, conversions: z.number() }).strict()),
  }).strict(),
}).strict();
export type GoogleAdsMarket = z.infer<typeof GoogleAdsMarketSchema>;

const AdText = z.string().trim().min(1).max(200);
const KeywordText = z.string().trim().min(1).max(120);

/** Keywords use Google's own notation: plain broad, "phrase" or [exact]. */
export const GoogleAdsBriefSchema = z.object({
  businessName: z.string().trim().min(2).max(80),
  service: z.string().trim().min(2).max(60),
  goal: z.enum(['bookings', 'calls', 'leads']),
  landingPageUrl: z.string().url().max(1000),
  locations: z.array(z.string().trim().min(2).max(80)).min(1).max(10),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  adLanguage: z.string().regex(/^[a-z]{2}$/),
  dailyBudget: z.string().regex(/^\d{1,6}(?:\.\d{1,2})?$/),
  ownerFacts: z.array(z.string().trim().min(2).max(300)).max(20),
  headlines: z.array(AdText).max(20),
  descriptions: z.array(AdText).max(8),
  paths: z.array(z.string().trim().min(1).max(40)).max(3),
  keywords: z.array(KeywordText).max(50),
  negativeKeywords: z.array(KeywordText).max(50),
}).strict();
export type GoogleAdsBrief = z.infer<typeof GoogleAdsBriefSchema>;

export const GoogleAdsDraftStateSchema = z.enum(['preview', 'draft', 'rejected', 'validated', 'verified', 'approved', 'publishing', 'published', 'launch_approved', 'launching', 'live', 'failed', 'outcome_unknown', 'discarded']);
export type GoogleAdsDraftState = z.infer<typeof GoogleAdsDraftStateSchema>;

export const GoogleAdsIssueSchema = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), field: z.string(), message: z.string() }).strict();
export type GoogleAdsIssue = z.infer<typeof GoogleAdsIssueSchema>;

export const GoogleAdsLandingSchema = z.object({
  requestedUrl: z.string(), finalUrl: z.string().nullable(), status: z.number().int().nullable(), language: z.string().nullable(), title: z.string().nullable(), reachable: z.boolean(),
}).strict();
export type GoogleAdsLanding = z.infer<typeof GoogleAdsLandingSchema>;

export const GoogleAdsValidationSchema = z.object({
  passed: z.boolean(), checkedAt: z.string(), draftHash: z.string(), issues: z.array(GoogleAdsIssueSchema), landing: GoogleAdsLandingSchema.nullable(), geoTargets: z.array(z.object({ name: z.string(), resourceName: z.string(), countryCode: z.string() }).strict()),
}).strict();
export type GoogleAdsValidation = z.infer<typeof GoogleAdsValidationSchema>;

export const GoogleAdsVerificationCheckSchema = z.object({ id: z.enum(['account_permissions', 'conversion_tracking', 'draft_correctness', 'existing_resources_preserved', 'google_validate_only']), passed: z.boolean(), detail: z.string() }).strict();
export type GoogleAdsVerificationCheck = z.infer<typeof GoogleAdsVerificationCheckSchema>;

export const GoogleAdsVerificationSchema = z.object({ passed: z.boolean(), checkedAt: z.string(), draftHash: z.string(), checks: z.array(GoogleAdsVerificationCheckSchema) }).strict();
export type GoogleAdsVerification = z.infer<typeof GoogleAdsVerificationSchema>;

/** What the owner approves, read back from the operations rather than from the brief. */
export const GoogleAdsChangeSummarySchema = z.object({
  customerId: GoogleAdsCustomerIdSchema, campaignName: z.string(), initialStatus: z.literal('PAUSED'), dailyBudgetMicros: GoogleAdsMicrosSchema,
  bidding: z.string(), locations: z.array(z.string()), keywords: z.array(z.string()), negativeKeywords: z.array(z.string()),
  headlines: z.array(z.string()), descriptions: z.array(z.string()), finalUrl: z.string(), operationCount: z.number().int(),
  maxDailySpendMicros: GoogleAdsMicrosSchema, maxMonthlySpendMicros: GoogleAdsMicrosSchema,
}).strict();
export type GoogleAdsChangeSummary = z.infer<typeof GoogleAdsChangeSummarySchema>;

export const GoogleAdsStrategySchema = z.object({
  recommendations: z.array(z.object({ title: z.string(), reason: z.string(), basis: GoogleAdsBasisSchema, source: z.string() }).strict()),
  blockers: z.array(z.string()),
}).strict();
export type GoogleAdsStrategy = z.infer<typeof GoogleAdsStrategySchema>;

export const GoogleAdsDraftSchema = z.object({
  id: z.uuid(), customerId: GoogleAdsCustomerIdSchema, state: GoogleAdsDraftStateSchema, revision: z.number().int(), brief: GoogleAdsBriefSchema,
  draftHash: z.string(), bidding: z.string(), summary: GoogleAdsChangeSummarySchema.nullable(), strategy: GoogleAdsStrategySchema.nullable(),
  validation: GoogleAdsValidationSchema.nullable(), verification: GoogleAdsVerificationSchema.nullable(), campaignResourceName: z.string().nullable(),
  error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type GoogleAdsDraft = z.infer<typeof GoogleAdsDraftSchema>;

export const GoogleAdsDraftActionSchema = z.object({ expectedRevision: z.number().int().min(1) }).strict();
export const GoogleAdsReviseSchema = z.object({ expectedRevision: z.number().int().min(1), brief: GoogleAdsBriefSchema }).strict();
export const GoogleAdsApprovalSchema = z.object({ expectedRevision: z.number().int().min(1), draftHash: z.string().regex(/^[a-f0-9]{64}$/), customerId: GoogleAdsCustomerIdSchema }).strict();

export const GoogleAdsAuditEntrySchema = z.object({ id: z.string(), draftId: z.string().nullable(), type: z.string(), detail: z.record(z.string(), z.unknown()), createdAt: z.string() }).strict();
export type GoogleAdsAuditEntry = z.infer<typeof GoogleAdsAuditEntrySchema>;

export const GoogleAdsExperienceSchema = z.object({
  id: z.string(), customerId: GoogleAdsCustomerIdSchema, kind: z.enum(['publish_confirmed', 'launch_confirmed', 'measured_outcome']), statement: z.string(),
  evidence: z.object({ source: z.literal('google_ads_api'), resourceName: z.string(), fetchedAt: z.string(), figures: z.record(z.string(), z.union([z.string(), z.number()])) }).strict(),
  createdAt: z.string(),
}).strict();
export type GoogleAdsExperience = z.infer<typeof GoogleAdsExperienceSchema>;
