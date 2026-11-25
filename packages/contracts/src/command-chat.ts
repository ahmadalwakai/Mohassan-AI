import { z } from 'zod';
import { CampaignEventStreamSchema } from './campaign-progress';
import { ChatRunViewSchema } from './agent-run';

export const ChatStatusSchema = z.enum(['idle', 'running', 'waiting_user', 'waiting_input', 'waiting_approval', 'failed', 'cancelled']);

export const ChatOptionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  label: z.string().min(1).max(160),
}).strict();

/** One suggested answer, taken by the brain from the owner's own site or sentence. */
export const ChatSuggestionSchema = z.object({
  label: z.string().min(1).max(120),
  /** Why the brain suggests it ("موقعك فيه رقم هاتف قابل للنقر"). */
  reason: z.string().max(160).optional(),
}).strict();

/** One of several questions asked together; the owner picks suggestions or writes another answer. */
export const ChatQuestionFieldSchema = z.object({
  id: z.string().regex(/^[a-z]{2,20}$/),
  prompt: z.string().min(1).max(300),
  suggestions: z.array(ChatSuggestionSchema).max(6),
  /** Several suggestions may be chosen together (places). */
  multiple: z.boolean().optional(),
  /** Keep line breaks in supplied text such as a letter body. */
  multiline: z.boolean().optional(),
  /** User-supplied literal content to review and edit, never an inferred fact. */
  initialValue: z.string().max(4000).optional(),
  /** Suggestions the brain is confident in, chosen in advance; the owner can change them. */
  selected: z.array(z.number().int().min(0).max(5)).max(6).optional(),
  placeholder: z.string().max(120).optional(),
}).strict();

/** A question from the assistant. The owner can pick an option or type a reply. */
export const ChatQuestionSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(1000),
  options: z.array(ChatOptionSchema).max(5),
  /** The `connect` option opens Google's own consent page instead of answering. */
  action: z.literal('google_ads_connect').optional(),
  /** Several questions in one card; the answers are sent together as one numbered reply. */
  fields: z.array(ChatQuestionFieldSchema).max(6).optional(),
}).strict();

export const ChatApprovalSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(1000),
  detail: z.string().max(1000),
  /**
   * The exact thing the action touches, what follows from it, and whether it can be undone (null: the server cannot
   * tell). Written by the server's permission gate (2026-11-23); absent on approvals asked before it existed.
   */
  target: z.string().max(300).optional(),
  consequence: z.string().max(300).optional(),
  reversible: z.boolean().nullable().optional(),
}).strict();

export const ChatSecureFieldSchema = z.object({
  id: z.enum(['username', 'password', 'code']),
  label: z.string().max(80),
  type: z.enum(['text', 'password', 'code']),
}).strict();

/**
 * A request for a credential or for the owner's own hands on the page. Values
 * entered here go straight to the page and never reach the model or the database.
 */
export const ChatSecureRequestSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['login', 'code', 'hands_on']),
  site: z.string().max(200),
  prompt: z.string().max(600),
  note: z.string().max(300).nullable(),
  fields: z.array(ChatSecureFieldSchema).max(3),
}).strict();

/** An image the user attached; its bytes are served at /api/chat/images/:id to the owner only. */
export const ChatImageSchema = z.object({
  id: z.uuid(),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
}).strict();
export type ChatImage = z.infer<typeof ChatImageSchema>;
export const ChatImageUploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(16).max(7_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const MAX_CHAT_IMAGES = 4;

export const ChatMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(),
  images: z.array(ChatImageSchema).max(MAX_CHAT_IMAGES).optional(),
}).strict();

