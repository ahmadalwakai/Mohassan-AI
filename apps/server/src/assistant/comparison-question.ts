import { matchText, normalizeRequest, stripCourtesyTail } from './mind/normalize.js';

export interface ComparisonAttribute {
  key: string;
  label: { en: string; ar: string };
  conditionSensitive: boolean;
  words: RegExp;
}

export interface ParsedComparisonQuestion {
  question: string;
  subjects: [string, string];
  attribute: ComparisonAttribute;
  qualifier?: string;
}
type ComparisonParts = Omit<ParsedComparisonQuestion, 'question'>;

const word = '[\\p{L}\\p{N}+#]';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const normalizeComparisonText = (text: string) => matchText(text).normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
  .replace(/[‘’]/gu, "'").replace(/\s+/gu, ' ').trim();

const subjectKey = (text: string) => normalizeComparisonText(text).replace(/^(?:the |an? |ال(?=\p{L}{3}))/u, '');

function term(text: string): RegExp {
  const key = subjectKey(text);
  const arabic = /^\p{Script=Arabic}/u.test(key);
  return new RegExp(
    `(?<!${word})${arabic ? '(?:[وفبكل])?(?:ال)?' : ''}${escape(key)}(?!${word})`, 'u',
  );
}

export function mentionsComparisonSubject(text: string, subject: string): boolean {
  return term(subject).test(normalizeComparisonText(text));
}

/** A longer name cannot stand in for a separately named shorter alternative. */
export function mentionedComparisonSubjects(text: string, subjects: readonly string[]): string[] {
  const normalized = normalizeComparisonText(text);
  const matches = subjects.flatMap(subject => [...normalized.matchAll(new RegExp(term(subject).source, 'gu'))]
    .map(match => ({ subject, start: match.index, end: match.index + match[0].length })))
    .sort((first, second) => (second.end - second.start) - (first.end - first.start) || first.start - second.start);
  const selected: typeof matches = [];
  for (const match of matches) {
    if (!selected.some(other => match.start < other.end && other.start < match.end)) selected.push(match);
  }
  return subjects.filter(subject => selected.some(match => match.subject === subject));
}

// Base letters from the Unicode CLDR Arabic–Latin transform (retrieved 2026-11-27).
// https://github.com/unicode-org/cldr/blob/release-48/common/transforms/Arabic-Latin.xml
const arabicRoman: Record<string, string> = {
  ا: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh', د: 'd', ذ: 'dh', ر: 'r', ز: 'z',
  س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l',
  م: 'm', ن: 'n', ه: 'h', و: 'w', ي: 'y', پ: 'p', چ: 'ch', ڤ: 'v', گ: 'g',
};

/** Resolve a single transliterated name only within an explicit two-choice source record. */
export function matchesChoiceTransliteration(value: string, subject: string): boolean {
  const sides = [normalizeComparisonText(value), normalizeComparisonText(subject)];
  const arabic = sides.find(item => /^\p{Script=Arabic}+$/u.test(item));
  const latin = sides.find(item => /^[a-z]+$/u.test(item));
  if (!arabic || !latin || [...arabic].some(letter => !arabicRoman[letter])) return false;
  const consonants = (name: string) => name.replace(/[aeiouy]/gu, '').replace(/(.)\1+/gu, '$1');
  const romanized = consonants([...arabic].map(letter => arabicRoman[letter]).join(''));
  return romanized.length >= 3 && romanized === consonants(latin);
}

function dimension(key: string, en: string, ar: string, english: string, arabic: string, conditionSensitive = false): ComparisonAttribute {
  return {
    key, label: { en, ar }, conditionSensitive,
    words: new RegExp(`(?<!${word})(?:${english}|(?:[وف])?(?:ال)?(?:${arabic}))(?!${word})`, 'u'),
  };
}

