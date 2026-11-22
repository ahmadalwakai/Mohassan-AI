import { createHash } from 'node:crypto';
import { asksToRemember, deniesMemoryWrite } from './brain.js';
import { assessUserFactMemoryRequest } from './user-fact-memory-receipt.js';
import { scanCurrentMemoryDeclaration } from './current-memory-declaration.js';

export interface LegacyMemoryStatementSource {
  /** Host-pinned CURRENT USER pre-schema hash, never inferred from model text or a memory receipt. */
  originalRequestHash: string;
  /** Host's actual vault+credential scrub result. Any change makes this exemption unavailable. */
  scrubbedRequest: string;
}
export interface LegacyMemoryStatementAssessment {
  scope: 'legacy_adapter_ack_only';
  eligible: boolean;
  reason: 'eligible_current_declaration' | 'invalid_input' | 'source_changed' | 'not_unsupported_candidate' | 'not_affirmative'
    | 'request_constraint' | 'source_or_reference' | 'credential_material' | 'sequence_or_condition' | 'unsupported_declaration';
  /** Literal origin of the statement, not a model payload or exact-write receipt. */
  statementSpan?: { start: number; end: number; hash: string };
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
/**
 * Narrow legacy-routing exemption, never memory permission or exact persistence
 * proof. Hosts ALSO require an existing model path and no exact-flow attempt.
 * Generic memory_save MUST still require asksToRemember (AND, never OR), quotas,
 * redaction, current account/lease, action history and the existing adapter ack.
 */
export function assessLegacyMemoryStatement(raw: unknown, source: LegacyMemoryStatementSource): LegacyMemoryStatementAssessment {
  const result = (reason: LegacyMemoryStatementAssessment['reason']): LegacyMemoryStatementAssessment => ({ scope: 'legacy_adapter_ack_only', eligible: false, reason });
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 4000 || /[\u0000\ud800-\udfff]/u.test(raw)) return result('invalid_input');
    if (!source || !/^[a-f0-9]{64}$/u.test(source.originalRequestHash) || source.originalRequestHash !== hash(raw)
      || source.scrubbedRequest !== raw || raw.trim() !== raw) return result('source_changed');
    const current = assessUserFactMemoryRequest(raw);
    if (!current.candidate || !(current.status === 'rejected' && current.reason === 'unsupported_statement'
      || current.status === 'ready' && current.statementKind === 'current_declaration')) return result('not_unsupported_candidate');
    if (!asksToRemember(raw) || deniesMemoryWrite(raw)) return result('not_affirmative');
    const scanned = scanCurrentMemoryDeclaration(raw);
    if (scanned.status !== 'ready') return result(scanned.reason);
    return { scope: 'legacy_adapter_ack_only', eligible: true, reason: 'eligible_current_declaration', statementSpan: scanned.statementSpan };
  } catch { return result('invalid_input'); }
}
