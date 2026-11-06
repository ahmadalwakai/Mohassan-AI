import { z } from 'zod';

export const SkillSandboxGateIdSchema = z.enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
export const SkillSandboxGateSchema = z.object({
  id: SkillSandboxGateIdSchema,
  name: z.string().min(1).max(120),
  required: z.literal(true),
  status: z.enum(['verified', 'blocked']),
  reason: z.string().min(1).max(600),
  evidence: z.array(z.string().min(1).max(400)).max(12),
}).strict();

/** All eight gates, including LPAC (G5), remain mandatory. This describes
 * trusted runner evidence; it is never accepted as an execution request. */
export const SkillSandboxReadinessSchema = z.object({
  provider: z.string().min(1).max(100),
  enabled: z.boolean(),
  baselineVerified: z.boolean(),
  gates: z.array(SkillSandboxGateSchema).length(8),
}).strict().superRefine((report, context) => {
  if (new Set(report.gates.map(gate => gate.id)).size !== 8) context.addIssue({ code: 'custom', path: ['gates'], message: 'Each mandatory gate must appear exactly once.' });
  if (report.enabled && (!report.baselineVerified || report.gates.some(gate => gate.status !== 'verified'))) context.addIssue({ code: 'custom', path: ['enabled'], message: 'Every mandatory gate and the baseline must be verified.' });
});
export const SkillSandboxDiagnosticSchema = z.object({
  readiness: SkillSandboxReadinessSchema,
  executionAllowed: z.literal(false),
}).strict();
export type SkillSandboxReadiness = z.infer<typeof SkillSandboxReadinessSchema>;
export type SkillSandboxDiagnostic = z.infer<typeof SkillSandboxDiagnosticSchema>;
