import { describe, expect, it } from 'vitest';
import type { ChatConversation, ChatRunView } from '@mohassan/contracts';
import { STAGE_LABELS, engineLabel, isNewerSnapshot, linkable, steerable, verdictBadge } from '../apps/web/components/run-view.js';

/** The web's words for the server's run: the badge, the engine line, snapshot order and when a message steers. */
const run = (extra: Partial<ChatRunView> = {}): ChatRunView => ({
  id: '7f6e5d4c-3b2a-4190-8a7b-6c5d4e3f2a1b', phase: 'completed', path: 'action', engine: { kind: 'rules', modelCalls: 0 }, context: null, plan: null,
  evidence: [], permissions: [], verification: null, verdict: { status: 'completed', reason: 'criteria_met', decidedAt: '2026-11-23T14:00:00.000Z' },
  repairs: { used: 0, limit: 1 }, steeredFrom: null, sequence: 5, updatedAt: '2026-11-23T14:00:00.000Z', ...extra,
});
const conversation = (extra: Partial<ChatConversation> = {}): ChatConversation => ({
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', title: 't', status: 'idle', updatedAt: '2026-11-23T14:00:00.000Z', messages: [], question: null, approval: null,
  secure: null, browser: null, progress: null, steps: [], error: null, configured: false, run: run(), ...extra,
});

describe('the run as the web shows it', () => {
  it('draws the server\'s verdict for every finished run, never a check mark of its own', () => {
    expect(verdictBadge(run())).toMatchObject({ tone: 'done', label: 'اكتمل' });
    expect(verdictBadge(run({ phase: 'blocked', verdict: { status: 'blocked', reason: 'step_failed', decidedAt: '2026-11-23T14:00:00.000Z' } })))
      .toMatchObject({ tone: 'blocked', label: 'تعذّر الإكمال', reason: 'فشلت خطوة مطلوبة.' });
    expect(verdictBadge(run({ verdict: { status: 'partial', reason: 'steps_outstanding', decidedAt: '2026-11-23T14:00:00.000Z' } }))?.tone).toBe('partial');
    expect(verdictBadge(run({ phase: 'executing', verdict: null }))).toBeNull();
    expect(Object.keys(STAGE_LABELS)).toHaveLength(14);
  });

  it('says a model took part only when the server counted model calls that returned a valid result', () => {
    expect(engineLabel(run())).toContain('دون نموذج لغوي');
    expect(engineLabel(run({ engine: { kind: 'model', modelCalls: 2 } }))).toContain('شارك نموذج لغوي (2');
  });

  it('keeps the newer snapshot when an older poll answer arrives late', () => {
    const current = conversation({ run: run({ sequence: 9, phase: 'executing', verdict: null }), status: 'running', updatedAt: '2026-11-23T14:00:05.000Z' });
    expect(isNewerSnapshot(current, conversation({ run: run({ sequence: 7, phase: 'executing', verdict: null }), status: 'running', updatedAt: '2026-11-23T14:00:05.000Z' }))).toBe(false);
    expect(isNewerSnapshot(current, conversation({ run: run({ sequence: 9, phase: 'executing', verdict: null }), status: 'running', updatedAt: '2026-11-23T14:00:01.000Z' }))).toBe(false);
    expect(isNewerSnapshot(current, conversation({ run: run({ sequence: 12 }), updatedAt: '2026-11-23T14:00:06.000Z' }))).toBe(true);
    // A corrected task is a new run: its snapshot replaces the old run's.
    expect(isNewerSnapshot(current, conversation({ run: run({ id: '9a8b7c6d-5e4f-4321-8a9b-0c1d2e3f4a5b', sequence: 0, phase: 'understanding', verdict: null, updatedAt: '2026-11-23T14:00:07.000Z' }),
      status: 'running', updatedAt: '2026-11-23T14:00:07.000Z' }))).toBe(true);
    expect(isNewerSnapshot(current, conversation({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))).toBe(true);
    expect(isNewerSnapshot(null, conversation())).toBe(true);
  });

  it('steers from the composer while a task works or waits for approval or hands, never during a sign-in card', () => {
    expect(steerable('running')).toBe(true);
    expect(steerable('waiting_approval')).toBe(true);
    expect(steerable('waiting_input', 'hands_on')).toBe(true);
    expect(steerable('waiting_input', 'login')).toBe(false);
    expect(steerable('waiting_input', 'code')).toBe(false);
    expect(steerable('idle')).toBe(false);
    expect(steerable('waiting_user')).toBe(false);
  });

  it('links only http(s) evidence', () => {
    expect(linkable('https://ar.wikipedia.org/wiki/x')).toBe(true);
    expect(linkable('document:123')).toBe(false);
    expect(linkable('javascript:alert(1)')).toBe(false);
    expect(linkable(null)).toBe(false);
  });
});
