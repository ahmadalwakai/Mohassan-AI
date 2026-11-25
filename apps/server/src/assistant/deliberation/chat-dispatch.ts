import { randomUUID } from 'node:crypto';
import type { ChatQuestion } from '@mohassan/contracts';
import { fulfilWant, siteCommand } from '@mohassan/sites';
import type { Kysely } from 'kysely';
import type { CommandChatConfig } from '../../command-chat.js';
import { restoreActionCompletionLedger } from '../action-completion.js';
import type { RunLedger } from '../agent-run.js';
import type { BrainState } from '../brain.js';
import type { EffectiveRequestSource } from '../effective-request-source.js';
import type { JudgeEvidence } from '../judge.js';
import { projectPreferredLanguageMemoryQuery } from '../preferred-language-fact.js';
import { decideRequestRoute, projectDeliberationRoute, type RequestRoutingDecision } from '../routing-decision.js';
import { gateRefusalText } from '../run-plans.js';
import { handlerRoutes, type CascadeHandler } from './cascade-handlers.js';
import { inspectCascade, type CascadeInput, type CascadeTurn } from './cascade.js';
import { conversationEvidence } from './conversation-evidence.js';
import { deliberate, sameDecision } from './decision.js';
import { reviewDeliberationResult } from './review.js';
import { recordDeliberation } from './run-ledger.js';
import { deliberationSettings } from './settings.js';
import type { DecisionOutcome, DecisionRoute, Deliberation, RouterCandidate } from './types.js';

interface Intake {
  db: Kysely<any>;
  config: CommandChatConfig;
  ownerId: string;
  conversationId: string;
  runId: string;
  runIntent: string;
  source: EffectiveRequestSource;
  state: BrainState;
  fullAccess: boolean;
  chatModel: boolean;
  historyLimit: number;
}
interface WorkCallbacks {
  ledger(change: (ledger: RunLedger) => void): void;
  save(): Promise<void>;
  reply(text: string, question?: ChatQuestion): Promise<void>;
}
interface Prepared {
  result: Deliberation;
  routing: RequestRoutingDecision;
  canSteer: boolean;
  choice: CascadeHandler | null;
  turnId: string;
  previousRequest: string | null;
  missingLocation: boolean;
}
interface ShadowReview {
  prepared: Prepared;
  input: Intake;
  callbacks: WorkCallbacks;
}

const workReviews = new WeakMap<BrainState, ShadowReview>();
const optionPrefix = 'deliberation-';
const authorityHandlers = new Set<CascadeHandler>([
  'member_browser_blocked', 'request_constraint', 'literal_clarification', 'ledger_blocked',
  'verify_note', 'verify_memory', 'save_fact', 'browser_review', 'browser_restore', 'pending_action', 'desktop_refused',
]);
const nativeChoiceHandlers = new Set<CascadeHandler>([
  'local_conversation', 'local_computation', 'self_question', 'runtime_status', 'local_sequence', 'planning', 'writing',
]);

const routeLabels: Partial<Record<DecisionRoute, readonly [string, string]>> = {
  web_search: ['البحث عن معلومة عامة', 'Look up public information'],
  browser_command: ['تنفيذ أمر في المتصفح', 'Run a browser command'],
  news: ['قراءة الأخبار', 'Read the news'],
  memory: ['استخدام الذاكرة', 'Use memory'],
  compute: ['إجراء الحساب', 'Calculate'],
  ads: ['العمل على حملة إعلانية', 'Work on an ad campaign'],
  pc: ['استخدام الكمبيوتر', 'Use the computer'],
  writing: ['كتابة مسودة', 'Write a draft'],
  planning: ['إعداد خطة', 'Make a plan'],
  coding: ['العمل على مشروع برمجي', 'Work on a coding project'],
  chat: ['الجواب داخل المحادثة', 'Answer in the conversation'],
  skill: ['قراءة مهارة', 'Read a skill'],
  capture: ['تصوير الصفحة', 'Capture the page'],
  document: ['معالجة مستند', 'Work on a document'],
  compound: ['الإجابة عن كل أجزاء الطلب', 'Answer each part of the request'],
  site: ['العمل على الموقع', 'Work on the website'],
  knowledge: ['البحث في المستندات', 'Look up the answer in documents'],
  inventory: ['عرض المشاريع', 'Show projects'],
};

