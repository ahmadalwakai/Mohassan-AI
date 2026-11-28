import { performance } from 'node:perf_hooks';
import type { ModelCouncil, ModelCouncilMember } from '@mohassan/contracts';
import { ModelRelationsManager, type TurnDecisionLog, type TurnObservation } from '../../../../packages/model-relations/src/manager.js';
import type { ModelRunResult } from '../../../../packages/model-relations/src/runtime.js';
import { comparable, judge, type JudgeEvidence } from './judge.js';
import { needsDefinition, relevantLines } from './hands.js';

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
 *   with each other. The pipeline retains priority when it completes and passes screening. An experimental reading
 *   result can replace it with a supporting passage and text corroboration, or v5 as the owner's labelled last resort.
 */

export type CouncilStatus = 'completed' | 'partial' | 'blocked';
export type CouncilHistory = readonly { role: 'user' | 'assistant'; content: string }[];

export interface CouncilRunner {
  run(modelId: string, input: unknown): Promise<ModelRunResult>;
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
const NUMBER = /[+\-−]?\p{N}+(?:[.,٫٬]\p{N}+)*/gu;
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

/** Match the folded answer as a whole phrase, with numbers kept intact. */
export function states(haystack: string, answer: string): boolean {
  const target = comparable(answer);
  if (!target) return false;
  if (!` ${comparable(haystack)} `.includes(` ${target} `)) return false;
  const numbers = answer.match(NUMBER);
  if (!numbers) return true;
  const foundNumbers = new Set(haystack.match(NUMBER));
  return numbers.every(number => foundNumbers.has(number));
}

function answersMatch(first: string, second: string): boolean {
  const normalized = comparable(first);
  return Boolean(normalized) && normalized === comparable(second)
    && (first.match(NUMBER) ?? []).join(' ') === (second.match(NUMBER) ?? []).join(' ');
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

async function capped<T>(work: () => Promise<T>, ms: number, signal: AbortSignal): Promise<Settled<T>> {
  const started = performance.now();
  if (signal.aborted || ms <= 0) return { status: 'timeout', ms: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
    onAbort = () => resolve('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([work(), stop]);
    const elapsed = Math.round(performance.now() - started);
    return value === 'timeout' ? { status: 'timeout', ms: elapsed } : { status: 'ok', value: value as T, ms: elapsed };
  } catch {
    return { status: 'failed', ms: Math.round(performance.now() - started) };
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
  judge?: ModelCouncilMember['judge'];
  inEvidence?: boolean;
  definitionMatches?: boolean;
  agreements: number;
  note?: string;
}

export interface CouncilDecision {
  chosen: string;
  changed: boolean;
  reason: string;
}

function canConsider(candidate: Candidate): boolean {
  return candidate.outcome === 'ok' && Boolean(candidate.text) && candidate.judge === 'send';
}

function publicationFor(candidate: Candidate, pipelineStands: boolean, v5MayAnswer: boolean): NonNullable<ModelCouncilMember['publication']> {
  if (candidate.model === PIPELINE) return pipelineStands ? 'pipeline' : 'ineligible';
  if (!canConsider(candidate)) return 'ineligible';
  if (candidate.model === READER && candidate.inEvidence === true && candidate.definitionMatches !== false && candidate.agreements > 0) return 'corroborated';
  if (candidate.model === V5 && v5MayAnswer) return 'owner-fallback';
  return 'ineligible';
}

/**
 * The pipeline has priority when it completes and the screening can send or repair it. Otherwise try the corroborated
 * source-backed reader, then the existing owner-only v5 fallback, then keep the pipeline's status and reply.
 */
export function decide(turn: Pick<CouncilTurn, 'v5MayAnswer'>, pipelineStands: boolean, candidates: readonly Candidate[]): CouncilDecision {
  const answering = candidates.filter(candidate => candidate.model !== PIPELINE && canConsider(candidate));
  if (pipelineStands) {
    const pipeline = candidates.find(candidate => candidate.model === PIPELINE);
    const agreeing = answering.filter(candidate => pipeline && answersMatch(pipeline.text, candidate.text))
      .map(candidate => label(candidate.model));
    const differing = answering.map(candidate => label(candidate.model)).filter(name => !agreeing.includes(name));
    return {
      chosen: PIPELINE, changed: false,
      reason: `بقي اختيار المحرك بعد اكتمال رده وفحصه.${agreeing.length ? ` ظهرت مطابقة نصية مع: ${agreeing.join('، ')}.` : ''}${differing.length ? ` لم تظهر مطابقة نصية مع: ${differing.join('، ')}.` : ''}`.slice(0, 400),
    };
  }
  // A model answer replaces the pipeline's only when it is in this turn's pages and another member says the same thing:
  // on the frozen date and population questions (2026-11-26) the reading model was right in 1 of its 7 answers alone.
  const grounded = answering.find(candidate => publicationFor(candidate, pipelineStands, turn.v5MayAnswer) === 'corroborated');
  if (grounded) {
    return { chosen: grounded.model, changed: true,
      reason: `اختار المجلس جواب ${label(grounded.model)} بعد مطابقته نصًا في فقرة مقروءة وفي جواب عضو آخر.` };
  }
  const alone = answering.find(candidate => candidate.model === READER && candidate.inEvidence === true && candidate.definitionMatches !== false);
  const v5 = answering.find(candidate => publicationFor(candidate, pipelineStands, turn.v5MayAnswer) === 'owner-fallback');
  if (v5) {
    return { chosen: V5, changed: true,
      reason: 'اختار المجلس جواب v5 بوصفه خيارًا تجريبيًا أخيرًا للمالك. لم يجتز النموذج اختبار الجودة.' };
  }
  return { chosen: PIPELINE, changed: false,
    reason: alone ? `بقي رد المحرك. طابق جواب ${label(alone.model)} الفقرة المقروءة وغابت المطابقة مع أي عضو مؤهل آخر.`
      : 'بقي رد المحرك لعدم وجود جواب بديل مستوفٍ لشروط النشر في المجلس.' };
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
    const requireDefinition = needsDefinition(turn.question);
    const publication = { v5MayAnswer: turn.v5MayAnswer && !requireDefinition };
    const members: ModelCouncilMember[] = [];
    const pipelineText = turn.pipeline.text.trim();
    const judgeOf = (reply: string, status: string, evidence: readonly JudgeEvidence[]) => {
      try {
        return judge({ question: turn.question, previous: turn.previous, reply, status, ...(evidence.length ? { evidence } : {}) });
      } catch { return null; }
    };
    const pipelineReview = pipelineText ? judgeOf(pipelineText, turn.pipeline.status, turn.evidence) : null;
    const pipelineStands = turn.pipeline.status === 'completed'
      && (pipelineReview?.decision === 'send' || pipelineReview?.decision === 'fix');

    // Understanding: the organizer's own stage models, bounded by its turn budget.
    const understood = await capped(() => organizer.inspect({
      id: `council:${Date.now()}`, text: turn.question, previousText: turn.previous, baseline: turn.baseline,
    }), left(caps.understanding + 1_000), turn.signal);
    if (understood.status === 'ok') members.push(...understandingMembers(understood.value));

    // The web, when needed: nothing was read, the pipeline has no answer that stands, and the request is a web question.
    let evidence = turn.evidence;
    const search = turn.search ?? options.search;
    if (search && !evidence.length && !pipelineStands && turn.baseline.refusal === 'allow'
        && wantsWeb(turn.baseline, understood.status === 'ok' ? understood.value : undefined)) {
      const searched = await capped(() => search(turn.question, turn.signal), left(caps.search), turn.signal);
      const pages = searched.status === 'ok' ? searched.value.pages.filter(page => page.text.trim()) : [];
      members.push({
        model: WEB_SEARCH, label: label(WEB_SEARCH), round: 'search',
        outcome: searched.status === 'timeout' ? 'timeout' : pages.length ? 'ok' : 'failed',
        ...(pages.length ? { output: short(pages.map(page => page.title || page.url || '').filter(Boolean).join(' · ')) } : {}),
        elapsedMs: Math.min(600_000, searched.ms),
        note: (pages.length ? `قرأ ${pages.length} صفحة لأن المحرك لم يقرأ أي صفحة ولم يجد جواباً`
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
      const spoken = await capped(() => options.v5!(turn.history, turn.signal), left(caps.v5), turn.signal);
      const text = spoken.status === 'ok' ? spoken.value?.trim() : undefined;
      candidates.push({ model: V5, text: text ?? '', reply: text ?? '', ms: spoken.ms, agreements: 0, note: MEASURED[V5],
        outcome: spoken.status === 'timeout' ? 'timeout' : text ? 'ok' : 'failed' });
    }
    const passage = evidence.length ? selectPassage(turn.question, evidence) : null;
    if (passage) {
      const read = await capped(() => options.runner.run(READER, { prompt: readerPrompt(turn.question, passage.text), maxNewTokens: 20 }),
        left(caps.reader), turn.signal);
      const raw = read.status === 'ok' && read.value.ok ? outputText(read.value.output) : undefined;
      const answer = raw?.split('\n')[0]?.trim() ?? '';
      const abstained = Boolean(raw !== undefined && (!answer || ABSTAIN.test(answer)));
      const source = passage.title || passage.url ? `\n\n${ar ? 'المصدر' : 'Source'}: ${[passage.title, passage.url].filter(Boolean).join(' — ')}` : '';
      const footer = ar ? `\n\n— جواب «${label(READER)}» (${MEASURED[READER]})` : '\n\n— Answer from the reading model v3 (experimental; F1 18% Arabic, 26% English on XQuAD)';
      candidates.push({ model: READER, text: abstained ? '' : answer, reply: `${answer}${source}${footer}`, ms: read.ms, agreements: 0,
        note: `${MEASURED[READER]}؛ قرأ فقرة من: ${passage.title || passage.url || 'صفحة'}`.slice(0, 240),
        outcome: read.status === 'timeout' ? 'timeout' : raw === undefined ? 'failed' : abstained ? 'abstained' : 'ok' });
    } else if (!evidence.length) {
      const spoken = await capped(() => options.runner.run(V4, { text: turn.question, maxNewTokens: 48 }), left(caps.v4), turn.signal);
      const raw = spoken.status === 'ok' && spoken.value.ok ? outputText(spoken.value.output) : undefined;
      const text = raw?.split(/\n\s*\n/u)[0]?.trim() ?? '';
      candidates.push({ model: V4, text, reply: text, ms: spoken.ms, agreements: 0, note: MEASURED[V4],
        outcome: spoken.status === 'timeout' ? 'timeout' : text ? 'ok' : 'failed' });
    }
    if (!ar && /\d/u.test(turn.question) && turn.baseline.refusal === 'allow') {
      const solved = await capped(() => options.runner.run(ARITHMETIC, { text: turn.question }), left(caps.arithmetic), turn.signal);
      const output = solved.status === 'ok' && solved.value.ok ? solved.value.output as { value?: unknown; expression?: unknown } | null : undefined;
      const value = typeof output?.value === 'string' ? output.value : undefined;
      const expression = typeof output?.expression === 'string' ? output.expression : undefined;
      if (solved.status !== 'ok' || !solved.value.ok || value) {
        candidates.push({ model: ARITHMETIC, text: value ?? '', ms: solved.ms, agreements: 0, note: MEASURED[ARITHMETIC],
          reply: value ? `${value}${expression ? `\n\n${expression} = ${value}` : ''}\n\n— Answer from the arithmetic model (experimental)` : '',
          outcome: solved.status === 'timeout' ? 'timeout' : value ? 'ok' : 'failed' });
      }
    }

    // The rule-based screening, source matching and cross-candidate comparison are separate checks.
    const pages = evidence.filter(item => item.kind === 'page' && item.url && item.text.trim());
    const definitionPage = requireDefinition && passage?.url ? pages.find(page => page.url === passage.url) : undefined;
    const definitions = definitionPage ? relevantLines({ text: definitionPage.text, title: definitionPage.title ?? '', elements: [] },
      turn.question, 3, true, { requireDefinition }) : [];
    for (const candidate of candidates) {
      if (candidate.outcome !== 'ok' || !candidate.text) continue;
      const verdict = candidate.model === PIPELINE ? pipelineReview : judgeOf(candidate.text, 'completed', evidence);
      candidate.judge = verdict?.decision ?? 'failed';
      if (candidate.model === PIPELINE) {
        if (verdict?.support?.sentences) candidate.inEvidence = verdict.support.supported === verdict.support.sentences;
      } else if (candidate.model === READER) {
        if (passage?.url) candidate.inEvidence = states(passage.text, candidate.text);
        if (requireDefinition) candidate.definitionMatches = definitions.some(line => answersMatch(candidate.text, line));
      } else if (pages.length) candidate.inEvidence = pages.some(page => states(page.text, candidate.text));
    }
    for (const candidate of candidates) {
      if (!canConsider(candidate)) continue;
      candidate.agreements = candidates.filter(other => other !== candidate && (other.model !== PIPELINE || pipelineStands) && canConsider(other)
        && answersMatch(other.text, candidate.text)).length;
    }

    const decision = decide(publication, pipelineStands, candidates);
    const winner = candidates.find(candidate => candidate.model === decision.chosen);
    const changed = decision.changed && Boolean(winner?.reply.trim());
    const chosen = changed ? decision.chosen : PIPELINE;
    for (const candidate of candidates) {
      members.push({
        model: candidate.model, label: label(candidate.model), round: 'answer', outcome: candidate.outcome,
        ...(candidate.text ? { output: short(candidate.text) } : {}),
        ...(candidate.inEvidence !== undefined ? { inEvidence: candidate.inEvidence } : {}),
        ...(candidate.outcome === 'ok' && candidate.text ? { agreements: Math.min(16, candidate.agreements) } : {}),
        ...(candidate.judge ? { judge: candidate.judge } : {}),
        publication: publicationFor(candidate, pipelineStands, publication.v5MayAnswer),
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
