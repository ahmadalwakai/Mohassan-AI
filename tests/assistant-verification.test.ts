import { describe, expect, it } from 'vitest';
import { evidenceHash, type AgentPostcondition, type AgentVerificationReport } from '@mohassan/browser';
import { assessBrowserVerification } from '../apps/server/src/assistant/verification.js';
import { newBrainState, noteAttempt, shouldAskForHelp } from '../apps/server/src/assistant/brain.js';

const expected: AgentPostcondition[] = [{ kind: 'text', contains: 'Reservation reference: R-41' }, { kind: 'http_status', allowed: [200] }];
const page = { id: 'observation-2', hash: 'a'.repeat(24), observedAt: '2026-11-08T12:00:02.000Z' };
const clock = { actionStartedAt: Date.parse('2026-11-08T12:00:01.000Z'), now: Date.parse('2026-11-08T12:00:03.000Z') };
const receipt = (): AgentVerificationReport => ({ scope: 'declared_postconditions', status: 'passed', pageId: page.id, pageHash: page.hash, observedAt: page.observedAt, samples: 1,
  checks: expected.map(condition => ({ kind: condition.kind, status: 'passed', expectedHash: evidenceHash(JSON.stringify(condition)), actualHash: evidenceHash('read independently') })) });

describe('browser outcome evidence', () => {
  it('requires declared criteria and a matching independent receipt, not a changed page', () => {
    expect(assessBrowserVerification([], receipt(), page, clock)).toMatchObject({ status: 'unverified', reason: 'missing_expectation' });
    expect(assessBrowserVerification(expected, undefined, page, clock)).toMatchObject({ status: 'unverified', reason: 'missing_report' });
    expect(assessBrowserVerification(expected, receipt(), page, clock)).toEqual({ scope: 'declared_postconditions', status: 'verified', reason: 'matched' });
  });

  it('refuses receipts for old pages, altered expectations, missing checks or pre-action observations', () => {
    expect(assessBrowserVerification(expected, receipt(), { ...page, hash: 'b'.repeat(24) }, clock)).toMatchObject({ status: 'unverified' });
    expect(assessBrowserVerification([{ kind: 'text', contains: 'Something else' }, expected[1]], receipt(), page, clock)).toMatchObject({ reason: 'mismatched_evidence' });
    expect(assessBrowserVerification(expected, { ...receipt(), checks: receipt().checks.slice(1) }, page, clock)).toMatchObject({ reason: 'mismatched_evidence' });
    expect(assessBrowserVerification(expected, receipt(), page, { ...clock, actionStartedAt: clock.now })).toMatchObject({ reason: 'old_observation' });
    expect(assessBrowserVerification(expected, receipt(), page, { ...clock, now: clock.actionStartedAt - 5000 })).toMatchObject({ reason: 'old_observation' });
  });

  it('distinguishes proven failure from unavailable verification without fabricating success', () => {
    const failed = receipt(); failed.status = 'failed'; failed.checks[0].status = 'failed';
    expect(assessBrowserVerification(expected, failed, page, clock)).toMatchObject({ status: 'failed', reason: 'condition_failed' });
    const unknown = receipt(); unknown.status = 'unavailable'; unknown.checks[0].status = 'unavailable'; unknown.checks[0].actualHash = null;
    expect(assessBrowserVerification(expected, unknown, page, clock)).toMatchObject({ status: 'unverified', reason: 'condition_unavailable' });
    const forged = receipt(); forged.checks[0].actualHash = null;
    expect(assessBrowserVerification(expected, forged, page, clock)).toMatchObject({ status: 'unverified' });
  });

  it('allows verified idempotent progress without changing the observed page-difference flag', () => {
    const state = newBrainState(); state.unchanged = 4;
    noteAttempt(state, 'set-a-field-to-its-current-value', false, false, true);
    expect(state.unchanged).toBe(0);
    expect(shouldAskForHelp(state)).toBe(false);
    noteAttempt(state, 'failed-action', false, true, true);
    expect(state.failures).toBe(1);
    expect(state.unchanged).toBe(1);
  });
});