function cascadeHandler(value: unknown): value is CascadeHandler {
  return typeof value === 'string' && Object.hasOwn(handlerRoutes, value);
}

function selectedChoice(state: BrainState, enabled: boolean): CascadeHandler | null {
  if (!enabled || !state.requestClarification || state.steps || !state.trail.length ||
    !state.trail.every(entry => entry.action === 'asked the user') || !state.lastChoice?.startsWith(optionPrefix)) return null;
  const handler = state.lastChoice.slice(optionPrefix.length);
  return cascadeHandler(handler) ? handler : null;
}

async function prepare(input: Intake, enabled: boolean): Promise<Prepared> {
  const { db, state, config, ownerId, conversationId, runId } = input;
  const text = input.source.request;
  const [recentMessages, recentRuns] = await Promise.all([
    db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
      .select(['m.id', 'm.role', 'm.text']).where('m.conversation_id', '=', conversationId).where('c.owner_id', '=', ownerId)
      .orderBy('m.created_at', 'desc').orderBy('m.role', 'desc').limit(input.historyLimit + 1).execute(),
    db.selectFrom('chat_runs').select(['state', 'status']).where('owner_id', '=', ownerId).where('conversation_id', '=', conversationId)
      .where('id', '!=', runId).orderBy('created_at', 'desc').limit(8).execute(),
  ]);
  const history = recentMessages.slice(1).reverse().filter(row => row.role === 'user' || row.role === 'assistant') as CascadeTurn[];
  const previous = history.findLast(turn => turn.role === 'user') ?? null;
  const previousStates = recentRuns.map(row => row.state).filter(Boolean) as BrainState[];
  const turnId = typeof recentMessages[0]?.id === 'string' ? recentMessages[0].id : runId;
  const configured: NonNullable<CascadeInput['configured']> = {
    computer: !!config.tools?.computer, documents: !!config.documents, sites: !!config.sites,
    memory: !!config.tools?.memory, knowledge: !!config.knowledgeSearch, skills: !!config.skillAnswer,
    inventory: !!config.tools?.work?.inventory, ads: !!config.adsModel, mind: !!(config.mind && config.mindDeps), chatModel: input.chatModel,
  };
  const now = new Date(input.source.evaluatedAt);
  const routed = decideRequestRoute({ text, now, context: previousStates[0]?.requestContext, turnId, fullAccess: input.fullAccess,
    capabilities: { browser: true, search: true, memory: configured.memory, adsModel: configured.ads, computer: configured.computer,
      coding: !!config.tools?.work?.code, chatModel: input.chatModel, writerModel: input.chatModel, planner: true } });
  const routing = { ...routed, ...(state.clarifiedRequest ? {} : state.routing), resolution: state.requestResolution ?? routed.resolution };
  const approvedPath = !!(state.pendingAction || state.pendingHeld || state.pendingTask || state.pendingComputer || state.pendingDesktop || state.desktopRefused);
  const pendingCard = !!(state.questionAnswer || state.site || state.writer || state.planner || state.document || state.adsBrief
    || state.pendingComputation || state.pendingOpen || state.requestResolution?.kind === 'answer' || approvedPath);
  const choice = selectedChoice(state, enabled);
  let memoryHit = !!(routing.resolution.topic && recentRuns.some(row => row.status === 'completed'
    && row.state?.requestResolution?.topic === routing.resolution.topic
    && row.state.trail?.some((entry: BrainState['trail'][number]) => entry.action === 'memory_search' && entry.changed === false && entry.result.length > 0)));
  const actionLedger = restoreActionCompletionLedger(state.actionCompletion, { runId, request: text });
  let siteMatch = false;
  if (config.sites && state.siteId && !state.site && !state.steps && state.trail.every(entry => entry.action === 'asked the user')) {
    try {
      const { brief } = await config.sites.detail(ownerId, state.siteId);
      siteMatch = !!siteCommand(text, brief) || !!(state.sitePendingWant && !/[؟?]\s*$/u.test(text.trim())
        && fulfilWant(brief, state.sitePendingWant.want, text));
    } catch {
      siteMatch = !!state.sitePendingWant && !/[؟?]\s*$/u.test(text.trim());
    }
  }
  const inspected = inspectCascade({ text, routing, now, state, history, previousStates, configured, desktop: config.desktop, fullAccess: input.fullAccess,
    pendingCard, hostIntent: input.runIntent, ownerId, conversationId, runId, confirmed: !!choice,
    actionLedgerValid: !!actionLedger, memoryHit, siteMatch });
  const { memoryHit: readMemoryHit } = deliberationSettings(db);
  if (readMemoryHit && inspected.predicates.some(candidate => candidate.handler === 'memory_recall' && candidate.eligible)) {
    try {
      const query = projectPreferredLanguageMemoryQuery(text) ?? routing.resolution.topic ?? text;
      memoryHit = await readMemoryHit(ownerId, query);
    } catch { /* Missing hints leave the underlying route evidence intact. */ }
  }
  const context = conversationEvidence(text, turnId, config.conversationShadow?.state(conversationId),
    history.filter(turn => turn.role === 'user'), pendingCard ? { id: turnId, kind: 'question_card' } : null);
  let b0: readonly RouterCandidate[] | undefined;
  try { b0 = config.shadowRouter?.topCandidates?.(text); } catch { /* The optional shadow head may be unreadable. */ }
  const result = deliberate({ text, routing, ...inspected, ...context, b0, memoryHit, pendingCard,
    choiceRoute: choice ? handlerRoutes[choice] : undefined, choiceHandler: choice ?? undefined });
  const currentText = recentMessages[0]?.role === 'user' ? String(recentMessages[0].text) : text;
  if (currentText !== text) for (const reading of result.trace.readings) {
    reading.spans = [
      { turn: 'current', start: 0, end: Math.min(currentText.length, 4000) },
      ...(previous?.text === text ? reading.spans.filter(span => span.turn === 'current').map(span => ({ ...span, turn: 'previous' as const })) : []),
    ];
  }
  // A concrete native match owns its inputs, approval and outcome. Keep the proposal advisory on that lane.
  const nativeWork = inspected.legacy.action === 'act' && ['desktop', 'document'].includes(inspected.legacy.handler ?? '');
  const canSteer = !!(enabled && (choice || !nativeWork) && !pendingCard && !state.hands && !state.steps && actionLedger && !actionLedger.events.length
    && !actionLedger.fault && input.runIntent === 'task' && !state.computationMemory && !state.userFactMemory && !state.adsCampaign
    && !state.securePageHash && state.trail.every(entry => entry.action === 'asked the user')
    && !inspected.predicates.some(candidate => cascadeHandler(candidate.handler) && authorityHandlers.has(candidate.handler)));
  return { result, routing, canSteer, choice, turnId, previousRequest: previous?.text ?? null, missingLocation: context.missingLocation };
}

