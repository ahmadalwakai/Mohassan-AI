import type { EvidenceKind } from '@mohassan/contracts';
import { RunLedgerError, enterPhase, settleStep, startStep, type RunLedger } from '../agent-run.js';
import { admitCompiledPlan, recordPlanResult } from './ledger.js';
import { resolveStepInputs } from './references.js';
import type { CompiledPlan, PlanStep, PlanTool, PlanValue, ResolvedStepInputs } from './types.js';

type RetryStrategy = 'another_source' | 'narrower_query';
export interface PlanAttempt {
  number: number;
  strategy: 'initial' | RetryStrategy;
  signal?: AbortSignal;
}

export type PlanFailureReason =
  | 'tool_error' | 'no_result' | 'invalid_result' | 'missing_input' | 'unavailable' | 'restricted' | 'unknown_effect';

export interface PlanToolEvidence {
  kind: EvidenceKind;
  label: string;
  reference?: string;
  independent?: boolean;
}

export type PlanToolResult =
  | { ok: true; value: PlanValue; text?: string; evidence?: PlanToolEvidence }
  | { ok: false; reason?: PlanFailureReason; text?: string; question?: string; evidence?: PlanToolEvidence };

export type RunPlanTool = (step: PlanStep, input: ResolvedStepInputs, attempt: PlanAttempt) => Promise<PlanToolResult>;

export type StepOutcome =
  | { stepId: string; status: 'succeeded'; attempts: number; value: PlanValue; text: string }
  | { stepId: string; status: 'failed'; attempts: number; reason: PlanFailureReason; text?: string; question?: string }
  | { stepId: string; status: 'skipped'; attempts: 0; blockedBy: string[] };

export interface PlanExecutionResult {
  status: 'completed' | 'partial' | 'blocked';
  steps: StepOutcome[];
  text: string;
  question: string | null;
}

export interface PlanExecutionOptions {
  ledger: RunLedger;
  runTool: RunPlanTool;
  /** The host fences and persists the ledger here. Checkpoints never overlap. */
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  isInterruption?: (error: unknown) => boolean;
}

type LocalizedText = readonly [en: string, ar: string];
interface RecoveryPolicy {
  retries: readonly [] | readonly [RetryStrategy] | readonly [RetryStrategy, RetryStrategy];
  /** A focused prompt after the tool's recovery options are exhausted. */
  question?: LocalizedText;
}

const RECOVERY: Record<PlanTool, RecoveryPolicy> = {
  compute: { retries: [], question: ['What expression or numbers should I use for step {n}?', 'ما العملية أو الأرقام التي أستخدمها في الخطوة {n}؟'] },
  search: { retries: ['another_source', 'narrower_query'], question: ['Which source or search term should I use for step {n}?', 'ما المصدر أو عبارة البحث التي أستخدمها في الخطوة {n}؟'] },
  read: { retries: ['another_source'], question: ['What public page URL should I read for step {n}?', 'ما رابط الصفحة العامة التي أقرؤها في الخطوة {n}؟'] },
  remember: { retries: [], question: ['What exact text should I save for step {n}?', 'ما النص الذي تريد حفظه في الخطوة {n}؟'] },
  recall: { retries: ['narrower_query'], question: ['Which saved detail should I look for in step {n}?', 'عمّ أبحث في الذاكرة في الخطوة {n}؟'] },
  pdf: { retries: [], question: ['What content should the PDF in step {n} contain?', 'ما المحتوى الذي تريد وضعه في ملف PDF في الخطوة {n}؟'] },
  letter: { retries: [], question: ['Who is the recipient and what is the purpose of the letter in step {n}?', 'لمن الرسالة وما غرضها في الخطوة {n}؟'] },
  site: { retries: [], question: ['What should the site in step {n} contain?', 'ما الذي تريد وضعه في الموقع في الخطوة {n}؟'] },
  compare: { retries: [], question: ['Which items or figures should I compare in step {n}?', 'ما العناصر أو الأرقام التي أقارنها في الخطوة {n}؟'] },
  unsupported: { retries: [] },
};

