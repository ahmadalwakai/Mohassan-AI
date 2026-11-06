import { z } from 'zod';
import { SkillGapClassificationSchema } from './skill-gaps';
import { SkillRunStatusSchema } from './skills';

export const SkillRunGapReportSchema = z.object({
  runId: z.uuid(), status: SkillRunStatusSchema, observedAt: z.iso.datetime(), truncated: z.boolean(),
  items: z.array(z.object({nodeId: z.string().max(97).nullable(), childTaskId: z.uuid().nullable(), classification: SkillGapClassificationSchema}).strict()).max(144),
}).strict();
export type SkillRunGapReport = z.infer<typeof SkillRunGapReportSchema>;
