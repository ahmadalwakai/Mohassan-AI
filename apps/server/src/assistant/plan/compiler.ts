import { asksToRemember } from '../brain.js';
import { computedRecord } from '../computation-reference.js';
import { planConversationPageRead } from '../conversation-state-page.js';
import { documentTask } from '../documents.js';
import { normalizeRequest } from '../mind/normalize.js';
import { ownFactQuestion } from '../own-fact-question.js';
import { parseUserRequestConstraints, requestCapabilityAllowed } from '../request-constraints.js';
import { assessRequestScope } from '../request-scope.js';
import { decideRequestRoute, type RequestRoutingDecision, type RequestRoutingInput } from '../routing-decision.js';
import { siteTask } from '../site-builder.js';
import { writingTask } from '../writer.js';
import { extractiveWritingEnabled } from '../writing/request.js';
import { actionHead, clauseMatchingText, splitPlanClauses } from './clauses.js';
import { planReferences } from './references.js';
import { parseSourceComputation } from './source-computation.js';
import type { CompiledPlan, PlanOutputType, PlanReference, PlanStep, PlanTool } from './types.js';
import { webMeasureKind } from './web-figures.js';
import { planReadMeasure, planReadTarget } from './web-target.js';

// The shared run ledger's execution-plan contract caps the graph at 16 nodes.
export const MAX_PLAN_STEPS = 16;
type RouteOptions = Omit<RequestRoutingInput, 'text'>;
type Constraints = ReturnType<typeof parseUserRequestConstraints>;

const READ = /^(?:read|open|visit|go to|navigate to|اقرا(?:ها|ه)?|افتح(?:ها|ه)?|تصفح|ادخل)(?![\p{L}\p{N}])/u;
const PDF_OBJECT = /\bpdf\b|(?<!\p{L})بي\s*دي\s*اف(?!\p{L})/u;
const ARABIC_CONVERSION = /^حول(?:ه|ها)(?!\p{L})/u;
const SEARCH = /^(?:search|look up|find(?: out)?|check|google|ابحث(?:لي)?|دور(?:لي)?|فتش|قلب|جيب(?:لي)?|لقيني|شوف(?:لي)?)(?![\p{L}\p{N}])/u;
const COMPUTE = /^(?:calculate|compute|multiply|divide|add|subtract|convert|احسب|اضرب(?:ه|ها)?|اقسم(?:ه|ها)?|اجمع(?:ه|ها)?|اطرح(?:ه|ها)?|اضف|زد|زود|ضاعف(?:ه|ها)?|حول)(?![\p{L}\p{N}])/u;
const RECALL = /^(?:recall|retrieve|استرجع(?:ها|ه)?|اذكر(?:ها|ه))(?![\p{L}\p{N}])/u;
const COMPARE = /^(?:compare|contrast|قارن(?:هما|هم|ها|ه)?|وازن)(?![\p{L}\p{N}])/u;
const NUMERIC_SEARCH = /\b(?:price|cost|population|height|distance|temperature|exchange rate|how (?:many|much|tall|far)|number of|area of)\b|(?<![\p{L}\p{N}])(?:ال)?(?:سعر|اسعار|تكلفه|سكان|ارتفاع|مسافه|حراره|صرف|كم|عدد|مساحه)(?![\p{L}\p{N}])/u;
const LIST_SEARCH = /\b(?:list|top \d+)\b|(?<!\p{L})(?:قائمه|لائحه)(?!\p{L})/u;
const ENTITY_SEARCH = /\b(?:official (?:site|website|page)|url|link|capital|winner|owner|who|name of)\b|(?<!\p{L})(?:الموقع الرسمي|رابط|العاصمه|عاصمه|الفائز|اسم)(?!\p{L})/u;
const PRIVATE_OPERAND = /\b(?:my|our|private|confidential|personal|password|secret)\b|(?<!\p{L})(?:خاص(?:تي|ه|بي)?|سري(?:ه)?|شخصي(?:ه)?|حسابي|ملفي|راتبي|بياناتي|كلمه المرور)(?!\p{L})/u;
const PAIRED_MEASURE = /^(?<prefix>(?:search for|find|look up|check)\s+(?:the\s+)?(?:population|price|cost|height|temperature|area|size)\s+(?:of|in|for)\s+)(?<left>[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’-]*?)\s+and\s+(?<right>[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’-]*)$/iu;
const ARABIC_PAIRED_MEASURE = /^(?<prefix>(?:[اأإ]بحث\s+عن|دوّ?ر\s+على)\s+(?:سعر|عدد\s+سكان|ارتفاع|مساحة)\s+)(?<left>[\p{L}\p{M}\p{N} -]+?)\s+و\s*(?<right>[\p{L}\p{M}\p{N} -]+)$/u;
const COMPARE_PAIR = /^(?:(?:compare|contrast)\s+(?:them|both|the (?:two|results))|قارن(?:هما|هم|\s+(?:بينهما|بين\s+النتيجتين|النتيجتين)))[.!?؟]*$/u;
const PAGE_SELECTOR = /^(?:read|find|check|اقرا|اعرف|شوف|خذ)(?![\p{L}\p{N}])/u;

