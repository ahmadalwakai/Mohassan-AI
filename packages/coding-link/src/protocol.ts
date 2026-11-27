import { z } from 'zod';
import { CodingResultSchema, ProjectSchema, SandboxStatusSchema, SandboxTestResultSchema } from '@mohassan/contracts';
import type { CodingCheckResult, ImportsLookup, ProjectInspection, ProjectSearchResult } from '@mohassan/coding';

export const CODING_DEVICE_PROTOCOL_VERSION = 1;
export const CODING_DEVICE_POLL_BODY_LIMIT = 1_048_576;
export const CODING_DEVICE_POLL_INTERVAL_MS = 1_000;
export const CODING_RESULT_HEADERS = {
  jobId: 'x-coding-device-job', nonce: 'x-coding-device-nonce', sentAt: 'x-coding-device-sent-at',
} as const;

const uuid = z.uuid();
const instant = z.iso.datetime();
const ownerId = z.string().min(1).max(256);
const absolutePath = z.string().min(1).max(4_096);
const projectPath = z.string().min(1).max(180);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const fileHash = z.string().regex(/^[a-f0-9]{64}$/);
const checkedFiles = z.array(projectPath).max(40);
const protocolVersion = z.number().int();
const deviceKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pollIntervalMs = z.number().int().min(100).max(30_000);
const wireErrorCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);

export const CodingDeviceErrorCodeSchema = z.enum([
  'CODING_DEVICE_NOT_PAIRED', 'CODING_DEVICE_OFFLINE', 'CODING_DEVICE_TIMEOUT',
  'CODING_DEVICE_RESULT_UNKNOWN', 'CODING_DEVICE_PATH_DENIED', 'CODING_DEVICE_VERSION',
  'CODING_DEVICE_SANDBOX_UNAVAILABLE', 'CODING_DEVICE_RESULT_TOO_LARGE',
  'CODING_DEVICE_BAD_RESULT', 'CODING_DEVICE_CANCELLED', 'CODING_DEVICE_DISABLED',
]);
export type CodingDeviceErrorCode = z.infer<typeof CodingDeviceErrorCodeSchema>;

export const CodingPairRequestSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  name: z.string().trim().min(1).max(80),
});
export const CodingPairResponseSchema = z.strictObject({ deviceId: uuid, deviceKey, pollIntervalMs });
export const CodingDeviceBootstrapSchema = CodingPairResponseSchema.extend({
  serverUrl: z.string().min(1).max(2_048),
  allowedRoots: z.array(absolutePath).max(128),
});

const sandboxStatus = SandboxStatusSchema.strict().extend({
  provider: z.string().min(1).max(100).nullable(), message: z.string().max(1_200),
});
export const CodingDeviceStatusSchema = z.strictObject({
  protocolVersion, platform: z.enum(['win32', 'linux']), sandbox: sandboxStatus,
});

const project = ProjectSchema.strict().extend({
  ownerId, path: absolutePath, baseCommit: commit, allowedPaths: z.array(projectPath).min(1).max(5), createdAt: instant,
});
const sandboxReceipt = SandboxTestResultSchema.strict().extend({ provider: z.string().min(1).max(100), isolationVerified: z.literal(true) });
const codingResult = CodingResultSchema.strict().extend({
  projectId: uuid, baseCommit: commit, branch: z.string().max(100), checkpoint: commit.nullable(),
  changes: z.array(z.strictObject({ path: projectPath, beforeHash: fileHash, afterHash: fileHash })).max(5),
  baselineTests: sandboxReceipt.nullable(), tests: sandboxReceipt,
  review: z.strictObject({ passed: z.boolean(), checks: z.array(z.strictObject({
    id: z.string().min(1).max(100), passed: z.boolean(), message: z.string().max(1_200),
  })).min(1).max(20) }),
  model: z.literal('deterministic-tools'),
  usage: z.strictObject({ inputTokens: z.literal(0), outputTokens: z.literal(0) }),
});

export const CodingJobKindSchema = z.enum([
  'inspect', 'demo', 'check', 'execute', 'verify', 'search', 'imports', 'instructions', 'trackedPaths',
]);
export type CodingJobKind = z.infer<typeof CodingJobKindSchema>;
export const CODING_EXECUTE_LEASE_MARGIN_MS = 15_000;
export const CODING_JOB_DEADLINES_MS = {
  inspect: 60_000, demo: 60_000, check: 120_000, execute: 180_000 - CODING_EXECUTE_LEASE_MARGIN_MS,
  verify: 60_000, search: 60_000, imports: 60_000, instructions: 60_000, trackedPaths: 60_000,
} satisfies Record<CodingJobKind, number>;

export const CodingJobPayloadSchemas = {
  inspect: z.strictObject({ path: absolutePath }),
  demo: z.strictObject({ ownerId }),
  check: z.strictObject({ project }),
  execute: z.strictObject({ project, taskId: uuid, goal: z.string().min(1).max(4_000) }),
  verify: z.strictObject({ project, taskId: uuid, result: codingResult }),
  search: z.strictObject({ project, query: z.string().max(4_000) }),
  imports: z.strictObject({ project, reference: z.string().max(4_000) }),
  instructions: z.strictObject({ project, baseCommit: commit.optional() }),
  trackedPaths: z.strictObject({ project, baseCommit: commit }),
} satisfies Record<CodingJobKind, z.ZodType>;