const WRITES = new Set<PlanTool>(['remember', 'pdf', 'site']);
const RETRYABLE = new Set<PlanFailureReason>(['tool_error', 'no_result', 'invalid_result']);
const ASKABLE = new Set<PlanFailureReason>(['missing_input', 'tool_error', 'no_result', 'invalid_result']);
const REASONS: Record<PlanFailureReason, LocalizedText> = {
  tool_error: ['The tool could not complete this step.', 'تعذَّر إكمال هذه الخطوة بالأداة.'],
  no_result: ['The tool found no usable result.', 'لم تجد الأداة نتيجة قابلة للاستخدام.'],
  invalid_result: ['The result failed the step’s check.', 'لم تجتز النتيجة فحص هذه الخطوة.'],
  missing_input: ['A required input is missing.', 'أحد المدخلات المطلوبة مفقود.'],
  unavailable: ['This tool is unavailable for the step.', 'الأداة غير متاحة لهذه الخطوة.'],
  restricted: ['The step is restricted by the request, account, or data source.', 'هذه الخطوة مقيّدة بحسب الطلب أو الحساب أو مصدر البيانات.'],
  unknown_effect: ['The tool may have changed something. The outcome is unverified.', 'ربما أجرت الأداة تغييرًا. لم تُتحقّق النتيجة.'],
};

function matchesOutput(value: PlanValue, expected: PlanStep['success']): boolean {
  if (!value || value.type !== expected) return false;
  switch (value.type) {
    case 'number': return Number.isFinite(value.value);
    case 'list': return Array.isArray(value.value) && value.value.length > 0
      && value.value.every(item => typeof item === 'string' && item.trim().length > 0);
    case 'text': case 'file': case 'entity': return typeof value.value === 'string' && value.value.trim().length > 0;
  }
}

function renderValue(value: PlanValue): string {
  switch (value.type) {
    case 'number': return [value.value, value.unit].filter(part => part !== undefined).join(' ');
    case 'list': return value.value.map(item => `- ${item}`).join('\n');
    case 'file': return value.label ? `[${value.label}](${value.value})` : value.value;
    case 'entity': return value.label || value.value;
    case 'text': return value.value;
  }
}

function summarize(plan: CompiledPlan, steps: StepOutcome[], ledger: RunLedger): PlanExecutionResult {
  const localized = (text: LocalizedText) => text[plan.lang === 'ar' ? 1 : 0];
  let question: string | null = null;
  const paragraphs = steps.map((outcome, index) => {
    const step = plan.steps[index]!;
    const label = ledger.plan?.steps.find(item => item.id === step.id)?.outcome ?? step.tool;
    const header = `${index + 1}. ${label}`;
    if (outcome.status === 'succeeded') {
      return `${header} — ${localized(['Completed', 'تم'])}\n${outcome.text}`;
    }
    if (outcome.status === 'skipped') {
      return `${header} — ${localized(['Skipped because a required step did not succeed.', 'لم تُنفَّذ لأن خطوةً تعتمد عليها لم تنجح.'])}`;
    }
    if (!question && ASKABLE.has(outcome.reason)) {
      const fallback = RECOVERY[step.tool].question;
      question = outcome.question?.trim() || (fallback ? localized(fallback).replace('{n}', String(index + 1)) : null);
    }
    const detail = outcome.text?.trim();
    return `${header} — ${localized(REASONS[outcome.reason])}${detail ? `\n${detail}` : ''}`;
  });
  const succeeded = steps.filter(step => step.status === 'succeeded').length;
  return {
    status: succeeded === steps.length ? 'completed' : succeeded > 0 ? 'partial' : 'blocked',
    steps,
    text: [...paragraphs, ...(question ? [question] : [])].join('\n\n'),
    question,
  };
}

