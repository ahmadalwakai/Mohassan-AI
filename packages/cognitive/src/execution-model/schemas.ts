import { z } from 'zod';
import { GoalDefinitionSchema, ProjectSchema, RawCodingEditsSchema, SkillToolIdSchema } from '@mohassan/contracts';

export const ExecutionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const ExecutionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(1200);
const Ids = z.array(ExecutionIdSchema).max(64);
const nonBlank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Concrete nonblank context is required.');

/** Lexical check only. The existing coding/tool boundary must still resolve roots and links. */
export const ExecutionPathSchema = z.string().min(1).max(180).refine(path =>
  /^[\p{L}\p{N}._/-]+$/u.test(path) && !path.startsWith('/') && path.split('/').every(part =>
    part !== '' && part !== '.' && part !== '..' && !part.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    && !/^\.env/i.test(part) && !/^(secrets?|credentials)(?:\.|$)/i.test(part)
    && !/^(\.git|node_modules|\.npmrc|\.pypirc|\.ssh|id_rsa|id_ed25519)$/i.test(part)
    && !/\.(pem|key|pfx|p12)$/i.test(part)), 'Expected a safe, non-sensitive workspace-relative file path.');

/** Phase 1 has no JSX, test/config edits, file creation, deletion, or multi-file support. */
export const ExecutionTargetPathSchema = ExecutionPathSchema.refine(path => /\.ts$/.test(path)
  && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path)
  && !/\.(?:test|spec)\./i.test(path)
  && !/(?:^|\/)(?:[^/]*\.config\.[^/]+|config\.[^/]+)$/i.test(path), 'Phase 1 targets one existing TypeScript source file.');

export const WorkspaceVersionReferenceSchema = z.object({
  projectId: ProjectSchema.shape.id,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  snapshotHash: ExecutionHashSchema,
}).strict();
export type WorkspaceVersionReference = z.infer<typeof WorkspaceVersionReferenceSchema>;

export const ExecutionBudgetSchema = z.object({
  timeoutMs: z.number().int().min(1).max(120_000),
  outputTokens: z.number().int().min(1).max(16_384),
  maxAttempts: z.number().int().min(1).max(3),
}).strict();
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

// These are declarations, not claims that a symbol exists. The supervisor supplies their evidence.
export const ExecutionContextSchema = z.object({
  projectDescription: Text,
  files: z.array(z.object({ path: ExecutionPathSchema, content: z.string().max(64_000), hash: ExecutionHashSchema }).strict()).max(40),
  symbols: z.array(z.object({ id: ExecutionIdSchema, name: Text, declaration: Text, sourcePath: ExecutionPathSchema }).strict()).max(64),
  imports: z.array(z.object({ id: ExecutionIdSchema, moduleSpecifier: nonBlank(240), declaration: Text, symbolIds: Ids }).strict()).max(64),
  types: z.array(z.object({ id: ExecutionIdSchema, name: Text, declaration: nonBlank(8000), sourcePath: ExecutionPathSchema.nullable() }).strict()).max(64),
  signatures: z.array(z.object({ id: ExecutionIdSchema, symbolId: ExecutionIdSchema, declaration: nonBlank(4000) }).strict()).max(64),
  documentation: z.array(z.object({ id: ExecutionIdSchema, reference: nonBlank(2000), excerpt: nonBlank(8000) }).strict()).max(32),
  evidence: z.array(z.object({
    id: ExecutionIdSchema, kind: z.enum(['diagnostic', 'test_failure', 'runtime_failure']),
    description: Text, details: nonBlank(8000), sourcePath: ExecutionPathSchema,
    workspace: WorkspaceVersionReferenceSchema,
  }).strict()).max(32),
  required: z.object({ files: z.array(ExecutionPathSchema).max(40), symbols: Ids, imports: Ids, types: Ids, signatures: Ids, documentation: Ids, evidence: Ids }).strict(),
}).strict();
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

