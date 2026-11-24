import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { beginRepair, createRunLedger, enterPhase, planStep, restoreRunLedger, setPlan, setStepAuthorization, settleStep, startStep } from '../apps/server/src/assistant/agent-run.js';
import { normalizeHandsPlan, runHands, type HandsIO, type HandsPlan } from '../apps/server/src/assistant/hands.js';
import { beginHandsStep, completeApprovedHandsStep, completeHandsStep, handsStepId, recordHandsPlan, reopenHandsReadStep, settleHandsPart } from '../apps/server/src/assistant/run-plans.js';
import { consumePermission, recordDecision, requestPermission } from '../apps/server/src/assistant/permission-gate.js';

const RUN = 'dd3946f1-bc57-48d2-b49a-ce77fc7a4b70';
const AT = Date.parse('2026-11-24T08:00:00.000Z');
const ledger = () => { const run = createRunLedger({ runId: RUN, path: 'action', at: AT }); enterPhase(run, 'understanding', AT); return run; };
const open = (name: string) => ({ kind: 'open' as const, url: `https://${name}.test/`, name });
const plan = (count = 2): HandsPlan => ({ lang: 'en', next: 0, steps: Array.from({ length: count }, (_, index) => open(`site-${index}`)) });
const page: AgentPage = {
  id: 'https://notes.test/', url: 'https://notes.test/', title: 'Field notes',
  text: 'This field notebook contains observations recorded during a spring survey. Every observation identifies its location and collection date.',
  elements: [], signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: 'field-notes', observedAt: '2026-11-24T08:00:00.000Z',
};
const io = (extra: Partial<HandsIO> = {}): HandsIO => ({
  page: async () => page, act: async () => page, prepare: async () => null, settle: async value => value,
  step: async () => {}, pause: async () => {}, approve: async () => {}, hold: async () => {}, ...extra,
});

