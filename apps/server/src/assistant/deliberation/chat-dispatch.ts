import { randomUUID } from 'node:crypto';
import type { ChatQuestion } from '@mohassan/contracts';
import { fulfilWant, siteCommand } from '@mohassan/sites';
import { sql, type Kysely } from 'kysely';
import { restoreActionCompletionLedger } from '../action-completion.js';
import type { RunLedger } from '../agent-run.js';
import type { BrainState } from '../brain.js';
import type { ConversationShadow } from '../conversation-state-shadow.js';
import type { JudgeEvidence } from '../judge.js';
import { projectPreferredLanguageMemoryQuery } from '../preferred-language-fact.js';
import { decideRequestRoute } from '../routing-decision.js';
import type { ShadowRouter } from '../router.js';
import type { SitesChatPort } from '../site-builder.js';
import type { WebSequenceAnswer } from '../web-sequence.js';
import { handlerRoutes, type CascadeHandler } from './cascade-handlers.js';
import { inspectCascade, type CascadeInput, type CascadeTurn } from './cascade.js';
import { conversationEvidence } from './conversation-evidence.js';
import { deliberate } from './decision.js';
import { recordDeliberation } from './run-ledger.js';
import { deliberationReadFindings, reviewDeliberationResult, type ReviewFindingCode } from './review.js';
import type { DecisionOutcome, DecisionRoute, Deliberation, RouterCandidate } from './types.js';

interface DispatchConfig {
  deliberationEnabled?: boolean;
  deliberationMemoryHit?: (ownerId: string, query: string) => Promise<boolean>;
  shadowRouter?: ShadowRouter;
  conversationShadow?: ConversationShadow;
  desktop?: unknown;
  documents?: unknown;
  sites?: Pick<SitesChatPort, 'detail'>;
  knowledgeSearch?: unknown;
  skillAnswer?: unknown;
  adsModel?: unknown;
  mind?: unknown;
  mindDeps?: unknown;
  tools?: { memory?: unknown; computer?: unknown; work?: { inventory?: unknown; code?: unknown } };
}
interface DispatchInput {
  db: Kysely<any>;
  config: DispatchConfig;
  ownerId: string;
  conversationId: string;
  runId: string;
  hostIntent: string;
  text: string;
  evaluatedAt: number;
  state: BrainState;
  fullAccess: boolean;
  chatModel: boolean;
  historyLimit: number;
  ledger: (change: (ledger: RunLedger) => void) => void;
}

const activeDispatches = new WeakMap<BrainState, ChatDispatch>();
const choices = 'deliberation-';
const forcedPaths = new Set<CascadeHandler>([
  'member_browser_blocked', 'request_constraint', 'literal_clarification', 'ledger_blocked', 'verify_note',
  'verify_memory', 'save_fact', 'browser_review', 'browser_restore', 'pending_action', 'desktop_refused',
]);

export const dispatchFor = (state: BrainState) => activeDispatches.get(state);

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

const sameOutcome = (first: DecisionOutcome, second: DecisionOutcome) => first.action === second.action
  && (first.action !== 'act' || second.action === 'act' && first.route === second.route
    && (!first.handler || !second.handler || first.handler === second.handler));

class ChatDispatch {
  private actual?: DecisionOutcome;
  private parts?: readonly WebSequenceAnswer[];
  private readRevision?: readonly ReviewFindingCode[];

  constructor(private readonly input: DispatchInput, private readonly result: Deliberation,
    readonly enabled: boolean, readonly confirmed: boolean, private readonly previousRequest: string | null,
    private readonly missingLocation: boolean, private readonly turnId: string,
    private readonly selected: DecisionOutcome = result.outcome) {}

  write() {
    const legacy = this.enabled ? this.result.trace.legacy : this.actual ?? this.result.trace.legacy;
    this.input.ledger(ledger => recordDeliberation(ledger, {
      ...this.result.trace, chosen: this.selected, legacy, enforced: this.enabled, legacyObserved: !this.enabled && !!this.actual,
      ...(legacy ? { disagrees: !sameOutcome(this.selected, legacy) } : {}),
    }, Date.now(), { turnId: this.turnId }));
  }

