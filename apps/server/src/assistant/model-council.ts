import { performance } from 'node:perf_hooks';
import type { ModelCouncil, ModelCouncilMember } from '@mohassan/contracts';
import { ModelRelationsManager, type TurnDecisionLog, type TurnObservation } from '../../../../packages/model-relations/src/manager.js';
import type { ModelRunResult } from '../../../../packages/model-relations/src/runtime.js';
import { redactSensitiveCredentialText } from '../sensitive-credential-text.js';
import { comparable, judge, type JudgeDecision, type JudgeEvidence } from './judge.js';

/**
 * The owner's model council: for one finished turn, the trained models that fit it speak in three rounds, and a fixed
 * referee picks the answer that is sent.
 *
 * - Understanding: the classifiers read the request (refusal, speech act, route, follow-up), through the same
 *   ModelRelationsManager the shadow organizer uses. Shown to the owner; they do not change the turn.
 * - Web search, when needed: the pipeline read no page and has no answer that stands, and the rules or a routing model
 *   send the request to the web. The council searches and reads pages with the pipeline's own engine and guard.
 * - Answers: the pipeline (rules, skills and pages), v5, one reading model over the best page passage (or v4 when
 *   nothing was read), and the arithmetic ranker for an English word problem.
 * - Decision: the judge (judge.ts) checks every answer against the question and the pages, and the members are compared
 *   with each other. The pipeline's answer is kept whenever it stands, because it is the only member with a passed
 *   product evaluation; a model's answer is sent only when the pipeline has none and the answer is found in a page read
 *   for this turn, or, for v5, as the owner's existing labelled last resort.
 */

export type CouncilStatus = 'completed' | 'partial' | 'blocked';
export type CouncilHistory = readonly { role: 'user' | 'assistant'; content: string }[];

export interface CouncilRunner {
  run(modelId: string, input: unknown, signal?: AbortSignal): Promise<ModelRunResult>;
}

export interface CouncilTurn {
  question: string;
  previous: string | null;
  pipeline: { text: string; status: CouncilStatus };
  /** Pages read for this turn (judge evidence); empty when the turn read nothing. */
  evidence: readonly JudgeEvidence[];
  /** The conversation for v5, oldest first, ending with the user's turn. */
  history: CouncilHistory;
  /** The rules' own reading of the request, as the shadow organizer observes it. */
  baseline: TurnObservation['baseline'];
  /** Whether v5 may answer: the same no-model blocked turns where it answers without the council. */
  v5MayAnswer: boolean;
  /** This turn's public web search (the chat's engine, page reader and public-query guard); overrides `options.search`. */
  search?: (question: string, signal: AbortSignal) => Promise<CouncilSearchResult>;
  /** Redacts credentials held for this conversation before making diagnostic excerpts. */
  scrub?: (text: string) => string;
  signal: AbortSignal;
}

export interface CouncilOutcome {
  text: string;
  status: CouncilStatus;
  chosen: string;
  changed: boolean;
  council: ModelCouncil;
}

export interface CouncilSearchResult {
  pages: readonly JudgeEvidence[];
  /** Why nothing was read (no results, a refused query, unreadable pages), shown to the owner. */
  note?: string;
}

export interface ModelCouncilOptions {
  runner: CouncilRunner;
  /** The resident v5 worker (v5-chat.ts); absent when v5 is not configured. */
  v5?: (history: CouncilHistory, signal: AbortSignal) => Promise<string | undefined>;
  /**
   * A public web search and page read for this turn (the pipeline's own search engine and page reader, with its
   * public-query guard). Used only when the pipeline read no page, has no answer that stands, and the rules or a
   * routing model send the request to the web.
   */
  search?: (question: string, signal: AbortSignal) => Promise<CouncilSearchResult>;
  /** Total wall time for one council (default 45 s). Members still running then are recorded as timed out. */
  budgetMs?: number;
  /** Per-member caps in milliseconds. */
  memberMs?: Partial<Record<'understanding' | 'search' | 'v5' | 'reader' | 'v4' | 'arithmetic', number>>;
}

export const PIPELINE = 'pipeline';
export const WEB_SEARCH = 'web-search';
const READER = 'reading-v3-last';
const V4 = 'chat-v4';
const V5 = 'chat-v5';
const ARITHMETIC = 'arithmetic';

