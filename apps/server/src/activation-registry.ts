import { requestContextIntents } from './assistant/request-context.js';
import { requestOperations, requestSources } from './assistant/request-scope.js';

export interface ActivationCapability {
  id: string;
  label: string;
  flag: string | null;
  enabledValue: string | boolean | null;
  shadowValue: string | boolean | null;
  gateId: string | null;
  eventNames: readonly string[];
  privacy: 'same-account';
  differencesOnly?: true;
}

export interface ActivationEvent {
  capabilityId: string;
  changed: boolean | null;
  category: string | null;
  latencyMs: number | null;
  error: boolean;
  baseline: string | null;
  shadow: string | null;
}

type Data = Record<string, unknown>;
type Evidence = Partial<Omit<ActivationEvent, 'capabilityId'>>;

const requestRoutes = [...requestContextIntents, 'image', 'media', 'reply', 'clarify'];
const deliberationRoutes = [...requestRoutes, 'skill', 'capture', 'document', 'compound', 'site', 'knowledge', 'inventory', 'resume'];
const deliberationHandlers = [
  'request_constraint', 'literal_clarification', 'ledger_blocked', 'member_browser_blocked', 'verify_note', 'verify_memory',
  'save_fact', 'desktop', 'local_computer', 'browser_review', 'browser_restore', 'pending_action', 'resume_card', 'stop_run',
  'desktop_refused', 'site_build', 'site_edit', 'pending_calculation', 'pending_open', 'calculation_reference', 'earlier_answer',
  'unnamed_site', 'missing_reference', 'runtime_status', 'local_conversation', 'local_sequence', 'web_sequence', 'self_question',
  'computation_memory', 'local_computation', 'knowledge', 'memory_recall', 'unsupported', 'skill', 'web_search', 'browser_hands',
  'news', 'document', 'writing', 'planning', 'browser_direct', 'browser_capture', 'inventory', 'ads', 'mind', 'model', 'exhausted',
  'image_attachment',
];
const judgeDecisions = ['send', 'fix', 'withhold'];
const browserSteps = ['open', 'find', 'read', 'fill', 'select', 'click', 'download', 'upload'];
const planTools = ['compute', 'search', 'read', 'remember', 'recall', 'pdf', 'letter', 'site', 'compare', 'unsupported'];

function object(value: unknown): Data {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
}

