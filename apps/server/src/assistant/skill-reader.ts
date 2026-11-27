import { z } from 'zod';
import { requestTerms, skillStems } from '../../../../packages/skills/src/stems.js';
import { buildFrame } from './mind/frame.js';
import { matchText } from './mind/normalize.js';
import { orderReaderMatches, READER_MATCH_WINDOW } from './skill-reader-routing.js';

/**
 * Model-free reading of the owner's active instruction skills.
 *
 * Without a language model the assistant cannot generate expert prose, so a skill is used the
 * way a professional uses a playbook: pick the playbook that fits the request, then answer with
 * its steps, its answer outline and its checks, and name it as the source. Selection reads only
 * the metadata the skills package already verified (name, id, description); the body comes from
 * the same verified gate as the model prompt (active version, matching content hash, current
 * inspection). Skill text is displayed, never executed: it cannot start a tool, grant a
 * permission or change the route of the conversation.
 */

/** One active, inspected instruction skill, as `preloadInstructionMetadata` reports it. */
export interface SkillReaderCandidate { id: string; slug: string; name: string; description: string; category: string; version: string; contentHash: string }
export interface SkillReaderDeps {
  /** Metadata of the owner's active instruction skills. */
  candidates(ownerId: string): Promise<readonly SkillReaderCandidate[]>;
  /** The verified SKILL.md body of one active skill, or null when it no longer passes the gate. */
  instructions(ownerId: string, id: string): Promise<string | null>;
  /** All active skills already indexed (the catalogue snapshot). When given, `candidates` is not read. */
  index?(ownerId: string): Promise<SkillReaderIndex | null>;
}
/**
 * `advice`: a how-to or planning request that would otherwise become a web search.
 * `writing`: free writing that needs a model (an article, a post, a CV); the skill gives its method and outline.
 * `fallback`: a request no other path handled; the skill is better than «not completed».
 * `personal`: a how-to about the owner's own project, store or team that their memory and documents did not answer.
 */
export type SkillReadMode = 'advice' | 'writing' | 'fallback' | 'personal';
export interface SkillMatch { skill: SkillReaderCandidate; score: number; terms: string[]; genericFallback?: true }
export interface SkillReadResult { text: string; skill: SkillReaderCandidate; related: SkillReaderCandidate[]; terms: string[]; score: number; lang: 'ar' | 'en' }
export type SkillReader = (ownerId: string, request: string, options: { mode: SkillReadMode; signal?: AbortSignal }) => Promise<SkillReadResult | null>;

/** A match needs this much evidence: one distinctive word in a skill's name or id, or two in its description. */
export const MIN_SKILL_SCORE = 3;
export const MIN_SKILL_TERMS = 2;
/** A short request whose words are mostly the skill's own needs less weight: «كيف أذاكر للاختبارات» is about studying even with common words. */
const COVERED_SCORE = 2;
const COVERED_SHARE = 0.6;
const MAX_REQUEST_CHARS = 800;
const MAX_ANSWER_CHARS = 3800;
const MAX_SECTION_CHARS = 2800;
const MAX_CANDIDATES = 1300;
const LOAD_TIMEOUT_MS = 4000;

const ARABIC = /\p{Script=Arabic}/u;

// The folding, stop words and stemming moved unchanged to packages/skills/src/stems.ts (2026-11-24), so the model path's router reads a
// request on the same terms as this reader. They stay exported from here for the reader's callers and tests.
export { skillStems, requestTerms };

/**
 * Ranks skills by the request's words found in their name and id (weight 3) or description (1.5), each word weighted
 * by how rare it is among the owner's skills, so «اكتب» that many skills share counts less than «سيو» that one has.
 */
