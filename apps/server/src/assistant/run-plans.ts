import { createHash } from 'node:crypto';
import type { PlanStep, RunPath } from '@mohassan/contracts';
import type { DesktopCommand } from '@mohassan/desktop';
import { RunLedgerError, appendStep, planStep, setPlan, settleStep, startStep, tryEnterPhase, validatePlan, type RunCapability, type RunLedger } from './agent-run.js';
import { normalizeHandsPlan, type HandsPlan, type HandsStep } from './hands.js';
import type { ForbiddenRequestCapability } from './request-constraints.js';
import type { RoutingHandler } from './routing-decision.js';
import type { GateDecision } from './permission-gate.js';

/**
 * Typed plans for the run ledger (agent-run.ts), built from the plans the runtime actually executes: the browser's
 * model-free hands plan, a desktop command, a PDF. Each step names a registered capability, its observable acceptance
 * criteria and how its outcome is checked. Pure: no I/O.
 */

type Lang = 'ar' | 'en';
const say = (lang: Lang, ar: string, en: string) => lang === 'ar' ? ar : en;

const HANDS_CAPABILITY: Record<HandsStep['kind'], RunCapability> = {
  open: 'browser.open', search: 'web.search', click: 'browser.click', type: 'browser.type', read: 'browser.read', scroll: 'browser.scroll',
  back: 'browser.back', news: 'news.read', ask_page: 'browser.read',
};

export const handsStepId = (prefix: string, index: number) => `${prefix}${index + 1}`;

function handsOutcome(step: HandsStep, lang: Lang): { outcome: string; input: string | null; acceptance: string[] } {
  switch (step.kind) {
    case 'open': return { outcome: say(lang, `فتح ${step.name}`, `Open ${step.name}`), input: step.url, acceptance: [say(lang, 'المتصفح يعرض الموقع المطلوب', 'The browser shows the requested site')] };
    case 'search': return step.ask
      ? { outcome: say(lang, `الإجابة عن «${step.query}» من صفحة مقروءة`, `Answer “${step.query}” from a page that was read`), input: step.query,
        acceptance: [say(lang, 'جملة الجواب موجودة في صفحة قُرئت فعلًا', 'The answer sentence is found in a page that was actually read'), say(lang, 'المصدر مذكور مع الجواب', 'The source is cited with the answer')] }
      : { outcome: say(lang, `البحث عن «${step.query}»`, `Search for “${step.query}”`), input: step.query, acceptance: [say(lang, 'نتائج بحث مرتبطة بالطلب', 'Search results related to the request')] };
    case 'click': return { outcome: say(lang, `الضغط على «${step.target}»`, `Click “${step.target}”`), input: step.target, acceptance: [say(lang, 'العنصر موجود في الصفحة وضُغط', 'The element exists on the page and was clicked')] };
    case 'type': return { outcome: say(lang, `كتابة النص في ${step.field || 'الخانة'}`, `Type into ${step.field || 'the field'}`), input: step.field || null, acceptance: [say(lang, 'الخانة تحمل النص المكتوب', 'The field holds the typed text')] };
    case 'read': return { outcome: say(lang, 'قراءة الصفحة', 'Read the page'), input: null, acceptance: [say(lang, 'نص الصفحة الحالية معروض', 'The current page\'s text is shown')] };
    case 'scroll': return { outcome: say(lang, step.up ? 'التمرير للأعلى' : 'التمرير للأسفل', step.up ? 'Scroll up' : 'Scroll down'), input: null, acceptance: [say(lang, 'تغيّر موضع الصفحة', 'The page position changed')] };
    case 'back': return { outcome: say(lang, 'الرجوع للصفحة السابقة', 'Go back'), input: null, acceptance: [say(lang, 'المتصفح على الصفحة السابقة', 'The browser is on the previous page')] };
    case 'news': return { outcome: say(lang, `عناوين ${step.source.name}`, `Headlines from ${step.source.name}`), input: step.source.url, acceptance: [say(lang, 'العناوين من الصفحة المفتوحة نفسها', 'Headlines come from the opened page itself')] };
    case 'ask_page': return { outcome: say(lang, `الإجابة عن «${step.question}» من الصفحة`, `Answer “${step.question}” from the page`), input: step.question, acceptance: [say(lang, 'الجواب مقتبس من نص الصفحة', 'The answer is quoted from the page text')] };
  }
}

