import { describe, expect, it } from 'vitest';
import { evidenceHash, type AgentPostcondition, type AgentVerificationReport } from '@mohassan/browser';
import {
  browserEffectTaskObservation, compileTaskSupervisor, createTaskSupervisor, observeTaskStep,
  restoreTaskSupervisor, reviewTaskCompletion, taskEvidenceHash,
  type TaskCriterion, type TaskObservation, type TaskStepInput, type TaskSupervisorState,
} from '../apps/server/src/assistant/task-supervisor.js';

const started = Date.parse('2026-11-21T05:00:00Z');
const url = 'https://example.test/prices?city=Leeds';
const hash = (value: string) => taskEvidenceHash(value);

function navigation(screenshot = false) {
  return compileTaskSupervisor({ id: 'run-1', objective: `Open ${url}`, now: started, mode: 'enforced',
    operation: { kind: 'navigation', url, screenshot } });
}

function step(sequence: number, overrides: Partial<TaskStepInput> = {}): TaskStepInput {
  return { stepId: `step-${sequence}`, sequence, tool: 'open', startedAt: started + sequence * 100,
    finishedAt: started + sequence * 100 + 50, result: 'succeeded', ...overrides };
}

function page(sequence = 1, overrides: Partial<Extract<TaskObservation, { kind: 'navigation' }>> = {}): Extract<TaskObservation, { kind: 'navigation' }> {
  return { criterionId: 'navigation', kind: 'navigation', source: 'browser-observation', target: url,
    reference: `page-${sequence}`, observedAt: started + sequence * 100 + 20, httpStatus: 200, contentHash: 'a'.repeat(24), ...overrides };
}

function effectState() {
  return compileTaskSupervisor({ id: 'effect-run', objective: 'Create the requested draft in the account', now: started, mode: 'enforced',
    operation: { kind: 'effect', target: 'account:42/campaign:draft', description: 'The requested paused draft exists in the account.', expectationHash: hash('paused draft exists') } });
}

function effect(sequence = 1, overrides: Partial<Extract<TaskObservation, { kind: 'effect' }>> = {}): Extract<TaskObservation, { kind: 'effect' }> {
  return { criterionId: 'effect', kind: 'effect', source: 'authoritative-readback', target: 'account:42/campaign:draft',
    reference: `readback-${sequence}`, observedAt: started + sequence * 100 + 20, expectationHash: hash('paused draft exists'),
    independentlyVerified: true, outcome: 'confirmed', actionRef: 'action-1', ...overrides };
}

describe('task contracts and scope', () => {
  it('keeps creative/general conversation unscoped while unsupported requests remain explicitly unsupported', () => {
    const chat = compileTaskSupervisor({ id: 'chat', objective: 'اكتب قصيدة قصيرة', now: started, operation: { kind: 'conversation' } });
    expect(reviewTaskCompletion(chat, { now: started })).toMatchObject({ status: 'unscoped', allowCompletion: true, shouldBlockCompletion: false });
    const unsupported = compileTaskSupervisor({ id: 'other', objective: 'An unavailable operation', now: started, operation: { kind: 'unsupported' } });
    expect(reviewTaskCompletion(unsupported, { now: started })).toMatchObject({ status: 'unsupported', allowCompletion: false, shouldBlockCompletion: false });
  });

  it('canonicalizes explicit navigation without loosening the requested path, query or fragment', () => {
    const state = compileTaskSupervisor({ id: 'url', objective: 'Open the section', now: started,
      operation: { kind: 'navigation', url: 'https://EXAMPLE.test#section' } });
    expect(state.contract.criteria[0].target).toBe('https://example.test/#section');
    expect(() => compileTaskSupervisor({ id: 'bad', objective: 'Open', operation: { kind: 'navigation', url: 'file:///secret' } })).toThrow('TASK_SUPERVISOR_INVALID_TARGET');
    expect(() => compileTaskSupervisor({ id: 'credentials', objective: 'Open', operation: { kind: 'navigation', url: 'https://user:secret@example.test' } })).toThrow('TASK_SUPERVISOR_INVALID_TARGET');
  });

  it('rejects duplicate criterion identities and tasks without actual criteria', () => {
    const criterion = navigation().contract.criteria[0];
    expect(() => createTaskSupervisor({ id: 'duplicate', objective: 'Open', criteria: [criterion, criterion] })).toThrow('TASK_SUPERVISOR_INVALID_CONTRACT');
    expect(() => createTaskSupervisor({ id: 'empty', objective: 'Task', kind: 'task' })).toThrow('TASK_SUPERVISOR_INVALID_CONTRACT');
  });

  it('permits advisory evaluation without presenting missing evidence as verified', () => {
    const state = compileTaskSupervisor({ id: 'advisory', objective: 'Recall the budget', now: started, operation: { kind: 'memory_recall' } });
    expect(reviewTaskCompletion(state, { now: started })).toMatchObject({ status: 'unverified', allowCompletion: false, shouldBlockCompletion: false, missingCriteria: ['memory-answer'] });
  });
});