function expandComparisonClauses(clauses: string[]): string[] {
  return clauses.flatMap((clause, index) => {
    const next = clauses[index + 1];
    if (!next || !COMPARE_PAIR.test(actionHead(next)) || clauseMatchingText(clause) !== clause) return [clause];
    const pair = (PAIRED_MEASURE.exec(clause) ?? ARABIC_PAIRED_MEASURE.exec(clause))?.groups;
    if (!pair?.prefix || !pair.left || !pair.right || /\band\b|\sو\S/u.test(pair.right)) return [clause];
    return [pair.prefix + pair.left, pair.prefix + pair.right];
  });
}

/** A measurement requested immediately after opening its page belongs to that read. */
function attachPageSelectors(clauses: string[]): string[] {
  const joined: string[] = [];
  for (const [index, clause] of clauses.entries()) {
    const prior = joined.at(-1);
    const following = clauses[index + 1];
    const combined = prior && `${prior}, ${clause}`;
    if (prior && combined && following && planReadTarget(prior) && !planReadMeasure(prior)
      && PAGE_SELECTOR.test(actionHead(clause)) && planReadMeasure(combined) && parseSourceComputation(following)) {
      joined[joined.length - 1] = combined;
    } else {
      joined.push(clause);
    }
  }
  return joined;
}

function classify(text: string, route: RequestRoutingDecision): PlanTool {
  const head = actionHead(text);
  if (route.availability === 'restricted' || route.resolution.constraints?.ambiguous || route.resolution.constraints?.standalone) return 'unsupported';
  if (asksToRemember(text)) return 'remember';
  if (ownFactQuestion(text) || RECALL.test(head)) return 'recall';
  if (route.intent === 'memory') return route.sourceAssessment.operation === 'lookup' ? 'recall' : 'unsupported';
  const document = documentTask(text);
  if (document && document.kind !== 'unsupported' || ARABIC_CONVERSION.test(head) && PDF_OBJECT.test(head)) return 'pdf';
  if (siteTask(text)) return 'site';
  const writing = writingTask(text);
  if (writing && !('unsupported' in writing) && !writing.pendingDelivery) return 'letter';
  if (COMPARE.test(head)) return 'compare';
  if (route.intent === 'compute' || COMPUTE.test(head)) return 'compute';
  if (READ.test(head) || /^https?:\/\//iu.test(head)) {
    return route.intent === 'pc' || route.sourceAssessment.source === 'local_state' ? 'unsupported' : 'read';
  }
  if (route.handler === 'search' || SEARCH.test(head)) return 'search';
  return 'unsupported';
}

function outputType(tool: PlanTool, text: string, route: RequestRoutingDecision): PlanOutputType {
  const normalized = actionHead(text);
  if (tool === 'compute') {
    const result = route.localReply;
    return result?.status === 'completed' && 'consumption' in result && !computedRecord(result) ? 'text' : 'number';
  }
  if (tool === 'pdf') {
    const task = documentTask(text);
    return task?.kind === 'edit' && task.operation === 'info' ? 'text' : 'file';
  }
  if (tool === 'site') return 'entity';
  if (tool === 'read' && planReadMeasure(text)) return 'number';
  if (tool === 'search') {
    if (LIST_SEARCH.test(normalized)) return 'list';
    if (NUMERIC_SEARCH.test(normalized) || webMeasureKind(normalized)) return 'number';
    if (ENTITY_SEARCH.test(normalized)) return 'entity';
  }
  return 'text';
}

function bodyForRoute(text: string, tool: PlanTool, references: PlanReference[], steps: PlanStep[]): string {
  if (tool === 'read') {
    const address = planReadTarget(text) ?? (references.length ? 'https://example.com/' : null);
    // The existing navigator recognises a public URL operand explicitly. The
    // adapter still validates the exact URL, authority and network policy.
    return address ? `open ${address}` : text;
  }
  let candidate = text;
  for (const reference of references.toReversed()) {
    const { start, end } = reference;
    if (start === undefined || end === undefined) continue;
    const source = steps.find(step => step.id === reference.stepId);
    const placeholder = reference.kind === 'number' || source?.output === 'number' ? '37' : 'London';
    candidate = candidate.slice(0, start) + placeholder + candidate.slice(end);
  }
  return candidate;
}

function allowedTool(tool: PlanTool, constraints: Constraints): PlanTool {
  if (tool === 'search' && !requestCapabilityAllowed(constraints, 'public_search')
    || tool === 'read' && !requestCapabilityAllowed(constraints, 'browser_navigation')
    || tool === 'recall' && !requestCapabilityAllowed(constraints, 'memory_read')
    || tool === 'remember' && !requestCapabilityAllowed(constraints, 'memory_write')) return 'unsupported';
  return tool;
}