/** The hands plan as typed steps, each depending on the one before it, in the order the executor runs them. */
export function planFromHands(plan: HandsPlan, prefix: string): PlanStep[] {
  const lang: Lang = plan.lang ?? 'ar';
  return plan.steps.map((step, index) => {
    const described = handsOutcome(step, lang);
    return planStep({ id: handsStepId(prefix, index), capability: HANDS_CAPABILITY[step.kind], dependsOn: index ? [handsStepId(prefix, index - 1)] : [],
      outcome: described.outcome, input: described.input, acceptance: described.acceptance,
      // A browser click or typing that the page turns into a request waits for the owner at the browser boundary.
      ...(step.kind === 'click' || step.kind === 'type' ? { authorization: 'not_needed' as const } : {}) });
  });
}

/**
 * Records the complete normalized plan atomically. Its 128-bit namespace is stable across persistence and progress;
 * a matching namespace must contain exactly this plan, never just one matching step or a truncated prefix.
 */
export function recordHandsPlan(ledger: RunLedger, plan: HandsPlan, at: number): string {
  normalizeHandsPlan(plan);
  const prefix = handsPlanPrefix(plan);
  const steps = planFromHands(plan, prefix);
  if (ledger.plan?.steps.some(step => step.id.startsWith(prefix))) {
    checkedHandsSteps(ledger, plan, prefix);
    assertPriorHandsSteps(ledger, prefix, plan.next);
    return prefix;
  }
  if (plan.next !== 0 || ledger.plan?.steps.some(step => /^h[0-9a-f]{6}-\d+$/u.test(step.id))) {
    throw new RunLedgerError('RUN_PLAN_INVALID', 'The saved browser plan needs explicit reconciliation before it can resume.');
  }
  const combined = { version: 1 as const, steps: [...(ledger.plan?.steps ?? []), ...steps] };
  const checked = validatePlan(combined);
  if (!checked.ok) throw new RunLedgerError('RUN_PLAN_INVALID', 'The complete browser plan was rejected before execution.', checked.errors);
  // Apply to a clone so even an unexpected append failure leaves the live ledger unchanged.
  const draft = structuredClone(ledger);
  if (!draft.plan) setPlan(draft, { version: 1, steps }, at);
  else for (const step of steps) if (!appendStep(draft, step, at)) {
    throw new RunLedgerError('RUN_PLAN_INVALID', 'The complete browser plan exceeds the run ledger capacity.');
  }
  tryEnterPhase(draft, 'planning', at);
  Object.assign(ledger, draft);
  return prefix;
}

