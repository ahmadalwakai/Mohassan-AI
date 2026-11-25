import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256 = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const filePin = z.object({ path: z.string().min(1), sha256 });
const evidencePins = z.object({
  receipt: filePin,
  predictions: filePin,
  provenance: filePin,
  native_manifest: filePin.nullable(),
  task_files: z.array(filePin),
});

// The owner supplies the report bytes and its SHA-256 from the evaluation archive.
// Archive paths and command arguments stay private and are never used by the server.
const passedDecision = z.object({
  schema_version: z.literal(1),
  version: z.int().positive(),
  previous_report: filePin.nullable(),
  gate_id: z.string().min(1),
  adapter: z.enum(['generation', 'agent', 'classifier']),
  case_count: z.int().positive(),
  counts: z.object({ overall: z.object({ passed: z.int().nonnegative(), total: z.int().positive() }) }),
  decision: z.literal('pass'),
  checks: z.array(z.object({ rule: z.string().min(1), status: z.literal('pass') })).min(1),
  hashes: z.object({
    registration: filePin,
    seal: filePin,
    cases: filePin,
    candidate: filePin,
    baseline: filePin.optional(),
    start: filePin,
    view: filePin,
    packet: filePin,
    packet_receipt: filePin,
    evidence: z.object({ candidate: evidencePins, baseline: evidencePins.optional() }),
    verdicts: z.array(filePin.extend({ original_sha256: sha256 })),
  }),
  times: z.object({ sealed_at: z.iso.datetime(), decided_at: z.iso.datetime() }),
});

export type ActivationGateInput = { record: string; sha256: string };

export function verifyActivationGate(gateId: string, input: ActivationGateInput): string | null {
  if (!sha256.safeParse(input.sha256).success) return null;
  const digest = createHash('sha256').update(input.record, 'utf8').digest('hex');
  if (digest !== input.sha256) return null;

  let document: unknown;
  try {
    document = JSON.parse(input.record);
  } catch {
    return null;
  }
  const parsed = passedDecision.safeParse(document);
  if (!parsed.success) return null;

  const report = parsed.data;
  const { passed, total } = report.counts.overall;
  if (report.gate_id !== gateId || total !== report.case_count || passed > total) return null;
  if ((report.version === 1) !== (report.previous_report === null)) return null;
  if (Boolean(report.hashes.baseline) !== Boolean(report.hashes.evidence.baseline)) return null;
  if (Date.parse(report.times.sealed_at) > Date.parse(report.times.decided_at)) return null;

  return digest;
}