const LABELS: Record<string, string> = {
  [PIPELINE]: 'المحرك (القواعد والصفحات)',
  [WEB_SEARCH]: 'البحث في الويب',
  [V5]: 'نموذج المحادثة v5',
  [V4]: 'نموذج المحادثة v4',
  [READER]: 'نموذج القراءة v3',
  'reading-v4-hn-last': 'نموذج القراءة v4',
  [ARITHMETIC]: 'نموذج الحساب',
  refusal: 'مصنّف الرفض',
  'scratch-refusal': 'مصنّف الرفض الصغير',
  'scratch-speech-act': 'مصنّف نوع الكلام',
  'scratch-route': 'الموجّه الصغير',
  'scratch-follow-up': 'مصنّف المتابعة',
  'router-b0': 'الموجّه B0',
  'router-b2': 'الموجّه B2',
  'question-edit': 'رأس إعادة صياغة السؤال',
  'head-sufficiency': 'رأس كفاية الأدلة',
  'head-answer-sentence': 'رأس جملة الجواب',
  ocr: 'قارئ الصور',
};

/** Measured results the decision and the owner can rely on, with where they come from. */
const MEASURED: Record<string, string> = {
  [READER]: 'تجريبي: F1 ‏18٪ بالعربية و26٪ بالإنجليزية على XQuAD',
  [V5]: 'لم يجتز Gate 3 ‏(0 من 20 بكل لغة)',
  [V4]: 'لم يجتز اختبار الاستمرار الدلالي',
  [ARITHMETIC]: 'لا يجيب إلا فوق عتبة ثقة معايرة، وبالإنجليزية فقط',
};

const STAGES: Record<string, string> = {
  refusal: 'الرفض', 'speech-act': 'نوع الكلام', router: 'المسار', arithmetic: 'الحساب', 'turn-type': 'نوع الدور',
  'question-rewrite': 'إعادة الصياغة', 'evidence-reader': 'كفاية الأدلة', 'answer-sentence': 'جملة الجواب',
  'reply-judge': 'الحكم', 'image-reader': 'قراءة الصورة',
};

const TEMPLATE = { en: { q: 'Question: ', a: 'Answer:' }, ar: { q: 'سؤال: ', a: 'الجواب:' } } as const;
const ABSTAIN = /غير\s+مذكور|لا\s+يذكر|لم\s+يذكر|لا\s+يوجد\s+في\s+النص|ليس\s+في\s+النص|not\s+(?:mentioned|stated|given|in\s+the\s+(?:text|passage))|unanswerable|no\s+answer|cannot\s+be\s+answered/iu;
const STOP = new Set(['ما', 'ماذا', 'من', 'متى', 'اين', 'أين', 'كيف', 'كم', 'هل', 'هو', 'هي', 'في', 'على', 'عن', 'الى', 'إلى', 'التي', 'الذي', 'ذلك', 'هذه', 'هذا',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'is', 'are', 'was', 'were', 'what', 'who', 'when', 'where', 'how', 'which', 'does', 'did', 'do', 'and', 'or', 'for', 'with']);
const WEB_ROUTES = new Set(['web_search', 'news']);
const MAX_PASSAGE = 1_200;
const OUTPUT_CHARS = 600;

const label = (id: string) => LABELS[id] ?? id;
const arabic = (text: string) => /\p{Script=Arabic}/u.test(text);
const short = (text: string) => text.length <= OUTPUT_CHARS ? text : `${text.slice(0, OUTPUT_CHARS - 1)}…`;

function words(text: string): string[] {
  return comparable(text).split(' ').filter(word => word.length >= 2 && !STOP.has(word));
}

/** The best passage of the pages for the question: the paragraph sharing the most question words. */
export function selectPassage(question: string, evidence: readonly JudgeEvidence[]): { text: string; title?: string; url?: string } | null {
  const asked = new Set(words(question));
  if (!asked.size) return null;
  let best: { text: string; title?: string; url?: string; score: number } | null = null;
  for (const page of evidence) {
    if (page.kind !== 'page') continue;
    const paragraphs = page.text.split(/\n\s*\n|\n/u).map(part => part.trim()).filter(part => part.length >= 40);
    for (const paragraph of paragraphs) {
      for (let start = 0; start < paragraph.length; start += MAX_PASSAGE) {
        const text = paragraph.slice(start, start + MAX_PASSAGE);
        const score = new Set(words(text).filter(word => asked.has(word))).size;
        if (score > (best?.score ?? 0)) best = { text, title: page.title, url: page.url, score };
      }
    }
  }
  return best && best.score >= Math.min(2, asked.size) ? { text: best.text, title: best.title, url: best.url } : null;
}

