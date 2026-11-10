import { z } from 'zod';
import { CampaignEventStreamSchema } from './campaign-progress';
import { ChatDecisionStreamSchema, ChatGoalSummarySchema, ReadinessStatusSchema, SlotIdSchema } from './goal-clarification';

export const ChatStatusSchema = z.enum(['idle', 'running', 'waiting_user', 'waiting_input', 'waiting_approval', 'failed', 'cancelled']);

export const ChatOptionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  label: z.string().min(1).max(160),
}).strict();

/** A question from the assistant. The owner can pick an option or type a reply. */
export const ChatQuestionSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(1000),
  options: z.array(ChatOptionSchema).max(5),
  /** The `connect` option opens Google's own consent page instead of answering. */
  action: z.literal('google_ads_connect').optional(),
  /**
   * Present when the clarification engine asked: why the answer matters, the
   * recommended option and whether a typed answer is accepted. Answering is data;
   * it never approves an action.
   */
  clarification: z.object({
    reason: z.string().max(300),
    recommendedOptionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).nullable(),
    allowText: z.boolean(),
    slots: z.array(SlotIdSchema).min(1).max(3),
    goalVersion: z.number().int().min(1).max(1000),
    readiness: ReadinessStatusSchema,
  }).strict().optional(),
}).strict();

export const ChatApprovalSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(1000),
  detail: z.string().max(1000),
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

export const ChatMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(),
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

export const ChatStepSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  createdAt: z.string(),
}).strict();

export const ChatConversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: ChatStatusSchema,
  updatedAt: z.string(),
  browserAccount: z.string().nullable().optional(),
}).strict();

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
  /** Structured events of the latest Google Ads campaign task in this conversation. Absent when there is none. */
  campaign: CampaignEventStreamSchema.nullable().optional(),
  /** What the clarification engine understood about the latest task. Absent for older runs. */
  goal: ChatGoalSummarySchema.nullable().optional(),
  /** Decision events of the latest run; `lastSeq` is the conversation's newest, for resuming with `?after=`. */
  decisions: ChatDecisionStreamSchema.optional(),
}).strict();

export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatConversationSummary = z.infer<typeof ChatConversationSummarySchema>;
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;
export type ChatApproval = z.infer<typeof ChatApprovalSchema>;
export type ChatSecureRequest = z.infer<typeof ChatSecureRequestSchema>;

export const ChatCreateSchema = z.object({ goal: z.string().trim().min(1).max(4000).optional(), browserAccount: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable().optional() }).strict();
export const ChatSendSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
/** An option, a typed answer, or both. The server checks it against the pending question. */
export const ChatRespondSchema = z.object({
  questionId: z.uuid(),
  optionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
}).strict().refine(value => value.optionId !== undefined || value.text !== undefined, { message: 'optionId or text is required' });
export const ChatApproveSchema = z.object({ approvalId: z.uuid(), approved: z.boolean() }).strict();
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
