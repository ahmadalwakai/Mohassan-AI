import { randomUUID } from 'node:crypto';
import type { State, StateStore, TaskClaim, TaskRecord } from './contracts.js';
import { fail } from './safety.js';

export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = Object.freeze<Record<State, readonly State[]>>({
  CREATED: ['VALIDATING', 'CANCELLED', 'FAILED'],
  VALIDATING: ['WAITING_FOR_CONTEXT', 'WAITING_FOR_APPROVAL', 'ROUTING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_CONTEXT: ['VALIDATING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['VALIDATING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  ROUTING: ['GENERATING', 'CANDIDATE_VALIDATION', 'WAITING_FOR_CONTEXT', 'ESCALATED', 'FAILED', 'CANCELLED'],
  GENERATING: ['CANDIDATE_VALIDATION', 'WAITING_FOR_CONTEXT', 'REPAIR_REQUIRED', 'ESCALATED', 'FAILED', 'CANCELLED'],
  CANDIDATE_VALIDATION: ['READY_FOR_EXECUTION', 'WAITING_FOR_APPROVAL', 'REPAIR_REQUIRED', 'ESCALATED', 'FAILED', 'CANCELLED'],
  READY_FOR_EXECUTION: ['EXECUTING', 'WAITING_FOR_APPROVAL', 'ESCALATED', 'FAILED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'REPAIR_REQUIRED', 'ESCALATED', 'FAILED', 'CANCELLED'],
  REPAIR_REQUIRED: ['GENERATING', 'ESCALATED', 'FAILED', 'CANCELLED'],
  ESCALATED: [], COMPLETED: [], FAILED: [], CANCELLED: [],
});
Object.values(TRANSITIONS).forEach(transitions => Object.freeze(transitions));
export function terminal(state: State): boolean { return TRANSITIONS[state].length === 0; }
export function assertTransition(before: TaskRecord, after: TaskRecord): void {
  if (!TRANSITIONS[before.state].includes(after.state) || before.taskId !== after.taskId
    || before.correlationId !== after.correlationId || before.createdAt !== after.createdAt
    || after.deadlineAt > before.deadlineAt || after.revision !== before.revision + 1
    || after.generationCount < before.generationCount || after.recoveryCount < before.recoveryCount
    || (before.executionStarted && !after.executionStarted)) fail('state_conflict');
  if (after.executionStarted && !before.executionStarted && after.state !== 'EXECUTING') fail('state_conflict');
  if (after.state === 'EXECUTING' && (before.executionStarted || !after.executionStarted || !after.candidateHash)) fail('state_conflict');
  if (after.state === 'EXECUTING' && (!after.executionManifest || after.executionManifest.candidateHash !== after.candidateHash
    || !after.executionManifest.operations.length)) fail('state_conflict');
  if (before.executionStarted && JSON.stringify(before.executionManifest) !== JSON.stringify(after.executionManifest)) fail('state_conflict');
  if (after.state === 'VERIFYING' && !before.executionStarted) fail('state_conflict');
  if (after.state === 'GENERATING' && before.executionStarted) fail('state_conflict');
  if (after.state === 'COMPLETED' && (!before.executionStarted || after.verification?.status !== 'verified')) fail('state_conflict');
}

/** Reference store for isolated composition only. No durability, lease takeover, or production activation. */
export class InMemoryStateStore implements StateStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly claims = new Map<string, string>();
  private readonly cancellations = new Set<string>();
  async create(record: TaskRecord): Promise<boolean> {
    if (record.state !== 'CREATED' || record.revision !== 0 || record.executionStarted || record.generationCount !== 0 || record.recoveryCount !== 0) fail('state_conflict');
    if (this.records.has(record.taskId)) return false;
    this.records.set(record.taskId, structuredClone(record)); return true;
  }
  async read(taskId: string): Promise<TaskRecord | null> { return structuredClone(this.records.get(taskId) ?? null); }
  async claim(taskId: string): Promise<TaskClaim | null> {
    if (!this.records.has(taskId) || this.claims.has(taskId)) return null;
    const fence = randomUUID(); this.claims.set(taskId, fence); return { taskId, fence };
  }
  async assertClaim(claim: TaskClaim): Promise<void> {
    if (this.claims.get(claim.taskId) !== claim.fence) fail('state_conflict');
  }
  async requestCancellation(taskId: string): Promise<void> {
    if (!this.records.has(taskId)) fail('state_conflict');
    this.cancellations.add(taskId);
  }
  async isCancellationRequested(taskId: string): Promise<boolean> { return this.cancellations.has(taskId); }
  private update(claim: TaskClaim, expectedRevision: number, next: TaskRecord, beginning: boolean): boolean {
    if (this.claims.get(claim.taskId) !== claim.fence) return false;
    const previous = this.records.get(claim.taskId);
    if (!previous || previous.revision !== expectedRevision || next.taskId !== claim.taskId) return false;
    if (this.cancellations.has(claim.taskId) && ['EXECUTING', 'COMPLETED'].includes(next.state)) return false;
    assertTransition(previous, next);
    if ((next.state === 'EXECUTING') !== beginning) fail('state_conflict');
    this.records.set(claim.taskId, structuredClone(next)); return true;
  }
  async compareAndSet(claim: TaskClaim, expectedRevision: number, next: TaskRecord): Promise<boolean> {
    return this.update(claim, expectedRevision, next, false);
  }
  async beginExecution(claim: TaskClaim, expectedRevision: number, next: TaskRecord): Promise<boolean> {
    return this.update(claim, expectedRevision, next, true);
  }
  async release(claim: TaskClaim): Promise<void> {
    if (this.claims.get(claim.taskId) === claim.fence) this.claims.delete(claim.taskId);
  }
}