function questionFor(prepared: Prepared, text: string): ChatQuestion {
  const arabic = /\p{Script=Arabic}/u.test(text);
  const options = new Map<DecisionRoute, { id: string; label: string }>();
  for (const candidate of prepared.result.candidates) {
    const label = routeLabels[candidate.route]?.[arabic ? 0 : 1];
    if (!label || !candidate.eligible || !cascadeHandler(candidate.handler) || options.has(candidate.route)) continue;
    options.set(candidate.route, { id: optionPrefix + candidate.handler, label });
    if (options.size === 4) break;
  }
  const prompt = prepared.missingLocation
    ? arabic ? 'لأي موقع تريد معرفة الطقس؟ اذكره عند إعادة كتابة طلب الطقس.' : 'Which location should I use? Include it when you restate the weather request.'
    : options.size > 1 ? arabic ? 'أيّ من هذه الخيارات تقصد؟' : 'Which of these options did you mean?'
    : arabic ? 'ما الإجراء أو الموضوع الذي تقصده تحديدًا؟ أعد كتابة الطلب كاملاً.' : 'Which action or subject do you mean? Restate the full request.';
  return { id: randomUUID(), prompt, options: [...options.values()] };
}

function writeTrace(prepared: Prepared, callbacks: WorkCallbacks) {
  callbacks.ledger(ledger => recordDeliberation(ledger, prepared.result.trace, Date.now(), { turnId: prepared.turnId }));
}

function canUseChoice(choice: CascadeHandler, selected: DecisionOutcome, legacy: DecisionOutcome | undefined) {
  return nativeChoiceHandlers.has(choice) && selected.action === 'act' && selected.handler === choice
    && !!legacy && sameDecision(selected, legacy, true);
}

