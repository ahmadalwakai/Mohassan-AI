/**
 * The word stems skill selection reads, shared by the model-free reader (apps/server/src/assistant/skill-reader.ts) and the model
 * path's router (router.ts), so both meet a request on the same terms. Moved here unchanged from the reader on 2026-11-24.
 *
 * Folding (as the assistant's matchText): Arabic-Indic digits → ASCII, Arabic marks and tatweel removed, أ/إ/آ/ٱ → ا, ى/ی → ي,
 * ة → ه, lower case. Stemming is light on purpose: one article or prefix and one suffix, never below three letters.
 */
const ARABIC_MARKS = /[ؐ-ؚـً-ٰٟۖ-ۭ]/gu;
const foldDigits = (text: string) => text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));
export function foldText(text: string): string {
  return foldDigits(text.normalize('NFKC')).replace(ARABIC_MARKS, '').replace(/[أإآٱ]/gu, 'ا').replace(/[ىی]/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();
}

// Folded forms: أ/إ/آ → ا, ى → ي, ة → ه. These words say how something is asked, not what it is about.
export const STEM_STOP_WORDS: ReadonlySet<string> = new Set(`
من في فى على علي الى إلى عن ما ماذا هل كيف كيفيه لماذا ليش متى متي اين وين لي لك له لها لنا لكم هذا هذه هذي ذلك تلك هناك هنا مع او ام و ثم ان كان
يكون تكون هو هي انا نحن انت انتي انتم اريد ابغى ابغي ابي بدي عايز عاوز ممكن لو سمحت فضلك رجاء الرجاء شي شيء اي ايش وش شو كل بعض جدا عند عندي حتى قد
لقد لم لن لا نعم مثل غير بين بعد قبل ساعدني ساعدنا اعطني اعطيني عطني قل قولي افضل احسن طريقه طرق خطوات خطوه نصائح نصيحه دليل ارشدني علمني كيفيه
اعمل سوي سويلي اعملي جهز جهزلي ضع حتي ايضا كذلك اكثر اقل يعني بس فقط لكن ولكن اذا إذا لانه لان التي الذي الذين اللي يا ياريت عشان علشان
يوجه يبدا يبدأ يساعد يجعل يحقق يعطي يقدم يشرح يمكن يمكنك تبدا يتم كان كانت صار يصير متي
the a an and or to of in for on with by at from this that these those is are was were be been am do does did i me my we our us you your it its
how what why when where which who whom can could would should will shall may might must please help tell give show want need get make about into
over best way ways step steps tip tips guide some any all very just also than then there here
`.trim().split(/\s+/u));
const STOP_WORDS = STEM_STOP_WORDS;
const ARTICLES = ['وبال', 'فبال', 'وكال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ال'];
const CLITICS = ['و', 'ف', 'ب', 'ل', 'ك'];
const NUMBER_SUFFIXES = ['يات', 'ات', 'ون', 'ين', 'ان'];
const SUFFIXES = [...NUMBER_SUFFIXES, 'ها', 'هم', 'هن', 'كم', 'نا', 'يه', 'ي', 'ه'];
const POSSESSIVES = ['هما', 'كما', 'ها', 'هم', 'هن', 'كم', 'كن', 'نا', 'ه', 'ك', 'ي'];
// These word families need more than affix removal. Match whole words to preserve unrelated roots.
const LEMMA_FAMILIES = [
  [/^(?:استقلال|استقل(?:ت|تم|تن|نا|وا)?|[تني]ستقل(?:ان|ون|ن|ين)?)$/u, 'استقلال'],
  [/^(?:استخدام|استخدم(?:ت|تم|تن|نا|وا)?|[تني]ستخدم(?:ان|ون|ن|ين)?)$/u, 'استخدام'],
  [/^(?:اعلان|اعلن(?:ت|تم|تن|نا|وا)?|[تني]علن(?:ان|ون|ن|ين)?)$/u, 'اعلان'],
  [/^(?:لغه|لغت|لغات)$/u, 'لغه'],
  [/^(?:عاصمه|عاصمت|عواصم)$/u, 'عاصمه'],
] as const;
const ARABIC = /\p{Script=Arabic}/u;
/** The reader reads the first 800 characters of a request. */
const MAX_REQUEST_CHARS = 800;

/** A word with only its article or prefix removed (no suffix): «الإعلان» → «اعلان». */
export function arabicBase(word: string): string {
  for (const article of ARTICLES) if (word.startsWith(article) && word.length - article.length >= 3) return word.slice(article.length);
  return word;
}
function withoutSuffix(word: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  return word;
}
export function arabicStem(word: string): string {
  return withoutSuffix(arabicBase(word), SUFFIXES);
}

function arabicLemma(word: string): string {
  const base = arabicBase(word);
  const unpossessed = withoutSuffix(base, POSSESSIVES);
  const stem = withoutSuffix(unpossessed, unpossessed === base ? SUFFIXES : NUMBER_SUFFIXES);
  const forms = [base, unpossessed, stem].flatMap(form => {
    const unjoined = form.replace(/^[وف]/u, '');
    return [form, unjoined, arabicBase(unjoined).replace(/^[بلك]/u, '')];
  });
  return LEMMA_FAMILIES.find(([pattern]) => forms.some(form => pattern.test(form)))?.[1] ?? stem;
}
export function englishStem(word: string): string {
  let stem = word.replace(/'s$/u, '');
  if (stem.length > 4 && stem.endsWith('ies')) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && /(?:ss|sh|ch|x)es$/u.test(stem)) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
  if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  if (stem.length > 3 && /([bcdfghjklmnpqrstvwxz])\1$/u.test(stem)) stem = stem.slice(0, -1);
  if (stem.length > 4 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem;
}
/**
 * `english: 'stem'` (the reader, the default) shortens English words; `'exact'` keeps them whole. The model path's router uses 'exact':
 * on real requests the English stemmer joined «bookings» to the book skill and «leads» to «leading» in the typography skill.
 */
export interface StemOptions { english?: 'stem' | 'exact' }
const stemOf = (word: string, options: StemOptions = {}) => ARABIC.test(word) ? arabicStem(word) : options.english === 'exact' ? word : englishStem(word);
const words = (text: string) => foldText(text).replace(/[_-]+/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A function word, bare or behind a clitic: «وكل», «لكل», «فما», «وبعد» name no topic. «وكل كم» in the backup skill's description
 * matched «وكل الملفات» in a ransomware request and took it (skills-pilot/tests/heldout-2.json, 2026-11-22). «واي» stays: «واي فاي».
 */
function functionWord(word: string): boolean {
  if (STOP_WORDS.has(word)) return true;
  if (!ARABIC.test(word)) return false;
  return CLITICS.some(clitic => {
    const rest = word.slice(clitic.length);
    return word.startsWith(clitic) && rest.length >= 2 && rest !== 'اي' && STOP_WORDS.has(rest);
  });
}

/** Stems a skill is indexed by. The same folding and stemming runs on both sides, so they meet even when the stem is imperfect. */
export function skillStems(text: string, options: StemOptions = {}): string[] {
  return collectKeys(text, word => stemOf(word, options));
}

/** Content keys for matching Arabic word forms. Non-Arabic words are folded and kept whole. */
export function lemmaKeys(text: string): string[] {
  return collectKeys(text, word => ARABIC.test(word) ? arabicLemma(word) : word);
}

function collectKeys(text: string, keyOf: (word: string) => string): string[] {
  const stems = new Set<string>();
  for (const word of words(text)) {
    if (functionWord(word)) continue;
    const stem = keyOf(word);
    if (stem.length >= 2 && !STOP_WORDS.has(stem)) stems.add(stem);
  }
  return [...stems];
}

export interface RequestTerm { word: string; variants: string[] }
/** Each request word with its variants: «ومقال» may be «و» + «مقال», but «وصف» is a word of its own, so both are tried. */
export function requestTerms(request: string, maxChars = MAX_REQUEST_CHARS, options: StemOptions = {}): RequestTerm[] {
  const seen = new Set<string>(), terms: RequestTerm[] = [];
  for (const word of words(request.slice(0, maxChars))) {
    if (functionWord(word) || seen.has(word)) continue;
    seen.add(word);
    const variants = new Set([stemOf(word, options)]);
    if (ARABIC.test(word)) for (const clitic of CLITICS) if (word.startsWith(clitic) && word.length - clitic.length >= 3) {
      const rest = word.slice(clitic.length);
      if (!STOP_WORDS.has(rest)) variants.add(arabicStem(rest));
    }
    const kept = [...variants].filter(stem => stem.length >= 2 && !STOP_WORDS.has(stem));
    if (kept.length) terms.push({ word, variants: kept });
  }
  return terms;
}