describe('declared evidence, not model success claims', () => {
  it('requires an actual requested-page observation; generic changed flags and result hashes do not prove completion', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { changed: true, resultRef: 'model-said-done', resultHash: hash('done') }));
    expect(reviewTaskCompletion(state, { now: started + 200 })).toMatchObject({ status: 'unverified', allowCompletion: false });
    observeTaskStep(state, step(2, { observations: [page(2)] }));
    expect(reviewTaskCompletion(state, { now: started + 300 })).toMatchObject({ status: 'verified', allowCompletion: true });
  });

  it('rejects model-shaped evidence before mutating the state', () => {
    const state = navigation();
    expect(() => observeTaskStep(state, step(1, { observations: [{ ...page(), source: 'model' } as never] }))).toThrow();
    expect(state.steps).toHaveLength(0);
    expect(reviewTaskCompletion(state, { now: started + 200 }).allowCompletion).toBe(false);
  });

  it('does not accept a redirect, query change, login failure or observation older than the action', () => {
    for (const observation of [page(1, { target: 'https://example.test/login' }), page(1, { target: `${url}&other=1` }), page(1, { httpStatus: 401 })]) {
      const state = navigation();
      observeTaskStep(state, step(1, { observations: [observation] }));
      expect(reviewTaskCompletion(state, { now: started + 200 }).allowCompletion).toBe(false);
    }
    const old = navigation();
    expect(observeTaskStep(old, step(1, { observations: [page(1, { observedAt: started })] }))).toMatchObject({ accepted: false, reason: 'invalid_step' });
  });

  it('binds a screenshot to the actual page captured, not a description or an image from another observation', () => {
    const state = navigation(true);
    observeTaskStep(state, step(1, { observations: [page()] }));
    expect(reviewTaskCompletion(state, { now: started + 200 })).toMatchObject({ status: 'partial', missingCriteria: ['screenshot'] });
    const screenshot: TaskObservation = { kind: 'artifact', criterionId: 'screenshot', source: 'artifact', target: url,
      reference: 'image-1', artifactHash: hash('actual screenshot bytes'), artifactType: 'screenshot', pageRef: 'different-page', observedAt: started + 220 };
    observeTaskStep(state, step(2, { tool: 'screenshot', observations: [screenshot] }));
    expect(reviewTaskCompletion(state, { now: started + 300 }).criteria[1]).toMatchObject({ status: 'unverified', reason: 'artifact_unbound' });
    observeTaskStep(state, step(3, { tool: 'screenshot', observations: [{ ...screenshot, pageRef: 'page-1', observedAt: started + 320 }] }));
    expect(reviewTaskCompletion(state, { now: started + 400 })).toMatchObject({ status: 'verified', allowCompletion: true });
  });

  it('requires a final-answer verifier, then invalidates the proof if that answer changes', () => {
    const state = compileTaskSupervisor({ id: 'recall', objective: 'ما ميزانيتي؟', now: started, operation: { kind: 'memory_recall' } });
    const answer = '£830';
    const observation: TaskObservation = { kind: 'answer_evidence', source: 'memory-read', criterionId: 'memory-answer', target: 'memory:recall',
      reference: 'memory-note:17', observedAt: started + 120, answerHash: hash(answer), independentlyVerified: false, outcome: 'confirmed' };
    observeTaskStep(state, step(1, { tool: 'memory_search', observations: [observation] }));
    expect(reviewTaskCompletion(state, { now: started + 200, answerHash: hash(answer) }).allowCompletion).toBe(false);
    observeTaskStep(state, step(2, { tool: 'memory_verify', observations: [{ ...observation, observedAt: started + 220, independentlyVerified: true }] }));
    expect(reviewTaskCompletion(state, { now: started + 300, answerHash: hash(answer) }).allowCompletion).toBe(true);
    expect(reviewTaskCompletion(state, { now: started + 300, answerHash: hash('£900') }).criteria[0]).toMatchObject({ reason: 'answer_changed', status: 'unverified' });
  });

  it('does not equate a dispatch receipt to a verified external effect', () => {
    const state = effectState();
    observeTaskStep(state, step(1, { tool: 'ads_create_paused', changed: true, affects: ['effect'], observations: [effect(1, { source: 'tool-receipt' })] }));
    expect(reviewTaskCompletion(state, { now: started + 200 }).allowCompletion).toBe(false);
    observeTaskStep(state, step(2, { tool: 'ads_readback', observations: [effect(2)] }));
    expect(reviewTaskCompletion(state, { now: started + 300 }).allowCompletion).toBe(true);
  });

  it('never promotes an external effect from flags, statuses or a receipt claiming its own verification', () => {
    for (const changed of [true, false, null]) for (const result of ['succeeded', 'failed', 'unknown'] as const) {
      for (const observation of [undefined, effect(1, { source: 'tool-receipt' }), effect(1, { independentlyVerified: false }), effect(1, { outcome: 'unknown' })]) {
        const state = effectState();
        observeTaskStep(state, step(1, { changed, result, resultHash: hash('The tool says done'), affects: ['effect'], observations: observation ? [observation] : [] }));
        expect(reviewTaskCompletion(state, { now: started + 200 }).allowCompletion).toBe(false);
      }
    }
  });

  it('requires the same predeclared effect expectation and treats subsequent uncertainty as unverified', () => {
    const state = effectState();
    observeTaskStep(state, step(1, { observations: [effect(1, { expectationHash: hash('different requirement') })] }));
    expect(reviewTaskCompletion(state, { now: started + 200 }).criteria[0]).toMatchObject({ reason: 'expectation_changed' });
    observeTaskStep(state, step(2, { observations: [effect(2)] }));
    expect(reviewTaskCompletion(state, { now: started + 300 }).allowCompletion).toBe(true);
    observeTaskStep(state, step(3, { tool: 'ads_update', result: 'unknown', affects: ['effect'] }));
    expect(reviewTaskCompletion(state, { now: started + 400 }).criteria[0]).toMatchObject({ status: 'unverified', reason: 'newer_unverified_step' });
  });

  it('lets newer contradiction supersede old success and refuses contradictory simultaneous proof', () => {
    const state = effectState();
    observeTaskStep(state, step(1, { observations: [effect()] }));
    observeTaskStep(state, step(2, { observations: [effect(2), effect(2, { outcome: 'contradicted', reference: 'readback-disagrees' })] }));
    expect(reviewTaskCompletion(state, { now: started + 300 })).toMatchObject({ status: 'failed', allowCompletion: false });
  });

  it('expires old evidence and refuses observations dated after the review clock', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { observations: [page()] }));
    expect(reviewTaskCompletion(state, { now: started + 100 }).criteria[0]).toMatchObject({ status: 'unverified', reason: 'future_evidence' });
    expect(reviewTaskCompletion(state, { now: started + 5 * 60_000 + 121 }).criteria[0]).toMatchObject({ status: 'expired', reason: 'expired_evidence' });
  });

  it('cannot certify an empty answer or empty screenshot artifact', () => {
    const memory = compileTaskSupervisor({ id: 'empty-recall', objective: 'Recall the stored budget', now: started, operation: { kind: 'memory_recall' } });
    observeTaskStep(memory, step(1, { observations: [{ kind: 'answer_evidence', source: 'memory-read', criterionId: 'memory-answer', target: 'memory:recall',
      reference: 'memory:empty', observedAt: started + 120, answerHash: hash(''), independentlyVerified: true, outcome: 'confirmed' }] }));
    expect(reviewTaskCompletion(memory, { now: started + 200, answerHash: hash('') }).allowCompletion).toBe(false);
    const screenshot = navigation(true);
    observeTaskStep(screenshot, step(1, { observations: [page(), { kind: 'artifact', criterionId: 'screenshot', source: 'artifact', target: url,
      reference: 'empty-image', artifactHash: hash(''), artifactType: 'screenshot', pageRef: 'page-1', observedAt: started + 130 }] }));
    expect(reviewTaskCompletion(screenshot, { now: started + 200 }).allowCompletion).toBe(false);
  });
});

