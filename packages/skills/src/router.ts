import type { SkillCategory } from '@mohassan/contracts';
import { arabicBase, foldText, functionWord, requestTerms, skillStems, STEM_STOP_WORDS, type RequestTerm } from './stems.ts';

export interface SkillContextMetadata {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: string;
  contentHash: string;
}

const CATEGORY_WORDS: Record<SkillCategory, string> = {
  reasoning: 'reasoning planning plan تحليل تخطيط خطة استدلال',
  coding: 'coding code software program typescript javascript python برمجة كود برنامج تطبيق',
  browser: 'browser web navigate website متصفح تصفح موقع',
  computer: 'computer desktop windows حاسوب كمبيوتر سطح مكتب',
  design: 'design ui ux interface تصميم واجهة ألوان',
  creativity: 'creativity creative ideas إبداع أفكار ابتكار',
  documents: 'documents document report pdf word مستند وثيقة تقرير',
  languages: 'languages translate translation لغة ترجمة لغات',
  business: 'business company strategy أعمال شركة استراتيجية',
  marketing: 'marketing campaign ads تسويق حملة إعلان',
  research: 'research sources evidence search بحث مصادر أدلة',
  security: 'security audit permissions أمان أمن تدقيق صلاحيات',
  analytics: 'analytics data analysis statistics بيانات إحصاء تحليلات',
  media: 'media image video audio صورة فيديو صوت',
};
// Function and question words name no topic. Without them, «ما عاصمة اليابان؟» matched a backup skill through «ما يُنسخ»,
// and «what is …» matched any description containing «is» (scripts/skills-catalogue/validate-pilot.ts, 2026-11-22).
const STOP_WORDS = new Set(('the a an and or to of in for on with this that please use task من في على إلى الى عن هذا هذه مع أو او و طلب مهمة '
  + 'ما ماذا هل كم كيف لماذا متى اين أين لي لك هو هي انا أنا نحن انت أنت الآن الان اليوم كل اي أي لا نعم قد لقد كان ثم ان إن أن '
  + 'is are was were be been am i me my we our you your it its what how why when where who which do does did can could would should will may might must not no yes there here than then also just very now today').split(' '));
