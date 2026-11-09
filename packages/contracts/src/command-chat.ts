import { z } from 'zod';

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
}).strict();

export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatConversationSummary = z.infer<typeof ChatConversationSummarySchema>;
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;
export type ChatApproval = z.infer<typeof ChatApprovalSchema>;
export type ChatSecureRequest = z.infer<typeof ChatSecureRequestSchema>;

export const ChatCreateSchema = z.object({ goal: z.string().trim().min(1).max(4000).optional(), browserAccount: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable().optional() }).strict();
export const ChatSendSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export const ChatRespondSchema = z.object({
  questionId: z.uuid(),
  optionId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
}).strict();
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