function canProject(text: string, tool: PlanTool, route: RequestRoutingDecision, references: PlanReference[], steps: PlanStep[]): boolean {
  if (tool === 'remember' || tool === 'recall' || tool === 'site' || tool === 'pdf' || tool === 'letter' || tool === 'unsupported') return false;
  const original = assessRequestScope(text);
  if (original.reasons.includes('credential_material') || route.sourceAssessment.reasons.includes('credential_material')
    || ['prior_conversation', 'local_state'].includes(original.source)) return false;
  if (tool === 'compute') {
    if (PRIVATE_OPERAND.test(actionHead(text))) return false;
    if (!references.length) {
      const computation = route.localReply;
      return Boolean(computation && 'consumption' in computation && computation.consumption?.kind === 'arithmetic'
        && computation.consumption.complete && computation.status === 'completed' && computedRecord(computation));
    }
  }
  if (tool === 'search' && !route.publicQuery) return false;
  if (tool === 'read' && route.sourceAssessment.scope !== 'public' && !references.length) return false;
  if (tool !== 'compute' && tool !== 'compare' && route.sourceAssessment.scope === 'private') return false;
  return references.every(reference => {
    const source = steps.find(step => step.id === reference.stepId);
    return Boolean(source?.publicInput && (source.output === 'number' || source.output === 'entity'));
  });
}

/** Classify each original clause using the existing deterministic routing contract. */
export function compilePlan(text: string, options: RouteOptions = {}): CompiledPlan {
  const lang = normalizeRequest(text).lang;
  const { context, previousScope, pendingQuestion, ...sharedOptions } = options;
  const capabilities = { browser: true, search: true, memory: true, ...options.capabilities, chatModel: false, writerModel: false };
  const split = splitPlanClauses(text, clause => {
    const route = decideRequestRoute({ ...sharedOptions, capabilities, text: clause });
    const tool = classify(clause, route);
    return tool !== 'unsupported' && (tool !== 'search' || SEARCH.test(actionHead(clause)));
  });
  const writing = split.length === 2 && extractiveWritingEnabled() ? writingTask(text, 'extractive') : null;
  const writesFromOnePage = writing?.opensSource && writing.source.kind === 'urls' && writing.source.urls.length === 1;
  // Opening one named page to answer a question or compare its contents is a
  // single source-backed task. Additional clauses keep their own dependencies.
  const clauses = split.length === 2 && (writesFromOnePage || planConversationPageRead(text))
    ? [text] : expandComparisonClauses(attachPageSelectors(split));
  const steps: PlanStep[] = [];
  const constraints = parseUserRequestConstraints(text);
  for (const clause of clauses) {
    const routeOptions = { ...sharedOptions, capabilities, ...(!steps.length ? { context, previousScope, pendingQuestion } : {}) };
    const initial = decideRequestRoute({ ...routeOptions, text: clause });
    const classified = classify(clause, initial);
    const prior = steps.at(-1);
    const measuredSource = prior?.tool === 'search' && prior.output === 'number'
      || prior?.tool === 'read' && prior.output === 'number';
    const sourceComputation = measuredSource && (classified === 'compute' || classified === 'unsupported')
      && initial.availability !== 'restricted' && !initial.resolution.constraints?.ambiguous
      && !initial.resolution.constraints?.standalone && !PRIVATE_OPERAND.test(actionHead(clause))
      && parseSourceComputation(clause);
    const tool = allowedTool(sourceComputation ? 'compute' : classified, constraints);
    const explicit = planReferences(clause, tool, steps);
    const references: PlanReference[] = sourceComputation && prior && explicit.every(reference => reference.stepId === prior.id)
      ? [{ stepId: prior.id, kind: 'number' }] : explicit;
    for (const reference of references) {
      const source = steps.find(step => step.id === reference.stepId);
      if (source?.tool === 'search' && source.output === 'text' && (reference.kind === 'number' || reference.kind === 'entity')) {
        source.output = reference.kind;
        source.success = reference.kind;
      }
    }
    const bound = bodyForRoute(clause, tool, references, steps);
    let route = bound === clause ? initial : decideRequestRoute({ ...routeOptions, text: bound });
    if (tool === 'search' && !route.publicQuery && /\.$/u.test(bound)) {
      route = decideRequestRoute({ ...routeOptions, text: bound.slice(0, -1) });
    }
    const output = outputType(tool, clause, route);
    const dependsOn = new Set(references.map(reference => reference.stepId));
    if (tool === 'remember' || tool === 'recall') {
      // The owner's memory is shared within this turn. Serialize writes with
      // all prior accesses so independent reads cannot observe a later write.
      const previousAccess = steps.findLast(step => step.tool === 'remember' || tool === 'remember' && step.tool === 'recall');
      if (previousAccess) dependsOn.add(previousAccess.id);
    }
    const publicInput = canProject(clause, tool, route, references, steps);
    steps.push({
      id: `step-${steps.length + 1}`, text: clause, route: sourceComputation ? 'compute' : route.route, tool, inputs: { text: clause, references }, output,
      success: output, dependsOn: [...dependsOn], publicInput,
      ...(tool === 'search' && publicInput && !references.length && route.publicQuery ? { publicQuery: route.publicQuery } : {}),
    });
  }
  return { lang, steps };
}
