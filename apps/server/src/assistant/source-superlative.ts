// Source rank words in their folded forms. Keep dimensions separate so that a
// country's population rank cannot answer a question about its area.
const RANKS = [
  'اكبر|largest|biggest', 'اصغر|smallest', 'اعلي|highest|tallest', 'ادني|اخفض|lowest',
  'اطول|longest', 'اقصر|shortest', 'اقدم|oldest', 'اسرع|fastest', 'اغني|richest',
  'اعمق|deepest',
  'اكثر سكانا|most populous|most populated', 'اقل سكانا|least populous|least populated',
];
const RANK = RANKS.join('|');
const QUESTION = new RegExp(`^(?:(?:ما|من|اي)(?:\\s+(?:هو|هي))?|(?:what|which|who) (?:is|was|are|were) the|which)\\s+(?:ال)?(${RANK})\\s+(.+)$`, 'u');
const CLASS_FIRST = new RegExp(`^(?:(?:which|what) (.+?) (?:is|was|are|were)(?: the)? |اي (.+?) (?:هي|هو) (?:ال)?)(${RANK})(?=\\s|$)(.*)$`, 'u');
const COUNTRIES = 'دوله|دول|بلد|بلدان';
const CLASS_FORMS = new Map([
  ['دوله', COUNTRIES], ['دول', COUNTRIES], ['بلد', COUNTRIES], ['بلدان', COUNTRIES],
  ['نهر', 'نهر|انهار'], ['جبل', 'جبل|جبال'], ['مدينه', 'مدينه|مدن'],
  ['بحر', 'بحر|بحار'], ['محيط', 'محيط|محيطات'], ['country', 'country|countries'],
]);
const AREA = /(?<!\p{L})(?:[بوف]?(?:ال)?مساح[هت]\p{L}*|(?:كيلومتر\p{L}*|كم)\s*(?:مربع\p{L}*|²|2)|area|square (?:kilometers?|kilometres?|miles?)|km\s*[²2])(?!\p{L})/u;
const POPULATION = /(?<!\p{L})(?:[بوف]?(?:ال)?سكان\p{L}*|نسمه|population|inhabitants)(?!\p{L})/u;
const DIMENSION = /\s+(?:من حيث|بحسب|حسب|by|in terms of)\s+/u;
const LOWER_RANK = /(?<!\p{L})(?:ال)?(?:من|احد|احدي|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر|one of|among|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)(?:[ -]+(?:of |the |worlds ))*[ -]*$/u;
const ARAB_SCOPE = /^(?:عربيه?|العربيه|العالم العربي|الوطن العربي)$/u;
const INTRODUCED_AREA = /(?:^|[،,]\s*)بمساحه\s+(?:تبلغ\s+)?\p{Nd}/u;
const FIRST_IN_ARAB_WORLD = /^\s+في العالم[،,]\s*و?ال(?:اول|اولي)\s+(?:و?(?:افريقيا|اسيويا|متوسطيا)\s+)*و?عربيا(?=$|[\s،,])/u;
const SUBJECT_BEFORE = /(?<!\p{L})(?:هي|هو|تعد|يعد|تعتبر|يعتبر|is|was|are|were)(?!\p{L})|[:،,]$/u;
const SUBJECT_AFTER = /(?<!\p{L})(?:هي|هو|is|was|are|were)\s+\p{L}/u;
const BARE_ARABIC_SUBJECT = /^(?!(?:هذا|هذه|تلك|ذلك|اولها|اكبرها)(?=\s|$))(?:\p{Script=Arabic}{2,}\s+){0,4}\p{Script=Arabic}{2,}$/u;
const UNASSERTED_RANK = /(?<!\p{L})(?:ليس|ليست|ليسا|لا|غير معروف|not|never|whether|which|unknown|unclear)(?!\p{L})/u;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const fullWord = (pattern: string) => `(?<!\\p{L})(?:${pattern})(?!\\p{L})`;

