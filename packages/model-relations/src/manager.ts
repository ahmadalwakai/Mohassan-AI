import { createHmac, randomBytes } from 'node:crypto';
import { ArbiterBrain, type ArbiterInput } from './arbiter.js';
import {
  isMonitorDecisionClaim, isRecord, makeMonitorArbiterInput, monitorDecisionModelId, MonitorDecisionPromotion,
  monitorDecisionType, monitorHeadComponent, monitorHeadMayOverride, type MonitorDecisionClaim, type MonitorDecisionContext,
  type MonitorDecisionHeadInput, type MonitorDecisionLabel,
} from './monitor-decision.js';
import type { ModelRunResult } from './runtime.js';

const arbiterFlags = {
  routing: 'MOHASSAN_ARBITER_ROUTING',
  'question-rewrite': 'MOHASSAN_ARBITER_QUESTION_REWRITE',
  'local-computation': 'MOHASSAN_ARBITER_LOCAL_COMPUTATION',
  'compound-plan': 'MOHASSAN_ARBITER_COMPOUND_PLAN',
  'monitor-context': 'MOHASSAN_ARBITER_MONITOR_CONTEXT',
} as const;
export type ArbiterDecisionType = keyof typeof arbiterFlags;

// Add entries only with per-area and per-language receipts for both development splits.
const promotedDecisionTypes: readonly ArbiterDecisionType[] = [];

export interface ArbiterDecisionLog extends ArbiterInput {
  selected: string;
  proposed: string;
  confidence: number | null;
  threshold: number | null;
  reason: string;
  elapsedMs: number;
  modelOutcome?: Outcome;
  explanation?: ReturnType<ArbiterBrain['choose']>['reasons'];
}

const routes = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing',
  'planning', 'coding', 'chat', 'reply', 'clarify', 'image', 'media', 'unsupported'] as const;
const refusals = ['allow', 'refuse', 'out_of_scope', 'unsafe'] as const;
const speechActs = ['request', 'smalltalk'] as const;
const turnTypes = ['new', 'follow_up', 'answer', 'ambiguous'] as const;
const sufficiencyLabels = ['sufficient', 'insufficient'] as const;
const judgeLabels = ['send', 'fix', 'withhold'] as const;

type OneOf<T extends readonly string[]> = T[number];
type Refusal = OneOf<typeof refusals>;
type SpeechAct = OneOf<typeof speechActs>;
type TurnType = OneOf<typeof turnTypes>;
type Sufficiency = OneOf<typeof sufficiencyLabels>;
type JudgeDecision = OneOf<typeof judgeLabels>;
type StageName = 'refusal' | 'speech-act' | 'router' | 'arithmetic' | 'turn-type' | 'question-rewrite' | 'evidence-reader' | 'answer-sentence' | 'reply-judge' | 'image-reader';
type RunFailure = Extract<ModelRunResult, { ok: false }>;
type Outcome = 'ok' | 'abstained' | 'invalid-output' | RunFailure['reason'] | NonNullable<RunFailure['code']>;

export interface TurnEvidence {
  kind: 'page' | 'memory' | 'knowledge' | 'computed';
  text: string;
  url?: string;
  title?: string;
}

export interface TurnObservation {
  id: string;
  text: string;
  previousText?: string | null;
  arbiter?: readonly ArbiterDecisionLog[];
  baseline: {
    route: string;
    refusal: Refusal;
    speechAct: SpeechAct;
    turnType: TurnType;
    arithmeticValue?: string;
    imageReadMs?: number;
    question?: string | null;
    evidence?: readonly TurnEvidence[];
    evidenceSufficiency?: Sufficiency;
    answer?: string;
    answerSentence?: string;
    judge?: JudgeDecision;
    status?: string;
  };
}

export interface JudgeObservation {
  question: string;
  reply: string;
  previous?: string | null;
  evidence?: readonly TurnEvidence[];
  status?: string;
}

interface ManagerOptions {
  maxTurnMs?: number;
  hashKey?: string | Buffer;
  judge?: (input: JudgeObservation) => JudgeDecision;
  arbiter?: ArbiterBrain;
  promotedDecisionTypes?: readonly ArbiterDecisionType[];
  env?: NodeJS.ProcessEnv;
}

export interface DecisionValue {
  hash: string;
  label?: string;
}