export const ExecutionConstraintsSchema = z.object({
  allowedFiles: z.array(ExecutionTargetPathSchema).length(1),
  allowedOperations: z.array(z.literal('replace_file')).length(1),
  requiredCapabilities: z.array(ExecutionIdSchema).min(1).max(16),
  requiredTools: z.array(SkillToolIdSchema).min(1).max(12),
  requiredScopes: z.array(z.string().min(1).max(100)).min(1).max(16),
  permissionRequirement: z.literal('supervisor_and_existing_gateway'),
  architecture: z.object({
    status: z.enum(['fixed', 'requires_supervisor']),
    decisions: z.array(z.object({ id: ExecutionIdSchema, statement: Text }).strict()).max(32),
  }).strict(),
}).strict();
export type ExecutionConstraints = z.infer<typeof ExecutionConstraintsSchema>;

// Preserve the existing planner's criterion identifiers, description, and required evidence.
export const ExecutionAcceptanceCriteriaSchema = GoalDefinitionSchema.shape.successCriteria;
export type ExecutionAcceptanceCriteria = z.infer<typeof ExecutionAcceptanceCriteriaSchema>;

export const ExecutionOperationCategorySchema = z.enum([
  'structured', 'typescript', 'code_repair',
  'react', 'nextjs', 'full_stack', 'multi_file', 'google_ads', 'ios', 'android',
]);
export type ExecutionOperationCategory = z.infer<typeof ExecutionOperationCategorySchema>;
export const ExecutionFamilySchema = z.enum(['structured_specification', 'typescript_implementation', 'local_code_repair']);
export type ExecutionFamily = z.infer<typeof ExecutionFamilySchema>;
export const ExecutionOutputCategorySchema = z.enum(['operation', 'typescript_edit']);

export const FileReplacementSchema = RawCodingEditsSchema.shape.edits.element.extend({ path: ExecutionTargetPathSchema }).strict();
export type FileReplacement = z.infer<typeof FileReplacementSchema>;
export const ExecutionCodeEditsSchema = RawCodingEditsSchema.extend({ edits: z.array(FileReplacementSchema).length(1) }).strict();

const TaskFields = {
  schemaVersion: z.literal('1'),
  taskId: ExecutionIdSchema,
  objective: Text,
  operation: z.object({ category: ExecutionOperationCategorySchema, name: ExecutionIdSchema }).strict(),
  context: ExecutionContextSchema,
  constraints: ExecutionConstraintsSchema,
  acceptanceCriteria: ExecutionAcceptanceCriteriaSchema,
  workspace: WorkspaceVersionReferenceSchema,
  budget: ExecutionBudgetSchema,
  policy: z.object({ strategy: z.enum(['deterministic_only', 'learned_only', 'prefer_deterministic']),
    missingContext: z.enum(['request', 'escalate']), unsupportedTask: z.enum(['return_unsupported', 'escalate']) }).strict(),
  output: z.object({ category: ExecutionOutputCategorySchema, language: z.literal('typescript'),
    responseLanguage: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    description: Text, maxBytes: z.number().int().min(1).max(64_000), maxFiles: z.literal(1) }).strict(),
};
const ImplementationInput = z.object({
  targetPath: ExecutionTargetPathSchema, signatureIds: Ids.min(1), typeIds: Ids,
  symbolIds: Ids, importIds: Ids,
}).strict();
export const ExecutionTaskContractSchema = z.discriminatedUnion('family', [
  z.object({ ...TaskFields, family: z.literal('structured_specification'), input: FileReplacementSchema }).strict(),
  z.object({ ...TaskFields, family: z.literal('typescript_implementation'), input: ImplementationInput }).strict(),
  z.object({ ...TaskFields, family: z.literal('local_code_repair'), input: ImplementationInput.extend({ evidenceIds: Ids.min(1) }).strict() }).strict(),
]);
export type ExecutionTaskContract = z.infer<typeof ExecutionTaskContractSchema>;