/** Executes one admitted graph. Values live in this invocation only and flow along declared dependencies. */
export async function executePlan(plan: CompiledPlan, options: PlanExecutionOptions): Promise<PlanExecutionResult> {
  const { ledger, runTool, signal, isInterruption } = options;
  const now = options.now ?? Date.now;
  const values = new Map<string, PlanValue>();
  const outcomes = new Map<string, StepOutcome>();
  let interruption: { error: unknown } | undefined;
  let checkpointTail = Promise.resolve();
  const assertRunning = () => {
    signal?.throwIfAborted();
    if (interruption) throw interruption.error;
  };
  const checkpoint = () => {
    checkpointTail = checkpointTail.then(async () => {
      assertRunning();
      await options.checkpoint?.();
      assertRunning();
    });
    return checkpointTail;
  };

  assertRunning();
  admitCompiledPlan(ledger, plan, now());
  await checkpoint();
  enterPhase(ledger, 'executing', now());

  const record = async (outcome: StepOutcome, evidence?: PlanToolEvidence) => {
    assertRunning();
    recordPlanResult(ledger, outcome, plan.lang, evidence, now());
    outcomes.set(outcome.stepId, outcome);
    if (outcome.status === 'succeeded') values.set(outcome.stepId, outcome.value);
    await checkpoint();
  };

  const runStep = async (step: PlanStep) => {
    const blockedBy = step.dependsOn.filter(id => outcomes.get(id)?.status !== 'succeeded');
    if (blockedBy.length) {
      await record({ stepId: step.id, status: 'skipped', attempts: 0, blockedBy });
      return;
    }
    const failedBeforeDispatch = async (reason: PlanFailureReason) => {
      await record({ stepId: step.id, status: 'failed', attempts: 0, reason });
    };
    if ((step.tool === 'search' || step.tool === 'read') && !step.publicInput) {
      await failedBeforeDispatch('restricted');
      return;
    }
    const input = resolveStepInputs(step, values);
    if (!input) {
      await failedBeforeDispatch('missing_input');
      return;
    }
    if (step.tool === 'unsupported') {
      await failedBeforeDispatch('unavailable');
      return;
    }

    const strategies = ['initial', ...RECOVERY[step.tool].retries] as const;
    for (const [index, strategy] of strategies.entries()) {
      assertRunning();
      const attempt = startStep(ledger, step.id, now()).attempts;
      await checkpoint();
      assertRunning();
      let result: PlanToolResult;
      try {
        result = await runTool(step, input, { number: attempt, strategy, signal });
      } catch (error) {
        if (isInterruption?.(error)) interruption = { error };
        assertRunning();
        result = { ok: false, reason: WRITES.has(step.tool) ? 'unknown_effect' : 'tool_error' };
      }
      assertRunning();
      if (result?.ok === true && matchesOutput(result.value, step.success)) {
        await record({ stepId: step.id, status: 'succeeded', attempts: attempt, value: result.value,
          text: result.text?.trim() || renderValue(result.value) }, result.evidence);
        return;
      }
      const failure = result?.ok === false ? result : undefined;
      const reason = failure?.reason ?? (result?.ok === true
        ? WRITES.has(step.tool) ? 'unknown_effect' : 'invalid_result'
        : 'tool_error');
      if (index + 1 < strategies.length && RETRYABLE.has(reason)) {
        settleStep(ledger, step.id, 'failed', now());
        await checkpoint();
        continue;
      }
      await record({ stepId: step.id, status: 'failed', attempts: attempt, reason,
        text: failure?.text, question: failure?.question }, failure?.evidence);
      return;
    }
  };

  let pending = [...plan.steps];
  while (pending.length) {
    assertRunning();
    const ready = pending.filter(step => step.dependsOn.every(id => outcomes.has(id)));
    if (!ready.length) throw new RunLedgerError('RUN_PLAN_INVALID', 'The compiled plan has no runnable step.');
    pending = pending.filter(step => !ready.includes(step));
    // The ledger and the host's lease updates are serialized, while independent tool calls may overlap.
    const settled = await Promise.allSettled(ready.map(runStep));
    for (const item of settled) if (item.status === 'rejected') throw item.reason;
  }
  assertRunning();
  return summarize(plan, plan.steps.map(step => outcomes.get(step.id)!), ledger);
}
