import { AgentPostconditionSchema, evidenceHash, type AgentPage, type AgentPostcondition, type AgentVerificationReport } from '@mohassan/browser';

export interface BrowserVerificationAssessment {
  scope: 'declared_postconditions';
  status: 'verified' | 'failed' | 'unverified';
  reason: 'matched' | 'missing_expectation' | 'missing_report' | 'mismatched_evidence' | 'old_observation' | 'condition_failed' | 'condition_unavailable';
}

/**
 * Check a trusted browser verifier receipt against criteria fixed before the
 * action and the observation delivered with its result. No model verdict, page
 * fingerprint difference, or newly invented predicate proves a task outcome.
 * Callers separately decide whether these criteria describe a step or the goal.
 */
export function assessBrowserVerification(expected: readonly AgentPostcondition[], report: AgentVerificationReport | undefined,
    page: Pick<AgentPage, 'id' | 'hash' | 'observedAt'>, options: { actionStartedAt: number; now?: number }): BrowserVerificationAssessment {
  const result = (status: BrowserVerificationAssessment['status'], reason: BrowserVerificationAssessment['reason']): BrowserVerificationAssessment => ({ scope: 'declared_postconditions', status, reason });
  if (!expected.length || expected.length > 16) return result('unverified', 'missing_expectation');
  const parsed = expected.map(value => AgentPostconditionSchema.safeParse(value));
  if (parsed.some(value => !value.success)) return result('unverified', 'missing_expectation');
  if (!report) return result('unverified', 'missing_report');
  if (report.scope !== 'declared_postconditions' || report.pageId !== page.id || report.pageHash !== page.hash || report.observedAt !== page.observedAt ||
      !/^[a-f0-9]{24}$/.test(report.pageHash) || !Number.isSafeInteger(report.samples) || report.samples < 1 || !Array.isArray(report.checks) || report.checks.length !== expected.length ||
      report.checks.some((check, index) => !check || check.kind !== parsed[index].data!.kind || check.expectedHash !== evidenceHash(JSON.stringify(parsed[index].data)))) return result('unverified', 'mismatched_evidence');
  const observedAt = Date.parse(report.observedAt);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(options.actionStartedAt) || !Number.isFinite(observedAt) || !Number.isFinite(now) || observedAt < options.actionStartedAt || observedAt > now + 1000) return result('unverified', 'old_observation');
  if (report.status === 'failed' && report.checks.some(check => check.status === 'failed')) return result('failed', 'condition_failed');
  if (report.status !== 'passed' || report.checks.some(check => check.status !== 'passed' || !check.actualHash || !/^[a-f0-9]{64}$/.test(check.actualHash))) return result('unverified', 'condition_unavailable');
  return result('verified', 'matched');
}
