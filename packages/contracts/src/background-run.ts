import { z } from 'zod';

export const BackgroundRunSchema = z.object({
  id: z.uuid(),
  task: z.string().min(1).max(200),
  step: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
  language: z.enum(['ar', 'en']),
}).strict();