  permits(handler: CascadeHandler) {
    if (!this.enabled) return true;
    return this.selected.action === 'act' && handlerRoutes[handler] === this.selected.route
      && (!this.selected.handler || this.selected.handler === handler);
  }

  selects(handler: CascadeHandler) { return this.enabled && this.permits(handler); }

  usesBrowser() {
    if (!this.enabled) return true;
    const selected = this.selected;
    return selected.action === 'act' && (['web_search', 'browser_command', 'capture', 'news', 'ads'].includes(selected.route)
      || selected.handler === 'web_sequence' || selected.handler === 'mind' || selected.handler === 'model');
  }

  enter(handler: CascadeHandler, action: DecisionOutcome['action'] = 'act') {
    if (!this.permits(handler)) return false;
    this.observe(handler, action);
    return true;
  }

  observe(handler: CascadeHandler, action: DecisionOutcome['action'] = 'act') {
    if (this.actual) return;
    this.actual = action === 'act' ? { action, handler, route: handlerRoutes[handler] } : { action };
    this.write();
  }

  observePause(status: string) {
    if (status !== 'waiting_user') return;
    this.actual = { action: 'ask' };
    this.write();
  }

  observeFailure() {
    if (!this.actual) this.observe('ledger_blocked', 'abstain');
  }

  async intercept(respond: (text: string, question?: ChatQuestion) => Promise<void>) {
    if (!this.enabled || this.selected.action === 'act') return false;
    const ar = /\p{Script=Arabic}/u.test(this.input.text);
    if (this.selected.action === 'abstain') {
      await respond(ar ? 'لم أجد إجراءً متاحًا يطابق طلبك.' : 'I could not identify an available action that matches your request.');
      return true;
    }
    const options = new Map<DecisionRoute, { id: string; label: string }>();
    for (const candidate of this.result.candidates) {
      const label = routeLabels[candidate.route]?.[ar ? 0 : 1];
      if (!label || !candidate.eligible || !isCascadeHandler(candidate.handler) || options.has(candidate.route)) continue;
      options.set(candidate.route, { id: choices + candidate.handler, label });
      if (options.size === 4) break;
    }
    const prompt = this.missingLocation
      ? ar ? 'لأي موقع تريد معرفة الطقس؟ اذكره عند إعادة كتابة طلب الطقس.' : 'Which location should I use? Include it when you restate the weather request.'
      : options.size > 1 ? ar ? 'أيّ من هذه الخيارات تقصد؟' : 'Which of these options did you mean?'
      : ar ? 'ما الإجراء أو الموضوع الذي تقصده تحديدًا؟' : 'Which action or subject do you mean?';
    const question: ChatQuestion = { id: randomUUID(), prompt, options: [...options.values()] };
    this.input.state.requestClarification = { attempts: (this.input.state.clarificationAttempts ?? 0) + 1 };
    this.input.state.clarificationAttempts = this.input.state.requestClarification.attempts;
    await respond(prompt, question);
    return true;
  }

  unavailable() {
    if (!this.enabled || this.actual) return null;
    return /\p{Script=Arabic}/u.test(this.input.text) ? 'لم أتمكن من تنفيذ الإجراء المحدد.' : 'I could not carry out the selected action.';
  }

  rememberParts(parts: readonly WebSequenceAnswer[]) { this.parts = parts; }

  findReadRevision(reply: string, status: 'completed' | 'partial' | 'blocked', evidence: readonly JudgeEvidence[],
    asked?: { question: string; previous: string | null }, retry = false) {
    if (!this.enabled || this.selected.action !== 'act' || this.readRevision && !retry) return null;
    return deliberationReadFindings({
      request: asked?.question ?? this.input.text, previousRequest: asked ? asked.previous : this.previousRequest,
      reading: asked ? undefined : this.reading(),
      decision: 'act', reply, status, evidence,
    });
  }

