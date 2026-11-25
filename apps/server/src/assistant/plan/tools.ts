import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../../command-chat.js';
import { assessUserFactMemoryRequest } from '../user-fact-memory-receipt.js';
import { actionRequestHash } from '../action-completion.js';
import { deniesMemoryWrite } from '../brain.js';
import { evaluateLocalRecall } from '../local-recall.js';
import { projectPreferredLanguageMemoryQuery } from '../preferred-language-fact.js';
import { parseUserRequestConstraints, requestCapabilityAllowed, type ForbiddenRequestCapability } from '../request-scope.js';
import { buildSiteReply, siteAnswers, siteCard, siteTask } from '../site-builder.js';
import { runUserFactMemoryFlow, validateUserFactMemoryReadback, type UserFactMemoryFlowState } from '../user-fact-memory-flow.js';
import { composeLetter, writingTask } from '../writer.js';
import type { AssistantTools, MemoryLookupResult } from '../tools.js';
import { clauseMatchingText } from './clauses.js';
import type { PlanAttempt, PlanToolResult, RunPlanTool } from './executor.js';
import { createPlanDocumentTools } from './document-tools.js';
import { runPlanComparison, runPlanComputation, valueText } from './local-tools.js';
import type { PlanStep, ResolvedStepInputs } from './types.js';
import { createPlanWebTools, type PlanWebToolContext } from './web-tools.js';

type VerifiedNote = Extract<UserFactMemoryFlowState, { phase: 'verified' }>;
type PlanCapability = Partial<Record<PlanStep['tool'], ForbiddenRequestCapability>>;
const CAPABILITY: PlanCapability = { search: 'public_search', read: 'browser_navigation', remember: 'memory_write', recall: 'memory_read' };
const WRITES: ReadonlySet<PlanStep['tool']> = new Set(['remember', 'pdf', 'site']);
const ARABIC = /\p{Script=Arabic}/u;
const MEMORY_QUOTA = new Error('PLAN_MEMORY_QUOTA');
const SITE_FIELDS: Readonly<Record<string, string>> = {
  name: 'name|الاسم', kind: 'kind|type|النوع', contact: 'contact|التواصل',
  items: 'services|products|items|menu|الخدمات|المنتجات|القائمة',
  offer: 'offer|العرض', city: 'city|المدينة', hours: 'hours|الساعات',
  colour: 'colou?r|اللون', about: 'about|نبذة', tagline: 'tagline|الشعار',
  address: 'address|العنوان', team: 'team|الفريق', faq: 'faq|الأسئلة الشائعة',
  pricing: 'pricing|الأسعار', projects: 'projects|المشاريع', features: 'features|المزايا',
  steps: 'steps|الخطوات', facts: 'facts|الحقائق', testimonials: 'testimonials|الشهادات',
};

export interface PlanToolContext extends Pick<PlanWebToolContext, 'openPage' | 'onWebAction'> {
  ownerId: string;
  conversationId: string;
  runId: string;
  /** Original user turn, used to enforce request-wide prohibitions. */
  request: string;
  originalRequestHash?: string;
  now: Date;
  signal: AbortSignal;
  active(): Promise<void>;
  scrub(text: string): string;
  search: NonNullable<CommandChatConfig['searchProvider']>;
  readPage?: CommandChatConfig['readPage'];
  networkPolicy?: CommandChatConfig['networkPolicy'];
  memory?: AssistantTools['memory'];
  documents?: CommandChatConfig['documents'];
  sites?: CommandChatConfig['sites'];
  fullAccess?: boolean;
  onSite?(id: string, stepId: string): void;
  memoryState?: { memorySaves?: number };
  memoryLimit?: number;
  fenceMemory?(tx: Kysely<any>): Promise<void>;
}

export type PlanToolRunner = RunPlanTool;

function evidenceItems(result: MemoryLookupResult): readonly string[] {
  // The current adapter separates evidence from its display. Older injected
  // adapters return a single note; the normal no-result sentinel is kept out.
  if (typeof result !== 'string') return result.evidence;
  return result.trim() && result !== 'no matching memory' ? [result] : [];
}