/** One intake before the unchanged worker cascade. Only explicit opt-in can intervene. */
export async function beginChatDeliberation(input: Intake, callbacks: WorkCallbacks): Promise<boolean> {
  let prepared: Prepared;
  try { prepared = await prepare(input, deliberationSettings(input.db).enabled === true); }
  catch { return false; }
  const { result, routing, canSteer, choice } = prepared;
  const text = input.source.request;
  const arabic = /\p{Script=Arabic}/u.test(text);
  let response: { text: string; question?: ChatQuestion } | undefined;
  result.trace.enforced = false;
  result.trace.legacyObserved = false;
  if (canSteer) {
    if (choice) {
      // The original worker cannot guarantee an alternative branch bypasses an earlier match.
      // Only a choice already on its verified legacy lane can resume without a rewritten request.
      if (canUseChoice(choice, result.outcome, result.trace.legacy)) {
        input.state.trail = [];
        input.state.lastChoice = null;
        input.state.requestClarification = undefined;
      } else {
        const prompt = arabic ? 'كيف تريد صياغة الطلب الكامل لهذا الخيار؟' : 'How would you state the full request for this option?';
        response = { text: prompt, question: { id: randomUUID(), prompt, options: [] } };
        result.trace.chosen = { action: 'ask' };
        result.trace.reasons = ['missing_context'];
        result.trace.changeEvidence = ['explicit_destination', 'clarified_choice'];
        if (result.trace.legacy) result.trace.disagrees = !sameDecision(result.trace.chosen, result.trace.legacy, true);
      }
    }
    if (!response && result.outcome.action === 'act') {
      const projected = input.fullAccess ? projectDeliberationRoute(routing, result.outcome) : routing;
      if (projected !== routing) {
        const { route, intent, handler, availability, missingCapabilities, reason } = projected;
        input.state.routing = { route, intent, handler, availability, missingCapabilities, reason };
        result.trace.routePreference = route;
      }
    } else if (!response && result.outcome.action === 'ask') {
      const question = questionFor(prepared, text);
      response = { text: question.prompt, question };
    } else if (!response && routing.reason === 'account_restriction' && routing.availability === 'restricted') {
      response = { text: gateRefusalText('actor_not_allowed', arabic ? 'ar' : 'en') };
    } else if (!response) {
      response = { text: arabic ? 'لم أجد إجراءً متاحًا يطابق طلبك.' : 'I could not identify an available action that matches your request.' };
    }
  }
  if (response?.question && (input.state.clarificationAttempts ?? 0) >= 2) {
    response = { text: arabic ? 'لم يتضح المطلوب بعد التوضيح. ابدأ طلبًا جديدًا وحدّد الإجراء المقصود.'
      : 'The requested action is still unclear. Start a new request and state the action you intend.' };
    result.trace.chosen = { action: 'abstain' };
    result.trace.reasons = ['missing_context'];
    result.trace.changeEvidence = ['explicit_destination'];
    if (result.trace.legacy) result.trace.disagrees = !sameDecision(result.trace.chosen, result.trace.legacy, true);
  }
  if (response && response.question) {
    const attempts = (input.state.clarificationAttempts ?? 0) + 1;
    input.state.clarificationAttempts = attempts;
    input.state.requestClarification = { attempts };
    input.state.lastChoice = null;
  }
  result.trace.enforced = !!response;
  workReviews.set(input.state, { prepared, input, callbacks });
  writeTrace(prepared, callbacks);
  await callbacks.save();
  if (!response) return false;
  if (response.question) observeFinalDeliberation(input.state, response.text, 'partial', []);
  await callbacks.reply(response.text, response.question);
  return true;
}

/** Review is advisory in this phase and shares the worker's fenced terminal write. */
export function observeFinalDeliberation(state: BrainState, text: string, status: 'completed' | 'partial' | 'blocked', evidence: readonly JudgeEvidence[]) {
  const registered = workReviews.get(state);
  if (!registered) return;
  const { prepared, input, callbacks } = registered;
  const { result } = prepared;
  try {
    const selected = result.trace.chosen;
    const reading = selected.action === 'act' ? result.readings.find(item => item.route === selected.route) : undefined;
    result.trace.review = reviewDeliberationResult({ request: input.source.request, reading, decision: selected.action,
      reply: text, status, previousRequest: prepared.previousRequest, evidence, completion: state.completionReview }, false).record;
    writeTrace(prepared, callbacks);
  } catch { /* Diagnostic review never affects publication. */ }
}
