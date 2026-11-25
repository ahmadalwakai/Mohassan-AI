import { z } from 'zod';

export const browserPremiumBriefPath = '/api/chat/browser-brief';

export const BrowserPremiumBriefRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  currentOrigin: z.string().max(256).optional(),
}).strict();

export const BrowserPremiumBriefSchema = z.object({
  summary: z.string().min(1).max(300),
  sites: z.array(z.string().min(1).max(253)).max(6),
  needs: z.array(z.enum(['login', 'code', 'approval'])).max(3),
  requiresStart: z.boolean(),
}).strict();

export type BrowserPremiumBriefData = z.infer<typeof BrowserPremiumBriefSchema>;
