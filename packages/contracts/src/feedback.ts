import { z } from 'zod';
import { ChatFeedbackSchema } from './command-chat';

const SourceUrlSchema = z.url({ protocol: /^https?$/ });
export const FeedbackDecisionSchema = z.enum(['pin', 'block', 'dismiss']);
export type FeedbackDecision = z.infer<typeof FeedbackDecisionSchema>;

export const FeedbackReviewSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.enum(['pin', 'block']), sourceUrl: SourceUrlSchema }).strict(),
  z.object({ decision: z.enum(['dismiss', 'clear']) }).strict(),
]);
export type FeedbackReviewInput = z.infer<typeof FeedbackReviewSchema>;

export const FeedbackItemSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  messageId: ChatFeedbackSchema.shape.messageId,
  question: z.string().nullable(),
  reply: z.string().nullable(),
  evidenceUrls: z.array(SourceUrlSchema),
  verdict: ChatFeedbackSchema.shape.verdict,
  note: z.string().nullable(),
  decision: FeedbackDecisionSchema.nullable(),
  sourceUrl: SourceUrlSchema.nullable(),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
}).strict();
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const FeedbackQueueSchema = z.object({
  items: z.array(FeedbackItemSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type FeedbackQueue = z.infer<typeof FeedbackQueueSchema>;
