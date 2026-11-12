import { createHash } from 'node:crypto';
import type { ExecutionFailure, ExecutionFailureCode, ExecutionIssue, ExecutionTaskContract, UnsupportedExecutionResult, WorkspaceVersionReference } from './schemas.ts';

/** Reject cycles, accessors, non-JSON values and excessive input before traversing Zod schemas. */
export function boundedJsonBytes(value: unknown, maxBytes = 262_144): number | null {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  function visit(entry: unknown, depth: number): boolean {
    if (++nodes > 16_384 || depth > 16 || bytes > maxBytes) return false;
    if (entry === null || typeof entry === 'boolean') { bytes += entry === null ? 4 : entry ? 4 : 5; return bytes <= maxBytes; }
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) return false; bytes += String(entry).length; return bytes <= maxBytes; }
    if (typeof entry === 'string') { if (entry.length > maxBytes) return false; bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8'); return bytes <= maxBytes; }
    if (typeof entry !== 'object' || seen.has(entry)) return false;
    const proto = Object.getPrototypeOf(entry);
    if (Array.isArray(entry) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    seen.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const keys = Reflect.ownKeys(descriptors).filter(key => !(Array.isArray(entry) && key === 'length'));
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) return false;
    if (Array.isArray(entry) && (entry.length !== keys.length || keys.some((key, index) => key !== String(index)))) return false;
    bytes += 2 + Math.max(0, keys.length - 1);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) return false;
      if (!Array.isArray(entry)) bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(entry);
    return bytes <= maxBytes;
  }
  try { return visit(value, 0) ? bytes : null; } catch { return null; }
}

export function sameWorkspace(left: WorkspaceVersionReference, right: WorkspaceVersionReference): boolean {
  return left.projectId === right.projectId && left.baseCommit === right.baseCommit && left.snapshotHash === right.snapshotHash;
}

export function contentHash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }

export function executionFailure(taskId: string | null, code: ExecutionFailureCode, message: string, issues: ExecutionIssue[] = []): ExecutionFailure {
  return { kind: 'failure', taskId, code, message, issues: issues.slice(0, 128), retryable: false, executionAllowed: false };
}

export function unsupportedExecution(task: ExecutionTaskContract, reason: string): UnsupportedExecutionResult {
  return { kind: 'unsupported', taskId: task.taskId, operation: task.operation.name, reason, disposition: task.policy.unsupportedTask, executionAllowed: false };
}

export function schemaIssues(issues: readonly { path: readonly PropertyKey[]; code: string }[]): ExecutionIssue[] {
  // Do not echo invalid values, source text, credentials, or provider diagnostics.
  return issues.slice(0, 128).map(issue => ({ path: issue.path.slice(0, 32).map(part => typeof part === 'number' ? part : String(part)), code: issue.code, message: 'Value does not satisfy the declared execution schema.' }));
}

/** Host-owned tokenizer. Count the serialized candidate, not a model-reported usage claim. */
export type ExecutionOutputTokenCounter = (serializedCandidate: string) => number;