export const ChatBrowserSchema = z.object({
  url: z.string(),
  title: z.string(),
  observedAt: z.string(),
  live: z.boolean(),
  screenUrl: z.string(),
  recovery: z.enum(['available', 'review_required', 'unavailable']).optional(),
  recoveryToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const ChatBrowserCursorSchema = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    action: z.enum(['move', 'click', 'type', 'select', 'scroll', 'press']),
    phase: z.enum(['moving', 'acting', 'done']),
    updatedAt: z.iso.datetime(),
}).strict();
/** Live host telemetry only: never includes typed text or page-supplied labels. */
export const ChatBrowserActivitySchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cursor: ChatBrowserCursorSchema.nullable(),
  sessionId: z.uuid().optional(),
  events: z.array(z.object({
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cursor: ChatBrowserCursorSchema.nullable(),
    updatedAt: z.iso.datetime(),
  }).strict()).max(32).optional(),
}).strict();
export type ChatBrowserActivity = z.infer<typeof ChatBrowserActivitySchema>;

export const ChatStepSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  createdAt: z.string(),
}).strict();

/** The five browser levels of docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §6.1: 0 none, 1 network only, 2 hidden, 3 in front, 4 forbidden. */
export const ChatBrowserVisibilityLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type ChatBrowserVisibilityLevel = z.infer<typeof ChatBrowserVisibilityLevelSchema>;
/** Decided by code and logged with its reason; the UI opens the panel by itself only at level 3. */
export const ChatBrowserVisibilitySchema = z.object({
  version: z.literal(1),
  level: ChatBrowserVisibilityLevelSchema,
  code: z.string().min(1).max(40),
  /** Shown to the user, in the request's language. */
  reason: z.string().max(300),
  lang: z.enum(['ar', 'en']),
  decidedAt: z.string(),
  /** The level the request-time table chose; a run may raise or lower the current level with a logged reason. */
  requested: ChatBrowserVisibilityLevelSchema,
  /** False for members: the live panel is never offered to them. */
  canView: z.boolean(),
  history: z.array(z.object({ level: ChatBrowserVisibilityLevelSchema, code: z.string().min(1).max(40), at: z.string() }).strict()).max(8),
}).strict();
export type ChatBrowserVisibility = z.infer<typeof ChatBrowserVisibilitySchema>;

export const ChatConversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: ChatStatusSchema,
  updatedAt: z.string(),
  browserAccount: z.string().nullable().optional(),
}).strict();

/**
 * What this session can do, from the server's runtime state for this account (2026-11-23). `chatModel`: a language model
 * that writes free replies is connected. `available`: the capabilities that answer without one. Clients show these instead
 * of a fixed sentence; absent from servers older than this field.
 */
export const chatCapabilityIds = ['computation', 'web', 'browser', 'memory', 'knowledge', 'documents', 'sites', 'skills', 'planner', 'letters', 'imageReading', 'ads', 'pc'] as const;
export const ChatCapabilitiesSchema = z.object({
  chatModel: z.boolean(),
  available: z.array(z.enum(chatCapabilityIds)).max(chatCapabilityIds.length),
}).strict();
export type ChatCapabilities = z.infer<typeof ChatCapabilitiesSchema>;

export const ChatConversationSchema = ChatConversationSummarySchema.extend({
  messages: z.array(ChatMessageSchema),
  question: ChatQuestionSchema.nullable(),
  approval: ChatApprovalSchema.nullable(),
  secure: ChatSecureRequestSchema.nullable(),
  browser: ChatBrowserSchema.nullable(),
  progress: z.string().nullable(),
  steps: z.array(ChatStepSchema),
  error: z.string().nullable(),
  configured: z.boolean(),
  capabilities: ChatCapabilitiesSchema.optional(),
  /** Absent for conversations recorded before the browser levels existed. */
  visibility: ChatBrowserVisibilitySchema.nullable().optional(),
  /** Structured events of the latest Google Ads campaign task in this conversation. Absent when there is none. */
  campaign: CampaignEventStreamSchema.nullable().optional(),
  /** Read-only recovery of a persisted Ads write; bound to this exact previous run. */
  campaignRecovery: z.object({ runId: z.uuid(), mode: z.literal('readback_only') }).strict().optional(),
  /**
   * An opaque mark of what this view shows. `GET /api/chat/conversations/:id?since=<version>&wait=<ms>` answers as soon as
   * the conversation's mark differs from it (or after the wait, at most 8 s). Absent from servers older than 2026-11-23.
   */
  version: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  /** How many earlier messages are not in `messages`, which holds the newest 300. Absent when none are left out. */
  olderMessages: z.number().int().min(1).optional(),
  /**
   * The latest run as the server's runtime committed it: phase, plan, evidence, permission decisions and verdict
   * (agent-run.ts). Null when the conversation has no run; absent from servers older than 2026-11-23.
   */
  run: ChatRunViewSchema.nullable().optional(),
}).strict();

