import { createHmac, randomBytes } from 'node:crypto';
import {
  RunLedgerError, addEvidence, canEnterPhase, enterPhase, planStep, setPlan, settleStep,
  type RunCapability, type RunLedger,
} from '../agent-run.js';
import type { PlanToolEvidence, StepOutcome } from './executor.js';
import type { CompiledPlan, PlanTool, PlanValue } from './types.js';

type LocalizedText = readonly [en: string, ar: string];
type Lang = CompiledPlan['lang'];
const say = (lang: Lang, words: LocalizedText) => words[lang === 'ar' ? 1 : 0];
// Result receipts are opaque even for a guessable private value. The key is
// process-local because a stopped run cannot automatically replay this plan.
const receiptKey = randomBytes(32);

const TOOLS: Record<PlanTool, { capability: RunCapability; title: LocalizedText }> = {
  compute: { capability: 'local.computation', title: ['Calculate', 'الحساب'] },
  search: { capability: 'web.search', title: ['Search the web', 'البحث في الويب'] },
  read: { capability: 'web.read', title: ['Read the page', 'قراءة الصفحة'] },
  remember: { capability: 'memory.write', title: ['Save to memory', 'الحفظ في الذاكرة'] },
  recall: { capability: 'memory.read', title: ['Recall from memory', 'الاسترجاع من الذاكرة'] },
  pdf: { capability: 'document.create', title: ['Create the PDF', 'إنشاء ملف PDF'] },
  letter: { capability: 'conversation.compose', title: ['Draft the letter', 'صياغة الرسالة'] },
  site: { capability: 'site.build', title: ['Build the site', 'بناء الموقع'] },
  compare: { capability: 'conversation.compose', title: ['Compare the results', 'مقارنة النتائج'] },
  unsupported: { capability: 'conversation.ask', title: ['Additional request', 'الطلب الإضافي'] },
};

const OUTPUTS: Record<PlanValue['type'], LocalizedText> = {
  number: ['A finite number', 'عدد محدود القيمة'],
  text: ['Nonempty text', 'نص غير فارغ'],
  list: ['A list with at least one item', 'قائمة فيها عنصر واحد على الأقل'],
  file: ['A file reference', 'مرجع الملف'],
  entity: ['An identified entity', 'كيان معروف'],
};

/** Admit the whole graph before a tool starts, using the same validation as other ledger plans. */
export function admitCompiledPlan(ledger: RunLedger, plan: CompiledPlan, at: number): void {
  if (ledger.plan || plan.steps.length < 2 || !(ledger.phase === 'received' || canEnterPhase(ledger.phase, 'planning'))) {
    throw new RunLedgerError('RUN_PLAN_INVALID', 'A compiled plan needs a fresh, eligible run and at least two steps.');
  }
  const steps = plan.steps.map(step => {
    const tool = TOOLS[step.tool];
    if (!tool || step.output !== step.success || !OUTPUTS[step.success]
      || step.inputs.references.some(reference => !step.dependsOn.includes(reference.stepId))) {
      throw new RunLedgerError('RUN_PLAN_INVALID', 'A compiled step has an invalid tool, check, or reference.');
    }
    return planStep({ id: step.id, capability: tool.capability, dependsOn: [...step.dependsOn],
      outcome: say(plan.lang, tool.title), input: null, acceptance: [say(plan.lang, OUTPUTS[step.success])] });
  });
  setPlan(ledger, { version: 1, steps }, at);
  ledger.path = 'action';
  if (ledger.phase === 'received') enterPhase(ledger, 'understanding', at);
  enterPhase(ledger, 'planning', at);
}

/** Record the checked result for this step without copying private payloads or raw exceptions into the ledger. */
export function recordPlanResult(ledger: RunLedger, outcome: StepOutcome, lang: Lang, evidence: PlanToolEvidence | undefined, at: number): void {
  const state = outcome.status === 'succeeded' ? 'verified' : outcome.status === 'skipped' ? 'skipped'
    : outcome.reason === 'unknown_effect' ? 'unknown' : 'failed';
  settleStep(ledger, outcome.stepId, state, at);
  const label = outcome.status === 'succeeded' ? say(lang, OUTPUTS[outcome.value.type])
    : outcome.status === 'skipped' ? say(lang, ['A required step did not succeed', 'لم تنجح خطوة مطلوبة'])
    : outcome.reason === 'unknown_effect' ? say(lang, ['Tool outcome unverified', 'نتيجة الأداة غير متحققة'])
    : say(lang, ['Step incomplete', 'الخطوة غير مكتملة']);
  const actualEvidence = evidence?.label.trim() ? evidence : { kind: 'adapter_report' as const, label };
  const reference = 'reference' in actualEvidence ? actualEvidence.reference : undefined;
  const receipt = !reference && outcome.status === 'succeeded'
    ? `plan-result:${createHmac('sha256', receiptKey).update(JSON.stringify([ledger.runId, outcome.stepId, outcome.value])).digest('hex')}`
    : reference;
  addEvidence(ledger, { ...actualEvidence, stepId: outcome.stepId, reference: receipt }, at, 'step');
}