const FOLDED_STOP_WORDS = new Set([...STOP_WORDS].map(foldText));
export function isGenericRoutingWord(word: string): boolean {
  return functionWord(word, FOLDED_STOP_WORDS) || functionWord(arabicBase(word), FOLDED_STOP_WORDS);
}
export function skillTerms(text: string): string[] {
  return [...new Set(text.normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(term => term.length > 1 && !STOP_WORDS.has(term)).slice(0, 100);
}

export interface SkillRoutingRelations {
  /** Bounded, positive graph relations already filtered by the owner's graph.
   * Conflict edges are never converted into recommendation candidates. */
  relatedCandidates?: readonly SkillContextMetadata[];
}

/** The router reads at most this many candidates per request. */
const ROUTER_WINDOW = 200;

/**
 * How much a term says about a skill: log(1 + N/df) / log(1 + N) over the N active skills, df of which hold the term. A term only one
 * skill holds weighs 1; a term every skill holds weighs log 2 / log(1 + N). The model-free reader weighs its stems the same way
 * (apps/server/src/assistant/skill-reader.ts). Unweighted, every shared word counted alike, so with 193 skills a common word in a name
 * («جدول»، «مشاريع»، «رسالة») put the wrong skill first in 23 of 100 development questions (it was 2 of 100 with 100 skills).
 */
export type RouterTermWeight = (term: string) => number;
export function rarityWeights(index: { readonly size: number; frequency(term: string): number }): RouterTermWeight {
  const total = Math.log(1 + index.size);
  return term => (total > 0 ? Math.log(1 + index.size / Math.max(1, index.frequency(term))) / total : 1);
}
/** Arabic words are stemmed as the reader stems them; English words stay whole (see StemOptions in stems.ts). */
const ROUTER_STEMS = { english: 'exact' } as const;
const routerStems = (text: string) => skillStems(text, ROUTER_STEMS);
/**
 * The terms the router reads in a skill: its id, its name and its description, folded as the reader folds them, with Arabic words
 * stemmed (stems.ts), so «الإكسل» meets «اكسل» and «جوالي» meets «الجوال». catalogue.ts indexes the same terms (routerIndex).
 */
export function routerTermsOf(skill: SkillContextMetadata): string[] {
  return [...new Set([...routerStems(skill.slug), ...routerStems(skill.name), ...routerStems(skill.description)])];
}
/**
 * A request's words with their stem variants, as the reader reads them, from the first 16,000 characters and at most 100 words.
 * The router also tries each Arabic word whole, with only its article or one prefix letter removed: a singular noun and its plural
 * otherwise stem apart (request «إعلان» → «اعل», skill «إعلانات» → «اعلان»), and «اكتب إعلان لخدمة النقل» then reached no Ads skill.
 */
export function routerRequestTerms(goal: string): RequestTerm[] {
  return requestTerms(goal, 16000, ROUTER_STEMS).slice(0, 100).map(term => {
    if (!/\p{Script=Arabic}/u.test(term.word)) return term;
    const whole = [arabicBase(term.word), ...['و', 'ف', 'ب', 'ل', 'ك'].filter(clitic => term.word.startsWith(clitic) && term.word.length > 3).map(clitic => arabicBase(term.word.slice(1)))];
    const extra = whole.filter(form => form.length >= 3 && !STEM_STOP_WORDS.has(form) && !term.variants.includes(form));
    return extra.length ? { word: term.word, variants: [...term.variants, ...new Set(extra)] } : term;
  });
}
/** Weights computed over the candidates themselves: right when they are every active skill, as in tests and offline checks. */
function candidateWeights(candidates: readonly SkillContextMetadata[]): RouterTermWeight {
  const frequency = new Map<string, number>();
  for (const skill of candidates) for (const term of routerTermsOf(skill)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return rarityWeights({ size: candidates.length, frequency: term => frequency.get(term) ?? 0 });
}
export interface RouterOptions {
  /** Term weights over every active skill (catalogue.routerWeights). Without them the weights come from the candidates given. */
  weight?: RouterTermWeight;
  /** A direct match below this score is left out. Default ROUTER_MIN_SCORE. */
  minScore?: number;
  /** A direct match below this share of the best match's score is left out. Default ROUTER_RELATIVE. */
  relative?: number;
}
/**
 * The cut (2026-11-24, docs/SKILLS-LIBRARY-EXPANSION-2026-11-24.md). A direct match needs 2, one distinctive word in the description,
 * and 35% of the best match's score. It was chosen on the development sets (library dev and none-dev, the expansion dev set, the pilot
 * cases; 289 requests that need a skill, 86 that need none) and checked on the 107 real requests, where a stricter cut failed: 3 and
 * 50% kept an acceptable skill in the first three for 8 of 36 real requests, against 28 with the old router (library skills only).
 * With the builtin skills, old router → this one: development first 235 → 260 of 289, wrong skills per request 3.60 → 1.62, no skill
 * for 31 → 26 of 86 no-skill requests; real first 23 → 23 of 36, acceptable in the first three 32 → 27, wrong per request 3.11 → 1.92.
 */
export const ROUTER_MIN_SCORE = 2;
export const ROUTER_RELATIVE = 0.35;

export type Scored = { skill: SkillContextMetadata; score: number };
/** A category word adds this little, so it only orders skills whose term scores are otherwise equal. */
const CATEGORY_TIE = 0.001;
/**
 * Stem overlap with the slug, the name and the description, weighted 6, 4 and 2 and by each stem's rarity. Each request word counts
 * once, by its best variant, and a stem counts once, as in the reader. Category words only break ties between skills that already
 * match: on their own, «شركة» would pull in every business skill.
 */
function scorer(terms: readonly RequestTerm[], weight: RouterTermWeight): (skill: SkillContextMetadata) => number {
  return skill => {
    const slug = new Set(routerStems(skill.slug)), name = new Set(routerStems(skill.name)), description = new Set(routerStems(skill.description));
    let content = 0;
    const used = new Set<string>();
    for (const term of terms) {
      let best = 0, stem = '';
      for (const variant of term.variants) {
        if (used.has(variant)) continue;
        const value = ((slug.has(variant) ? 6 : 0) + (name.has(variant) ? 4 : 0) + (description.has(variant) ? 2 : 0)) * weight(variant);
        if (value > best) { best = value; stem = variant; }
      }
      if (best > 0) { content += best; used.add(stem); }
    }
    if (content === 0) return 0;
    const category = new Set(routerStems(CATEGORY_WORDS[skill.category]));
    return content + CATEGORY_TIE * terms.filter(term => term.variants.some(variant => category.has(variant))).length;
  };
}
const byScore = (a: Scored, b: Scored) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug, 'en') || a.skill.id.localeCompare(b.skill.id, 'en');

/** Deterministic metadata-only ranking. A match is guidance, never a tool grant. */
export function routeInstructionSkills(goal: string, candidates: readonly SkillContextMetadata[], limit = 6, relations: SkillRoutingRelations = {}, options: RouterOptions = {}): SkillContextMetadata[] {
  const terms = routerRequestTerms(goal);
  const related = relations.relatedCandidates?.slice(0, 12) ?? [];
  if (!terms.length && !related.length) return [];
  const relatedIds = new Set(related.map(skill => skill.id));
  const scanned = candidates.slice(0, ROUTER_WINDOW);
  const combined = [...new Map([...scanned, ...related].map(skill => [skill.id, skill])).values()];
  const score = scorer(terms, options.weight ?? candidateWeights(scanned));
  const scored = combined.map(skill => ({ skill, score: score(skill) }));
  // Weak direct matches are left out: below the minimum, or far below the best match. Graph relations keep their place after them.
  const best = Math.max(0, ...scored.filter(entry => !relatedIds.has(entry.skill.id)).map(entry => entry.score));
  const floor = Math.max(options.minScore ?? ROUTER_MIN_SCORE, (options.relative ?? ROUTER_RELATIVE) * best);
  return scored
    .filter(entry => (entry.score > 0 && entry.score >= floor) || relatedIds.has(entry.skill.id))
    .sort(byScore)
    .slice(0, Math.min(6, Math.max(0, Math.floor(limit))))
    .map(entry => entry.skill);
}

/** Every direct match with its score, best first, before any cut or limit: for measuring where to cut (scripts/skills-library). */
export function scoreInstructionSkills(goal: string, candidates: readonly SkillContextMetadata[], options: RouterOptions = {}): Scored[] {
  const terms = routerRequestTerms(goal);
  if (!terms.length) return [];
  const scanned = candidates.slice(0, ROUTER_WINDOW);
  const score = scorer(terms, options.weight ?? candidateWeights(scanned));
  return scanned.map(skill => ({ skill, score: score(skill) })).filter(entry => entry.score > 0).sort(byScore);
}

/** With more active skills than the router reads, this picks the ones that score highest, with the same score and the same order,
 * so routing over its result returns exactly what routing over every candidate would, given the same weights (pass the catalogue's
 * to both). Skills that share no term are left out. */
export function rankInstructionCandidates(goal: string, candidates: readonly SkillContextMetadata[], limit = ROUTER_WINDOW, options: RouterOptions = {}): SkillContextMetadata[] {
  const terms = routerRequestTerms(goal);
  if (!terms.length) return [];
  const score = scorer(terms, options.weight ?? candidateWeights(candidates));
  return candidates.map(skill => ({ skill, score: score(skill) })).filter(entry => entry.score > 0).sort(byScore)
    .slice(0, Math.max(0, Math.floor(limit))).map(entry => entry.skill);
}