function labelledFields(text: string, names: Readonly<Record<string, string>>): { command: string; fields: Record<string, string> } {
  const entries = Object.entries(names);
  const labels = entries.map(([, patterns]) => `(?:${patterns})`).join('|');
  const matches = [...clauseMatchingText(text).matchAll(new RegExp(`(?:^|[\\n;؛])\\s*(${labels})\\s*[:：]`, 'giu'))];
  const fields: Record<string, string> = {};
  for (const [index, match] of matches.entries()) {
    const key = entries.find(([, patterns]) => new RegExp(`^(?:${patterns})$`, 'iu').test(match[1]!))?.[0];
    if (key) fields[key] = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim();
  }
  return { command: text.slice(0, matches[0]?.index ?? text.length).trim(), fields };
}

function letter(step: PlanStep, inputs: ResolvedStepInputs): PlanToolResult {
  const inline = labelledFields(step.text, { to: 'to|recipient|إلى|المستلم', from: 'from|signer|sender|من|المرسل|التوقيع', details: 'body|details|النص|المحتوى' });
  const task = writingTask(inline.command);
  const whole = writingTask(step.text);
  if (!task || 'unsupported' in task) return { ok: false, reason: 'unavailable' };
  const supplied = inputs.references.length ? inputs.references.map(({ value }) => valueText(value)).join('\n\n') : '';
  const fields = {
    to: inline.fields.to ?? '',
    from: (inline.fields.from ?? '').replace(/(?:\n|[;؛])\s*(?:saying|with (?:this|the) (?:text|body)|بالنص|نصها|محتواها|تقول)\b[\s\S]*$/iu, '').trim(),
    details: [supplied, inline.fields.details ?? (whole && !('unsupported' in whole) ? whole.suppliedText : undefined) ?? task.suppliedText].filter(Boolean).join('\n\n'),
  };
  const pendingDelivery = whole && !('unsupported' in whole) && whole.pendingDelivery;
  const result = composeLetter({ ...task, ...(pendingDelivery ? { pendingDelivery } : {}) }, fields);
  if (!result.complete) {
    const missing = !fields.to || !fields.from ? (task.lang === 'ar' ? 'من المستلم ومن يوقّع الرسالة؟' : 'Who is the recipient and who signs the letter?')
      : (task.lang === 'ar' ? 'ما النص الذي تريد وضعه في الرسالة؟' : 'What text belongs in the letter?');
    return { ok: false, reason: 'missing_input', question: missing, ...(result.draftComplete ? { text: result.text } : {}) };
  }
  const text = supplied ? result.text.split('\n\n---\n', 1)[0]! : result.text;
  return { ok: true, value: { type: 'text', value: text }, evidence: { kind: 'adapter_report', label: 'Letter template composed' } };
}

