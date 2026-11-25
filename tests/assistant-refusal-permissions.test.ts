import type { AgentPage } from '@mohassan/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunLedger } from '../apps/server/src/assistant/agent-run.js';
import { runHands, type HandsIO, type HandsPlan, type HandsStep } from '../apps/server/src/assistant/hands.js';
import { checkPermission, pendingActionMaterial, recordDecision, requestPermission } from '../apps/server/src/assistant/permission-gate.js';
import { reviewHandsRefusal, reviewPendingRefusal } from '../apps/server/src/assistant/refusal/permissions.js';
import { recordHandsPlan } from '../apps/server/src/assistant/run-plans.js';

const runId = '8440d351-6720-42dc-a600-80f12218b37b';
const approvalId = 'cc91b47d-5033-4be0-b5f7-49209340a089';
const scope = { actorId: 'owner', conversationId: 'conversation', runId };
const now = Date.parse('2026-11-25T09:30:00Z');
const checkout = { kind: 'open', url: 'https://shop.example/checkout', name: 'Checkout' } as const;
const permitFor = (path: string) => ({ id: 'permit', url: `https://shop.example${path}`, method: 'POST' as const, bodyHash: 'b'.repeat(64),
  pageHash: 'c'.repeat(64), actionHash: 'd'.repeat(64), expiresAt: now + 1000 });

const page: AgentPage = {
  id: 'checkout', url: checkout.url, title: 'Checkout', text: 'Delivery information',
  elements: [{ ref: 'message', role: 'textbox', label: 'Message', inViewport: true }],
  signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 },
  hash: 'checkout', observedAt: new Date(now).toISOString(),
};

const observedTools = () => ({
  page: vi.fn(async () => page), act: vi.fn(async () => page), prepare: vi.fn<HandsIO['prepare']>(async () => null),
  settle: vi.fn(async () => page), search: vi.fn(async () => []), read: vi.fn(async () => ({ kind: 'unreadable' } as const)),
  begin: vi.fn(async () => {}), complete: vi.fn(async () => {}), step: vi.fn(async () => {}),
  approve: vi.fn(async () => {}), hold: vi.fn(async () => {}),
}) satisfies HandsIO;

afterEach(() => vi.unstubAllEnvs());

describe('refusal policy plan permissions', () => {
  it.each([
    { step: { kind: 'click', target: 'Confirm payment', ordinal: null }, code: 'payment', lang: 'en' },
    { step: { kind: 'type', field: 'رمز التحقق', text: 'sample' }, code: 'secrets', lang: 'ar' },
    { step: { kind: 'click', target: "I'm not a robot", ordinal: null }, code: 'human_step', lang: 'en' },
  ] satisfies { step: HandsStep; code: string; lang: 'en' | 'ar' }[])('vetoes a multi-step plan with a $code tail before any tool or plan write', async ({ step, code, lang }) => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    const plan: HandsPlan = { steps: [checkout, step], next: 0, lang };
    const run = createRunLedger({ runId, at: now }), before = structuredClone(run);
    const io = observedTools();

    expect(reviewHandsRefusal(plan.steps)).toMatchObject({ code });
    expect(() => recordHandsPlan(run, plan, now)).toThrow(/complete browser plan/);
    expect(run).toEqual(before);
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'blocked', text: lang === 'ar' ? /لا أستطيع/u : /can't/u });
    expect(plan.next).toBe(0);
    for (const tool of Object.values(io)) expect(tool).toHaveBeenCalledTimes(0);
  });

  it('blocks credentials in navigation parameters but allows looking up protective guidance and drafting ordinary text', async () => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    expect(reviewHandsRefusal([{ ...checkout, url: `${checkout.url}?one_time_code=sample` }])).toMatchObject({ code: 'secrets' });
    expect(reviewHandsRefusal([{ kind: 'search', query: 'how password theft happens and how to protect against it', site: null }])).toBeNull();
    const plan: HandsPlan = { steps: [checkout, { kind: 'type', field: 'Message', text: 'How do passwords get stolen?' }], next: 0, lang: 'en' };
    const io = observedTools();
    expect(await runHands(plan, io)).toMatchObject({ status: 'completed' });
    expect(io.act).toHaveBeenCalledWith({ kind: 'type', ref: 'message', text: 'How do passwords get stolen?' });
  });

  it('rechecks the actual matched browser control before sends or clicks', async () => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    const io = observedTools();
    io.page.mockResolvedValue({ ...page, elements: [{ ref: 'password', role: 'textbox', label: 'Password', inViewport: true }] });
    const plan: HandsPlan = { steps: [{ kind: 'type', field: '', text: 'sample' }], next: 0, lang: 'en' };
    expect(reviewHandsRefusal(plan.steps)).toBeNull();
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'blocked', text: /passwords/u });
    expect(io.act).toHaveBeenCalledTimes(0);
    expect(io.prepare).toHaveBeenCalledTimes(0);
  });

  it('stops after a harmless-looking control reveals a payment destination without asking for approval', async () => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    const io = observedTools();
    io.page.mockResolvedValue({ ...page, elements: [{ ref: 'continue', role: 'button', label: 'Continue', inViewport: true }] });
    io.prepare.mockResolvedValue(permitFor('/checkout/confirm'));
    const plan: HandsPlan = { steps: [{ kind: 'click', target: 'Continue', ordinal: null }], next: 0, lang: 'en' };
    expect(reviewHandsRefusal(plan.steps)).toBeNull();
    expect(await runHands(plan, io)).toMatchObject({ kind: 'done', status: 'blocked', text: /review the details/u });
    expect(io.prepare).toHaveBeenCalledTimes(1);
    expect(io.approve).toHaveBeenCalledTimes(0);
    expect(io.act).toHaveBeenCalledTimes(0);
  });

  it.each([
    { path: '/checkout/confirm', allowed: false },
    { path: '/checkout/shipping', allowed: true },
  ])('rechecks a recorded grant for $path before dispatch', ({ path, allowed }) => {
    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', undefined);
    const state = { pendingAction: { action: { kind: 'click' as const, ref: 'button' }, label: 'Continue', permit: permitFor(path) } };
    const material = pendingActionMaterial(state)!.material;
    const run = createRunLedger({ runId, at: now });
    requestPermission(run, { ...scope, material, approvalId, at: now });
    recordDecision(run, { ...scope, approvalId, approved: true, at: now + 1 });
    const check = () => checkPermission(run, { ...scope, material, approvalId, actorAllowed: true, platformAllowed: true, at: now + 2 });
    expect(check().decision).toBe('allow');

    vi.stubEnv('MOHASSAN_REFUSAL_POLICY', '1');
    const dispatch = vi.fn();
    const checked = check();
    if (checked.decision === 'allow') dispatch();
    expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(checked.reason).toBe(allowed ? 'granted' : 'platform_restricted');
    expect(reviewPendingRefusal(state)).toEqual(allowed ? null : { code: 'payment', alternative: 'review_payment' });
  });

  it('vetoes a pending native payment control even when an ordinary browser action is also present', () => {
    expect(reviewPendingRefusal({
      pendingAction: { action: { kind: 'click', ref: 'browser' }, label: 'Continue', permit: permitFor('/checkout/shipping') },
      pendingComputer: { step: { kind: 'click', name: 'ادفع الآن', type: 'button' }, label: 'ادفع الآن' },
    })).toMatchObject({ code: 'payment' });
  });
});