describe('complete browser plan admission', () => {
  it('rejects an oversized plan without recording any prefix of it', () => {
    const run = ledger(), before = structuredClone(run);
    expect(() => recordHandsPlan(run, plan(17), AT + 1)).toThrow(/complete browser plan/);
    expect(run).toEqual(before);
  });

  it('rejects combined capacity overflow atomically after an existing plan has started', () => {
    const run = ledger();
    setPlan(run, { version: 1, steps: Array.from({ length: 15 }, (_, index) => planStep({
      id: `previous-${index}`, capability: 'web.search', outcome: 'Find an observed source', input: null, acceptance: ['Source read'],
    })) }, AT);
    startStep(run, 'previous-0', AT + 1);
    const before = structuredClone(run);
    expect(() => recordHandsPlan(run, plan(), AT + 2)).toThrow(/complete browser plan/);
    expect(run).toEqual(before);
  });

  it('expands site search before registration and retains its answer requirements', () => {
    const task: HandsPlan = { next: 0, lang: 'en', steps: [{ kind: 'search', query: 'field notes',
      site: { url: 'https://archive.test/', name: 'Archive' }, ask: true, reply: { lang: 'en', fields: ['title', 'link'] } }] };
    normalizeHandsPlan(task);
    const normalized = structuredClone(task);
    normalizeHandsPlan(task);
    expect(task).toEqual(normalized);
    expect(task.steps).toEqual([{ kind: 'open', url: 'https://archive.test/', name: 'Archive' }, { kind: 'search', query: 'field notes', site: null,
      here: true, ask: true, reply: { lang: 'en', fields: ['title', 'link'] } }]);
    const run = ledger();
    recordHandsPlan(run, task, AT);
    expect(run.plan?.steps.map(step => step.capability)).toEqual(['browser.open', 'web.search']);
  });

  it('counts normalized expansion against capacity before execution', () => {
    const task = plan(16);
    task.steps[15] = { kind: 'search', query: 'records', site: { url: 'https://archive.test/', name: 'Archive' } };
    const run = ledger(), before = structuredClone(run);
    expect(() => recordHandsPlan(run, task, AT)).toThrow(/complete browser plan/);
    expect(task.steps).toHaveLength(17);
    expect(run).toEqual(before);
  });

  it('restores exactly the same admitted plan and identities without adding steps', () => {
    const run = ledger(), task = plan(), prefix = recordHandsPlan(run, task, AT);
    task.next = 1;
    beginHandsStep(run, task, prefix, 0, AT + 1);
    completeHandsStep(run, task, prefix, 0, 'completed', AT + 2);
    const savedTask: HandsPlan = JSON.parse(JSON.stringify(task));
    const saved = restoreRunLedger(JSON.parse(JSON.stringify(run)), RUN)!;
    expect(recordHandsPlan(saved, savedTask, AT + 3)).toBe(prefix);
    expect(saved.plan?.steps).toHaveLength(2);
    expect(prefix).toMatch(/^h[0-9a-f]{32}-$/);
    expect(saved.plan?.steps[0]?.id).toBe(handsStepId(prefix, 0));
  });

  it('refuses a matching namespace with missing or changed step descriptions', () => {
    for (const tamper of [(run: ReturnType<typeof ledger>) => { run.plan!.steps.pop(); },
      (run: ReturnType<typeof ledger>) => { run.plan!.steps[0]!.input = 'https://another.test/'; }]) {
      const run = ledger(), task = plan();
      recordHandsPlan(run, task, AT);
      tamper(run);
      const before = structuredClone(run);
      expect(() => recordHandsPlan(run, task, AT + 1)).toThrow(/do not match/);
      expect(run).toEqual(before);
    }
  });

  it('keeps identities stable when object keys are reconstructed in a different order', () => {
    const run = ledger(), task = plan(1), prefix = recordHandsPlan(run, task, AT);
    const rebuilt: HandsPlan = { next: 0, steps: [{ name: 'site-0', url: 'https://site-0.test/', kind: 'open' }], lang: 'en' };
    expect(recordHandsPlan(run, rebuilt, AT + 1)).toBe(prefix);
    expect(run.plan?.steps).toHaveLength(1);
  });

  it('gives changed content its own pending steps instead of borrowing a previous receipt', () => {
    const run = ledger(), previous = plan(1), first = recordHandsPlan(run, previous, AT);
    previous.next = 1;
    beginHandsStep(run, previous, first, 0, AT + 1);
    completeHandsStep(run, previous, first, 0, 'completed', AT + 2);
    const current: HandsPlan = { next: 0, lang: 'en', steps: [open('different-site')] };
    const second = recordHandsPlan(run, current, AT + 3);
    expect(second).not.toBe(first);
    expect(run.plan?.steps.map(step => step.state)).toEqual(['verified', 'pending']);
  });

  it('refuses legacy or cursor-only restoration without inventing completion receipts', () => {
    const legacy = ledger();
    setPlan(legacy, { version: 1, steps: [planStep({ id: 'h123abc-1', capability: 'browser.open', outcome: 'Open notes',
      input: null, acceptance: ['Site observed'] })] }, AT);
    expect(() => recordHandsPlan(legacy, plan(1), AT + 1)).toThrow(/reconciliation/);
    const run = ledger(), task = plan();
    recordHandsPlan(run, task, AT);
    task.next = 1;
    expect(() => recordHandsPlan(run, task, AT + 1)).toThrow(/no explicit completion receipt/);
    expect(run.plan?.steps.every(step => step.state === 'pending')).toBe(true);
  });
});