export function createPlanTools(context: PlanToolContext): PlanToolRunner {
  const web = createPlanWebTools(context);
  const constraints = parseUserRequestConstraints(context.request);
  const runDocument = createPlanDocumentTools({ ...context, fullAccess: context.fullAccess && requestCapabilityAllowed(constraints, 'computer_read') });
  const memoryState = context.memoryState ?? {};
  const memoryLimit = context.memoryLimit ?? 3;
  const remembered = new Map<string, VerifiedNote>();
  const recallQueries = new Map<string, string>();
  const { memory } = context;

  async function remember(step: PlanStep, inputs: ResolvedStepInputs, signal: AbortSignal): Promise<PlanToolResult> {
    if (!memory) return { ok: false, reason: 'unavailable' };
    if (deniesMemoryWrite(context.request) || inputs.references.length || context.scrub(step.text) !== step.text
      || context.scrub(context.request) !== context.request || actionRequestHash(context.request) !== context.originalRequestHash) return { ok: false, reason: 'restricted' };
    const assessment = assessUserFactMemoryRequest(step.text);
    if (assessment.status !== 'ready') return {
      ok: false, reason: 'missing_input',
      question: ARABIC.test(step.text) ? 'ما النص الذي تريد حفظه حرفيًا؟' : 'What exact note would you like me to remember?',
    };
    // Any pre-existing note could satisfy generic search. Only an exact commit
    // receipt and same-key readback prove that this run performed the write.
    if (!memory.writeExact || !memory.reconcileExact || !context.fenceMemory) {
      return { ok: false, reason: 'unavailable' };
    }
    if ((memoryState.memorySaves ?? 0) >= memoryLimit) return { ok: false, reason: 'restricted' };
    const result = await runUserFactMemoryFlow({
      request: step.text,
      // Bind the receipt to this user clause and step. The chat host supplies
      // the serving account/lease fence at the same transaction as the write.
      binding: { ownerId: context.ownerId, conversationId: context.conversationId, runId: `${context.runId}:${step.id}`, evaluatedAt: context.now.getTime(),
        originalRequestHash: actionRequestHash(step.text) },
      policy: { accountAllowed: true, quota: { used: memoryState.memorySaves ?? 0, limit: memoryLimit } },
    }, {
      signal, assertActive: context.active, isExecutionEnded: () => signal.aborted,
      now: Date.now, scrubExact: context.scrub,
      checkpoint: async next => {
        if (next.phase !== 'write_attempted') return;
        if ((memoryState.memorySaves ?? 0) >= memoryLimit) throw MEMORY_QUOTA;
        memoryState.memorySaves = (memoryState.memorySaves ?? 0) + 1;
      },
      writeExact: (ownerId, input) => memory.writeExact!(ownerId, input, { signal, fence: context.fenceMemory }),
      reconcileExact: (ownerId, input) => memory.reconcileExact!(ownerId, input, { signal }),
    });
    if (result.status !== 'verified' || result.state?.phase !== 'verified' || !result.readback) {
      return { ok: false, reason: result.persistence === 'not_attempted' ? 'restricted' : 'unknown_effect' };
    }
    const payload = result.readback.item.content;
    remembered.set(step.id, result.state);
    return { ok: true, value: { type: 'text', value: payload },
      text: ARABIC.test(step.text) ? 'تحققت من حفظ الملاحظة في الذاكرة.' : 'I verified the note was saved in memory.',
      evidence: { kind: 'readback', label: 'Saved memory readback', reference: result.readback.receipt.itemId, independent: true } };
  }

  async function recall(step: PlanStep, inputs: ResolvedStepInputs, attempt: PlanAttempt, signal: AbortSignal): Promise<PlanToolResult> {
    if (!memory) return { ok: false, reason: 'unavailable' };
    const saved = inputs.references.map(({ reference }) => remembered.get(reference.stepId)).find(note => note !== undefined);
    const sourceNote = saved?.receipt.payload.text;
    const direct = /^\s*(?:(?:please\s+)?(?:recall|retrieve|read)\s+(?:it|that|the note)|what (?:did (?:you (?:save|remember)|i (?:just )?tell you)|(?:did|have) i (?:just )?ask(?:ed)? you to (?:save|remember))|(?:ماذا|ما|شو|ايش|وش)\s+(?:حفظت|تذكرت|قلت لك)|استرجع\s+(?:ها|ذلك|الملاحظ[ةه])|استرجعها|استدعها|اذكرها)[\s?.؟!]*$/iu.test(step.text);
    if (saved && direct) {
      if (attempt.strategy !== 'initial' || !memory.reconcileExact) return { ok: false, reason: 'no_result' };
      const { receipt } = saved;
      const startedAt = Date.now();
      const lookup = await memory.reconcileExact(context.ownerId, { operationKey: receipt.operationKey, payloadHash: receipt.payload.hash }, { signal });
      signal.throwIfAborted();
      const checked = validateUserFactMemoryReadback(lookup, receipt, saved, startedAt, Date.now());
      if (checked?.status !== 'verified') return { ok: false, reason: 'no_result' };
      return { ok: true, value: { type: 'text', value: context.scrub(checked.item.content) },
        evidence: { kind: 'readback', label: 'Recalled saved note', reference: checked.receipt.itemId, independent: true } };
    }
    const checked = await evaluateLocalRecall(inputs.text, {
      async memory(query) {
        const projected = projectPreferredLanguageMemoryQuery(inputs.text) ?? query;
        const narrow = projected.replace(/^\s*(?:please\s+)?(?:recall|tell me|what is|اذكر|استرجع|اخبرني|ما (?:هو|هي))\s+/iu, '');
        const lookup = attempt.strategy === 'narrower_query' ? narrow : projected;
        if (!lookup || recallQueries.get(step.id) === lookup) return [];
        recallQueries.set(step.id, lookup);
        const result = await memory!.search(context.ownerId, lookup);
        return evidenceItems(result).map(item => context.scrub(item));
      },
    }, signal, sourceNote ? { intent: 'memory', topic: sourceNote.slice(0, 600) } : undefined);
    if (!checked || checked.status !== 'completed' || !checked.evidence.length) return { ok: false, reason: 'no_result' };
    return { ok: true, value: { type: 'text', value: checked.text }, evidence: { kind: 'readback', label: 'Retrieved memory evidence', independent: true } };
  }

  async function site(step: PlanStep, inputs: ResolvedStepInputs): Promise<PlanToolResult> {
    if (!context.sites) return { ok: false, reason: 'unavailable' };
    // Site instruction grammar is for direct user words. Feeding a read page
    // back into it could make incidental instructions into site requirements.
    if (inputs.references.length) return {
      ok: false, reason: 'missing_input',
      question: ARABIC.test(step.text) ? 'ما النص الذي تريد وضعه في الموقع؟' : 'What text should the site contain?',
    };
    const inline = labelledFields(context.scrub(step.text), SITE_FIELDS);
    const parsed = siteTask(inline.command);
    if (!parsed) return { ok: false, reason: 'missing_input' };
    const task = Object.keys(inline.fields).length ? siteAnswers(parsed, inline.fields) : parsed;
    const card = siteCard(task);
    if (card) return { ok: false, reason: 'missing_input', question: card.fields[0]?.prompt };
    const result = await buildSiteReply(context.sites, context.ownerId, task, context.conversationId);
    if (result.siteId) context.onSite?.(result.siteId, step.id);
    const text = context.scrub(result.text);
    if (result.status !== 'completed' || !result.siteId) return { ok: false, reason: 'invalid_result', text };
    const link = context.sites.link?.(result.siteId) ?? `/#sites=${result.siteId}`;
    return { ok: true, value: { type: 'entity', value: result.siteId, url: link }, text, evidence: { kind: 'adapter_report', label: 'Site built and checked', reference: result.siteId } };
  }

  return async (step, inputs, attempt) => {
    const capability = CAPABILITY[step.tool];
    if (capability && (!requestCapabilityAllowed(constraints, capability)
      || !requestCapabilityAllowed(parseUserRequestConstraints(step.text), capability))) return { ok: false, reason: 'restricted' };
    if (step.tool === 'remember' && !requestCapabilityAllowed(constraints, 'memory_read')) return { ok: false, reason: 'restricted' };
    if ((step.tool === 'search' || step.tool === 'read') && !step.publicInput) return { ok: false, reason: 'restricted' };
    const write = WRITES.has(step.tool);
    if (write && attempt.number !== 1) return { ok: false, reason: 'unknown_effect' };
    const signal = attempt.signal ?? context.signal;
    signal.throwIfAborted();
    await context.active();
    signal.throwIfAborted();
    let result: PlanToolResult;
    try {
      switch (step.tool) {
        case 'compute': result = runPlanComputation(step, inputs, context.now); break;
        case 'search': result = await web.search(step, inputs, attempt); break;
        case 'read': result = await web.read(step, inputs, attempt); break;
        case 'remember': result = await remember(step, inputs, signal); break;
        case 'recall': result = await recall(step, inputs, attempt, signal); break;
        case 'pdf': result = await runDocument(step, inputs, signal); break;
        case 'letter': result = letter(step, inputs); break;
        case 'site': result = await site(step, inputs); break;
        case 'compare': result = runPlanComparison(step, inputs); break;
        case 'unsupported': result = { ok: false, reason: 'unavailable' }; break;
      }
    } catch (error) {
      signal.throwIfAborted();
      await context.active();
      if (!write) throw error;
      result = { ok: false, reason: error === MEMORY_QUOTA ? 'restricted' : 'unknown_effect' };
    }
    await context.active();
    signal.throwIfAborted();
    return result;
  };
}
