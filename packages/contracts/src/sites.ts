import { z } from 'zod';

/**
 * Website builder contracts. A site is composed deterministically from a brief: the user's own words
 * arranged into the pages and blocks they asked for. Nothing here is produced by a model, and the
 * builder asks the user for any content a requested block needs instead of inventing it.
 */
export const SiteLangSchema = z.enum(['ar', 'en']);
export type SiteLang = z.infer<typeof SiteLangSchema>;
export const SiteKindSchema = z.enum(['services', 'restaurant', 'clinic', 'portfolio', 'catalogue', 'landing']);
export type SiteKind = z.infer<typeof SiteKindSchema>;
export const SiteMoodSchema = z.enum(['warm', 'calm', 'bold']);
export type SiteMood = z.infer<typeof SiteMoodSchema>;
export const SiteGoalSchema = z.enum(['call', 'whatsapp', 'email', 'order', 'book']);
export type SiteGoal = z.infer<typeof SiteGoalSchema>;

const HexColour = z.string().regex(/^#[0-9a-f]{6}$/i, 'لون سداسي مثل #1d4ed8.');
/** Digits only, optionally with a leading plus, as the user wrote them. */
const PhoneDigits = z.string().regex(/^\+?[0-9]{7,15}$/, 'رقم من 7 إلى 15 خانة.');
const Short = (max: number) => z.string().trim().min(1).max(max);
const Opt = (max: number) => z.string().trim().max(max).optional();
const HttpsUrl = z.string().trim().max(500).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }, 'رابط https عام.');

export const SiteItemSchema = z.object({
  title: Short(80),
  detail: Opt(300),
  /** Written exactly as the user gave it ("50 ر.س", "£30"); never computed. */
  price: Opt(40),
  image: z.uuid().optional(),
}).strict();
export type SiteItem = z.infer<typeof SiteItemSchema>;

export const SiteImageRoleSchema = z.enum(['hero', 'gallery', 'about', 'logo', 'team', 'item']);
export const SiteImageRefSchema = z.object({ id: z.uuid(), role: SiteImageRoleSchema, alt: Short(200), ext: z.enum(['png', 'jpg', 'webp']) }).strict();
export type SiteImageRef = z.infer<typeof SiteImageRefSchema>;
export const SiteTestimonialSchema = z.object({ name: Short(60), quote: Short(400) }).strict();
export type SiteTestimonial = z.infer<typeof SiteTestimonialSchema>;
export const SiteSocialSchema = z.object({
  instagram: HttpsUrl.optional(), facebook: HttpsUrl.optional(), tiktok: HttpsUrl.optional(), x: HttpsUrl.optional(), youtube: HttpsUrl.optional(), linkedin: HttpsUrl.optional(),
}).strict();

