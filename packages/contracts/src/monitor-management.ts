import { z } from 'zod';
import { MonitorCardSchema } from './monitors';

export const MonitorManagementCardSchema = z.object({
  id: z.uuid(),
  language: z.enum(['ar', 'en']),
  question: z.string().min(1).max(500),
  choices: z.array(z.object({ id: z.uuid(), label: z.string().min(1).max(300) }).strict()).min(2).max(4).optional(),
}).strict();

export const MonitorV2ControlSchema = z.object({
  proactiveOffers: z.boolean(),
  action: MonitorManagementCardSchema.optional(),
}).strict();

export const MonitorManagementResultSchema = z.object({
  monitor: MonitorCardSchema.optional(),
  action: MonitorManagementCardSchema.optional(),
  proactiveOffers: z.boolean().optional(),
}).strict();

export type MonitorManagementCard = z.infer<typeof MonitorManagementCardSchema>;
export type MonitorManagementResult = z.infer<typeof MonitorManagementResultSchema>;
export type MonitorV2Control = z.infer<typeof MonitorV2ControlSchema>;