/** A selected sentence has to name a winner of the requested class, scope and measure. Inputs are folded text. */
export function superlativeEvidence(question: string): ((line: string) => boolean) | null {
  const parsed = QUESTION.exec(question);
  const classFirst = parsed ? null : CLASS_FIRST.exec(question);
  const rank = parsed?.[1] ?? classFirst?.[3];
  if (!rank) return null;
  const arabic = /\p{Script=Arabic}/u.test(question);
  const description = parsed?.[2] ?? `${classFirst?.[1] ?? classFirst?.[2]}${classFirst?.[4]}`;
  const [category, statedMeasure] = description.split(DIMENSION, 2);
  const bareMeasure = arabic && !statedMeasure ? /\s+(مساحه|سكانا)$/u.exec(category!) : null;
  const measure = statedMeasure ?? bareMeasure?.[1];
  const scopedCategory = bareMeasure ? category!.slice(0, bareMeasure.index) : category!;
  const categoryMatch = (arabic ? /^(\S+)\s*(.*)$/u : /^(.+?)(?:\s+(?:in|on|of|among)\s+(.+))?$/u).exec(scopedCategory);
  if (!categoryMatch) return null;
  const kind = categoryMatch[1]!.replace(/^ال/u, '');
  const scope = categoryMatch[2]?.replace(/^(?:في|من|ضمن|the)\s+/u, '');
  const ranks = RANKS.find(group => group.split('|').includes(rank))!;
  const rankInLine = arabic ? ranks.split('|').filter(word => /\p{Script=Arabic}/u.test(word)).join('|') : ranks.split('|').filter(word => /^[a-z]/u.test(word)).join('|');
  const kindInLine = CLASS_FORMS.get(kind) ?? `${escape(kind)}${arabic ? '' : 's?'}`;
  const rankedClass = new RegExp(`${fullWord(`(?:ال)?(?:${rankInLine})`)}\\s+(?:ال)?(?:${kindInLine})(?!\\p{L})`, 'gu');
  const scopeInLine = scope && new RegExp(`^\\s*(?:(?:في|من|ضمن|in|on|of|among)\\s+)?(?:the\\s+)?${fullWord(
    ARAB_SCOPE.test(scope) ? 'عربيه?|العربيه|العالم العربي|الوطن العربي'
      : scope === 'world' || scope === 'earth' ? 'world|earth' : escape(scope),
  )}`, 'u');
  const scopeBeforeRank = scope && !arabic ? new RegExp(`${fullWord(`${escape(scope)}s`)}$`, 'u') : null;
  const metric = !measure ? null : AREA.test(measure) ? AREA : POPULATION.test(measure) ? POPULATION : new RegExp(fullWord(escape(measure)), 'u');
  const arabCountryByArea = rank === 'اكبر' && kindInLine === COUNTRIES && metric === AREA && ARAB_SCOPE.test(scope ?? '');

  return (line: string): boolean => [...line.matchAll(rankedClass)].some(({ index, 0: matched }) => {
    const before = line.slice(0, index).trim();
    const after = line.slice(index + matched.length);
    const assertion = after.split(/[؛;]|(?:،|,)\s*(?:وهي|وهو|اما|بينما|but|while|whereas)\s+/u, 1)[0]!;
    if (UNASSERTED_RANK.test(before) || UNASSERTED_RANK.test(assertion)) return false;
    // “Second-largest”, “among the largest” and their Arabic forms are no winner.
    if (LOWER_RANK.test(before)) {
      // A sentence can state a lower global rank, then explicitly state first in the Arab world for the same area ranking.
      return arabCountryByArea && SUBJECT_BEFORE.test(before) && INTRODUCED_AREA.test(before) && FIRST_IN_ARAB_WORLD.test(assertion);
    }
    if (!SUBJECT_BEFORE.test(before) && !SUBJECT_AFTER.test(assertion) && !(arabic && BARE_ARABIC_SUBJECT.test(before))) return false;
    if (scopeInLine && !scopeBeforeRank?.test(before) && !scopeInLine.test(assertion)) return false;
    const explicitMeasure = assertion.split(DIMENSION, 2)[1]?.split(/[،,]/u, 1)[0];
    const evidence = explicitMeasure ?? assertion;
    const conflictingMetric = metric === AREA ? POPULATION : metric === POPULATION ? AREA : null;
    return !metric || metric.test(evidence) && !conflictingMetric?.test(evidence);
  });
}