function code(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function measuredMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function categoryForArabic(data: Data): Evidence {
  const resolution = list(data.resolutionChanges);
  const routing = list(data.routeChanges);
  const summarize = (summary: unknown, route: unknown) => {
    const value = object(summary);
    const fields = new Set([
      code(route, requestRoutes), code(value.intent, requestContextIntents), code(value.kind, ['new', 'follow_up', 'answer', 'ambiguous']),
      code(value.scope, ['public', 'private', 'unknown']), code(value.source, requestSources), code(value.operation, requestOperations),
    ]);
    return [...fields].filter(field => field !== null).join(' · ') || null;
  };
  return {
    changed: true,
    category: routing.length ? 'route' : resolution.includes('scope') || resolution.includes('sourceAssessment') ? 'scope' : 'resolution',
    baseline: summarize(data.legacy, data.legacyRoute),
    shadow: summarize(data.normalized, data.normalizedRoute),
  };
}

function planEvidence(data: Data): Evidence {
  if (data.status === 'compile_failed') return { error: true };
  if (!Array.isArray(data.steps)) return {};
  const tools = list(data.steps).slice(0, 16).flatMap(value => {
    const tool = code(object(value).tool, planTools);
    return tool ? [tool] : [];
  });
  if (tools.length < 2 || tools.every(tool => tool === 'unsupported')) return { changed: false };
  // The dry-run graph lacks the permission, freshness and receipt checks at the active dispatch.
  return { category: 'multi_step_plan', shadow: tools.join(' → ') };
}

function answerSelectionEvidence(data: Data): Evidence {
  const baseline = code(data.baseline, ['answer', 'abstain']);
  const ranker = code(data.ranker, ['answer', 'abstain', 'error']);
  const choice = code(data.choice, ['ranker', 'abstain', 'validated-legacy']);
  const shadow = choice ?? ranker;
  if (!baseline || !shadow || ranker === 'error') return { error: ranker === 'error' };
  if (choice === 'validated-legacy') return { changed: false, baseline, shadow };
  if (shadow === 'abstain') {
    // An abstaining ranker can delegate to a validated legacy answer. The shadow line
    // reports this fallback only when the combined chooser actually ran.
    const changed = baseline === 'abstain' ? false : choice === 'abstain' ? true : null;
    return { changed, category: 'abstention', baseline, shadow };
  }
  if (baseline === 'abstain') return { changed: true, category: 'new_answer', baseline, shadow: 'answer' };
  // The producer records the comparison outcome without retaining sources or quotations.
  if (data.sameSource === false) return { changed: true, category: 'source', baseline, shadow: 'answer' };
  if (data.sameQuote === false) return { changed: true, category: 'quote', baseline, shadow: 'answer' };
  return { changed: data.sameSource === true && data.sameQuote === true ? false : null, baseline, shadow: 'answer' };
}

function truthEvidence(data: Data): Evidence {
  const truth = object(data.truth);
  const decision = code(data.decision, judgeDecisions);
  const baseline = decision === 'withhold' && data.applied === true ? 'withhold'
    : decision === 'fix' && data.applied === true ? 'fix' : decision ? 'send' : null;
  const shadow = code(truth.decision, judgeDecisions);
  if (!baseline || !shadow || truth.measured === false) return {};
  const changed = baseline === 'withhold' || shadow === 'send' ? false
    : baseline !== shadow || truth.repaired === true ? true : null;
  const category = code(truth.source, ['not_needed', 'single_source', 'confirmed', 'conflict']) ?? shadow;
  return { changed, category, baseline, shadow };
}

function reviewerEvidence(data: Data): Evidence {
  const review = object(data.conversationReview);
  const shadow = code(review.action, ['send', 'fix', 'note']);
  if (!shadow) return {};
  const finding = list(review.findings).map(value => code(object(value).check,
    ['contradiction', 'coverage', 'commitments', 'corrections', 'preferences', 'repetition'])).find(value => value !== null);
  const original = code(data.decision, judgeDecisions);
  return {
    changed: shadow !== 'send',
    category: finding ?? shadow,
    latencyMs: measuredMs(review.ms),
    baseline: data.applied === true ? original : original ? 'send' : null,
    shadow,
  };
}

function memoryEvidence(data: Data): Evidence {
  const baseline = code(data.legacy, ['ready', 'rejected', 'unrelated']);
  const shadow = code(data.kind, ['secret', 'statement', 'correction', 'recall', 'forget']);
  // The legacy receipt status cannot establish the final result of a recall or write.
  return { category: shadow, baseline, shadow };
}

function clarificationEvidence(data: Data): Evidence {
  const baseline = typeof data.legacyWouldAsk === 'boolean' ? data.legacyWouldAsk ? 'ask_generic' : 'continue' : null;
  const decision = code(data.decision, ['ask', 'clear_winner', 'insufficient_evidence']);
  const shadow = decision === 'ask' ? 'ask_choices' : decision;
  return {
    changed: decision === 'ask' ? true : baseline === 'continue' && decision === 'clear_winner' ? false : null,
    category: code(data.kind, ['entity', 'date', 'account', 'file', 'route']),
    baseline,
    shadow,
  };
}

function writingEvidence(data: Data): Evidence {
  const shadow = code(data.operation, ['summary', 'explanation', 'comparison', 'restructure']);
  // A draft is available only for the local input in the disabled branch, and no legacy reply is compared.
  return { category: shadow, shadow };
}

function browserEvidence(data: Data): Evidence {
  const steps = list(data.steps).slice(0, 16).flatMap(value => {
    const step = code(value, browserSteps);
    return step ? [step] : [];
  });
  return {
    category: code(data.risk, ['read-only', 'reversible-write', 'irreversible']),
    shadow: steps.length ? steps.join(' → ') : null,
  };
}

function conversationStateEvidence(data: Data): Evidence {
  const agreement = object(data.agreement);
  const legacy = object(data.legacyDecision);
  const decision = object(data.decision);
  const changed = agreement.type === false || agreement.standalone === false ? true : agreement.type === true ? false : null;
  return {
    changed,
    category: agreement.type === false ? 'turn_type' : agreement.standalone === false ? 'standalone' : null,
    baseline: code(legacy.kind, ['new', 'follow_up', 'answer', 'ambiguous']),
    shadow: code(decision.type, ['new_request', 'follow_up', 'card_answer', 'correction', 'refinement', 'confirmation', 'small_talk']),
    latencyMs: measuredMs(data.ms),
  };
}

function deliberationDecision(value: unknown): string | null {
  const entry = object(value);
  const action = code(entry.action, ['act', 'ask', 'abstain']);
  if (action !== 'act') return action;
  return code(entry.route, deliberationRoutes) ?? action;
}

const deliberationTrace = (data: Data) => object(object(data.ledger).deliberation ?? data);

function deliberationEvidence(data: Data): Evidence {
  const trace = deliberationTrace(data);
  if (trace.version !== 1) return {};
  const baseline = deliberationDecision(trace.legacy);
  const shadow = deliberationDecision(trace.chosen);
  const changed = baseline && shadow && trace.legacyObserved !== false && typeof trace.disagrees === 'boolean' ? trace.disagrees : null;
  const handlerChanged = changed && baseline === shadow;
  const withHandler = (route: string | null, outcome: unknown) => {
    const handler = code(object(outcome).handler, deliberationHandlers);
    return route && handler ? `${route} · ${handler}` : route;
  };
  return {
    changed,
    category: changed ? handlerChanged ? 'handler' : 'decision' : null,
    baseline: handlerChanged ? withHandler(baseline, trace.legacy) : baseline,
    shadow: handlerChanged ? withHandler(shadow, trace.chosen) : shadow,
  };
}

function capability(
  id: string, label: string, flag: string | null, enabledValue: string | boolean | null, eventNames: readonly string[],
  shadowValue: string | boolean | null = null, gateId: string | null = null,
): ActivationCapability {
  return { id, label, flag, enabledValue, eventNames, shadowValue, gateId, privacy: 'same-account' };
}

// The producer names and switch values below are from origin PRs #23–#38. JSONL and ledger records have no
// event key of their own, so the source adapters name them by their actual field. Their absence means no observations.
export const activationCapabilities: readonly ActivationCapability[] = [
  { ...capability('arabic-understanding', 'فهم العربية', 'MOHASSAN_ARABIC_UNDERSTANDING', '1',
    ['arabic_understanding_shadow_difference', 'arabic_understanding_shadow_error']), differencesOnly: true },
  capability('plan-compiler', 'مُصرّف الخطط', 'MOHASSAN_PLAN_COMPILER', 'on', ['plan_compiler_shadow'], 'shadow'),
  capability('answer-selection', 'اختيار الإجابة', 'MOHASSAN_ANSWER_SELECTION', '1', ['answer_selection_shadow'], null, 'answer-selection'),
  capability('reasoning', 'الاستدلال', 'MOHASSAN_REASONING', '1', []),
  capability('truth-checks', 'التحقق من صحة الإجابة', 'MOHASSAN_JUDGE_TRUTH', '1', ['judge.truth']),
  capability('conversation-reviewer', 'مراجعة المحادثة', 'MOHASSAN_CONVERSATION_REVIEW_APPLY', '1', ['judge.conversationReview', 'conversation_review_unavailable']),
  capability('feedback-loop', 'حلقة الملاحظات', null, null, ['feedback_answer']),
  capability('structured-memory', 'الذاكرة المنظمة', 'MOHASSAN_STRUCTURED_MEMORY', '1', ['structured_memory_shadow']),
  capability('clarify-choices', 'خيارات التوضيح', 'MOHASSAN_CLARIFY_CHOICES', '1', ['clarification_shadow']),
  capability('extractive-writing', 'الكتابة الاستخراجية', 'MOHASSAN_EXTRACTIVE_WRITING', '1', ['extractive_writing_shadow']),
  capability('browser-hands', 'تنفيذ مهام المتصفح', 'AppConfig.browserHands', 'on', ['browser_task_shadow', 'browser_hands_wait_failed'], 'shadow'),
  capability('conversation-state', 'حالة المحادثة', 'MOHASSAN_CONVERSATION_SHADOW', 'decide', ['conversation.agreement'], null, 'conversation-state'),
  capability('deliberation', 'المداولة', 'AppConfig.deliberationEnabled', true, ['attachment_deliberation', 'run.deliberation']),
  capability('offline-knowledge', 'المعرفة المحلية', null, null, []),
];

const capabilitiesById = new Map(activationCapabilities.map(capability => [capability.id, capability]));
const capabilitiesByEvent = new Map(activationCapabilities.flatMap(capability => capability.eventNames.map(name => [name, capability] as const)));

export const activationEventNames = [...capabilitiesByEvent.keys()];

export function activationCapability(id: string): ActivationCapability | undefined {
  return capabilitiesById.get(id);
}

const errorEvidence = () => ({ error: true });
const eventEvidence: Record<string, (data: Data) => Evidence> = {
  arabic_understanding_shadow_difference: categoryForArabic,
  arabic_understanding_shadow_error: errorEvidence,
  plan_compiler_shadow: planEvidence,
  answer_selection_shadow: answerSelectionEvidence,
  'judge.truth': truthEvidence,
  'judge.conversationReview': reviewerEvidence,
  conversation_review_unavailable: errorEvidence,
  feedback_answer: () => ({}),
  structured_memory_shadow: memoryEvidence,
  clarification_shadow: clarificationEvidence,
  extractive_writing_shadow: writingEvidence,
  browser_task_shadow: browserEvidence,
  browser_hands_wait_failed: errorEvidence,
  'conversation.agreement': conversationStateEvidence,
  attachment_deliberation: deliberationEvidence,
  'run.deliberation': deliberationEvidence,
};

const enforcedEvent: Record<string, (data: Data) => boolean> = {
  arabic_understanding_shadow_difference: data => data.active === true,
  answer_selection_shadow: data => data.applied === true,
  'judge.truth': data => object(data.truth).applied === true,
  'judge.conversationReview': data => object(data.conversationReview).applied === true,
  clarification_shadow: data => data.enabled === true,
  extractive_writing_shadow: data => data.enabled === true,
  'conversation.agreement': data => data.mode === 'active',
  attachment_deliberation: data => deliberationTrace(data).enforced === true,
  'run.deliberation': data => deliberationTrace(data).enforced === true,
};

/** Never project a question, query, finding text, reply, value, URL, or logger error message. */
export function readActivationEvent(name: string, data: unknown): ActivationEvent | null {
  const capability = capabilitiesByEvent.get(name);
  if (!capability) return null;
  const fields = object(data);
  const evidence = eventEvidence[name](fields);
  const live = enforcedEvent[name]?.(fields) === true;
  return {
    capabilityId: capability.id, category: null, latencyMs: null, error: false, ...evidence,
    changed: live ? null : evidence.changed ?? null,
    baseline: live ? null : evidence.baseline ?? null,
    shadow: live ? null : evidence.shadow ?? null,
  };
}