const indexCache = new Map<string, { title: Set<string>; body: Set<string> }>();
const INDEX_CACHE_LIMIT = 4000;
/** A skill version's words never change, so they are computed once per version, not once per message. */
function indexOf(skill: SkillReaderCandidate): { title: Set<string>; body: Set<string> } {
  const key = `${skill.id}\u0000${skill.contentHash}\u0000${skill.slug}\u0000${skill.name}\u0000${skill.description}`;
  let entry = indexCache.get(key);
  if (!entry) {
    entry = { title: new Set(skillStems(`${skill.name} ${skill.slug}`)), body: new Set(skillStems(skill.description)) };
    if (indexCache.size >= INDEX_CACHE_LIMIT) indexCache.delete(indexCache.keys().next().value!);
    indexCache.set(key, entry);
  }
  return entry;
}

/** The stems of every active skill, their document frequencies and postings, built once per catalogue snapshot. */
export interface SkillReaderIndex {
  readonly size: number;
  readonly skills: readonly SkillReaderCandidate[];
  readonly entries: readonly { readonly title: ReadonlySet<string>; readonly body: ReadonlySet<string> }[];
  frequency(stem: string): number;
  /** Positions of the skills that hold at least one of the stems, in their own order. */
  shortlist(stems: Iterable<string>): number[];
}

/** Indexes all active skills: no candidate window, so a skill late in the alphabet is found like any other. */
export function buildSkillReaderIndex(candidates: readonly SkillReaderCandidate[]): SkillReaderIndex {
  const entries = candidates.map(skill => ({ title: new Set(skillStems(`${skill.name} ${skill.slug}`)), body: new Set(skillStems(skill.description)) }));
  const postings = new Map<string, number[]>();
  entries.forEach((entry, position) => {
    for (const stem of new Set([...entry.title, ...entry.body])) { const list = postings.get(stem); if (list) list.push(position); else postings.set(stem, [position]); }
  });
  return {
    size: candidates.length, skills: candidates, entries,
    frequency: stem => postings.get(stem)?.length ?? 0,
    shortlist(stems) {
      const hit = new Set<number>();
      for (const stem of stems) for (const position of postings.get(stem) ?? []) hit.add(position);
      return [...hit].sort((a, b) => a - b);
    },
  };
}

/** The scoring shared by both paths; `rarity` is computed over all candidates, so a shortlist scores exactly as the full list. */
function scoreSkills(terms: { word: string; variants: string[] }[], items: readonly { skill: SkillReaderCandidate; title: ReadonlySet<string>; body: ReadonlySet<string> }[], rarity: (stem: string) => number): SkillMatch[] {
  const matches: SkillMatch[] = [];
  for (const entry of items) {
    // A stem counts once: «سؤال … وسؤال» is one subject, yet it scored twice and gave an interview question to clarifying-requests
    // (skills-pilot/tests/heldout-2.json, 2026-11-22).
    let score = 0; const matched: string[] = []; const used = new Set<string>();
    for (const term of terms) {
      let best = 0, stem = '';
      for (const variant of term.variants) {
        if (used.has(variant)) continue;
        const weight = entry.title.has(variant) ? 3 : entry.body.has(variant) ? 1.5 : 0;
        if (weight && weight * rarity(variant) > best) { best = weight * rarity(variant); stem = variant; }
      }
      if (best > 0) { score += best; matched.push(term.word); used.add(stem); }
    }
    const covered = matched.length / terms.length >= COVERED_SHARE && score >= COVERED_SCORE;
    if (matched.length >= MIN_SKILL_TERMS && (score >= MIN_SKILL_SCORE || covered)) matches.push({ skill: entry.skill, score: Math.round(score * 1000) / 1000, terms: matched });
  }
  return matches.sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug, 'en') || a.skill.id.localeCompare(b.skill.id, 'en'));
}

/**
 * With an index (the catalogue path), every active skill is a candidate and only those sharing a stem are scored.
 * Without one, the first MAX_CANDIDATES are scored as before.
 */