// Keep qualitative and numeric dimensions distinct when the question names one.
// The local numeric comparison uses similar metric language for page observations.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/reasoning/comparison-page.ts (retrieved 2026-11-27)
const attributes = [
  dimension('price', 'price', 'السعر', 'prices?|costs?|charges?|fees?|fares?|cheaper|cheapest|expensive|affordab(?:le|ility)|budget|pricing', 'سعر|اسعار|تكلف[هة]|تكاليف|ثمن|رسوم|ارخص|اغلي|اوفر|يكلف|تكلف', true),
  dimension('speed', 'speed', 'السرعة', 'speeds?|faster|fastest|slower|slowest|execution time|run time|elapsed time|latency|throughput|delivery time|runs? in (?=\\d)|takes? (?=\\d)|\\d+(?:\\.\\d+)?\\s*(?:ms|milliseconds?|seconds?)', 'سرع(?:ه|ته|تها)|اسرع|ابطا|زمن التنفيذ|وقت التنفيذ|زمن التشغيل|زمن الاستجاب[هة]|سرعه الاستجاب[هة]', true),
  dimension('performance', 'performance', 'الأداء', 'performance|benchmarks?|efficient|efficiency|throughput|latency|execution time|memory usage', 'اداء|كفاء[هة]|زمن التنفيذ|معيار الاداء|اختبار(?:ات)? الاداء', true),
  dimension('safety', 'safety', 'السلامة', 'safety|safer|safest|safe|dangerous|dangers?|risks?|riskier|hazards?|side effects?', 'سلام[هة]|امان|امن|امنه|اخطر|خطر|مخاطر|اثار جانبي[هة]'),
  dimension('security', 'security', 'الأمن', 'security|secure|encryption|vulnerabilit(?:y|ies)', 'امن|تشفير|ثغر[هة]|ثغرات'),
  dimension('ease', 'ease', 'السهولة', 'ease|easy|easier|easiest|difficult(?:y)?|harder|simplicity|simpler|complexity|learning curve|usability|user[ -]friendly|beginner[ -]friendly', 'سهول[هة]|سهل|سهل[هة]|اسهل|اصعب|صعوب[هة]|بساط[هة]|ابسط|تعقيد|قابلي[هة] الاستخدام'),
  dimension('accuracy', 'accuracy', 'الدقة', 'accurac(?:y|ies)|accurate|precision|precise|error rates?', 'ادق|دق[هة]|معدل الخطا'),
  dimension('reliability', 'reliability', 'الموثوقية', 'reliab(?:le|ility)|unreliable|uptime|availability|stable|stability', 'موثوق(?:ي[هة])?|اعتمادي[هة]|استقرار'),
  dimension('battery', 'battery life', 'عمر البطارية', 'battery life|battery runtime|battery duration|battery endurance', 'عمر البطاري[هة]|مد[هة] عمل البطاري[هة]'),
  dimension('area', 'area', 'المساحة', 'areas?|square (?:miles?|met(?:ers?|res?)|kilomet(?:ers?|res?))|km[2²]', 'مساح(?:ه|ته|تها)|كيلومتر(?:ا)? مربعا?|كم مربع'),
  dimension('length', 'length', 'الطول', 'length|longer|longest|shorter|shortest|distances?', 'طول(?:ه|ها)?|اطول|اقصر|مساف[هة]'),
  dimension('height', 'height', 'الارتفاع', 'height|taller|tallest|elevation', 'ارتفاع(?:ه|ها)?|علو'),
  dimension('weight', 'weight', 'الوزن', 'weight|mass|weighs?|heavier|heaviest|lighter|lightest', 'وزن(?:ه|ها)?|كتل(?:ه|ته|تها)|اثقل|اخف|يزن|تزن'),
  dimension('age', 'age', 'العمر', 'age|older|oldest|younger|youngest|born|birth|found(?:ed|ing)', 'عمر(?:ه|ها)?|سن(?:ا|ه|ها)?|اقدم|احدث|ولد(?:ت)?|ميلاد|تاسيس|تاسس(?:ت)?'),
  dimension('population', 'population', 'عدد السكان', 'populat(?:ion|ed)|populous|inhabitants|residents?', 'سكان(?:ا|ه|ها)?|تعداد'),
  dimension('capacity', 'capacity', 'السعة', 'capacit(?:y|ies)|volume|storage|seating', 'سع[هة]|حجم التخزين|تخزين|استيعاب'),
  dimension('size', 'size', 'الحجم', 'sizes?|larger|bigger|smaller|largest|biggest|smallest|dimensions?|volumes?|areas?|length|height|width|radius|diameter', 'حجم(?:ه|ها)?|اكبر|اصغر|ابعاد|مساح[هة]|طول|ارتفاع|عرض|قطر'),
  dimension('duration', 'duration', 'المدة', 'duration|time taken|run time|takes|lasts', 'مد[هة]|يستغرق|تستغرق'),
  dimension('memory', 'memory', 'الذاكرة', 'memory|ram', 'ذاكر[هة]'),
  dimension('compatibility', 'compatibility', 'التوافق', 'compatib(?:le|ility)|interoperab(?:le|ility)|supported platforms?', 'توافق|متوافق(?:[هة])?|منصات مدعوم[هة]'),
  dimension('syntax', 'syntax', 'بنية اللغة', 'syntax', 'صياغ[هة]|بني[هة] اللغ[هة]'),
  dimension('documentation', 'documentation', 'التوثيق', 'documentation|tutorials?', 'توثيق|دروس'),
  dimension('community', 'community', 'المجتمع', 'communit(?:y|ies)|ecosystems?', 'مجتمع(?:ات)?'),
  dimension('libraries', 'libraries', 'المكتبات', 'librar(?:y|ies)', 'مكتب[هة]|مكتبات'),
  dimension('features', 'features', 'الميزات', 'features?|capabilit(?:y|ies)|functionalit(?:y|ies)|use cases?', 'مزايا|ميزات|خصائص|وظائف|حالات? الاستخدام'),
] as const;