const handsPlanPrefix = (plan: HandsPlan) => {
  const canonical = JSON.stringify([plan.lang ?? 'ar', plan.steps], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return `h${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}-`;
};
const handsDescription = (step: PlanStep) => JSON.stringify({ id: step.id, capability: step.capability, outcome: step.outcome, input: step.input,
  acceptance: step.acceptance, dependsOn: step.dependsOn, required: step.required, risk: step.risk, verification: step.verification });

function checkedHandsSteps(ledger: RunLedger, plan: HandsPlan, prefix: string): PlanStep[] {
  if (prefix !== handsPlanPrefix(plan)) throw new RunLedgerError('RUN_PLAN_INVALID', 'The browser plan changed after admission.');
  const expected = planFromHands(plan, prefix);
  const recorded = ledger.plan?.steps.filter(step => step.id.startsWith(prefix)) ?? [];
  if (expected.length !== recorded.length || expected.some((step, index) => handsDescription(step) !== handsDescription(recorded[index]!))) {
    throw new RunLedgerError('RUN_PLAN_INVALID', 'The recorded browser steps do not match the complete admitted plan.');
  }
  return recorded;
}

function assertPriorHandsSteps(ledger: RunLedger, prefix: string, index: number) {
  for (let earlier = 0; earlier < index; earlier++) {
    if (ledger.plan?.steps.find(step => step.id === handsStepId(prefix, earlier))?.state !== 'verified') {
      throw new RunLedgerError('RUN_STEP_DEPENDENCY', 'A browser step has no explicit completion receipt; reconcile it before continuing.');
    }
  }
}

/** Admit one exact execution, never inferring success from the cursor, labels, or a prior incomplete attempt. */
export function beginHandsStep(ledger: RunLedger, plan: HandsPlan, prefix: string, index: number, at: number) {
  const steps = checkedHandsSteps(ledger, plan, prefix);
  if (!Number.isSafeInteger(index) || index < 0 || index >= steps.length || plan.next !== index + 1) {
    throw new RunLedgerError('RUN_STEP_STATE', 'The browser execution cursor does not match the step being started.');
  }
  assertPriorHandsSteps(ledger, prefix, index);
  const current = steps[index]!;
  if (current.state !== 'pending' && current.state !== 'failed') {
    throw new RunLedgerError('RUN_STEP_STATE', 'A started or unresolved browser step cannot be replayed automatically.');
  }
  startStep(ledger, current.id, at);
  tryEnterPhase(ledger, 'executing', at);
}

/** Compatibility wrapper for callers with a pre-effect cursor; display/progress callbacks must not use it. */
export function advanceHandsStep(ledger: RunLedger, plan: HandsPlan, prefix: string, at: number) {
  const index = plan.next;
  if (index >= plan.steps.length) return;
  beginHandsStep(ledger, { ...plan, next: index + 1 }, prefix, index, at);
}

/** A host completion receipt applies to one started step only, after that exact step returns its result. */
export function completeHandsStep(ledger: RunLedger, plan: HandsPlan, prefix: string, index: number, status: 'completed' | 'partial', at: number) {
  const steps = checkedHandsSteps(ledger, plan, prefix);
  if (!Number.isSafeInteger(index) || index < 0 || index >= steps.length || plan.next !== index + 1) {
    throw new RunLedgerError('RUN_STEP_STATE', 'The browser completion receipt does not match the execution cursor.');
  }
  assertPriorHandsSteps(ledger, prefix, index);
  const step = steps[index]!;
  if (step.state !== 'running') throw new RunLedgerError('RUN_STEP_STATE', 'Only the exact running browser step can receive a completion receipt.');
  settleStep(ledger, step.id, status === 'completed' ? 'verified' : 'failed', at);
}

/** A later host judgment can reject a read without granting permission for another attempt. */
export function rejectHandsReadResult(ledger: RunLedger, plan: HandsPlan, prefix: string, index: number, at: number) {
  const steps = checkedHandsSteps(ledger, plan, prefix);
  const step = steps[index], operation = plan.steps[index];
  if (!step || !operation || !['search', 'ask_page', 'read'].includes(operation.kind) || step.risk !== 'read'
    || !['verified', 'failed', 'running'].includes(step.state)) {
    throw new RunLedgerError('RUN_STEP_STATE', 'Only an observed read result may be rejected by the host judge.');
  }
  if (step.state === 'failed') return;
  // Finding text was an observation; the later host judge can still reject its relevance to the requested answer.
  step.state = 'failed';
  ledger.sequence = Math.min(1_000_000, ledger.sequence + 1);
  ledger.updatedAt = new Date(at).toISOString();
}

/** Reopen only a read whose answer the host rejected under an already-admitted bounded repair. */
export function reopenHandsReadStep(ledger: RunLedger, plan: HandsPlan, prefix: string, index: number, at: number) {
  const steps = checkedHandsSteps(ledger, plan, prefix);
  const step = steps[index], operation = plan.steps[index];
  if (!Number.isSafeInteger(index) || !step || !operation || !['search', 'ask_page', 'read'].includes(operation.kind)
    || step.risk !== 'read' || ledger.phase !== 'repairing' || ledger.repairs.used < 1
    || !ledger.failures.some(failure => failure.stepId === step.id)
    || !['verified', 'failed'].includes(step.state)) {
    throw new RunLedgerError('RUN_STEP_STATE', 'Only a rejected read with a bounded repair may be reopened; unresolved effects cannot be replayed.');
  }
  assertPriorHandsSteps(ledger, prefix, index);
  // A judge has rejected this read's answer. It is no longer a valid completion receipt, while its attempt count stays.
  step.state = 'failed';
  ledger.sequence = Math.min(1_000_000, ledger.sequence + 1);
  ledger.updatedAt = new Date(at).toISOString();
}

/** The host calls this only after observing the return of the exact action admitted by its consumed permission. */
export function completeApprovedHandsStep(ledger: RunLedger, plan: HandsPlan | null | undefined, stepId: string | null | undefined, at: number) {
  if (!plan || !stepId || !/^h[0-9a-f]{32}-\d+$/u.test(stepId)) return;
  const prefix = handsPlanPrefix(plan), steps = checkedHandsSteps(ledger, plan, prefix);
  const index = steps.findIndex(step => step.id === stepId), step = steps[index];
  const consumed = ledger.permissions.findLast(permission => permission.stepId === stepId && permission.runId === ledger.runId && permission.decision === 'consumed');
  if (!step || index !== plan.next - 1 || step.state !== 'running' || step.authorization !== 'granted' || !consumed) {
    throw new RunLedgerError('RUN_STEP_STATE', 'The observed approval result does not match the exact running browser step and consumed grant.');
  }
  // Returning from an approved dispatch proves only that dispatch. A search/news/read
  // may still need extraction or source reading after its form submits; the advanced
  // cursor must not turn that unfinished work into an answer receipt.
  const primitive = ['open', 'click', 'type', 'scroll', 'back'].includes(plan.steps[index]!.kind);
  completeHandsStep(ledger, plan, prefix, index, primitive ? 'completed' : 'partial', at);
}

/** Finishing a part cannot substitute for a missing execution receipt or turn unexecuted work into success. */
export function settleHandsPart(ledger: RunLedger, prefix: string, _status: 'completed' | 'partial' | 'blocked', at: number) {
  for (const step of ledger.plan?.steps ?? []) {
    if (!step.id.startsWith(prefix)) continue;
    if (step.state === 'running') settleStep(ledger, step.id, 'unknown', at);
  }
}

const MODEL_TOOL_CAPABILITY: Record<string, RunCapability> = {
  search: 'web.search', open: 'browser.open', click: 'browser.click', select: 'browser.click', press: 'browser.click', type: 'browser.type',
  scroll: 'browser.scroll', back: 'browser.back', wait: 'browser.read', look: 'browser.read', read_more: 'browser.read',
  memory_search: 'memory.read', memory_save: 'memory.write', workspace_list: 'desktop.read', code_change: 'runtime.task', studio_change: 'runtime.task',
  run_skill: 'runtime.task', load_skill: 'skill.read', computer_view: 'computer.view', computer_click: 'computer.input', computer_type: 'computer.input',
  computer_key: 'computer.input', request_login: 'conversation.ask', hands_on: 'conversation.ask',
};
/**
 * One step a model decision chose, appended to the run's plan as information (not required): the step before it settles
 * by its own trail result. Tools outside the table are recorded as `model.decision`; the decision schema already refused
 * any tool the model was not offered.
 */
export function recordModelStep(ledger: RunLedger, tool: string, label: string, lastResult: string, at: number) {
  const steps = ledger.plan?.steps ?? [];
  for (const step of steps) if (step.id.startsWith('m') && step.state === 'running') settleStep(ledger, step.id, /^failed\b/u.test(lastResult) ? 'failed' : 'verified', at);
  const id = `m${steps.filter(step => step.id.startsWith('m')).length + 1}`;
  if (appendStep(ledger, planStep({ id, capability: MODEL_TOOL_CAPABILITY[tool] ?? 'model.decision', outcome: label || tool, input: null, required: false,
    acceptance: ['The host observed the tool\'s result'] }), at)) startStep(ledger, id, at);
  tryEnterPhase(ledger, 'executing', at);
}

const DESKTOP_READS = new Set(['file_read', 'file_list', 'file_search', 'project_list', 'window_list', 'system_info', 'clipboard_read', 'screenshot']);
const DESKTOP_RUNS = new Set(['shell', 'app_launch', 'open', 'type', 'keys', 'click_element', 'click_point', 'window_close']);
export const desktopCapability = (command: DesktopCommand): RunCapability => command.kind === 'file_delete' ? 'desktop.delete'
  : DESKTOP_RUNS.has(command.kind) ? 'desktop.run' : DESKTOP_READS.has(command.kind) ? 'desktop.read' : 'desktop.write';

/**
 * One desktop command as one step. Only the desktop engine reports its result, so the check is its report, labelled as
 * such. The engine's own classifier decides which commands wait for the owner (deleting, dangerous shell commands,
 * typing into an open file); when it asks, the approval card raises this step's authorization to required.
 */
export function desktopPlanStep(command: DesktopCommand, label: string, lang: Lang): PlanStep {
  const capability = desktopCapability(command);
  return planStep({ id: 'desktop', capability, outcome: label, input: null,
    acceptance: [say(lang, 'محرك سطح المكتب أبلغ بنجاح الأمر', 'The desktop engine reported the command succeeded')],
    verification: 'adapter_report', risk: capability === 'desktop.read' ? 'read' : 'reversible_write', authorization: 'not_needed' });
}

/** A PDF made or edited from the owner's words: done only when the stored file is read back and is the same PDF. */
export function documentPlanStep(kind: 'create' | 'edit', lang: Lang, name: string | null): PlanStep {
  return planStep({ id: `document-${kind}`, capability: kind === 'create' ? 'document.create' : 'document.edit',
    outcome: kind === 'create' ? say(lang, 'إنشاء ملف PDF', 'Create the PDF') : say(lang, 'تعديل ملف PDF', 'Edit the PDF'), input: name,
    acceptance: [say(lang, 'الملف محفوظ ويُقرأ من التخزين', 'The file is stored and reads back from storage'), say(lang, 'المقروء ملف PDF بالحجم والبصمة نفسيهما', 'What reads back is a PDF with the same size and hash')] });
}

/**
 * The readback check of a stored PDF: the bytes read back from storage are a PDF, of the recorded size and hash, and the
 * stored record names the same file. A create call that returned success is not enough without this.
 */
export function verifyStoredPdf(stored: { id: string; size: number; hash: string; pages: number }, readback: { bytes: Buffer; document: { id: string; pages: number } } | null): { ok: boolean; problems: string[] } {
  if (!readback) return { ok: false, problems: ['not_readable'] };
  const problems: string[] = [];
  if (readback.document.id !== stored.id) problems.push('other_file');
  if (readback.bytes.byteLength !== stored.size) problems.push('size_mismatch');
  if (readback.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') problems.push('not_pdf');
  if (!/%%EOF\s*$/u.test(readback.bytes.subarray(Math.max(0, readback.bytes.byteLength - 64)).toString('latin1'))) problems.push('truncated');
  if (createHash('sha256').update(readback.bytes).digest('hex') !== stored.hash) problems.push('hash_mismatch');
  if (stored.pages < 1 || readback.document.pages !== stored.pages) problems.push('pages_mismatch');
  return { ok: !problems.length, problems };
}

/** Handlers that answer from the request and local knowledge, with no external action. */
const DIRECT_HANDLERS: ReadonlySet<RoutingHandler> = new Set(['local_conversation', 'local_computation', 'local_coding', 'local_status']);
export const pathOfHandler = (handler: RoutingHandler | undefined): RunPath | null => !handler || handler === 'clarify' || handler === 'resume' ? null
  : DIRECT_HANDLERS.has(handler) ? 'direct' : 'action';

/** Trail actions that are tool use (search, pages, memory, computer, desktop, files): a run with none answered directly. */
export const TOOL_ACTION = /^(?:search|read|open|click|type|select|press|scroll|back|wait|look|read_more|memory_|knowledge|computer_|desktop|document_|skill_read|code_change|studio_change|run_skill|browser_recovery|user_note_verify|memory_verify|user_fact_memory|local_computer_view)/u;

/** The request capability that must not be forbidden by the owner's own words for this action to run. */
export function platformCapabilityOf(capability: RunCapability): ForbiddenRequestCapability | null {
  if (capability.startsWith('browser.')) return capability === 'browser.open' || capability === 'browser.back' ? 'browser_navigation' : 'browser_action';
  if (capability === 'computer.view' || capability === 'desktop.read') return 'computer_read';
  if (capability.startsWith('computer.') || capability.startsWith('desktop.')) return 'computer_action';
  if (capability === 'memory.write') return 'memory_write';
  if (capability === 'memory.read') return 'memory_read';
  return null;
}

/** What the owner reads when the gate stops an action that was waiting for approval. */
export function gateRefusalText(reason: Extract<GateDecision, { decision: 'deny' | 'ask' }>['reason'], lang: Lang): string {
  switch (reason) {
    case 'approval_mismatch': return say(lang, 'تغيّرت تفاصيل الإجراء بعد موافقتك، فالموافقة لا تغطيه. لم أنفّذه؛ اطلبه من جديد لأعرضه عليك بتفاصيله الحالية.',
      'The action\'s details changed after your approval, so the approval does not cover it. I did not carry it out; ask again and I will show it with its current details.');
    case 'owner_refused': return say(lang, 'رفضت هذا الإجراء من قبل في هذه المهمة، فلم أنفّذه ولم أطلبه مرة أخرى.', 'You refused this action earlier in this task, so I did not carry it out or ask again.');
    case 'approval_expired': return say(lang, 'انتهت صلاحية الموافقة قبل التنفيذ. لم أنفّذ الإجراء؛ اطلبه من جديد.', 'The approval expired before the action ran. I did not carry it out; ask again.');
    case 'actor_not_allowed': return say(lang, 'هذا الإجراء غير متاح لحسابك، فلم أنفّذه.', 'This action is not available to your account, so I did not carry it out.');
    case 'platform_restricted': return say(lang, 'طلبك نفسه يمنع هذا الإجراء، فلم أنفّذه.', 'Your own request forbids this action, so I did not carry it out.');
    case 'capability_unregistered': case 'invalid_arguments': return say(lang, 'لم أتحقق من أن الإجراء المعلّق أداة مسجلة بمدخلات صالحة، فلم أنفّذه.', 'I could not verify that the pending action is a registered tool with valid inputs, so I did not carry it out.');
    case 'awaiting_decision': case 'approval_required': case 'grant_consumed': return say(lang, 'لا توجد موافقة صالحة تغطي هذا الإجراء الآن، فلم أنفّذه. اطلبه من جديد لأعرض عليك تفاصيله.',
      'No valid approval covers this action now, so I did not carry it out. Ask again and I will show you its details.');
  }
}