export function matchSkills(request: string, candidates: readonly SkillReaderCandidate[], index?: SkillReaderIndex): SkillMatch[] {
  if (typeof request !== 'string' || !request.trim()) return [];
  if (index) {
    if (!index.size) return [];
    const terms = requestTerms(request);
    if (!terms.length) return [];
    const total = Math.log(1 + index.size);
    const rarity = (stem: string) => total > 0 ? Math.log(1 + index.size / Math.max(1, index.frequency(stem) || 1)) / total : 1;
    const positions = index.shortlist(terms.flatMap(term => term.variants));
    return orderReaderMatches(request, scoreSkills(terms, positions.map(position => ({ skill: index.skills[position], ...index.entries[position] })), rarity), index.skills, MIN_SKILL_SCORE);
  }
  const pool = candidates.slice(0, MAX_CANDIDATES);
  if (!pool.length) return [];
  const terms = requestTerms(request);
  if (!terms.length) return [];
  const indexed = pool.map(skill => ({ skill, ...indexOf(skill) }));
  const frequency = new Map<string, number>();
  for (const entry of indexed) for (const stem of new Set([...entry.title, ...entry.body])) frequency.set(stem, (frequency.get(stem) ?? 0) + 1);
  const total = Math.log(1 + pool.length);
  const rarity = (stem: string) => total > 0 ? Math.log(1 + pool.length / Math.max(1, frequency.get(stem) ?? 1)) / total : 1;
  return orderReaderMatches(request, scoreSkills(terms, indexed, rarity), pool, MIN_SKILL_SCORE);
}