describe('explicit browser step lifecycle', () => {
  it('keeps display labels inside an operation from starting or verifying the following step', async () => {
    const run = ledger();
    const task: HandsPlan = { next: 0, lang: 'en', steps: [open('notes'), { kind: 'read', more: false }] };
    const prefix = recordHandsPlan(run, task, AT), events: string[] = [];
    const runtime = io({
      begin: async index => { beginHandsStep(run, task, prefix, index, AT + index + 1); events.push(`begin:${index}`); },
      complete: async (index, status) => { completeHandsStep(run, task, prefix, index, status, AT + index + 2); events.push(`complete:${index}`); },
      step: async () => { events.push('label'); },
      act: async () => {
        await runtime.step('Reading internal detail one');
        await runtime.step('Reading internal detail two');
        expect(run.plan?.steps.map(step => step.state)).toEqual(['running', 'pending']);
        expect(task.next).toBe(1);
        events.push('effect');
        return page;
      },
    });
    const result = await runHands(task, runtime);
    expect(result.kind).toBe('done');
    expect(events.filter(event => event !== 'label')).toEqual(['begin:0', 'effect', 'complete:0', 'begin:1', 'complete:1']);
    expect(run.plan?.steps.map(step => step.state)).toEqual(['verified', 'verified']);
  });

  it('stops before a tool when its begin callback rejects an unresolved effect', async () => {
    const run = ledger(), task = plan(1), prefix = recordHandsPlan(run, task, AT);
    task.next = 1;
    beginHandsStep(run, task, prefix, 0, AT + 1);
    settleStep(run, handsStepId(prefix, 0), 'unknown', AT + 2);
    task.next = 0;
    let actions = 0;
    await expect(runHands(task, io({
      begin: async index => { beginHandsStep(run, task, prefix, index, AT + 3); },
      act: async () => { actions++; return page; },
    }))).rejects.toThrow(/cannot be replayed/);
    expect(actions).toBe(0);
    expect(run.plan?.steps[0]?.state).toBe('unknown');
  });

  it('does not issue a completion receipt when an operation throws or pauses', async () => {
    for (const paused of [false, true]) {
      const run = ledger(), task = plan(1), prefix = recordHandsPlan(run, task, AT);
      let completions = 0;
      const runtime = io({
        begin: async index => { beginHandsStep(run, task, prefix, index, AT + 1); },
        complete: async () => { completions++; },
        act: async () => { if (!paused) throw new Error('transport outcome unknown'); return page; },
        settle: async () => null,
      });
      if (paused) expect(await runHands(task, runtime)).toEqual({ kind: 'paused' });
      else await expect(runHands(task, runtime)).rejects.toThrow(/outcome unknown/);
      expect(completions).toBe(0);
      settleHandsPart(run, prefix, 'completed', AT + 2);
      expect(run.plan?.steps[0]?.state).toBe('unknown');
      expect(() => recordHandsPlan(run, task, AT + 3)).toThrow(/completion receipt/);
    }
  });

  it('cannot complete an unstarted step or skip a required earlier step', () => {
    const run = ledger(), task = plan(), prefix = recordHandsPlan(run, task, AT);
    task.next = 1;
    expect(() => completeHandsStep(run, task, prefix, 0, 'completed', AT + 1)).toThrow(/running browser step/);
    settleStep(run, handsStepId(prefix, 0), 'skipped', AT + 2);
    task.next = 2;
    expect(() => beginHandsStep(run, task, prefix, 1, AT + 3)).toThrow(/completion receipt/);
    settleHandsPart(run, prefix, 'completed', AT + 4);
    expect(run.plan?.steps.map(step => step.state)).toEqual(['skipped', 'pending']);
  });

  it('records an unanswered page question as partial rather than a verified answer', async () => {
    const run = ledger();
    const task: HandsPlan = { lang: 'en', next: 0, steps: [{ kind: 'ask_page', question: 'What is the main heading and the newest software version?' }] };
    const prefix = recordHandsPlan(run, task, AT);
    await runHands(task, io({
      begin: async index => { beginHandsStep(run, task, prefix, index, AT + 1); },
      complete: async (index, status) => { completeHandsStep(run, task, prefix, index, status, AT + 2); },
    }));
    expect(run.plan?.steps[0]?.state).toBe('failed');
  });

  it('reopens a rejected read only under a bounded repair and preserves its identity and attempts', () => {
    const run = ledger();
    const task: HandsPlan = { next: 0, lang: 'en', steps: [{ kind: 'read', more: false }] };
    const prefix = recordHandsPlan(run, task, AT), id = handsStepId(prefix, 0);
    task.next = 1;
    beginHandsStep(run, task, prefix, 0, AT + 1);
    completeHandsStep(run, task, prefix, 0, 'completed', AT + 2);
    expect(() => reopenHandsReadStep(run, task, prefix, 0, AT + 3)).toThrow(/bounded repair/);
    expect(beginRepair(run, { stepId: id, signature: 'judge:missing-required-field' }, AT + 4).allowed).toBe(true);
    reopenHandsReadStep(run, task, prefix, 0, AT + 5);
    beginHandsStep(run, task, prefix, 0, AT + 6);
    completeHandsStep(run, task, prefix, 0, 'completed', AT + 7);
    expect(run.plan?.steps).toHaveLength(1);
    expect(run.plan?.steps[0]).toMatchObject({ id, state: 'verified', attempts: 2 });
  });

  it('never reopens an unknown step or a write even when repair has been admitted', () => {
    for (const kind of ['unknown_read', 'write'] as const) {
      const run = ledger();
      const task: HandsPlan = { next: 0, lang: 'en', steps: kind === 'write'
        ? [{ kind: 'type', field: 'Notes', text: 'Survey' }] : [{ kind: 'read', more: false }] };
      const prefix = recordHandsPlan(run, task, AT), id = handsStepId(prefix, 0);
      task.next = 1;
      beginHandsStep(run, task, prefix, 0, AT + 1);
      if (kind === 'unknown_read') settleStep(run, id, 'unknown', AT + 2);
      else completeHandsStep(run, task, prefix, 0, 'completed', AT + 2);
      beginRepair(run, { stepId: id, signature: 'judge:incomplete' }, AT + 3);
      expect(() => reopenHandsReadStep(run, task, prefix, 0, AT + 4)).toThrow(/unresolved effects/);
      expect(run.plan?.steps[0]?.state).toBe(kind === 'unknown_read' ? 'unknown' : 'verified');
    }
  });

  it.each([false, true])('does not verify an unfinished form search after approval (ask=%s)', ask => {
    const run = ledger();
    const task: HandsPlan = { next: 0, lang: 'en', steps: [{ kind: 'search', query: 'Cerulean archive opening hours', site: null, here: true, ask }] };
    const prefix = recordHandsPlan(run, task, AT), id = handsStepId(prefix, 0);
    task.next = 1;
    beginHandsStep(run, task, prefix, 0, AT + 1);
    setStepAuthorization(run, id, 'granted', AT + 2);
    const approvalId = 'd1d1c176-7fb8-4d5a-8db8-19e29ef2ed53';
    requestPermission(run, { approvalId, actorId: 'owner', conversationId: 'conversation', runId: RUN, stepId: id, at: AT + 3,
      material: { capability: 'browser.submit', action: 'Search archive', target: 'https://notes.test/search',
        consequence: 'Submit search form', reversible: false, details: { method: 'POST' } } });
    recordDecision(run, { approvalId, actorId: 'owner', conversationId: 'conversation', approved: true, at: AT + 4 });
    consumePermission(run, approvalId, AT + 5);
    completeApprovedHandsStep(run, task, id, AT + 6);
    expect(run.plan?.steps[0]?.state).toBe('failed');
    expect(task.found).toBeUndefined();
    expect(task.results).toBeUndefined();
  });

  it('accepts an observed approval result only for the exact running step and consumed grant', () => {
    const setup = () => {
      const run = ledger();
      const task: HandsPlan = { next: 0, lang: 'en', steps: [{ kind: 'click', target: 'Submit survey', ordinal: null }] };
      const prefix = recordHandsPlan(run, task, AT), id = handsStepId(prefix, 0);
      task.next = 1;
      beginHandsStep(run, task, prefix, 0, AT + 1);
      setStepAuthorization(run, id, 'granted', AT + 2);
      const approvalId = '3d8d3d1f-a8d2-4d2e-b559-5985cc3c963c';
      requestPermission(run, { approvalId, actorId: 'owner', conversationId: 'conversation', runId: RUN, stepId: id, at: AT + 3,
        material: { capability: 'browser.submit', action: 'Submit survey', target: 'https://notes.test/submit',
          consequence: 'Send survey', reversible: false, details: { method: 'POST' } } });
      recordDecision(run, { approvalId, actorId: 'owner', conversationId: 'conversation', approved: true, at: AT + 4 });
      return { run, task, id, approvalId };
    };
    const pending = setup();
    expect(() => completeApprovedHandsStep(pending.run, pending.task, pending.id, AT + 5)).toThrow(/consumed grant/);
    const approved = setup();
    consumePermission(approved.run, approved.approvalId, AT + 5);
    completeApprovedHandsStep(approved.run, approved.task, approved.id, AT + 6);
    expect(approved.run.plan?.steps[0]?.state).toBe('verified');
    const foreign = setup();
    consumePermission(foreign.run, foreign.approvalId, AT + 5);
    expect(() => completeApprovedHandsStep(foreign.run, foreign.task, 'h00000000000000000000000000000000-1', AT + 6)).toThrow(/exact running browser step/);
  });
});