export function readerPrompt(question: string, passage: string): string {
  const template = arabic(question) ? TEMPLATE.ar : TEMPLATE.en;
  return `${passage}\n\n${template.q}${question}\n${template.a}`;
}

/** Whether `haystack` states `answer`: the whole folded answer, or every number in it with most of its words. */
export function states(haystack: string, answer: string): boolean {
  const target = comparable(answer);
  if (!target) return false;
  const text = comparable(haystack);
  if (text.includes(target)) return true;
  const numbers = target.match(/\d+(?:\.\d+)?/gu) ?? [];
  if (numbers.some(number => !text.includes(number))) return false;
  const parts = words(answer);
  if (!parts.length) return numbers.length > 0;
  return parts.filter(part => text.includes(part)).length / parts.length >= 0.75;
}

/**
 * Search results the council reads, best first: the hits sharing the most question words in their title and snippet,
 * one per site, whatever the site is (an encyclopedia is one source among the others, not the default).
 */
export function rankHits<T extends { title: string; url: string; snippet?: string }>(question: string, hits: readonly T[]): T[] {
  const asked = new Set(words(question));
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return url; } };
  const scored = hits.filter(hit => /^https?:\/\//iu.test(hit.url)).map((hit, index) => ({
    hit, index, score: new Set(words(`${hit.title} ${hit.snippet ?? ''}`).filter(word => asked.has(word))).size,
  })).sort((first, second) => second.score - first.score || first.index - second.index);
  const seen = new Set<string>();
  const ranked: T[] = [];
  for (const { hit, score } of scored) {
    const site = host(hit.url);
    if (score === 0 || seen.has(site)) continue;
    seen.add(site);
    ranked.push(hit);
  }
  return ranked;
}

/** Whether the rules or any routing model in the understanding round sends this request to the public web. */
export function wantsWeb(baseline: TurnObservation['baseline'], log?: TurnDecisionLog): boolean {
  if (WEB_ROUTES.has(baseline.route)) return true;
  return Boolean(log?.stages.some(stage => stage.stage === 'router'
    && stage.models.some(model => model.outcome === 'ok' && WEB_ROUTES.has(model.returned?.label ?? ''))));
}

function outputText(output: unknown): string | undefined {
  const text = output && typeof output === 'object' ? (output as { text?: unknown }).text : undefined;
  return typeof text === 'string' ? text : undefined;
}

type Settled<T> = { status: 'ok'; value: T; ms: number } | { status: 'timeout' | 'failed'; ms: number };