export interface ModelObservation {
  model: string;
  outcome: Outcome;
  attempted: boolean;
  elapsedMs: number;
  returned?: DecisionValue;
  disagreed?: boolean;
  fallback?: 'existing-rules';
}

export interface StageObservation {
  stage: StageName;
  winner: 'existing-rules';
  rule?: DecisionValue;
  review?: { outcome: 'ok' | 'unhealthy'; elapsedMs: number; verdict?: DecisionValue; disagreed?: boolean };
  models: ModelObservation[];
}

export interface TurnDecisionLog {
  event: 'model_relations_turn';
  mode: 'shadow';
  turnHash: string;
  requestHash: string;
  replyHash?: string;
  elapsedMs: number;
  arbiter?: readonly ArbiterDecisionLog[];
  arbitration: {
    winner: 'existing-rules';
    reason: 'host-refusal' | 'host-smalltalk' | 'shadow';
    proposal?: { source: string; route: DecisionValue };
  };
  stages: StageObservation[];
}

interface SummaryCounts {
  considered: number;
  attempted: number;
  compared: number;
  disagreements: number;
  fallbacks: number;
}

interface ModelRunner {
  run(modelId: string, input: unknown): Promise<ModelRunResult>;
}

type Decode = (output: unknown) => string | null | undefined;

function entry(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function label<T extends readonly string[]>(value: unknown, allowed: T): OneOf<T> | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value as OneOf<T> : undefined;
}

function classify(allowed: readonly string[], field = 'label'): Decode {
  return output => {
    const result = entry(output);
    if (result?.abstained === true || result?.[field] === null) return null;
    return label(result?.[field], allowed);
  };
}

function select(candidates: readonly string[]): Decode {
  return output => {
    const result = entry(output);
    if (result?.abstained === true || result?.selectedIndex === null) return null;
    const index = result?.selectedIndex;
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) return candidates[index];
    return undefined;
  };
}

function arithmeticValue(output: unknown): string | null | undefined {
  if (output === null) return null;
  const value = entry(output)?.value;
  return typeof value === 'string' && value.length <= 256 && /^-?\d+(?:\.\d+|\/\d+)?$/u.test(value) ? value : undefined;
}

function distinctText(items: readonly string[]): string[] {
  return [...new Set(items.map(text => text.trim()).filter(Boolean))];
}

function sentences(evidence: readonly TurnEvidence[]): string[] {
  return distinctText(evidence.flatMap(({ text }) => text.split(/\n+|(?<=[.!?؟])\s+/u)))
    .filter(text => text.length <= 600).slice(0, 24);
}

/** Evaluates only already available turn data. Its output is an observation without dispatch authority. */
export class ModelRelationsManager {
  private readonly hashKey: string | Buffer;
  private readonly maxTurnMs: number;
  private readonly counts = new Map<string, SummaryCounts>();
  private readonly arbiter: ArbiterBrain;
  private readonly promoted: ReadonlySet<ArbiterDecisionType>;
  private readonly env: NodeJS.ProcessEnv;
  private turns = 0;

  constructor(private readonly runtime: ModelRunner, private readonly options: ManagerOptions = {}) {
    this.hashKey = options.hashKey ?? randomBytes(32);
    this.maxTurnMs = options.maxTurnMs ?? 1500;
    this.arbiter = options.arbiter ?? new ArbiterBrain();
    this.promoted = new Set(options.promotedDecisionTypes ?? promotedDecisionTypes);
    this.env = options.env ?? process.env;
    if (!Number.isFinite(this.maxTurnMs) || this.maxTurnMs < 1) throw new RangeError('Model relations turn budget must be positive');
  }

  canApplyArbiter(type: ArbiterDecisionType): boolean {
    const flag = arbiterFlags[type];
    return this.env.MOHASSAN_MODEL_RELATIONS !== 'off' && this.promoted.has(type)
      && this.env[flag] === '1' && this.env[`${flag}_KILL`] !== '1';
  }