describe('progress, idempotency and resumption', () => {
  it('detects repeated reads even if the page receipt and time keep changing', () => {
    const state = navigation();
    expect(observeTaskStep(state, step(1, { observations: [page()] }))).toMatchObject({ progressed: true, stagnantSteps: 0 });
    expect(observeTaskStep(state, step(2, { observations: [page(2)], changed: true }))).toMatchObject({ progressed: false, stagnantSteps: 1 });
    expect(observeTaskStep(state, step(3, { observations: [page(3)], changed: true }))).toMatchObject({ progressed: false, stagnantSteps: 2 });
    expect(observeTaskStep(state, step(4, { observations: [page(4, { contentHash: 'b'.repeat(24) })] }))).toMatchObject({ progressed: true, stagnantSteps: 0 });
  });

  it('uses actual new result content for progress while failed calls and bare change flags stay stagnant', () => {
    const state = navigation();
    expect(observeTaskStep(state, step(1, { changed: true }))).toMatchObject({ progressed: false, stagnantSteps: 1 });
    expect(observeTaskStep(state, step(2, { resultHash: hash('new tool result') }))).toMatchObject({ progressed: true });
    expect(observeTaskStep(state, step(3, { tool: 'read_more', resultHash: hash('new tool result') }))).toMatchObject({ progressed: false });
    expect(observeTaskStep(state, step(4, { result: 'failed', resultHash: hash('another error string') }))).toMatchObject({ progressed: false });
  });

  it('records a replay once and rejects altered replay identities, old sequences and invalid time order', () => {
    const state = navigation();
    const first = step(1, { observations: [page()] });
    observeTaskStep(state, first);
    expect(observeTaskStep(state, first)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(observeTaskStep(state, { ...first, result: 'unknown' })).toMatchObject({ reason: 'duplicate_conflict' });
    expect(observeTaskStep(state, step(1, { stepId: 'other-step' }))).toMatchObject({ reason: 'out_of_order' });
    expect(observeTaskStep(state, step(2, { finishedAt: started + 1 }))).toMatchObject({ reason: 'out_of_order' });
    expect(state.steps).toHaveLength(1);
  });

  it('restores a JSON snapshot against the same objective and rejects changed objectives or revisions', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { observations: [page()] }));
    const snapshot = JSON.parse(JSON.stringify(state));
    const restored = restoreTaskSupervisor(snapshot, state.contract, { now: started + 200 });
    expect(restored).toEqual(state);
    expect(reviewTaskCompletion(restored!, { now: started + 200 }).allowCompletion).toBe(true);
    const next = compileTaskSupervisor({ id: 'run-1', objective: 'A different request', revision: 2, now: started,
      operation: { kind: 'navigation', url } });
    expect(restoreTaskSupervisor(snapshot, next.contract, { now: started + 200 })).toBeNull();
    expect(restoreTaskSupervisor(snapshot, state.contract, { now: started + 100 })).toBeNull();
  });

  it('rejects snapshots with corrupted records, counters, contract identity or unknown evidence sources', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { observations: [page()] }));
    const corruptions: ((copy: TaskSupervisorState) => void)[] = [
      copy => { copy.contract.objective = 'Rewritten after execution'; },
      copy => { copy.steps[0].observations[0].reference = 'changed'; },
      copy => { copy.lastSequence = 17; },
      copy => { copy.stagnantSteps = 10; },
      copy => { copy.steps[0].contractHash = hash('wrong revision'); },
      copy => { (copy.steps[0].observations[0] as { source: string }).source = 'model'; },
    ];
    for (const change of corruptions) {
      const copy = structuredClone(state); change(copy);
      expect(restoreTaskSupervisor(copy, state.contract, { now: started + 200 })).toBeNull();
    }
  });

  it('rejects direct state corruption during both review and subsequent observation', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { observations: [page()] }));
    state.steps[0].observations[0].target = 'https://other.test/';
    expect(() => reviewTaskCompletion(state, { now: started + 200 })).toThrow('TASK_SUPERVISOR_INVALID_STATE');
    expect(() => observeTaskStep(state, step(2))).toThrow('TASK_SUPERVISOR_INVALID_STATE');
  });

  it('restores aged work for resumption while requiring new evidence before completion', () => {
    const state = navigation();
    observeTaskStep(state, step(1, { observations: [page()] }));
    const later = started + 10 * 60_000;
    const restored = restoreTaskSupervisor(JSON.parse(JSON.stringify(state)), state.contract, { now: later });
    expect(restored).not.toBeNull();
    expect(reviewTaskCompletion(restored!, { now: later }).criteria[0].status).toBe('expired');
    observeTaskStep(restored!, step(2, { startedAt: later, finishedAt: later + 50, observations: [page(2, { observedAt: later + 20 })] }));
    expect(reviewTaskCompletion(restored!, { now: later + 100 }).allowCompletion).toBe(true);
  });

  it('keeps snapshot size bounded and rejects unknown affected criteria', () => {
    const state = navigation();
    expect(observeTaskStep(state, step(1, { affects: ['invented-criterion'] }))).toMatchObject({ reason: 'invalid_step' });
    for (let sequence = 1; sequence <= 64; sequence++) observeTaskStep(state, step(sequence));
    expect(observeTaskStep(state, step(65))).toMatchObject({ accepted: false, reason: 'capacity' });
    expect(state.steps).toHaveLength(64);
    expect(restoreTaskSupervisor({ ...state, steps: [...state.steps, state.steps[0]] }, state.contract, { now: started + 10_000 })).toBeNull();
  });
});