const general: ComparisonAttribute = {
  key: 'general', label: { en: 'their differences', ar: 'أوجه الاختلاف' }, conditionSensitive: false, words: /(?!)/u,
};
const beginner = dimension('beginner', 'beginners', 'المبتدئين', 'beginners?|novices?|newcomers?|new learners?|first[ -]time learners?|new to (?:coding|programming)', '(?:لل)?مبتدئ(?:ين|ون|ه|ات)?|حديث(?:ي|و) العهد|لاول مره');
const generic = /^(?:(?:the )?(?:(?:better|best|worse|worst)(?: (?:choice|option|fit))?|difference(?:s)?|comparisons?|pros and cons|both|which one)|(?:ال)?(?:افضل|احسن|اسوا|فرق|فروق|اختلاف(?:ات)?|مقارن[هة]))$/u;
const qualifierLead = /^(?:for|when|under|using|at|in|on|عند|في|اثناء|خلال|ل)\s+/iu;

export function comparisonAttributesIn(comparison: ParsedComparisonQuestion, text: string): string[] {
  const normalized = normalizeComparisonText(text);
  const { attribute, qualifier } = comparison;
  if (qualifier) {
    const scope = normalizeComparisonText(qualifier);
    if (beginner.words.test(scope) ? !beginner.words.test(normalized)
      : !term(scope.replace(qualifierLead, '')).test(normalized)) return [];
  }
  return (attribute.key === general.key ? attributes : [attribute])
    .filter(candidate => candidate.words.test(normalized)).map(candidate => candidate.key);
}

export function mentionsComparisonAttribute(comparison: ParsedComparisonQuestion, text: string): boolean {
  return comparisonAttributesIn(comparison, text).length > 0;
}

export function isConditionalComparisonAttribute(key: string): boolean {
  return attributes.some(attribute => attribute.key === key && attribute.conditionSensitive);
}

