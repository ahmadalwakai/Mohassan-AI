/**
 * Phase 1 contract builders for the bounded local demonstration and its tests.
 * They stand in for the Cognitive Runtime's preparation step; nothing here grants
 * authority. Permission observations are explicit inputs to the Phase 1 validator.
 */
import { createHash } from 'node:crypto';
import type { ExecutionTaskContract } from '../../cognitive/src/execution-model/schemas.ts';
import { EXECUTION_SPEC_DOCUMENT_ID } from './phase1-model-adapter.js';

export const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Host-owned upper bound: byte-level BPE never emits more tokens than UTF-8 bytes.
export const countOutputTokens = (serialized: string) => Buffer.byteLength(serialized, 'utf8');
export const PROJECT_ID = '4f1b7c2e-9a0d-4e8b-8f3a-1c2d3e4f5a6b';
export const CAPABILITY = { id: 'coding.change', name: 'Coding change', description: 'Existing coding capability', version: '1', risk: 'medium' as const, status: 'active' as const, requiredScopes: ['code:write'] };

export interface Evidence { case: string; expected: string; observed: string; passed: boolean; details: Record<string, unknown> }

export function functionSource(name: string, expression: string): string {
  return `export function ${name}(value: number | null | undefined): number {\n  return ${expression};\n}\n`;
}

export function workspaceRef(files: Record<string, string>) {
  const snapshot = sha(JSON.stringify(Object.entries(files).sort()));
  return { projectId: PROJECT_ID, baseCommit: snapshot.slice(0, 40), snapshotHash: snapshot };
}

export function contract(options: {
  taskId: string; family: ExecutionTaskContract['family']; target: string; files: Record<string, string>;
  spec?: Record<string, unknown>; evidence?: { id: string; details: string }[]; strategy?: 'learned_only' | 'prefer_deterministic' | 'deterministic_only';
  category?: string; operation?: string; omitTargetFile?: boolean; replacement?: string;
}): Record<string, unknown> {
  const workspace = workspaceRef(options.files);
  const files = Object.entries(options.files).filter(([path]) => !(options.omitTargetFile && path === options.target))
    .map(([path, content]) => ({ path, content, hash: sha(content) }));
  const symbolId = 'sym-target';
  const documentation = options.spec ? [{ id: EXECUTION_SPEC_DOCUMENT_ID, reference: 'supervisor:execution-spec', excerpt: JSON.stringify(options.spec) }] : [];
  const operation = options.operation ?? { structured_specification: 'structured.replace-file.v1', typescript_implementation: 'typescript.implement.v1', local_code_repair: 'typescript.repair.v1' }[options.family];
  const category = options.category ?? { structured_specification: 'structured', typescript_implementation: 'typescript', local_code_repair: 'code_repair' }[options.family];
  const base = {
    schemaVersion: '1', taskId: options.taskId, objective: 'Bounded local execution demonstration.',
    operation: { category, name: operation },
    context: {
      projectDescription: 'Disposable demonstration workspace.', files,
      symbols: [{ id: symbolId, name: String(options.spec?.function_name ?? 'target'), declaration: 'exported function', sourcePath: options.target }],
      imports: [], types: [],
      signatures: [{ id: 'sig-target', symbolId, declaration: '(value: number | null | undefined): number' }],
      documentation,
      evidence: (options.evidence ?? []).map(entry => ({ id: entry.id, kind: 'test_failure', description: 'Sandbox test failure', details: entry.details, sourcePath: options.target, workspace })),
      required: { files: [options.target], symbols: [], imports: [], types: [], signatures: [], documentation: documentation.map(d => d.id), evidence: (options.evidence ?? []).map(e => e.id) },
    },
    constraints: { allowedFiles: [options.target], allowedOperations: ['replace_file'], requiredCapabilities: ['coding.change'],
      requiredTools: ['coding.change'], requiredScopes: ['code:write'], permissionRequirement: 'supervisor_and_existing_gateway',
      architecture: { status: 'fixed', decisions: [] } },
    acceptanceCriteria: [{ id: 'behavior', description: 'Supervisor-authored tests pass in the sandbox.', evidence: 'AppContainer test receipt' }],
    workspace, budget: { timeoutMs: 120_000, outputTokens: 4096, maxAttempts: 2 },
    policy: { strategy: options.strategy ?? (options.family === 'structured_specification' ? 'prefer_deterministic' : 'learned_only'), missingContext: 'request', unsupportedTask: 'return_unsupported' },
    output: { category: options.family === 'structured_specification' ? 'operation' : 'typescript_edit', language: 'typescript', responseLanguage: 'ar', description: 'One-file TypeScript replacement.', maxBytes: 16_000, maxFiles: 1 },
  };
  if (options.family === 'structured_specification') {
    return { ...base, family: options.family, input: { path: options.target, expectedHash: sha(options.files[options.target] ?? ''), content: options.replacement } };
  }
  const input = { targetPath: options.target, signatureIds: ['sig-target'], typeIds: [], symbolIds: [symbolId], importIds: [] };
  return { ...base, family: options.family, input: options.family === 'local_code_repair' ? { ...input, evidenceIds: (options.evidence ?? []).map(e => e.id) } : input };
}

export function routingContext(learned: unknown) {
  return { availableCapabilities: [CAPABILITY], availableTools: ['coding.change'], attemptsUsed: 0, ...(learned ? { learned } : {}) };
}

export function eligibilitySnapshot(task: Record<string, unknown>, state: 'granted' | 'denied', target: string) {
  const now = Date.now();
  const binding = { taskId: task.taskId as string, workspace: task.workspace as ReturnType<typeof workspaceRef> };
  return { ...binding, status: 'running', cancellationRequested: false, attemptsUsed: 0, availableCapabilities: [CAPABILITY], availableTools: ['coding.change'],
    permission: state === 'granted' ? { ...binding, state, scopes: ['code:write'], tools: ['coding.change'], files: [target],
      checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() } : { ...binding, state } };
}