const Point = z.object({ title: Short(80), detail: Opt(300) }).strict();
/** Blocks are the sections a page shows. Every block with content holds the user's words only. */
export const SiteBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hero'), title: Opt(140), lead: Opt(300), image: z.uuid().optional(), variant: z.enum(['split', 'centered', 'cover']).optional() }).strict(),
  /** The main offering (services, dishes, products, works); `items` overrides the brief's list for a second list such as projects. */
  z.object({ type: z.literal('items'), title: Opt(80), lead: Opt(200), layout: z.enum(['cards', 'menu', 'tiles', 'list']).optional(), items: z.array(SiteItemSchema).max(60).optional(), limit: z.number().int().min(1).max(60).optional() }).strict(),
  z.object({ type: z.literal('text'), title: Opt(80), body: Short(4000), image: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('features'), title: Opt(80), lead: Opt(200), points: z.array(Point).min(1).max(12) }).strict(),
  z.object({ type: z.literal('steps'), title: Opt(80), lead: Opt(200), steps: z.array(Point).min(1).max(8) }).strict(),
  z.object({ type: z.literal('gallery'), title: Opt(80), images: z.array(z.uuid()).max(24).optional() }).strict(),
  z.object({ type: z.literal('team'), title: Opt(80), lead: Opt(200), members: z.array(z.object({ name: Short(60), role: Opt(80), bio: Opt(300), image: z.uuid().optional() }).strict()).min(1).max(24) }).strict(),
  z.object({ type: z.literal('faq'), title: Opt(80), entries: z.array(z.object({ question: Short(200), answer: Short(1000) }).strict()).min(1).max(30) }).strict(),
  z.object({ type: z.literal('pricing'), title: Opt(80), lead: Opt(200), plans: z.array(z.object({ name: Short(60), price: Opt(40), period: Opt(40), features: z.array(Short(120)).max(12), note: Opt(120), featured: z.boolean().optional() }).strict()).min(1).max(6) }).strict(),
  z.object({ type: z.literal('testimonials'), title: Opt(80), entries: z.array(SiteTestimonialSchema).max(12).optional() }).strict(),
  /** Numbers the user stated ("+500 عميل"); never computed or estimated. */
  z.object({ type: z.literal('facts'), title: Opt(80), items: z.array(z.object({ value: Short(20), label: Short(60) }).strict()).min(1).max(6) }).strict(),
  z.object({ type: z.literal('hours'), title: Opt(80), lines: z.array(Short(80)).max(7).optional() }).strict(),
  z.object({ type: z.literal('contact'), title: Opt(80), lead: Opt(200), form: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('map') }).strict(),
  z.object({ type: z.literal('cta'), title: Opt(120), lead: Opt(200) }).strict(),
  z.object({ type: z.literal('posts'), title: Opt(80), posts: z.array(z.object({ title: Short(120), date: Opt(40), body: Short(4000) }).strict()).min(1).max(30) }).strict(),
]);
export type SiteBlock = z.infer<typeof SiteBlockSchema>;
export type SiteBlockType = SiteBlock['type'];

export const SitePagePathSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}\.html$/, 'اسم صفحة لاتيني مثل team.html');
export const SitePageSchema = z.object({ path: SitePagePathSchema, title: Short(60), blocks: z.array(SiteBlockSchema).min(1).max(16), inNav: z.boolean() }).strict();
export type SitePage = z.infer<typeof SitePageSchema>;

export const SiteBriefSchema = z.object({
  lang: SiteLangSchema,
  kind: SiteKindSchema,
  name: Short(80),
  tagline: Opt(140),
  city: Opt(60),
  address: Opt(200),
  phone: PhoneDigits.optional(),
  whatsapp: PhoneDigits.optional(),
  email: z.email().max(120).optional(),
  mapUrl: HttpsUrl.optional(),
  hours: z.array(Short(80)).max(7).optional(),
  /** Services, dishes, products or works, depending on the kind. */
  items: z.array(SiteItemSchema).max(60),
  /** The single offer of a landing page, in the user's words. */
  offer: Opt(300),
  images: z.array(SiteImageRefSchema).max(24),
  primary: HexColour,
  mood: SiteMoodSchema,
  goal: SiteGoalSchema,
  /** Only quotes the user supplied; the generator never writes one. */
  testimonials: z.array(SiteTestimonialSchema).max(12),
  social: SiteSocialSchema.optional(),
  /** The pages the user asked for, each with its blocks. index.html must exist. */
  pages: z.array(SitePageSchema).min(1).max(12),
}).strict().superRefine((brief, context) => {
  if (!brief.phone && !brief.whatsapp && !brief.email) context.addIssue({ code: 'custom', path: ['phone'], message: 'يلزم رقم هاتف أو واتساب أو بريد واحد على الأقل.' });
  if (!brief.pages.some(page => page.path === 'index.html')) context.addIssue({ code: 'custom', path: ['pages'], message: 'يلزم صفحة index.html.' });
  if (new Set(brief.pages.map(page => page.path)).size !== brief.pages.length) context.addIssue({ code: 'custom', path: ['pages'], message: 'تكرر مسار صفحة.' });
  if (brief.goal === 'whatsapp' && !brief.whatsapp) context.addIssue({ code: 'custom', path: ['goal'], message: 'هدف واتساب يحتاج رقم واتساب.' });
  if (brief.goal === 'email' && !brief.email) context.addIssue({ code: 'custom', path: ['goal'], message: 'هدف البريد يحتاج عنوان بريد.' });
  if (brief.goal === 'call' && !brief.phone) context.addIssue({ code: 'custom', path: ['goal'], message: 'هدف الاتصال يحتاج رقم هاتف.' });
});
export type SiteBrief = z.infer<typeof SiteBriefSchema>;