function job<K extends CodingJobKind>(kind: K) {
  return z.strictObject({ id: uuid, kind: z.literal(kind), payload: CodingJobPayloadSchemas[kind], deadlineAt: instant });
}
export const CodingJobSchema = z.discriminatedUnion('kind', [
  job('inspect'), job('demo'), job('check'), job('execute'), job('verify'),
  job('search'), job('imports'), job('instructions'), job('trackedPaths'),
]);
export type CodingJob = z.infer<typeof CodingJobSchema>;
export type CodingJobPayloads = { [K in CodingJobKind]: z.input<(typeof CodingJobPayloadSchemas)[K]> };

const position = z.number().int().nonnegative();
const location = z.strictObject({ path: projectPath, line: position, column: position.nullable() });
const failureField = z.string().max(200).nullable();
const inspection = z.strictObject({ path: absolutePath, baseCommit: commit, candidateEditablePaths: checkedFiles, testFiles: checkedFiles });
const check = z.strictObject({
  projectId: uuid, baseCommit: commit, testFiles: checkedFiles,
  report: z.strictObject({
    status: z.enum(['passed', 'failed', 'timed_out']),
    counts: z.strictObject({ tests: position, pass: position, fail: position, cancelled: position, skipped: position, todo: position }).nullable(),
    failures: z.array(z.strictObject({
      test: z.string().max(200), location: location.nullable(), error: z.string().max(300), comparison: z.string().max(300).nullable(),
      expected: failureField, actual: failureField, operator: failureField, origin: location.nullable(),
    })).max(10),
    omittedFailures: position,
    typecheck: z.array(location.extend({ code: z.string().max(64), message: z.string().max(300) })).max(10),
    syntax: z.array(z.strictObject({ location: location.nullable(), message: z.string().max(300) })).max(5),
    unparsed: z.string().max(900).nullable(),
  }),
  diagnostics: z.array(location.extend({ column: position, code: z.string().max(64), message: z.string().max(128_000) })).max(5),
  receipt: sandboxReceipt.pick({ provider: true, isolationVerified: true, network: true, snapshotHash: true, exitCode: true, timedOut: true, durationMs: true }),
}) satisfies z.ZodType<CodingCheckResult>;
const search = z.strictObject({
  query: z.string().min(1).max(200), wholeWord: z.boolean(), matches: z.array(z.strictObject({
    path: projectPath, line: position, text: z.string().max(160),
  })).max(30), total: position, files: position, masked: position, pathMatches: z.array(projectPath).max(10),
}) satisfies z.ZodType<ProjectSearchResult>;
const importSpecifier = z.string().max(64_000);
const imports = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('ambiguous'), paths: z.array(projectPath).max(8) }),
  z.strictObject({ kind: z.literal('file'), relations: z.strictObject({
    target: projectPath,
    imports: z.array(z.strictObject({ specifier: importSpecifier, path: projectPath.nullable() })).max(64_000),
    importedBy: z.array(z.strictObject({ path: projectPath, specifier: importSpecifier })).max(128_000),
  }) }),
]) satisfies z.ZodType<ImportsLookup>;
const instructions = z.strictObject({
  protectedGlobs: z.array(z.string().min(1).max(180)).max(16_000), notes: z.string().max(1_500),
  warnings: z.array(z.string().max(300)).max(1),
}).nullable() satisfies z.ZodType<NonNullable<ProjectInspection['instructions']> | null>;

export const CodingJobResultSchemas = {
  inspect: inspection,
  demo: inspection.extend({ allowedPaths: z.array(projectPath).min(1).max(5) }),
  check,
  execute: codingResult,
  verify: codingResult.nullable(),
  search,
  imports,
  instructions,
  trackedPaths: checkedFiles,
} satisfies Record<CodingJobKind, z.ZodType>;
export type CodingJobResults = { [K in CodingJobKind]: z.output<(typeof CodingJobResultSchemas)[K]> };

export const CodingProgressSchema = z.strictObject({
  jobId: uuid, seq: z.number().int().positive().max(32), stage: z.enum([
    'project_inspected', 'baseline_tested', 'worktree_created', 'repair_requested', 'edits_validated',
    'edits_applied', 'tests_started', 'tests_finished', 'review_finished', 'checkpoint_created',
  ]), message: z.string().max(1_200),
});
export type CodingProgress = z.infer<typeof CodingProgressSchema>;

// Parse the result separately after authenticating its device and dispatched job.
// Invalid result payloads still have to terminate the job as a durable failure.
export const CodingFinishedResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ jobId: uuid, status: z.literal('succeeded'), value: z.unknown() }),
  z.strictObject({ jobId: uuid, status: z.literal('failed'), code: wireErrorCode, message: z.string().max(1_200).optional() }),
  z.strictObject({ jobId: uuid, status: z.literal('cancelled'), code: z.literal('CODING_DEVICE_CANCELLED') }),
]);
export type CodingFinishedResult = z.infer<typeof CodingFinishedResultSchema>;

export const CodingPollRequestSchema = z.strictObject({
  nonce: uuid, sentAt: instant, activeJobId: uuid.nullable(), status: CodingDeviceStatusSchema,
  progress: z.array(CodingProgressSchema).max(32), result: z.unknown(),
});
export const CodingPollResponseSchema = z.strictObject({ job: CodingJobSchema.nullable(), cancel: z.array(uuid).max(32) });
export type CodingPollRequest = z.infer<typeof CodingPollRequestSchema>;
