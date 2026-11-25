import { z } from 'zod';

export const FeedbackReviewSchema = z.object({ decision: z.enum(['correct', 'wrong', 'unsure']) }).strict();
export const FeedbackTrainingSchema = z.object({ allowed: z.boolean() }).strict();
export type FeedbackDecision = z.infer<typeof FeedbackReviewSchema>['decision'];

export interface FeedbackPolicy {
  id: string;
  url: string;
  kind: 'block' | 'pin';
  scope: 'reporter' | 'workspace';
  expiresAt: string;
  active: boolean;
  clearedAt: string | null;
}

export interface FeedbackItem {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  question: string;
  reply: string;
  evidenceUrls: string[];
  route: string | null;
  judgeDecision: 'send' | 'fix' | 'withhold' | null;
  verdict: 'useful' | 'wrong' | 'incomplete';
  note: string | null;
  decision: FeedbackDecision | null;
  createdAt: string;
  reviewedAt: string | null;
  caseSha256: string | null;
  trainingAllowed: boolean;
  policies: FeedbackPolicy[];
}

export interface FeedbackMetrics {
  answerOpportunities: number;
  repeatedWrongAnswers: number;
  repeatErrorRate: number | null;
  regressionSize: number;
}

export type FeedbackQueue = {
  items: FeedbackItem[];
  nextOffset: number | null;
} & ({ role: 'owner'; metrics: FeedbackMetrics } | { role: 'member' });