/** Content kinds the planner can ask the user for, one card field each. */
export const SiteWantSchema = z.enum(['name', 'kind', 'contact', 'items', 'city', 'hours', 'offer', 'colour', 'about', 'team', 'faq', 'pricing', 'projects', 'features', 'steps', 'facts', 'testimonials', 'posts', 'tagline', 'address']);
export type SiteWant = z.infer<typeof SiteWantSchema>;

/** What the chat has learned so far: the sentence, then each card's answers, until a brief can be completed. */
export const SitePartialBriefSchema = z.object({
  lang: SiteLangSchema,
  kind: SiteKindSchema.optional(),
  kindReason: z.string().max(120).optional(),
  name: Opt(80),
  tagline: Opt(140),
  city: Opt(60),
  address: Opt(200),
  phone: PhoneDigits.optional(),
  whatsapp: PhoneDigits.optional(),
  email: z.email().max(120).optional(),
  url: HttpsUrl.optional(),
  mapUrl: HttpsUrl.optional(),
  items: z.array(SiteItemSchema).max(60).optional(),
  hours: z.array(Short(80)).max(7).optional(),
  offer: Opt(300),
  primary: HexColour.optional(),
  colourWord: Opt(40),
  about: Opt(4000),
  /** Blocks the request asked for, with their content once the user supplied it. */
  requested: z.array(SiteWantSchema).max(20),
  /** Requested blocks the user chose to skip ("لا", "skip"), so they are not asked again. */
  skipped: z.array(SiteWantSchema).max(20),
  singlePage: z.boolean().optional(),
  team: z.array(z.object({ name: Short(60), role: Opt(80), bio: Opt(300) }).strict()).max(24).optional(),
  faq: z.array(z.object({ question: Short(200), answer: Short(1000) }).strict()).max(30).optional(),
  pricing: z.array(z.object({ name: Short(60), price: Opt(40), period: Opt(40), features: z.array(Short(120)).max(12), note: Opt(120) }).strict()).max(6).optional(),
  projects: z.array(SiteItemSchema).max(60).optional(),
  features: z.array(Point).max(12).optional(),
  steps: z.array(Point).max(8).optional(),
  facts: z.array(z.object({ value: Short(20), label: Short(60) }).strict()).max(6).optional(),
  testimonials: z.array(SiteTestimonialSchema).max(12).optional(),
  posts: z.array(z.object({ title: Short(120), date: Opt(40), body: Short(4000) }).strict()).max(30).optional(),
  rounds: z.number().int().min(0).max(10),
}).strict();
export type SitePartialBrief = z.infer<typeof SitePartialBriefSchema>;

export const SiteStatusSchema = z.enum(['draft', 'ready', 'published', 'failed']);
export const SiteCommandInputSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export const SiteCheckSchema = z.object({ id: z.string().min(1).max(60), passed: z.boolean(), message: z.string().max(300) }).strict();
export const SiteCheckReportSchema = z.object({ passed: z.boolean(), checks: z.array(SiteCheckSchema).max(40), bytes: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }).strict();
export type SiteCheckReport = z.infer<typeof SiteCheckReportSchema>;

export const SiteSummarySchema = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(), kind: SiteKindSchema, lang: SiteLangSchema, status: SiteStatusSchema,
  revision: z.number().int().min(1), publishedUrl: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type SiteSummary = z.infer<typeof SiteSummarySchema>;
export const SiteDetailSchema = SiteSummarySchema.extend({
  brief: SiteBriefSchema,
  pages: z.array(z.object({ path: z.string(), title: z.string() }).strict()).max(12),
  checks: SiteCheckReportSchema,
  previewPath: z.string(),
  canUndo: z.boolean(),
  images: z.array(SiteImageRefSchema.extend({ width: z.number().int(), height: z.number().int(), bytes: z.number().int() })).max(24),
}).strict();
export type SiteDetail = z.infer<typeof SiteDetailSchema>;