describe('browser verifier adapter', () => {
  it('uses the existing declared-postcondition verifier and binds its requirement hash', () => {
    const expected: AgentPostcondition[] = [{ kind: 'text', contains: 'Reservation reference: R-41' }];
    const criterion: Extract<TaskCriterion, { kind: 'effect' }> = { id: 'booked', kind: 'effect', target: 'booking:R-41', description: 'Booking exists',
      required: true, maxAgeMs: 300_000, expectationHash: hash(JSON.stringify(expected)) };
    const observedAt = new Date(started + 120).toISOString();
    const browserPage = { id: 'booking-page', hash: 'a'.repeat(24), observedAt };
    const report: AgentVerificationReport = { scope: 'declared_postconditions', status: 'passed', pageId: browserPage.id, pageHash: browserPage.hash,
      observedAt, samples: 1, checks: [{ kind: 'text', status: 'passed', expectedHash: evidenceHash(JSON.stringify(expected[0])), actualHash: hash('observed reservation') }] };
    const state = createTaskSupervisor({ id: 'book', objective: 'Book a reservation', now: started, criteria: [criterion] });
    const observation = browserEffectTaskObservation({ criterion, expected, report, page: browserPage, actionRef: 'booking-action', actionStartedAt: started + 100, now: started + 150 });
    observeTaskStep(state, step(1, { observations: [observation] }));
    expect(reviewTaskCompletion(state, { now: started + 200 }).status).toBe('verified');
    const missing = browserEffectTaskObservation({ criterion, expected, report: undefined, page: browserPage, actionRef: 'booking-action', actionStartedAt: started + 100, now: started + 150 });
    expect(missing).toMatchObject({ independentlyVerified: false, outcome: 'unknown' });
  });
});