export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatConversationSummary = z.infer<typeof ChatConversationSummarySchema>;
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;
export type ChatQuestionField = z.infer<typeof ChatQuestionFieldSchema>;
export type ChatApproval = z.infer<typeof ChatApprovalSchema>;
export type ChatSecureRequest = z.infer<typeof ChatSecureRequestSchema>;

export const ChatCreateSchema = z.object({ goal: z.string().trim().min(1).max(4000).optional(), browserAccount: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable().optional(),
  images: z.array(z.uuid()).min(1).max(MAX_CHAT_IMAGES).optional() }).strict();
export const ChatFieldAnswerSchema = z.object({
  fieldId: z.string().regex(/^[a-z]{2,20}$/),
  value: z.string().min(1).max(4000).refine(value => value.trim().length > 0, { message: 'A field answer cannot be blank.' }),
}).strict();
export type ChatFieldAnswer = z.infer<typeof ChatFieldAnswerSchema>;
export const ChatSendSchema = z.object({
  text: z.string().trim().max(4000).default(''),
  questionId: z.uuid().optional(),
  answers: z.array(ChatFieldAnswerSchema).min(1).max(6).optional(),
  /** Uploaded image ids; a message may be images alone. Never combined with field answers. */
  images: z.array(z.uuid()).min(1).max(MAX_CHAT_IMAGES).optional(),
}).strict().refine(input => Boolean(input.text) || Boolean(input.answers?.length) || Boolean(input.images?.length), { message: 'A message, images or field answers are required.' })
  .refine(input => !input.images || !input.answers, { message: 'Images cannot accompany field answers.' })
  .refine(input => !input.answers || Boolean(input.questionId)
  && new Set(input.answers.map(answer => answer.fieldId)).size === input.answers.length
  && input.answers.reduce((length, answer) => length + answer.value.length, 0) + (input.answers.length > 1 ? input.answers.length * 4 - 1 : 0) <= 4000,
  { message: 'Field answers require a question ID, distinct fields, and at most 4000 characters.' });
export const ChatRespondSchema = z.object({
  questionId: z.uuid(),
  optionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
}).strict();
export const ChatApproveSchema = z.object({ approvalId: z.uuid(), approved: z.boolean() }).strict();
/** The owner's judgement of one reply (plan §7.5): a rating record, never training data. */
export const ChatFeedbackSchema = z.object({ messageId: z.uuid(), verdict: z.enum(['useful', 'wrong', 'incomplete']), note: z.string().trim().max(500).optional() }).strict();
export type ChatFeedback = z.infer<typeof ChatFeedbackSchema>;
export const ChatSecureSubmitSchema = z.object({
  requestId: z.uuid(),
  action: z.enum(['submit', 'done', 'skip']),
  values: z.object({
    username: z.string().max(320).optional(),
    password: z.string().max(512).optional(),
    code: z.string().max(32).optional(),
  }).strict().optional(),
}).strict();
export const ChatPointerSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const ChatKeyboardSchema = z.object({
  text: z.string().max(2000).optional(),
  key: z.enum(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']).optional(),
}).strict();