  noteReadRevision(findings: readonly ReviewFindingCode[] = []) { this.readRevision = findings; }
  mayRevise() { return !this.enabled || !this.readRevision; }

  review(reply: string, status: 'completed' | 'partial' | 'blocked', evidence: readonly JudgeEvidence[], protectedReply = false) {
    const checked = reviewDeliberationResult({
      request: this.input.text, previousRequest: this.previousRequest, reading: this.reading(),
      decision: this.enabled ? this.selected.action : this.actual?.action ?? this.selected.action,
      reply, status, evidence, completion: this.input.state.completionReview,
      parts: this.parts, readRevision: this.readRevision, protectedReply,
    }, this.enabled);
    this.result.trace.review = checked.record;
    this.write();
    return checked;
  }

  private reading() {
    const route = this.selected.action === 'act' ? this.selected.route : undefined;
    return this.result.readings.find(reading => reading.route === route) ?? this.result.readings[0];
  }
}

function isCascadeHandler(value: unknown): value is CascadeHandler {
  return typeof value === 'string' && Object.hasOwn(handlerRoutes, value);
}

async function prepareChatDispatch(input: DispatchInput): Promise<ChatDispatch | undefined> {
  const { db, state, config, ownerId, conversationId, runId, text } = input;
  try {
    const [recentMessages, recentRuns] = await Promise.all([
      db.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.id', 'm.role', 'm.text']).where('m.conversation_id', '=', conversationId).where('c.owner_id', '=', ownerId)
        .orderBy('m.created_at', 'desc').orderBy('m.role', 'desc').limit(input.historyLimit + 1).execute(),
      db.selectFrom('chat_runs').select(['state', 'status']).where('owner_id', '=', ownerId).where('conversation_id', '=', conversationId)
        .where('id', '!=', runId).orderBy('created_at', 'desc').limit(8).execute(),
    ]);
    const history = recentMessages.slice(1).reverse().filter(row => row.role === 'user' || row.role === 'assistant') as CascadeTurn[];
    const previousStates = recentRuns.map(row => row.state).filter(Boolean) as BrainState[];
    const previous = history.findLast(turn => turn.role === 'user') ?? null;
    const currentTurnId = typeof recentMessages[0]?.id === 'string' ? recentMessages[0].id : runId;
    const configured: NonNullable<CascadeInput['configured']> = {
      desktop: !!config.desktop, computer: !!config.tools?.computer, documents: !!config.documents, sites: !!config.sites,
      memory: !!config.tools?.memory, knowledge: !!config.knowledgeSearch, skills: !!config.skillAnswer,
      inventory: !!config.tools?.work?.inventory, ads: !!config.adsModel, mind: !!(config.mind && config.mindDeps), chatModel: input.chatModel,
    };
    const now = new Date(input.evaluatedAt);
    const routed = decideRequestRoute({ text, now, context: previousStates[0]?.requestContext, turnId: currentTurnId, fullAccess: input.fullAccess,
      capabilities: { browser: true, search: true, memory: configured.memory, adsModel: configured.ads, computer: configured.computer,
        coding: !!config.tools?.work?.code, chatModel: input.chatModel, writerModel: input.chatModel, planner: true } });
    const routing = { ...routed, ...(state.clarifiedRequest ? {} : state.routing), resolution: state.requestResolution ?? routed.resolution };
    const approvedPath = !!(state.pendingAction || state.pendingHeld || state.pendingTask || state.pendingComputer || state.pendingDesktop || state.desktopRefused);
    const pendingCard = !!(state.questionAnswer || state.site || state.writer || state.planner || state.document || state.adsBrief
      || state.pendingComputation || state.pendingOpen || state.requestResolution?.kind === 'answer' || approvedPath);
    const confirmedHandler = state.lastChoice?.startsWith(choices) ? state.lastChoice.slice(choices.length) : undefined;
    const confirmed = input.config.deliberationEnabled === true && isCascadeHandler(confirmedHandler)
      && !state.steps && state.trail.every(entry => entry.action === 'asked the user');
    let memoryHit = !!(routing.resolution.topic && recentRuns.some(row => row.status === 'completed'
      && row.state?.requestResolution?.topic === routing.resolution.topic
      && row.state.trail?.some((entry: BrainState['trail'][number]) => entry.action === 'memory_search' && entry.changed === false && entry.result.length > 0)));
    const actionLedgerValid = Boolean(restoreActionCompletionLedger(state.actionCompletion, { runId, request: text }));
    let siteMatch = false;
    if (config.sites && state.siteId && !state.site && !state.steps && state.trail.every(entry => entry.action === 'asked the user')) {
      try {
        const { brief } = await config.sites.detail(ownerId, state.siteId);
        siteMatch = !!siteCommand(text, brief) || !!(state.sitePendingWant && !/[؟?]\s*$/u.test(text.trim())
          && fulfilWant(brief, state.sitePendingWant.want, text));
      } catch {
        // Pending site content remains local if its brief could not be read.
        siteMatch = !!state.sitePendingWant && !/[؟?]\s*$/u.test(text.trim());
      }
    }
    const inspected = inspectCascade({ text, routing, now, state, history, previousStates, configured, fullAccess: input.fullAccess,
      pendingCard, hostIntent: input.hostIntent, ownerId, conversationId, runId, confirmed, actionLedgerValid, memoryHit, siteMatch });
    if (config.deliberationMemoryHit && inspected.predicates.some(candidate => candidate.handler === 'memory_recall' && candidate.eligible)) {
      try {
        const query = projectPreferredLanguageMemoryQuery(text) ?? routing.resolution.topic ?? text;
        memoryHit = await config.deliberationMemoryHit(ownerId, query);
      } catch { /* The optional read-only memory hint does not settle a route. */ }
    }
    const context = conversationEvidence(text, currentTurnId, config.conversationShadow?.state(conversationId),
      history.filter(turn => turn.role === 'user'), pendingCard ? { id: currentTurnId, kind: 'question_card' } : null);
    let b0: readonly RouterCandidate[] | undefined;
    try { b0 = config.shadowRouter?.topCandidates?.(text); } catch { /* A shadow head may be unreadable. */ }
    const result = deliberate({ text, routing, ...inspected, ...context, b0, memoryHit, pendingCard,
      choiceRoute: confirmed && isCascadeHandler(confirmedHandler) ? handlerRoutes[confirmedHandler] : undefined,
      choiceHandler: confirmed ? confirmedHandler : undefined });
    const currentText = recentMessages[0]?.role === 'user' ? String(recentMessages[0].text) : text;
    if (currentText !== text) {
      for (const reading of result.trace.readings) {
        reading.spans = [
          { turn: 'current', start: 0, end: Math.min(currentText.length, 4000) },
          ...(previous?.text === text ? reading.spans.filter(span => span.turn === 'current').map(span => ({ ...span, turn: 'previous' as const })) : []),
        ];
      }
    }
    const forced = inspected.legacy.action === 'act' && isCascadeHandler(inspected.legacy.handler) && forcedPaths.has(inspected.legacy.handler);
    const enable = config.deliberationEnabled === true && !forced && !pendingCard && !approvedPath && !state.hands && !state.steps
      && actionLedgerValid && input.hostIntent === 'task' && !state.computationMemory
      && !state.userFactMemory && !state.adsCampaign && !state.securePageHash
      && !inspected.predicates.some(candidate => ['member_browser_blocked', 'request_constraint', 'literal_clarification'].includes(candidate.handler))
      && (state.trail.every(entry => entry.action === 'asked the user'));
    let chosen = result.outcome;
    if (confirmed) {
      state.lastChoice = null;
      state.requestClarification = undefined;
      if (chosen.action !== 'act' || chosen.handler !== confirmedHandler) {
        chosen = { action: 'abstain' };
        result.trace.reasons = ['missing_capability'];
        result.trace.changeEvidence = ['missing_capability'];
        result.trace.confidence = 1;
      }
    }
    const dispatch = new ChatDispatch(input, result, enable, confirmed, previous?.text ?? null, context.missingLocation, currentTurnId, chosen);
    activeDispatches.set(state, dispatch);
    dispatch.write();
    return dispatch;
  } catch {
    // Observation must never change the default execution path.
    return undefined;
  }
}