  /** Selects an already available claim without asking any model to run or loading an artifact. */
  arbitrate(input: ArbiterInput, options: { forced?: string; protected?: boolean; shadowOnly?: boolean;
    monitorPromotion?: MonitorDecisionPromotion } = {}): ArbiterDecisionLog {
    const started = performance.now();
    const { type, precedence, claimants } = input;
    const flag = Object.hasOwn(arbiterFlags, type) ? arbiterFlags[type as ArbiterDecisionType] : undefined;
    const decision = (selected: string, proposed: string, reason: string, confidence: number | null = null,
      threshold: number | null = null, explanation?: ArbiterDecisionLog['explanation']): ArbiterDecisionLog => ({
      ...input, selected, proposed, reason, confidence, threshold, elapsedMs: performance.now() - started,
      ...(explanation?.length ? { explanation } : {}),
    });
    if (options.protected) return decision(precedence, precedence, 'protected');
    const monitor = type === monitorDecisionType;
    if (!monitor && !options.shadowOnly && options.forced && flag && claimants.some(claim => claim.component === options.forced)) {
      return decision(options.forced, options.forced, 'forced');
    }
    if (this.env.MOHASSAN_MODEL_RELATIONS === 'off') return decision(precedence, precedence, 'off');
    if (flag && this.env[`${flag}_KILL`] === '1') return decision(precedence, precedence, 'killed');
    const monitorPromotion = monitor && options.monitorPromotion instanceof MonitorDecisionPromotion ? options.monitorPromotion : undefined;
    const pick = (monitorPromotion?.brain ?? this.arbiter).choose(input);
    const proposed = pick.proposedChoice ?? pick.choice;
    const reason = pick.choice === precedence ? pick.reason
      : options.shadowOnly || (monitor && !monitorPromotion) || !flag || !this.canApplyArbiter(type as ArbiterDecisionType) ? 'shadow' : pick.reason;
    const selected = reason === 'higher-pass-likelihood' ? pick.choice : precedence;
    return decision(selected, proposed, reason, pick.confidence, pick.threshold, pick.reasons);
  }

  async reviewMonitorDecision(context: MonitorDecisionContext, baseline: MonitorDecisionClaim, features: MonitorDecisionHeadInput,
    options: { protected?: boolean } = {}): Promise<{ action: MonitorDecisionLabel; log: ArbiterDecisionLog }> {
    const started = performance.now();
    let learned: MonitorDecisionClaim | undefined;
    let promotion: MonitorDecisionPromotion | undefined;
    let modelOutcome: Outcome | undefined;
    if (this.env.MOHASSAN_MODEL_RELATIONS !== 'off') {
      try {
        const result = await this.runtime.run(monitorDecisionModelId,
          { frameFeatures: features.frameFeatures, textFeatureIds: features.textFeatureIds });
        if (!result.ok) modelOutcome = result.reason;
        else if (isMonitorDecisionClaim(result.output)) {
          learned = { label: result.output.label, score: result.output.score };
          const candidate = (result.output as MonitorDecisionClaim & { promotion?: unknown }).promotion;
          if (candidate instanceof MonitorDecisionPromotion) promotion = candidate;
          modelOutcome = 'ok';
        } else modelOutcome = isRecord(result.output) && result.output.label === null ? 'abstained' : 'invalid-output';
      } catch { modelOutcome = 'unhealthy'; }
    }
    const input = makeMonitorArbiterInput(context, baseline, learned);
    const log = this.arbitrate(input, {
      monitorPromotion: promotion,
      shadowOnly: !learned || !monitorHeadMayOverride(baseline.label, learned.label, options.protected),
    });
    return { action: log.selected === monitorHeadComponent && learned ? learned.label : baseline.label,
      log: { ...log, ...(modelOutcome ? { modelOutcome } : {}), elapsedMs: performance.now() - started } };
  }

