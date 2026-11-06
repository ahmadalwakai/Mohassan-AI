import { z } from 'zod';
import { SkillContractSchema } from './skills';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SkillBenchmarkSuiteIdSchema = z.enum(['instruction-delivery-v1', 'file-read-correctness-v1', 'file-write-correctness-v1']);
export const SkillBenchmarkScopeSchema = z.enum(['instruction_delivery', 'file_tool_correctness']);
export const SkillBenchmarkPinSchema = z.object({ versionId: z.uuid(), revision: z.number().int().positive(), contentHash: Hash, inspectionId: z.uuid(), inspectorVersion: z.string().min(1).max(100) }).strict();
export const SkillBenchmarkSuiteSchema = z.object({
  id: SkillBenchmarkSuiteIdSchema, scope: SkillBenchmarkScopeSchema, suiteHash: Hash, configHash: Hash, verifierVersion: z.string().min(1).max(100), independentHoldout: z.boolean(),
  measuredScope: z.string().min(1).max(600), limitations: z.array(z.string().min(1).max(600)).max(12),
  cases: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), split: z.enum(['training', 'holdout']), fixtureHash: Hash, proofKind: z.enum(['instruction_context', 'runtime_receipt', 'file_observation']) }).strict()).min(2).max(16),
}).strict().superRefine((suite, context) => {
  if (new Set(suite.cases.map(item => item.id)).size !== suite.cases.length) context.addIssue({ code: 'custom', path: ['cases'], message: 'Case IDs must be unique.' });
  if (!suite.cases.some(item => item.split === 'training') || !suite.cases.some(item => item.split === 'holdout')) context.addIssue({ code: 'custom', path: ['cases'], message: 'Training and holdout cases are required.' });
  if (suite.independentHoldout && suite.cases.some(item => item.split === 'holdout' && suite.cases.some(other => other.split === 'training' && other.fixtureHash === item.fixtureHash))) context.addIssue({ code: 'custom', path: ['independentHoldout'], message: 'Holdout fixtures must differ from training fixtures.' });
});
export const SkillBenchmarkSnapshotSchema = z.object({ pin: SkillBenchmarkPinSchema, contract: SkillContractSchema,
  files: z.array(z.object({ path: z.string().min(1).max(240), kind: z.enum(['instructions', 'script', 'reference', 'data']), content: z.string().max(256000), contentHash: Hash, sizeBytes: z.number().int().nonnegative().max(256000) }).strict()).max(200),
}).strict();
const MetricName = z.enum(['success', 'verification', 'safety', 'recovery', 'costUsd']);
export const SkillBenchmarkCaseResultSchema = z.object({
  caseId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), arm: z.enum(['baseline', 'candidate']), split: z.enum(['training', 'holdout']), scope: SkillBenchmarkScopeSchema,
  status: z.enum(['passed', 'failed', 'blocked', 'unknown']), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).nullable(),
  sourceVersionId: z.uuid(), sourceContentHash: Hash, suiteHash: Hash, configHash: Hash, verifierVersion: z.string().min(1).max(100),
  inputsHash: Hash, outputHash: Hash.nullable(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), durationMs: z.number().finite().nonnegative().max(1800000),
  metrics: z.object({ success: z.boolean().nullable(), verification: z.boolean().nullable(), safety: z.boolean().nullable(), recovery: z.boolean().nullable(), costUsd: z.number().finite().nonnegative().nullable() }).strict(),
  notApplicable: z.array(MetricName).max(5), usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable() }).strict(),
  evidenceScope: z.literal('isolated_experiment'),
  evidence: z.array(z.object({ kind: z.enum(['instruction_context', 'runtime_receipt', 'file_observation']), runId: z.uuid().optional(), taskId: z.uuid().optional(), receiptId: z.uuid().optional(), inputsHash: Hash, outputHash: Hash, verifiedAt: z.iso.datetime() }).strict().superRefine((proof, context) => {
    if (proof.kind === 'runtime_receipt' && (!proof.runId || !proof.taskId || !proof.receiptId)) context.addIssue({ code: 'custom', message: 'A runtime receipt needs its isolated run, task and receipt IDs.' });
  })).max(8),
}).strict().superRefine((result, context) => {
  if (new Date(result.finishedAt).getTime() < new Date(result.startedAt).getTime()) context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'Invalid measurement interval.' });
  if (new Set(result.notApplicable).size !== result.notApplicable.length || result.notApplicable.some(name => result.metrics[name] !== null)) context.addIssue({ code: 'custom', path: ['notApplicable'], message: 'Not-applicable metrics must be unique and null.' });
  if (result.status === 'passed' && (result.metrics.success !== true || result.metrics.verification !== true || result.metrics.safety !== true || !result.outputHash || !result.evidence.length)) context.addIssue({ code: 'custom', path: ['status'], message: 'A passing case requires measured success, verification, safety and evidence.' });
  if (result.status === 'blocked' && result.metrics.success === true) context.addIssue({ code: 'custom', path: ['status'], message: 'Blocked is not success.' });
  if (result.status === 'passed' && result.scope === 'instruction_delivery' && !result.evidence.some(proof => proof.kind === 'instruction_context')) context.addIssue({ code: 'custom', path: ['evidence'], message: 'Instruction delivery needs compiled-context evidence.' });
});
export const SkillBenchmarkRequestSchema = z.object({ baselineId: z.uuid(), baselineRevision: z.number().int().positive(), candidateId: z.uuid(), candidateRevision: z.number().int().positive(), suiteId: SkillBenchmarkSuiteIdSchema }).strict();
export const SkillBenchmarkQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0), versionId: z.uuid().optional() }).strict();
export const SkillBenchmarkEvaluationSchema = z.object({
  id: z.uuid(), status: z.enum(['running', 'completed', 'failed', 'unknown']), baseline: SkillBenchmarkPinSchema, candidate: SkillBenchmarkPinSchema, suite: SkillBenchmarkSuiteSchema,
  cases: z.array(SkillBenchmarkCaseResultSchema).max(32), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), errorCode: z.string().max(100).nullable(), evidenceScope: z.literal('isolated_experiment'),
}).strict();
export const SkillBenchmarkPageSchema = z.object({ items: z.array(SkillBenchmarkEvaluationSchema).max(50), total: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50), offset: z.number().int().nonnegative() }).strict();
export const SkillBenchmarkCatalogSchema = z.object({ enabled: z.boolean(), suites: z.array(z.object({ id: SkillBenchmarkSuiteIdSchema, scope: SkillBenchmarkScopeSchema, suiteHash: Hash, configHash: Hash, verifierVersion: z.string().min(1).max(100), independentHoldout: z.boolean(), measuredScope: z.string().min(1).max(600), limitations: z.array(z.string().min(1).max(600)).max(12), trainingCases: z.number().int().nonnegative(), holdoutCases: z.number().int().nonnegative(), caseCount: z.number().int().min(2).max(16) }).strict()).max(3) }).strict();
export type SkillBenchmarkPin = z.infer<typeof SkillBenchmarkPinSchema>;
export type SkillBenchmarkSuite = z.infer<typeof SkillBenchmarkSuiteSchema>;
export type SkillBenchmarkSnapshot = z.infer<typeof SkillBenchmarkSnapshotSchema>;
export type SkillBenchmarkCaseResult = z.infer<typeof SkillBenchmarkCaseResultSchema>;
export type SkillBenchmarkRequest = z.infer<typeof SkillBenchmarkRequestSchema>;
export type SkillBenchmarkEvaluation = z.infer<typeof SkillBenchmarkEvaluationSchema>;