// Two explicit alternatives are required. This excludes unnamed follow-ups and
// rankings over an open category, which have their own local reasoning path.
const pairSeparator = /\s+(?:(?:and|or|versus|vs\.?|[أا][مو]|ولا)\s+|و\s*(?=\p{L}))/iu;
const versus = /\s+(?:versus|vs\.?)\s+/iu;
const englishDifference = /^(?:(?:what(?:\s+(?:is|are)|['’]s)|tell me|show me|explain)\s+(?:the\s+)?|the\s+)?(?:(.+?)\s+)?differences?(?:\s+in\s+(.+?))?\s+between\s+(.+)$/iu;
const arabicDifference = /^(?:(?:ما(?:ذا)?(?:\s+(?:هو|هي))?|وضح(?:\s+لي)?|اشرح(?:\s+لي)?)\s+)?(?:(?:ال)?فرق|(?:ال)?اختلاف(?:ات)?|مقارن[ةه]|قارن)\s+(?:(.+?)\s+)?بين\s+(.+)$/u;
const compareLead = /^(?:(?:please\s+)?(?:can|could) you\s+)?(?:compare|contrast|قارن)\s+/iu;
const choiceLead = /^(?:(?:which(?: one| [\p{L}-]+(?= (?:is|was|are|has|have)\s))?|who)(?: is| was| are| has| have)?|[اأ]يهما(?:\s+(?:هو|هي))?)(?:\s+|[،,:]\s*)/iu;
const qualified = /\s+(?:in terms of|with respect to|regarding|by|من حيث|من ناحية|من ناحيه|بحسب|حسب)\s+(.+)$/iu;
const context = /(?:[,،]\s*|\s+)((?:for|when|under|using|عند|أثناء|اثناء|خلال)\s+.+|للمبتدئ(?:ين|ون|ة|ه|ات)?(?:\s+في\s+.+)?)$/iu;
const usageScope = /\s+((?:in|at|on|في|على)\s+.+)$/iu;
const tailAttribute = /:\s*([^:،,]+)$/u;
const enAdjective = String.raw`better|worse|faster|slower|cheaper|larger|bigger|smaller|safer|riskier|easier|harder|simpler|older|younger|longer|shorter|taller|heavier|lighter|costs? (?:more|less)|(?:more|less)\s+[\p{L}-]+`;
const arAdjective = String.raw`[اأ](?:فضل|حسن|سوأ|سوا?|سرع|بط[اأء]|رخص|غل[ىي]|كبر|صغر|سهل|صعب|من|خطر|قدم|حدث|طول|قصر|ثقل|خف)|[اأ](?:كثر|قل)\s+[\p{L}\p{M}]+`;
const comparativeEnding = new RegExp(`(?:^|\\s+)(${enAdjective}|${arAdjective})(?:\\s+(.+))?$`, 'iu');
const comparativeLead = new RegExp(`^(${enAdjective}|${arAdjective})\\s+(.+)$`, 'iu');
const subjectLabel = /^[\p{L}\p{N}.][\p{L}\p{M}\p{N}.'’()+#&/_ -]*$/u;
const requestVerb = /\s+(?:runs?|works?|performs?|operates?|have|has|had|is|are|was|were)\s*$/iu;
const notASide = /^(?:before|ever|now|expected|usual|that|this|them|those|these|it|they|both|average|(?:the )?rest|المعتاد|قبل|السابق|اي وقت مضي)$/u;
const otherRequest = /^(?:(?:who|what|why|where|how|which|when|write|explain|tell|show|calculate|define)\b|(?:ما|ماذا|كيف|لماذا|اين|من|اي|اكتب|اشرح|احسب)(?!\p{L}))/u;
// Explicit page/table scope and inline quantities belong to local comparison.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/fixtures/reasoning-comparison.ts (retrieved 2026-11-27)
const localScope = /\b(?:in|on|from|according to) (?:this|that|the) (?:open )?(?:page|table|list|data)\b|(?<!\p{L})(?:في|من|على|علي|حسب) (?:(?:هذه|هذي|هات|هذا) )?(?:الصفحه|هالصفحه|الجدول|هالجدول|القائمه|البيانات)(?!\p{L})/u;
const inlineQuantity = /\((?:born|founded|ولد(?:ت)?|تاسس(?:ت)?)\s+\p{Nd}|\p{Nd}\s+(?:years?|months?|days?|cm|km|m|kg|سن(?:ه|وات)|عاما?|متر|سم|كم|م|كغ)\s*$|^(?:(?:ال)?(?:اول|ثاني|ثالث)|first|second|third)\s+\p{Nd}/u;

function trimPart(text: string): string {
  return text.trim().replace(/^[\s«»“”"':،,؛;]+|[\s«»“”"':،,؛;!?؟]+$/gu, '').trim();
}

function readAttribute(descriptor: string): ComparisonAttribute {
  const normalized = normalizeComparisonText(descriptor);
  if (!normalized || generic.test(normalized)) return general;
  const known = attributes.find(attribute => attribute.words.test(normalized));
  if (known) return known;
  const name = descriptor.replace(/^(?:more|less|[اأ]كثر|[اأ]قل|the)\s+/iu, '').trim();
  return { key: normalizeComparisonText(name), label: { en: name, ar: name }, conditionSensitive: false, words: term(name) };
}

function comparison(left: string, right: string, descriptor = '', qualifier?: string): ComparisonParts | null {
  const request = trimPart(descriptor);
  const subjects: [string, string] = [trimPart(left), trimPart(right)];
  if (subjects.some(subject => !subjectLabel.test(subject) || !/[\p{L}\p{N}]/u.test(subject)
      || notASide.test(normalizeComparisonText(subject)) || inlineQuantity.test(normalizeComparisonText(subject)))
    || subjectKey(subjects[0]) === subjectKey(subjects[1])) return null;
  return { subjects, attribute: readAttribute(request), ...(qualifier && { qualifier: trimPart(qualifier) }) };
}

function splitPair(pair: string, descriptor = '', qualifier?: string, separator = pairSeparator): ComparisonParts | null {
  const scope = context.exec(pair);
  const scoped = scope && separator.test(pair.slice(0, scope.index)) ? pair.slice(0, scope.index) : pair;
  const attributeTail = qualified.exec(scoped) ?? tailAttribute.exec(scoped);
  const usageTail = usageScope.exec(scoped);
  const tail = attributeTail ?? usageTail;
  const cut = tail && separator.test(scoped.slice(0, tail.index)) ? tail.index : scoped.length;
  const entries = scoped.slice(0, cut).split(separator);
  if (entries.length !== 2) return null;
  const usage = cut < scoped.length && !attributeTail ? usageTail?.[1] : undefined;
  const usageAttribute = usage && attributes.find(candidate => candidate.words.test(normalizeComparisonText(usage)));
  return comparison(entries[0], entries[1], cut < scoped.length && attributeTail ? attributeTail[1] : usageAttribute ? usage : descriptor,
    scoped !== pair ? scope?.[1] : usageAttribute ? qualifier : usage ?? qualifier);
}

function parseChoice(question: string): ComparisonParts | null {
  const inverted = /^which(?: one)? of\s+(.+)\s+(?:is|are|has|have)\s+(.+)$/iu.exec(question);
  if (inverted) return splitPair(inverted[1], inverted[2]);
  const lead = choiceLead.exec(question);
  if (!lead) return null;
  const rest = question.slice(lead[0].length);
  const delimited = /^([^:,،]+)[:,،]\s*(.+)$/u.exec(rest);
  if (delimited) {
    const scope = context.exec(delimited[1]);
    const choice = splitPair(delimited[2], scope ? delimited[1].slice(0, scope.index) : delimited[1], scope?.[1]);
    if (choice) return choice;
  }
  const qualifier = comparativeLead.exec(rest);
  if (qualifier) {
    const scope = /^((?:for (?:beginners?|novices?|newcomers?)|للمبتدئ(?:ين|ون|ة|ه|ات)?))\s+(.+)$/iu.exec(qualifier[2]);
    return splitPair(scope?.[2] ?? qualifier[2], qualifier[1], scope?.[1]);
  }
  return /^(?:which one|[اأ]يهما)(?=\s|[:,،])/iu.test(question) ? splitPair(rest) : null;
}

function parseComparisonParts(clean: string): ComparisonParts | null {
  if (localScope.test(normalizeComparisonText(clean))) return null;
  const english = englishDifference.exec(clean);
  if (english) return splitPair(english[3], english[2] ?? english[1]);
  const arabic = arabicDifference.exec(clean);
  if (arabic) return splitPair(arabic[2], arabic[1]);
  const action = compareLead.exec(clean);
  if (action) return splitPair(clean.slice(action[0].length));
  if (choiceLead.test(clean) || /^which(?: one)? of\s+/iu.test(clean)) return parseChoice(clean);
  if (versus.test(clean)) return splitPair(clean, '', undefined, versus);

  const arabicDirect = /^(?:هل\s+)?(.+?)\s+من\s+(?!(?:حيث|ناحي[ةه])\s)(.+)$/u.exec(clean);
  const englishDirect = /^(?:(?:(?:where|when|why)\s+)?(?:is|are|was|were|does|do|did|can|could)\s+)?(.+?)\s+than\s+(.+)$/iu.exec(clean);
  const direct = englishDirect ?? arabicDirect;
  if (!direct) return null;
  const cue = comparativeEnding.exec(direct[1]);
  if (!cue) return null;
  const left = direct[1].slice(0, cue.index).replace(requestVerb, '');
  if (otherRequest.test(normalizeComparisonText(left))) return null;
  const cueContext = cue[2] && (context.test(` ${cue[2]}`) || usageScope.test(` ${cue[2]}`) || qualified.test(` ${cue[2]}`))
    ? cue[2] : undefined;
  if (cue[2] && !cueContext && !/^(?:(?:more|less)\b|[اأ](?:كثر|قل)\s)/iu.test(cue[1])) return null;
  const descriptor = cue[2] && !cueContext ? `${cue[1]} ${cue[2]}` : cue[1];
  const attributeTail = qualified.exec(direct[2]);
  const sideContext = context.exec(direct[2]) ?? usageScope.exec(direct[2]);
  const tail = attributeTail ?? sideContext;
  return comparison(left, tail ? direct[2].slice(0, tail.index) : direct[2], attributeTail?.[1] ?? descriptor,
    attributeTail ? cueContext : sideContext?.[1] ?? cueContext);
}

export function parseComparisonQuestion(question: string): ParsedComparisonQuestion | null {
  const { text } = normalizeRequest(stripCourtesyTail(question));
  const clean = text.replace(/[.!?؟]+$/u, '').trim();
  const parts = parseComparisonParts(clean);
  return parts ? { question: clean, ...parts } : null;
}