// A request that only asks what something is, who, when, where or how much is better answered from sources; a skill is a method.
const FACT_START = /^(?:ما هو|ما هي|ماهو|ماهي|من هو|من هي|متي|اين|وين|كم|هل|ما معني|ما تعريف|عرف|what is|what are|what's|who|when|where|how much|how many|is|are|does|did|define)(?![\p{L}\p{N}])/u;
const ADVICE = /(?:^|[^\p{L}])(?:كيف|كيفيه|طريقه|خطوات|خطوه|نصائح|نصيحه|دليل|افضل طريقه|خطه|ساعدني|ارشدني|علمني|راجع|قيم|حلل|جهز|ضع|اعمل|how to|how do|how can|how should|steps?|tips?|guide|best way|plan|help me|review|checklist)(?:$|[^\p{L}])/u;
// Time-bound facts only. A price word alone is not live: «كيف أحدد سعر منتجي» asks for a method. A subject that is always live
// stays live in any wording («كيف الطقس غدا؟»). A time word is live in a question about a value («كم سعر الذهب اليوم؟»,
// «لخّص أخبار اليوم») or with no how-to at all («ذكرني بموعد الطبيب بكرة»), but not in a request for what to do: «عندي مقابلة
// عمل بكره كيف أستعد؟» asks for preparation and "our website got hacked, what should we do now?" for steps. Until 2026-11-22
// every time word blocked the skill, so both went unanswered.
const LIVE = /(?:^|[^\p{L}])(?:(?:ال)?طقس|نتيجه المباراه|مباراه|مباريات|مواعيد|weather|score|scores)(?:$|[^\p{L}])/u;
const LIVE_TIME = /(?:^|[^\p{L}])(?:اليوم|الان|حاليا|هالايام|غدا|بكره|الليله|today|now|tonight|tomorrow|current|currently|latest)(?:$|[^\p{L}])/u;
const LIVE_VALUE = /(?:^|[^\p{L}])(?:ال)?(?:سعر|اسعار|اخبار|خبر|نتيجه|نتائج|price|prices|rate|rates|news|result|results)(?:$|[^\p{L}])/u;
/** How the asker should act: «كيف أتجهز»، «كيف نتصرف»، "how do I", "how to". «كيف الطقس» and «كيف حالك» are not. */
const DOING = /(?:^|[^\p{L}])(?:(?:كيف|كيفيه|ازاي|شلون|اشلون)\s+(?:ا(?!ل)|ن)\p{L}{2,}|how\s+(?:to|(?:do|can|should|could|would)\s+(?:i|we)))(?:$|[^\p{L}])/u;
/** Translating or reworking a supplied text is work on that text; a method instead of the text would not answer it. */
const REWORK = /^(?:ترجم|تترجم|اعد صياغه|تعيد صياغه|صحح|تصحح|حسن|اختصر|تختصر|لخص|تلخص|translate|rewrite|paraphrase|proofread|shorten|summari[sz]e|reword|edit|polish|improve|correct)(?![\p{L}])|ترجمه/u;

// A question about the owner's own things asks for a stored fact that only their memory or documents can give, whatever words
// follow: «ما ميزانية حملتي؟», «ما خطة مشروعي؟». No mode answers it from a skill: «ما هو بريدي الإلكتروني؟» reached the
// email-marketing skill through `fallback` on 2026-11-22 (pf14 in artifacts/wiring-check-2026-11-22). «كيف أسعّر منتجي؟» asks for a method.
const WH_START =/^(?:ما|ماذا|من(?!\s+فضلك)|كم|اين|وين|متي|امتي|هل|اي|ايهما|وش|شنو|شو|ايش|ايه|what|what's|whats|which|who|whom|whose|when|where|is|are|was|were|does|do|did|has|have)(?![\p{L}\p{N}])/u;
/**
 * A question word followed by what the asker should do asks for a method, not for a stored fact: «ماذا أفعل بعد اختراق حسابي؟»,
 * «ما الخطوات بعد اختراق موقعنا؟», "what should I check before I tell my team the bug is fixed" (refused until 2026-11-22).
 * «ماذا كتبت في تقرير فريقي؟», «وش آخر نسخة سويتها لملفاتي؟» and "what did my team ship?" still ask for a fact: no first-person
 * verb or modal follows the question word.
 */
const ASKS = String.raw`(?:what|which)(?:\s+[\p{L}'’]+){0,2}\s+(?:should|shall|must)\s+(?:i|we)|what\s+(?:can|do)\s+(?:i|we)\s+do|what\s+do\s+(?:i|we)\s+need\s+to|what(?:'s|’s|\s+is)\s+the\s+best\s+way`
  + String.raw`|(?:ماذا|ايش|وش|شو|شنو|ما\s+(?:الذي|اللي)|(?:ايش|وش|شو)\s+اللي)\s+(?:(?:افعل|نفعل|اسوي|نسوي|اعمل|نعمل|بعمل|اتصرف|نتصرف|اكتب|نكتب|بكتب|اقول|نقول)(?:ه|ها)?|لازم|يلزم|يجب|ينبغي|المفروض|علي|علينا)`
  + String.raw`|(?:ما|ماهي|ما\s+هي|وش|ايش|شو)\s+(?:هي\s+)?(?:الخطوات|الخطوه|الطريقه|افضل\s+طريقه)|ما\s+(?:يجب|ينبغي)`;
/** At the start, it lifts the stored-fact refusal; anywhere, it is a how-to cue like `ADVICE`. */
const ADVICE_QUESTION = new RegExp(String.raw`^(?:${ASKS})(?![\p{L}\p{N}])`, 'u');
const ASKS_HOW = new RegExp(String.raw`(?:^|[^\p{L}])(?:${ASKS})(?![\p{L}\p{N}])`, 'u');

// Timing a recommended action and sizing a future requirement are methods too. Keep the exception at the start of the
// question: an unrelated how-to later in a stored-fact question must not turn that fact into advice. Bare Arabic timing
// is restricted to present-tense maintenance, care and usage actions; a date, appointment or past action still needs evidence.
const TIMING_ADVICE = /^(?:(?:متي|امتي)\s+(?:(?:يجب|ينبغي|يفضل|لازم)(?:\s+ان)?\s+(?:ا(?!ل)|ن)\p{L}{2,}|(?:ا|ن)(?:غير|ستبدل|جدد|فحص|صلح|سقي|زرع|راجع|صون|ستخدم))|when\s+(?:should|shall|must)\s+(?:i|we)\s+\p{L}+)(?![\p{L}\p{N}])/u;
const EN_SIZING_ADVICE = /^how\s+(?:many|much)(?:\s+[\p{L}\p{N}'’]+)*?\s+(?:(?:should|shall|must)\s+(?:i|we)\s+\p{L}+|(?:do|will|would)\s+(?:i|we)\s+need)(?![\p{L}\p{N}])/u;
const AR_SIZING_ADVICE = /^كم((?:\s+[\p{L}\p{N}]+)*?)\s+س?(?:احتاج|نحتاج)(?:ه|ها|هم|هن)?(?![\p{L}\p{N}])/u;
const PAST_OR_REPORTED_NEED = /(?:^|\s)(?:كنت|كنا|كان|كانت|قال|قالت|ذكر|ذكرت|اخبر|اخبرت|سجل|سجلت)(?=\s|$)/u;
// A future-tense question can still ask for a fact from a particular record. Require its evidence rather than substitute
// a playbook. The source connector must lead to a record noun within one short phrase, without crossing punctuation;
// merely mentioning an owned policy as the thing to update does not establish a source.
const GROUNDED_ADVICE_SOURCE = /\b(?:according to|based on|per|from|in|using|as (?:stated|specified|written) in)\s+(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:emails?|e-mails?|messages?|letters?|notes?|records?|contracts?|prescriptions?|documents?|reports?|files?|polic(?:y|ies)|manuals?|instructions?|confirmations?|schedules?|calendars?)\b|(?:^|[^\p{L}])(?:حسب|بحسب|وفقا|طبقا|بناءا?\s+علي|استنادا\s+الي|من|في)\s+(?:[\p{L}\p{N}]+\s+){0,4}(?:ال|لل|[بل])?(?:رساله|رسالت|رسائل|بريد|ايميل|ملاحظه|ملاحظت|ملاحظات|سجل|سجلات|عقد|عقود|وصفه|وصفت|وصفات|تقرير|تقارير|مستند|مستندات|وثيقه|وثيقت|وثائق|ملف|ملفات|تعليمات|جدول|سياسه|سياست|سياسات|دليل)(?:ي|نا)?(?![\p{L}\p{N}])/u;
function asksTimingOrSizingAdvice(text: string): boolean {
  if (TIMING_ADVICE.test(text) || EN_SIZING_ADVICE.test(text)) return true;
  const sizing = AR_SIZING_ADVICE.exec(text);
  return sizing !== null && !PAST_OR_REPORTED_NEED.test(sizing[1]!);
}

/** Whether a request in the given mode may be answered from a skill at all, before any skill is read. */
export function skillReadable(request: string, mode: SkillReadMode): boolean {
  if (typeof request !== 'string') return false;
  const text = matchText(request).trim();
  if (!text || text.length > MAX_REQUEST_CHARS) return false;
  const decision = asksTimingOrSizingAdvice(text);
  const doing = DOING.test(text) || ASKS_HOW.test(text) || decision;
  if (LIVE.test(text) || (LIVE_TIME.test(text) && (LIVE_VALUE.test(text) || !doing))) return false;
  if (mode === 'writing') return !REWORK.test(text);
  if (decision && GROUNDED_ADVICE_SOURCE.test(text)) return false;
  if ((FACT_START.test(text) || WH_START.test(text)) && !ADVICE_QUESTION.test(text) && !decision && buildFrame(request).personal) return false;
  if (mode === 'advice') return ADVICE.test(text) || ASKS_HOW.test(text) || decision || !FACT_START.test(text);
  if (mode === 'personal') return (ADVICE.test(text) || doing) && (ADVICE_QUESTION.test(text) || decision || (!FACT_START.test(text) && !WH_START.test(text)));
  return true;
}

type SectionKey = 'when' | 'inputs' | 'steps' | 'answer' | 'checks' | 'pitfalls' | 'tips' | 'other';
export interface SkillSection { key: SectionKey; heading: string; text: string }
export interface SkillSections { intro: string; sections: SkillSection[] }
const SECTION_NAMES: [SectionKey, RegExp][] = [
  ['when', /^(?:متي تستخدم|متي استخدم|متي يستخدم|متي تستعمل|استخدمها عندما|when to use|use (?:it )?when|when)/u],
  ['inputs', /^(?:ما احتاجه منك|ما احتاج معرفته|ما تحتاجه|ما يلزمني|المعلومات المطلوبه|معلومات مطلوبه|المدخلات|اسئله قبل البدء|inputs?|what i need|information needed|before you start)/u],
  ['steps', /^(?:الخطوات|خطوات العمل|الطريقه|المنهج|المنهجيه|steps?|procedure|method|process)/u],
  ['answer', /^(?:قالب الجواب|شكل الجواب|هيكل الجواب|الجواب|المخرج|النتيجه|القالب|الهيكل|answer|output|template|deliverable|structure)/u],
  ['checks', /^(?:التحقق|قائمه التحقق|تحقق قبل التسليم|معايير الجوده|checks?|checklist|quality)/u],
  ['pitfalls', /^(?:اخطاء شائعه|تجنب|ما يجب تجنبه|pitfalls?|mistakes?|avoid)/u],
  ['tips', /^(?:نصائح|نصائح سريعه|tips?)/u],
];
const HIDDEN = /<!--[\s\S]*?(?:-->|$)|[​-‏‪-‮⁠-⁯﻿]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const clean = (text: string) => text.replace(/\r\n?/gu, '\n').replace(HIDDEN, '').replace(/\n{3,}/gu, '\n\n').trim();
const headingKey = (heading: string): SectionKey => {
  const name = matchText(heading).replace(/^[\s#*\d.)\-–—•:]+/u, '').replace(/[\s:：.*]+$/u, '').trim();
  return SECTION_NAMES.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other';
};

/** Splits a SKILL.md body at its markdown headings and names the sections it knows. */
export function parseSkillSections(body: string): SkillSections {
  const lines = clean(body).split('\n');
  const sections: SkillSection[] = [];
  let intro: string[] = [], current: { heading: string; lines: string[] } | null = null;
  const close = () => { if (current) { const text = current.lines.join('\n').trim(); if (text) sections.push({ key: headingKey(current.heading), heading: current.heading, text }); } };
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) { close(); current = { heading: heading[1]!.replace(/\*\*/gu, '').trim(), lines: [] }; continue; }
    if (current) current.lines.push(line); else intro.push(line);
  }
  close();
  return sections.length ? { intro: intro.join('\n').trim(), sections } : plainSections(intro.join('\n'));
}

const ANSWER_LINE = /^\s*(?:answer shape|answer format|output|شكل الجواب|هيكل الجواب|الجواب)\s*[:：]\s*(.*)$/iu;
const NUMBERED = /^\s*(?:\d{1,2}|[٠-٩]{1,2})[.)-]\s+/u;
/** A body without headings, the shape of the published library: an opening line, numbered steps and an «Answer shape:» line. */
function plainSections(text: string): SkillSections {
  const intro: string[] = [], steps: string[] = [], answer: string[] = [];
  for (const line of text.split('\n')) {
    const shape = ANSWER_LINE.exec(line);
    if (shape) { if (shape[1]!.trim()) answer.push(shape[1]!.trim()); continue; }
    if (steps.length || NUMBERED.test(line)) steps.push(line); else intro.push(line);
  }
  const sections: SkillSection[] = [];
  const body = steps.join('\n').trim();
  if (body) sections.push({ key: 'steps', heading: '', text: body });
  if (answer.length) sections.push({ key: 'answer', heading: '', text: answer.join('\n') });
  const opening = intro.join('\n').trim();
  // Unstructured text is shown whole, not cut down to an opening line.
  if (!sections.length && opening) return { intro: '', sections: [{ key: 'other', heading: '', text: opening }] };
  return { intro: opening, sections };
}

/** The language a body is written in, by its letters. */
export function bodyLanguage(text: string): 'ar' | 'en' {
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0, latin = text.match(/[A-Za-z]/gu)?.length ?? 0;
  return arabic >= latin ? 'ar' : 'en';
}

const LABELS = {
  ar: { steps: 'الخطوات', answer: 'شكل الجواب', checks: 'تحقق قبل التسليم', pitfalls: 'أخطاء شائعة', tips: 'نصائح',
    inputs: 'لأطبّق المهارة على حالتك بدقة، أخبرني بـ:', related: 'مهارات قريبة',
    writing: 'لا أكتب نصًا حرًا كاملًا دون نموذج لغوي، لكن مهارة «{name}» المفعّلة لديك تعطيك الطريقة والهيكل لتكتبه باحتراف:',
    name: (name: string) => `«${name}»`, list: '، ', applied: (request: string) => `طلبك: «${request}»`, foreign: 'نص هذه المهارة مكتوب بالإنجليزية كما نُشر.',
    source: (skill: SkillReaderCandidate) => `المصدر: مهارة «${skill.name}» (${skill.slug})، الإصدار ${skill.version}.` },
  en: { steps: 'Steps', answer: 'Answer outline', checks: 'Check before you deliver', pitfalls: 'Common mistakes', tips: 'Tips',
    inputs: 'To tailor this to your case, tell me:', related: 'Related skills',
    writing: 'I do not write free text in full without a language model, but your active skill “{name}” gives you the method and the outline to write it well:',
    name: (name: string) => `“${name}”`, list: ', ', applied: (request: string) => `Your request: “${request}”`, foreign: 'This skill is written in Arabic, as published.',
    source: (skill: SkillReaderCandidate) => `Source: skill “${skill.name}” (${skill.slug}), version ${skill.version}.` },
} as const;
const ORDER: SectionKey[] = ['steps', 'answer', 'checks', 'pitfalls', 'tips', 'other'];
const bound = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit).replace(/\s+\S*$/u, '')}…`;

/** Builds the answer from one skill: its steps, outline and checks first, what it needs from the owner last, and the skill named as source. */
export function composeSkillAnswer(request: string, skill: SkillReaderCandidate, body: string, options: { mode: SkillReadMode; related?: readonly SkillReaderCandidate[] }): { text: string; lang: 'ar' | 'en' } {
  const lang: 'ar' | 'en' = ARABIC.test(request) ? 'ar' : 'en';
  const label = LABELS[lang];
  const quoted = bound(request.replace(/\s+/gu, ' ').trim(), 160);
  const fill = (text: string) => text.replace(/\{\{\s*(?:الطلب|request)\s*\}\}/giu, `«${quoted}»`);
  const { intro, sections } = parseSkillSections(body);
  const parts: string[] = [];
  if (options.mode === 'writing') parts.push(label.writing.replace('{name}', skill.name));
  parts.push(`**${skill.name}**\n${label.applied(quoted)}${bodyLanguage(body) === lang ? '' : `\n${label.foreign}`}`);
  const opening = intro || skill.description.split(/(?<=[.!؟?])\s/u)[0] || '';
  if (opening) parts.push(bound(fill(opening), 600));
  const ordered = ORDER.flatMap(key => sections.filter(section => section.key === key));
  const inputs = sections.filter(section => section.key === 'inputs');
  const tail: string[] = [];
  if (inputs.length) tail.push(`**${label.inputs}**\n${bound(fill(inputs.map(section => section.text).join('\n')), 700)}`);
  const related = (options.related ?? []).slice(0, 3);
  if (related.length) tail.push(`${label.related}: ${related.map(item => label.name(item.name)).join(label.list)}.`);
  tail.push(label.source(skill));
  const reserved = tail.join('\n\n').length + 4;
  for (const section of ordered) {
    const title = section.key === 'other' ? section.heading : label[section.key as 'steps' | 'answer' | 'checks' | 'pitfalls' | 'tips'];
    const text = bound(fill(section.text), MAX_SECTION_CHARS);
    const block = title ? `**${title}**\n${text}` : text;
    if (parts.join('\n\n').length + block.length + reserved > MAX_ANSWER_CHARS) continue;
    parts.push(block);
  }
  return { text: [...parts, ...tail].join('\n\n'), lang };
}

const Envelope = z.object({
  kind: z.literal('skill_context'), permissionsGranted: z.literal(false),
  skills: z.array(z.object({ sources: z.array(z.object({ path: z.string(), text: z.string() }).passthrough()) }).passthrough()),
}).passthrough();
/** The SKILL.md text inside a compiled skill context, or null when the context holds no instructions. */
export function skillInstructionText(compiledText: string): string | null {
  if (typeof compiledText !== 'string' || !compiledText) return null;
  let raw: unknown;
  try { raw = JSON.parse(compiledText); } catch { return null; }
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.skills[0]?.sources.find(source => source.path === 'SKILL.md')?.text ?? null;
}

/** Bounded wait for one verified read; a slow or failing skill store never holds a reply back. */
async function withinTime<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS); timer.unref?.(); });
  const aborted = new Promise<null>(resolve => signal?.addEventListener('abort', () => resolve(null), { once: true }));
  try { return await Promise.race([work, timeout, aborted]); } finally { if (timer) clearTimeout(timer); }
}

/** The reader the chat calls. It returns null whenever no active skill clearly fits, so the conversation goes on as before. */
export function createSkillReader(deps: SkillReaderDeps): SkillReader {
  return async (ownerId, request, options) => {
    if (!skillReadable(request, options.mode) || options.signal?.aborted) return null;
    const index = deps.index ? await withinTime(deps.index(ownerId).catch(() => null), options.signal) : null;
    let matches: SkillMatch[];
    if (index) {
      if (!index.size || options.signal?.aborted) return null;
      matches = matchSkills(request, index.skills, index);
    } else {
      const candidates = await withinTime(deps.candidates(ownerId).catch(() => null), options.signal);
      if (!candidates?.length || options.signal?.aborted) return null;
      matches = matchSkills(request, candidates);
    }
    const wanted: 'ar' | 'en' = ARABIC.test(request) ? 'ar' : 'en';
    // The best skill that still passes the gate, unless a close one (within 80% of its score) is written in the request's language.
    let chosen: { match: SkillMatch; body: string } | null = null;
    // If topic filtering displaced an original top match, try it only when the new window has no verified body.
    const shortlist = matches.filter((match, position) => position < READER_MATCH_WINDOW || match.genericFallback);
    for (const [position, match] of shortlist.entries()) {
      if (chosen && position >= READER_MATCH_WINDOW) break;
      if (chosen && match.score < chosen.match.score * 0.8) continue;
      const body = await withinTime(deps.instructions(ownerId, match.skill.id).catch(() => null), options.signal);
      if (options.signal?.aborted) return null;
      if (!body?.trim()) continue;
      if (!chosen) chosen = { match, body };
      if (bodyLanguage(body) === wanted) { chosen = { match, body }; break; }
    }
    if (!chosen) return null;
    const { match, body } = chosen;
    const related = matches.filter(entry => entry !== match).map(entry => entry.skill);
    const { text, lang } = composeSkillAnswer(request, match.skill, body, { mode: options.mode, related });
    return { text, skill: match.skill, related, terms: match.terms, score: match.score, lang };
  };
}
