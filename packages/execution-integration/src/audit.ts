import { randomUUID } from 'node:crypto';
import { INTEGRATION_VERSION, type AuditKind, type AuditSink, type FailureCode, type TaskRecord } from './contracts.js';
import { hash, IntegrationError, within } from './safety.js';

export class ExecutionAudit {
  constructor(private readonly sink: AuditSink, private readonly now: () => number = Date.now) {}
  async emit(record: TaskRecord, kind: AuditKind, refs: readonly string[] = [], code?: FailureCode): Promise<void> {
    try {
      await within(5_000, new AbortController().signal, signal => this.sink.append({ version: INTEGRATION_VERSION, id: randomUUID(), at: this.now(),
        taskHash: hash(record.taskId), correlationHash: hash(record.correlationId), kind, state: record.state,
        ...(code ? { code } : {}), referenceHashes: refs.map(ref => hash(ref)) }, signal));
    } catch { throw new IntegrationError('audit_unavailable'); }
  }
}