export async function beginChatDeliberation(input: DispatchInput & {
  save: () => Promise<void>;
  ask: (text: string, question: ChatQuestion) => Promise<void>;
  finish: (text: string) => Promise<void>;
}): Promise<{ dispatch: ChatDispatch | undefined; ended: boolean }> {
  const dispatch = await prepareChatDispatch(input);
  if (!dispatch) {
    const safelyStoppable = input.config.deliberationEnabled === true && input.hostIntent === 'task'
      && !input.state.steps && !input.state.trail.length && !input.state.computationMemory && !input.state.userFactMemory;
    if (!safelyStoppable) return { dispatch, ended: false };
    input.ledger(ledger => recordBoundDeliberation(ledger, 'ledger_blocked', input.text.length));
    await input.finish(/\p{Script=Arabic}/u.test(input.text) ? 'لم أتمكن من التحقق من المسار المناسب لهذا الطلب.' : 'I could not verify a suitable action for this request.');
    return { dispatch, ended: true };
  }
  await input.save();
  const ended = await dispatch.intercept((text, question) => question ? input.ask(text, question) : input.finish(text));
  return { dispatch, ended };
}

export function dispatchGate(state: BrainState, handler: CascadeHandler) {
  return dispatchFor(state)?.enter(handler) ?? true;
}