async function capped<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<Settled<T>> {
  const started = performance.now();
  if (parent.aborted || ms <= 0) return { status: 'timeout', ms: 0 };
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timeout = Symbol();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<typeof timeout>(resolve => {
    timer = setTimeout(() => controller.abort(), ms);
    onAbort = () => resolve(timeout);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([work(signal), stop]);
    const elapsed = Math.round(performance.now() - started);
    return signal.aborted || value === timeout ? { status: 'timeout', ms: elapsed } : { status: 'ok', value: value as T, ms: elapsed };
  } catch {
    return { status: signal.aborted ? 'timeout' : 'failed', ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** The understanding round as members: one per model the organizer asked, with its label and the rules' label. */
export function understandingMembers(log: TurnDecisionLog): ModelCouncilMember[] {
  const members: ModelCouncilMember[] = [];
  for (const stage of log.stages) {
    for (const model of stage.models) {
      if (!model.attempted) continue;
      const outcome = model.outcome === 'ok' ? 'ok' : model.outcome === 'abstained' ? 'abstained'
        : model.outcome === 'timeout' ? 'timeout' : 'failed';
      const rule = stage.rule?.label;
      members.push({
        model: model.model, label: label(model.model), round: 'understanding', outcome,
        ...(model.returned?.label ? { output: model.returned.label } : {}),
        ...(typeof model.disagreed === 'boolean' ? { agreesWithRules: !model.disagreed } : {}),
        elapsedMs: Math.min(600_000, Math.max(0, Math.round(model.elapsedMs))),
        note: `${STAGES[stage.stage] ?? stage.stage}${rule ? `؛ القواعد: ${rule}` : ''}`.slice(0, 240),
      });
    }
  }
  return members.slice(0, 32);
}

export interface Candidate {
  model: string;
  text: string;
  /** The text to send if this member is chosen (with its source and label lines). */
  reply: string;
  outcome: ModelCouncilMember['outcome'];
  ms: number;
  judge?: JudgeDecision;
  inEvidence?: boolean;
  agreements: number;
  note?: string;
}

export interface CouncilDecision {
  chosen: string;
  changed: boolean;
  reason: string;
}

/**
 * The referee. The pipeline stands when it completed and the judge would not withhold it. Otherwise the first model
 * answer found in this turn's pages is sent (with its page), then v5 where it may answer, else the pipeline's reply.
 */
export function decide(turn: Pick<CouncilTurn, 'v5MayAnswer'>, pipelineStands: boolean, candidates: readonly Candidate[]): CouncilDecision {
  const answering = candidates.filter(candidate => candidate.model !== PIPELINE && candidate.outcome === 'ok'
    && candidate.text && candidate.judge !== 'withhold');
  if (pipelineStands) {
    const pipeline = candidates.find(candidate => candidate.model === PIPELINE);
    const agreeing = answering.filter(candidate => pipeline && (states(pipeline.text, candidate.text) || states(candidate.text, pipeline.text)))
      .map(candidate => label(candidate.model));
    const differing = answering.map(candidate => label(candidate.model)).filter(name => !agreeing.includes(name));
    return {
      chosen: PIPELINE, changed: false,
      reason: `بقي جواب المحرك لأنه العضو الوحيد الذي اجتاز تقييم المنتج.${agreeing.length ? ` وافقه: ${agreeing.join('، ')}.` : ''}${differing.length ? ` خالفه: ${differing.join('، ')}.` : ''}`.slice(0, 400),
    };
  }
  // A model answer replaces the pipeline's only when it is in this turn's pages and another member says the same thing:
  // on the frozen date and population questions (2026-11-26) the reading model was right in 1 of its 7 answers alone.
  const grounded = answering.find(candidate => candidate.model !== V5 && candidate.inEvidence === true && candidate.agreements > 0);
  if (grounded) {
    return { chosen: grounded.model, changed: true,
      reason: `لم يكن للمحرك جواب يقف، فأُرسل جواب ${label(grounded.model)} لأنه موجود في صفحة قُرئت لهذا السؤال ووافقه عضو آخر.`.slice(0, 400) };
  }
  const alone = answering.find(candidate => candidate.model !== V5 && candidate.inEvidence === true);
  const v5 = turn.v5MayAnswer ? answering.find(candidate => candidate.model === V5) : undefined;
  if (v5) {
    return { chosen: V5, changed: true,
      reason: 'لم يجد المحرك جواباً ولم يجد أي عضو جواباً في الصفحات، فأجاب v5 كملاذ أخير (لم يجتز اختبار الجودة).' };
  }
  return { chosen: PIPELINE, changed: false,
    reason: alone ? `لم يجد المحرك جواباً، وجواب ${label(alone.model)} موجود في الصفحات لكن لم يوافقه أي عضو آخر، فبقي رد المحرك ولم يُرسل تخمين منفرد.`.slice(0, 400)
      : answering.length ? 'لم يجد المحرك جواباً، ولم يكن جواب أي عضو موجوداً في الصفحات، فبقي رد المحرك.'
        : 'لم يقدّم أي عضو جواباً يمكن الاعتماد عليه، فبقي رد المحرك.' };
}

export function createModelCouncil(options: ModelCouncilOptions) {
  const budgetMs = options.budgetMs ?? 45_000;
  const caps = { understanding: 4_000, search: 15_000, v5: 20_000, reader: 25_000, v4: 25_000, arithmetic: 5_000, ...options.memberMs };
  const organizer = new ModelRelationsManager(options.runner, {
    maxTurnMs: caps.understanding,
    judge: input => judge(input).decision,
  });

  async function deliberate(turn: CouncilTurn): Promise<CouncilOutcome> {
    const started = performance.now();
    const deadline = started + budgetMs;
    const left = (cap: number) => Math.min(cap, Math.floor(deadline - performance.now()));
    const ar = arabic(turn.question);
    const scrub = turn.scrub ?? redactSensitiveCredentialText;
    const members: ModelCouncilMember[] = [];
    const pipelineText = turn.pipeline.text.trim();
    const judgeOf = (reply: string, status: string, evidence: readonly JudgeEvidence[]): JudgeDecision | undefined => {
      try {
        return judge({ question: turn.question, previous: turn.previous, reply, status, ...(evidence.length ? { evidence } : {}) }).decision;
      } catch { return undefined; }
    };
    const pipelineStands = turn.pipeline.status === 'completed' && pipelineText.length > 0
      && judgeOf(pipelineText, turn.pipeline.status, turn.evidence) !== 'withhold';

    // Understanding: the organizer's own stage models, bounded by its turn budget.
    const understood = await capped(signal => organizer.inspect({
      id: `council:${Date.now()}`, text: turn.question, previousText: turn.previous, baseline: turn.baseline,
    }, undefined, signal), left(caps.understanding + 1_000), turn.signal);
    if (understood.status === 'ok') members.push(...understandingMembers(understood.value));

    // The web, when needed: nothing was read, the pipeline has no answer that stands, and the request is a web question.
    let evidence = turn.evidence;
    const search = turn.search ?? options.search;
    if (search && !evidence.length && !pipelineStands && turn.baseline.refusal === 'allow'
        && wantsWeb(turn.baseline, understood.status === 'ok' ? understood.value : undefined)) {
      const searched = await capped(signal => search(turn.question, signal), left(caps.search), turn.signal);
      const pages = searched.status === 'ok' ? searched.value.pages.filter(page => page.text.trim()) : [];
      members.push({
        model: WEB_SEARCH, label: label(WEB_SEARCH), round: 'search',
        outcome: searched.status === 'timeout' ? 'timeout' : pages.length ? 'ok' : 'failed',
        ...(pages.length ? { output: short(pages.map(page => scrub(page.title || page.url || '')).filter(Boolean).join(' · ')) } : {}),
        elapsedMs: Math.min(600_000, searched.ms),
        note: scrub(pages.length ? `قرأ ${pages.length} صفحة لأن المحرك لم يقرأ أي صفحة ولم يجد جواباً`
          : searched.status === 'ok' ? searched.value.note ?? 'لم يجد صفحة مقروءة' : searched.status === 'timeout' ? 'انتهى وقت البحث' : 'تعذر البحث').slice(0, 240),
      });
      if (pages.length) evidence = pages;
    }

    // Answers. The pipeline is a member like the others; the models run one after another (one heavy worker at a time).
    const candidates: Candidate[] = [];
    if (pipelineText) {
      candidates.push({ model: PIPELINE, text: pipelineText, reply: turn.pipeline.text, outcome: 'ok', ms: 0, agreements: 0,
        note: turn.pipeline.status === 'completed' ? 'أكمل الجواب' : turn.pipeline.status === 'partial' ? 'جواب ناقص' : 'لم يجد جواباً' });
    }
    if (options.v5 && turn.history.at(-1)?.role === 'user') {
      const spoken = await capped(signal => options.v5!(turn.history, signal), left(caps.v5), turn.signal);
      const text = spoken.status === 'ok' ? spoken.value?.trim() : undefined;
      candidates.push({ model: V5, text: text ?? '', reply: text ?? '', ms: spoken.ms, agreements: 0, note: MEASURED[V5],
        outcome: spoken.status === 'timeout' ? 'timeout' : text ? 'ok' : 'failed' });
    }
    const passage = evidence.length ? selectPassage(turn.question, evidence) : null;
    if (passage) {
      const read = await capped(signal => options.runner.run(READER, { prompt: readerPrompt(turn.question, scrub(passage.text)), maxNewTokens: 20 }, signal),
        left(caps.reader), turn.signal);
      const raw = read.status === 'ok' && read.value.ok ? outputText(read.value.output) : undefined;
      const answer = raw === undefined ? '' : scrub(raw).split('\n')[0]?.trim() ?? '';
      const abstained = Boolean(raw !== undefined && (!answer || ABSTAIN.test(answer)));
      const title = passage.title && scrub(passage.title);
      const url = passage.url && scrub(passage.url);
      const source = title || url ? `\n\n${ar ? 'المصدر' : 'Source'}: ${[title, url].filter(Boolean).join(' — ')}` : '';
      const footer = ar ? `\n\n— جواب «${label(READER)}» (${MEASURED[READER]})` : '\n\n— Answer from the reading model v3 (experimental; F1 18% Arabic, 26% English on XQuAD)';
      candidates.push({ model: READER, text: abstained ? '' : answer, reply: `${answer}${source}${footer}`, ms: read.ms, agreements: 0,
        note: `${MEASURED[READER]}؛ قرأ فقرة من: ${title || url || 'صفحة'}`.slice(0, 240),
        outcome: read.status === 'timeout' ? 'timeout' : read.status === 'ok' && read.value.ok ? abstained ? 'abstained' : 'ok' : 'failed' });
    } else if (!evidence.length) {
      const spoken = await capped(signal => options.runner.run(V4, { text: turn.question, maxNewTokens: 48 }, signal), left(caps.v4), turn.signal);
      const raw = spoken.status === 'ok' && spoken.value.ok ? outputText(spoken.value.output) : undefined;
      const text = raw === undefined ? '' : scrub(raw).split(/\n\s*\n/u)[0]?.trim() ?? '';
      candidates.push({ model: V4, text, reply: text, ms: spoken.ms, agreements: 0, note: MEASURED[V4],
        outcome: spoken.status === 'timeout' ? 'timeout' : text ? 'ok' : 'failed' });
    }
    if (!ar && /\d/u.test(turn.question) && turn.baseline.refusal === 'allow') {
      const solved = await capped(signal => options.runner.run(ARITHMETIC, { text: turn.question }, signal), left(caps.arithmetic), turn.signal);
      const output = solved.status === 'ok' && solved.value.ok ? solved.value.output as { value?: unknown; expression?: unknown } | null : undefined;
      const value = typeof output?.value === 'string' ? output.value : undefined;
      const expression = typeof output?.expression === 'string' ? output.expression : undefined;
      if (solved.status !== 'ok' || !solved.value.ok || value) {
        candidates.push({ model: ARITHMETIC, text: value ?? '', ms: solved.ms, agreements: 0, note: MEASURED[ARITHMETIC],
          reply: value ? `${value}${expression ? `\n\n${expression} = ${value}` : ''}\n\n— Answer from the arithmetic model (experimental)` : '',
          outcome: solved.status === 'timeout' ? 'timeout' : value ? 'ok' : 'failed' });
      }
    }

    // Cross-examination: the judge on every answer, the pages, and agreement between answers.
    const evidenceText = evidence.map(item => item.text).join('\n');
    for (const candidate of candidates) {
      if (candidate.outcome !== 'ok' || !candidate.text) continue;
      candidate.judge = judgeOf(candidate.text, candidate.model === PIPELINE ? turn.pipeline.status : 'completed', evidence);
      if (evidenceText && candidate.model !== PIPELINE) candidate.inEvidence = states(evidenceText, candidate.text);
    }
    for (const candidate of candidates) {
      if (candidate.outcome !== 'ok' || !candidate.text) continue;
      candidate.agreements = candidates.filter(other => other !== candidate && other.outcome === 'ok' && other.judge !== 'withhold' && other.text
        && (states(other.text, candidate.text) || states(candidate.text, other.text))).length;
    }

    const decision = decide(turn, pipelineStands, candidates);
    const winner = candidates.find(candidate => candidate.model === decision.chosen);
    const changed = decision.changed && Boolean(winner?.reply.trim());
    const chosen = changed ? decision.chosen : PIPELINE;
    for (const candidate of candidates) {
      members.push({
        model: candidate.model, label: label(candidate.model), round: 'answer', outcome: candidate.outcome,
        ...(candidate.text ? { output: short(scrub(candidate.text)) } : {}),
        ...(candidate.inEvidence !== undefined ? { inEvidence: candidate.inEvidence } : {}),
        ...(candidate.outcome === 'ok' && candidate.text ? { agreements: Math.min(16, candidate.agreements) } : {}),
        ...(candidate.judge ? { judge: candidate.judge } : {}),
        ...(candidate.model === chosen ? { chosen: true } : {}),
        elapsedMs: Math.min(600_000, Math.max(0, Math.round(candidate.ms))),
        ...(candidate.note ? { note: candidate.note.slice(0, 240) } : {}),
      });
    }
    return {
      text: changed ? winner!.reply : turn.pipeline.text,
      status: changed ? 'completed' : turn.pipeline.status,
      chosen,
      changed,
      council: {
        version: 1, chosen, changed, reason: changed || decision.chosen === PIPELINE ? decision.reason
          : 'لم يكن لجواب العضو المختار نص يُرسل، فبقي رد المحرك.',
        elapsedMs: Math.min(600_000, Math.round(performance.now() - started)), members: members.slice(0, 48),
      },
    };
  }

  return { deliberate };
}

export type ModelCouncilService = ReturnType<typeof createModelCouncil>;
