import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyActivationGate } from '../apps/server/src/activation-gates.js';

function pinnedReport(report: unknown) {
  const record = `${JSON.stringify(report, null, 2)}\n`;
  return { record, sha256: createHash('sha256').update(record).digest('hex') };
}

const pin = { path: '/evaluation/archive/file', sha256: 'a'.repeat(64) };
const passingReport = {
  schema_version: 1,
  version: 1,
  previous_report: null,
  gate_id: 'conversation-state',
  adapter: 'classifier',
  case_count: 6,
  counts: { overall: { passed: 6, total: 6 } },
  decision: 'pass',
  checks: [{ rule: 'minimum_passes.overall', status: 'pass' }],
  hashes: {
    registration: pin,
    seal: pin,
    cases: pin,
    candidate: pin,
    start: pin,
    view: pin,
    packet: pin,
    packet_receipt: pin,
    evidence: {
      candidate: { receipt: pin, predictions: pin, provenance: pin, native_manifest: null, task_files: [] },
    },
    verdicts: [],
  },
  times: { sealed_at: '2026-11-25T13:00:00.000000Z', decided_at: '2026-11-25T13:05:00.000000Z' },
};

describe('activation gate decision records', () => {
  it('accepts only the exact SHA-256-pinned bytes of a passing record for this capability', () => {
    const input = pinnedReport(passingReport);
    expect(verifyActivationGate('conversation-state', input)).toBe(input.sha256);
    expect(verifyActivationGate('answer-selection', input)).toBeNull();
    expect(verifyActivationGate('conversation-state', { ...input, record: input.record.trim() })).toBeNull();
    expect(verifyActivationGate('conversation-state', { ...input, sha256: 'invalid' })).toBeNull();
  });

  it('refuses a non-passing decision or a passing claim containing a failed check', () => {
    for (const decision of ['stop', 'inconclusive']) {
      expect(verifyActivationGate('conversation-state', pinnedReport({ ...passingReport, decision }))).toBeNull();
    }
    const checks = [{ rule: 'minimum_passes.overall', status: 'stop' }];
    expect(verifyActivationGate('conversation-state', pinnedReport({ ...passingReport, checks }))).toBeNull();
  });

  it('requires the sealed registration pins and measured counts of a runner decision', () => {
    const hashes = { ...passingReport.hashes, seal: undefined };
    const counts = { overall: { passed: 7, total: 6 } };
    expect(verifyActivationGate('conversation-state', pinnedReport({ ...passingReport, hashes }))).toBeNull();
    expect(verifyActivationGate('conversation-state', pinnedReport({ ...passingReport, counts }))).toBeNull();
    expect(verifyActivationGate('conversation-state', pinnedReport({
      gate_id: 'conversation-state', decision: 'pass', schema_version: 1,
    }))).toBeNull();
  });

  it('requires the previous report pin for an updated decision', () => {
    const revised = { ...passingReport, version: 2 };
    expect(verifyActivationGate('conversation-state', pinnedReport(revised))).toBeNull();
    const input = pinnedReport({ ...revised, previous_report: pin });
    expect(verifyActivationGate('conversation-state', input)).toBe(input.sha256);
  });
});