export const ExecutionIssueSchema = z.object({ path: z.array(z.union([z.string(), z.number()])).max(32), code: ExecutionIdSchema, message: Text }).strict();
export type ExecutionIssue = z.infer<typeof ExecutionIssueSchema>;
export const ExecutionFailureCodeSchema = z.enum([
  'invalid_contract', 'invalid_model_output', 'timeout', 'cancelled', 'stale_workspace', 'permission_required',
  'capability_unavailable', 'verification_failure', 'escalation_required', 'invalid_task_state', 'budget_exhausted', 'executor_failure',
]);
export type ExecutionFailureCode = z.infer<typeof ExecutionFailureCodeSchema>;
export const ExecutionFailureSchema = z.object({
  kind: z.literal('failure'), taskId: ExecutionIdSchema.nullable(), code: ExecutionFailureCodeSchema,
  message: Text, issues: z.array(ExecutionIssueSchema).max(128), retryable: z.literal(false), executionAllowed: z.literal(false),
}).strict();
export type ExecutionFailure = z.infer<typeof ExecutionFailureSchema>;

export const MissingContextItemSchema = z.object({
  kind: z.enum(['file', 'symbol', 'import', 'type', 'signature', 'documentation', 'evidence']),
  reference: z.string().min(1).max(240), reason: Text,
}).strict();
export type MissingContextItem = z.infer<typeof MissingContextItemSchema>;
export const MissingContextRequestSchema = z.object({
  kind: z.literal('missing_context'), taskId: ExecutionIdSchema, missing: z.array(MissingContextItemSchema).min(1).max(128),
  disposition: z.enum(['request', 'escalate']), executionAllowed: z.literal(false),
}).strict();
export type MissingContextRequest = z.infer<typeof MissingContextRequestSchema>;
export const UnsupportedExecutionResultSchema = z.object({
  kind: z.literal('unsupported'), taskId: ExecutionIdSchema, operation: ExecutionIdSchema, reason: Text,
  disposition: z.enum(['return_unsupported', 'escalate']), executionAllowed: z.literal(false),
}).strict();
export type UnsupportedExecutionResult = z.infer<typeof UnsupportedExecutionResultSchema>;

export const ExecutionModelIdentitySchema = z.object({
  id: ExecutionIdSchema, version: ExecutionIdSchema, artifactHash: ExecutionHashSchema,
  initialization: z.literal('random'), locality: z.literal('local'),
}).strict();
export type ExecutionModelIdentity = z.infer<typeof ExecutionModelIdentitySchema>;
export const ExecutionProducerSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('deterministic'), compilerVersion: z.literal('1') }).strict(),
  z.object({ strategy: z.literal('learned'), model: ExecutionModelIdentitySchema }).strict(),
]);
export const ExecutionCandidateSchema = z.object({
  kind: z.literal('candidate'), taskId: ExecutionIdSchema, workspace: WorkspaceVersionReferenceSchema,
  producer: ExecutionProducerSchema,
  output: z.discriminatedUnion('category', [
    z.object({ category: z.literal('operation'), language: z.literal('typescript'), operation: z.literal('replace_file'), replacement: FileReplacementSchema }).strict(),
    z.object({ category: z.literal('typescript_edit'), language: z.literal('typescript'), proposal: ExecutionCodeEditsSchema }).strict(),
  ]),
  // No executor-supplied verification, permission grant, or lifecycle transition is accepted.
  verification: z.literal('not_verified'), executionAllowed: z.literal(false),
}).strict();
export type ExecutionCandidate = z.infer<typeof ExecutionCandidateSchema>;
export const ExecutionResultSchema = z.discriminatedUnion('kind', [
  ExecutionCandidateSchema, MissingContextRequestSchema, UnsupportedExecutionResultSchema, ExecutionFailureSchema,
]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ExecutionModelCapabilitiesSchema = z.object({
  model: ExecutionModelIdentitySchema,
  tasks: z.array(z.object({ family: ExecutionFamilySchema, category: ExecutionOperationCategorySchema,
    operation: ExecutionIdSchema, outputCategory: ExecutionOutputCategorySchema, outputLanguage: z.literal('typescript'),
    responseLanguages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)).min(1).max(32) }).strict()).min(1).max(32),
  limits: z.object({ maxInputBytes: z.number().int().min(1).max(262_144),
    maxOutputTokens: z.number().int().min(1).max(16_384), maxTimeoutMs: z.number().int().min(1).max(120_000) }).strict(),
  cancellation: z.literal('abort_signal'),
}).strict();
export type ExecutionModelCapabilities = z.infer<typeof ExecutionModelCapabilitiesSchema>;