  summary() {
    return { turns: this.turns, models: [...this.counts].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([model, counts]) => ({ model, ...counts,
      disagreementRate: counts.compared ? counts.disagreements / counts.compared : null })) };
  }

  async inspect(turn: TurnObservation, review = this.options.judge): Promise<TurnDecisionLog> {
    const started = performance.now();
    const deadline = { at: started + this.maxTurnMs, expired: false };
    const stages: StageObservation[] = [];
    const { baseline } = turn;
    const request = turn.text.slice(0, 8000);
    const previous = turn.previousText?.slice(0, 4000);
    const textInput = { text: request };
    const requestInput = { ...textInput, ...(previous ? { previousText: previous } : {}) };
    const history = previous ? [previous] : [];

    const value = (stage: StageName, text: string, allowed?: readonly string[]): DecisionValue => {
      const safeLabel = allowed && label(text, allowed);
      return { hash: this.hash(stage, text), ...(safeLabel ? { label: safeLabel } : {}) };
    };
    const stage = (name: StageName, rule?: string | null, allowed?: readonly string[]): StageObservation => {
      const decision: StageObservation = { stage: name, winner: 'existing-rules',
        ...(rule != null ? { rule: value(name, rule, allowed) } : {}), models: [] };
      stages.push(decision);
      return decision;
    };
    const ask = (decision: StageObservation, id: string, input: unknown, decode: Decode, allowed?: readonly string[]) =>
      this.ask(decision, id, input, decode, text => value(decision.stage, text, allowed), deadline);
    const complete = (arbitration: TurnDecisionLog['arbitration']): TurnDecisionLog => {
      this.turns++;
      return { event: 'model_relations_turn', mode: 'shadow', turnHash: this.hash('turn', turn.id),
        requestHash: this.hash('request', turn.text),
        ...(turn.arbiter?.length ? { arbiter: turn.arbiter } : {}),
        ...(baseline.answer !== undefined ? { replyHash: this.hash('reply', baseline.answer) } : {}),
        elapsedMs: performance.now() - started, arbitration, stages };
    };

    if (baseline.route === 'image' && baseline.imageReadMs !== undefined) {
      stage('router', 'image', routes);
      const reader = stage('image-reader');
      this.record(reader, 'ocr', 'ok', true, baseline.imageReadMs, value('image-reader', 'read', ['read']));
      stage('answer-sentence', baseline.answer);
      return complete({ winner: 'existing-rules', reason: 'shadow' });
    }

    const refusal = stage('refusal', baseline.refusal, refusals);
    const refusalModel = await ask(refusal, 'refusal', textInput, classify(refusals), refusals);
    const scratchRefusal = await ask(refusal, 'scratch-refusal', requestInput, classify(refusals), refusals);
    const speech = stage('speech-act', baseline.speechAct, speechActs);
    const speechModel = await ask(speech, 'scratch-speech-act', requestInput, classify(speechActs), speechActs);
    const routing = stage('router', baseline.route, routes);
    const b2Route = await ask(routing, 'router-b2', textInput, classify(routes, 'route'), routes);
    const b0Route = b2Route ? undefined : await ask(routing, 'router-b0', textInput, classify(routes, 'route'), routes);
    const scratchRoute = await ask(routing, 'scratch-route', requestInput, classify(routes), routes);

    const arbitration: TurnDecisionLog['arbitration'] = { winner: 'existing-rules',
      reason: baseline.refusal !== 'allow' ? 'host-refusal' : baseline.speechAct === 'smalltalk' ? 'host-smalltalk' : 'shadow' };
    const refusalSource = refusalModel && refusalModel !== 'allow' ? 'refusal'
      : scratchRefusal && scratchRefusal !== 'allow' ? 'scratch-refusal' : undefined;
    const proposal = refusalSource ? { route: 'unsupported', source: refusalSource }
      : speechModel === 'smalltalk' ? { route: 'chat', source: 'scratch-speech-act' }
      : b2Route ? { route: b2Route, source: 'router-b2' }
      : b0Route ? { route: b0Route, source: 'router-b0' }
      : scratchRoute ? { route: scratchRoute, source: 'scratch-route' } : undefined;
    if (proposal) arbitration.proposal = { source: proposal.source, route: value('router', proposal.route, routes) };

    const arithmetic = stage('arithmetic', baseline.arithmeticValue);
    if (baseline.route === 'compute' && baseline.refusal === 'allow') {
      await ask(arithmetic, 'arithmetic', { text: request }, arithmeticValue);
    }

    const turnType = stage('turn-type', baseline.turnType, turnTypes);
    const typeModel = previous && baseline.turnType !== 'answer'
      ? await ask(turnType, 'scratch-follow-up', requestInput, classify(turnTypes), turnTypes) : undefined;
    const shadowType = typeModel ?? baseline.turnType;
    const ruleQuestion = baseline.question?.trim() || request.trim();
    const rewrite = stage('question-rewrite', ruleQuestion);
    const questionCandidates = distinctText([ruleQuestion, request]);
    const canRead = baseline.refusal === 'allow' && baseline.speechAct !== 'smalltalk';
    const shadowRoute = canRead ? proposal?.route ?? baseline.route : baseline.route;
    const lookup = canRead && (shadowRoute === 'web_search' || shadowRoute === 'news' || Boolean(baseline.evidence?.length));
    const question = (lookup && shadowType === 'follow_up' && questionCandidates.length > 1
      ? await ask(rewrite, 'question-edit', { text: request, history, candidates: questionCandidates }, select(questionCandidates))
      : undefined) ?? ruleQuestion;

    const evidence = (baseline.evidence ?? []).slice(0, 4).map(item => ({ ...item, text: item.text.slice(0, 8000) }));
    const reader = stage('evidence-reader', baseline.evidenceSufficiency, sufficiencyLabels);
    const readerModel = lookup && evidence.length && question
      ? await ask(reader, 'head-sufficiency', { text: question, history: evidence.map(item => item.text) },
        classify(sufficiencyLabels), sufficiencyLabels) : undefined;
    const sufficiency = readerModel ?? baseline.evidenceSufficiency;
    const answerStage = stage('answer-sentence', baseline.answerSentence);
    const candidates = lookup && sufficiency !== 'insufficient' && question ? sentences(evidence) : [];
    const answer = (candidates.length > 1
      ? await ask(answerStage, 'head-answer-sentence', { text: question, candidates }, select(candidates))
      : undefined) ?? baseline.answer;

    const judgeStage = stage('reply-judge', baseline.judge, judgeLabels);
    if (review && answer && question && !deadline.expired && performance.now() < deadline.at) {
      const judging = performance.now();
      const context = { previous, status: baseline.status, evidence };
      try {
        const verdict = value('reply-judge', review({ ...context, question, reply: answer }), judgeLabels);
        if (!judgeStage.rule && baseline.answer) {
          judgeStage.rule = answer === baseline.answer && question === ruleQuestion ? verdict
            : value('reply-judge', review({ ...context, question: ruleQuestion, reply: baseline.answer }), judgeLabels);
        }
        judgeStage.review = { outcome: 'ok', elapsedMs: performance.now() - judging, verdict,
          ...(judgeStage.rule ? { disagreed: verdict.hash !== judgeStage.rule.hash } : {}) };
      } catch { judgeStage.review = { outcome: 'unhealthy', elapsedMs: performance.now() - judging }; }
    }

    return complete(arbitration);
  }

  private hash(domain: string, value: string): string {
    return createHmac('sha256', this.hashKey).update(domain).update('\0').update(value).digest('hex');
  }

  private async ask(decision: StageObservation, id: string, input: unknown, decode: Decode,
    value: (text: string) => DecisionValue, deadline: { at: number; expired: boolean }): Promise<string | undefined> {
    const started = performance.now();
    const attempted = started < deadline.at && !deadline.expired;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: Outcome;
    let result: string | null | undefined;
    try {
      if (!attempted) outcome = 'timeout';
      else {
        const timeout = new Promise<ModelRunResult>(resolve => {
          timer = setTimeout(() => {
            deadline.expired = true;
            resolve({ ok: false, reason: 'timeout', elapsedMs: performance.now() - started });
          }, Math.ceil(deadline.at - started));
        });
        const run = await Promise.race([this.runtime.run(id, input), timeout]);
        if (deadline.expired || performance.now() >= deadline.at) outcome = 'timeout';
        else if (!run.ok) outcome = run.code ?? run.reason;
        else {
          result = decode(run.output);
          outcome = result === null ? 'abstained' : result === undefined ? 'invalid-output' : 'ok';
        }
      }
    } catch { outcome = 'unhealthy'; }
    finally { clearTimeout(timer); }
    this.record(decision, id, outcome, attempted, performance.now() - started, result == null ? undefined : value(result));
    return result ?? undefined;
  }

  private record(decision: StageObservation, id: string, outcome: Outcome, attempted: boolean, elapsedMs: number, returned?: DecisionValue) {
    const disagreed = !returned || !decision.rule ? undefined
      : decision.stage === 'refusal' ? (returned.label === 'allow') !== (decision.rule.label === 'allow')
      : returned.hash !== decision.rule.hash;
    decision.models.push({ model: id, outcome, attempted, elapsedMs, ...(returned ? { returned } : { fallback: 'existing-rules' }),
      ...(disagreed !== undefined ? { disagreed } : {}) });
    const counts = this.counts.get(id) ?? { considered: 0, attempted: 0, compared: 0, disagreements: 0, fallbacks: 0 };
    counts.considered++;
    if (attempted) counts.attempted++;
    if (disagreed !== undefined) counts.compared++;
    if (disagreed) counts.disagreements++;
    if (!returned) counts.fallbacks++;
    this.counts.set(id, counts);
  }
}