export function dispatchPermit(state: BrainState, handler: CascadeHandler) {
  return dispatchFor(state)?.permits(handler) ?? true;
}

export function observeHandler(state: BrainState, handler: CascadeHandler, action: DecisionOutcome['action'] = 'act') {
  dispatchFor(state)?.observe(handler, action);
}

export async function persistFailedDeliberation(tx: Kysely<any>, runId: string, state: BrainState | undefined) {
  if (!state || !dispatchFor(state)) return;
  dispatchFor(state)?.observeFailure();
  if (!state.agentRun?.deliberation) return;
  const { deliberation, earlierDeliberation } = state.agentRun;
  await tx.updateTable('chat_runs').set({
    state: sql`jsonb_set(coalesce(state, '{}'::jsonb), '{agentRun}',
      coalesce(state->'agentRun', '{}'::jsonb) || ${JSON.stringify({ deliberation, earlierDeliberation })}::jsonb, true)`,
  }).where('id', '=', runId).execute();
}

export function recordBoundDeliberation(ledger: RunLedger, handler: 'stop_run' | 'ledger_blocked', length = 0) {
  const route = handlerRoutes[handler];
  const stopping = handler === 'stop_run';
  const chosen: DecisionOutcome = stopping ? { action: 'act', route, handler } : { action: 'abstain' };
  recordDeliberation(ledger, {
    version: 1, enforced: false, chosen, legacy: chosen, disagrees: false, confidence: 1, legacyObserved: true,
    candidates: [{ route, handler, score: 1, evidence: ['cascade_match'] }],
    reasons: [stopping ? 'clarified_choice' : 'scope_conflict'],
    changeEvidence: [stopping ? 'pending_card' : 'request_scope'],
    readings: [{ route, scope: 'unknown', spans: length > 0 ? [{ turn: 'current', start: 0, end: Math.min(4000, length) }] : [] }],
  }, Date.now(), { newTurn: true });
}
