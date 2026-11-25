/**
 * What a request asks for, told apart from how the reply should look and from a label written in front of it.
 *
 * Live test of 2026-11-23: «QA test 2026-11-23: Calculate 37 × 24 and reply with the result in one short Arabic sentence.»
 * was not calculated. The calculator reads only a message that is the calculation, so the label in front and the
 * instruction about the reply made it give up, and the skill fallback then answered with the software-testing skill
 * because of the words «QA» and «test». The same instructions made «Explain why rain falls in two short Arabic
 * sentences.» look like an unknown request and became part of the search for «Search the web for …. Return the page title
 * and source link.».
 *
 * `splitReplyDirective` returns the request itself (`body`), the label (set aside) and the directive (applied by the
 * handler that answers). It changes no word of the body. A label is only a short tag that names a test, a case or a note
 * («QA test 2026-11-23:», «Case 4:», «سؤال ٣:»); it is never an instruction, a field of a document («Title:»), or a topic
 * («Unit tests:» stays, see `incidentalLabel`). A directive is a closing clause that only says the reply's language,
 * length or fields. Callers use the body only when it is complete on its own (a calculation that computes, a full
 * question), so a wrong split never changes what is done.
 */
export type ReplyLanguage = 'ar' | 'en';
export type ReplyField = 'title' | 'link' | 'heading' | 'first_sentence';
export interface ReplyDirective {
  /** The language the reply is asked in, when the request names one. */
  lang?: ReplyLanguage;
  /** «in one sentence», «في جملتين»: how many sentences, 1 to 3. */
  sentences?: number;
  /** «short», «قصيرة», «briefly», «باختصار». */
  brief?: boolean;
  /** «Return the page title and source link»: what the reply should name. */
  fields?: ReplyField[];
  /** The owner's own words of the directive, as written. */
  text: string;
}
export interface ReplyFraming { body: string; label: string | null; directive: ReplyDirective | null }

const MAX_TEXT = 4000;
/** Matching key only: Arabic letter forms folded, lower case, single spaces. The original text is never changed. */
const fold = (value: string) => value.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Words that name a tag rather than a subject: a test, a case, a question number, a note. */
const LABEL_WORD = /(?:^|[^\p{L}])(?:qa|test|tests|testing|case|demo|trial|ticket|note|exercise|question|scenario|probe|run|check|item|task|step|example)(?![\p{L}])|(?:^|[^\p{L}])(?:اختبار|تجربه|حاله|سؤال|ملاحظه|مثال|تمرين|بند|سيناريو|مهمه|خطوه)(?![\p{L}])/iu;
/** A label never carries an instruction of its own («Translate: …», «اكتب: …»). */
const INSTRUCTION = /(?:^|[^\p{L}])(?:translate|write|explain|summari[sz]e|calculate|compute|remember|save|send|open|search|find|create|make|delete|remove|add|set|change|reply|answer|tell|show|give|list|describe|define|convert|draft|book|buy|call|play|draw|ترجم|اكتب|اشرح|لخص|احسب|تذكر|احفظ|ارسل|افتح|ابحث|انشئ|اصنع|احذف|اضف|غير|اجب|اذكر|عرف|حول|صمم|ارسم)(?![\p{L}])/iu;
/** Words that make a «label» a subject instead: «Unit tests:», «Test results:», «اختبارات الوحدة:» name what is asked about. */
const SUBJECT_AFTER_LABEL_WORD = /(?:^|[^\p{L}])(?:unit|integration|e2e|end-to-end|blood|covid|pcr|driving|results?|coverage|plan|plans|strategy|suite|data|نتائج|نتيجه|الوحده|التكامل|الدم|القياده|خطه|خطط)(?![\p{L}])/iu;

/**
 * The tag in front of a request («QA test 2026-11-23: …», «Case 4 — …»), or null. At most eight words before a colon or a
 * spaced dash, at least one of them a tag word, none an instruction, no question word first, and a request after it.
 */
export function incidentalLabel(text: string): { label: string; rest: string } | null {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return null;
  const match = /^\s*([^\n:：]{1,60}?)\s*(?:[:：]|\s[—–-]\s)\s*(\S[\s\S]*)$/u.exec(text);
  if (!match) return null;
  const label = match[1]!.trim(), rest = match[2]!.trim();
  const folded = fold(label);
  if (/https?$/iu.test(label) || label.split(/\s+/u).length > 8 || rest.length < 3) return null;
  if (!LABEL_WORD.test(folded) || INSTRUCTION.test(folded) || SUBJECT_AFTER_LABEL_WORD.test(folded)) return null;
  if (/^(?:what|who|when|where|why|how|which|is|are|can|ما|ماذا|من|متي|اين|لماذا|كيف|هل|كم)(?![\p{L}])/iu.test(folded)) return null;
  return { label, rest };
}

const LANG_EN = String.raw`(arabic|english)`;
const COUNT_EN: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, 'a single': 1, 'one single': 1, two: 2, three: 3, '1': 1, '2': 2, '3': 3 };
const ADJ_EN = String.raw`(?:short|brief|simple|concise|clear|plain|single)`;
/** «reply with the result in one short Arabic sentence», «answer in two sentences in English», «in one sentence». */
const SENTENCES_EN = new RegExp(String.raw`^(?:please\s+)?(?:(?:reply|respond|answer|explain(?:\s+it)?|write(?:\s+it)?|give(?:\s+me)?(?:\s+the\s+(?:answer|result))?|state(?:\s+it)?|summari[sz]e(?:\s+it)?|put(?:\s+it)?|keep(?:\s+it)?|say(?:\s+it)?|tell\s+me)\s+)?(?:with\s+(?:the\s+)?(?:result|answer|value|number|total)\s+)?(?:in|as|using|within)\s+(a single|one single|a|an|one|two|three|1|2|3)\s+(?:${ADJ_EN}\s+){0,2}(?:${LANG_EN}\s+)?(?:${ADJ_EN}\s+){0,2}(sentences?|lines?|paragraphs?)(?:\s+(?:in|using)\s+${LANG_EN})?(?:\s+only)?$`, 'iu');
/** «in Arabic», «reply in English only», «answer using Arabic». */
const LANGUAGE_EN = new RegExp(String.raw`^(?:please\s+)?(?:(?:reply|respond|answer|write(?:\s+it)?|say(?:\s+it)?|give(?:\s+me)?(?:\s+the\s+(?:answer|result))?|explain(?:\s+it)?)\s+)?(?:with\s+(?:the\s+)?(?:result|answer)\s+)?(?:only\s+)?(?:in|using)\s+${LANG_EN}(?:\s+only)?$`, 'iu');
const BRIEF_EN = /^(?:please\s+)?(?:(?:reply|respond|answer|keep\s+it|be)\s+)?(?:briefly|concisely|short|brief)$/iu;
/** «Return the page title and source link», «give me the link», «with the source link», «include the title and URL». */
const FIELD_VERB_EN = /^(?:please\s+)?(?:(?:return|give|show|tell|send|provide|include|report|list|share|quote|cite)(?:\s+me)?|with|and)\s+/iu;
const FIELD_NOUN_EN: [RegExp, ReplyField][] = [
  [/^(?:main\s+)?(?:heading|headline|h1)$/iu, 'heading'], [/^(?:page\s+)?(?:title|name)$/iu, 'title'],
  [/^(?:source\s+)?(?:link|url|address|source)$/iu, 'link'], [/^first\s+(?:sentence|line|paragraph)$/iu, 'first_sentence'],
];

const LANG_AR: [RegExp, ReplyLanguage][] = [[/^(?:بال)?عربي(?:ه)?$|^باللغه العربيه$|^العربيه$/u, 'ar'], [/^(?:بال)?(?:انجليزي|انكليزي|إنجليزي)(?:ه)?$|^باللغه الانجليزيه$|^الانجليزيه$/u, 'en']];
const COUNT_AR: Record<string, number> = { جمله: 1, سطر: 1, فقره: 1, جملتين: 2, جملتان: 2, سطرين: 2, فقرتين: 2 };
const MODIFIER_AR = /^(?:واحده|واحد|قصيره|قصيرتين|قصيرتان|قصير|مختصره|مختصرتين|بسيطه|بسيطتين|واضحه|فقط|عربيه|عربي|انجليزيه|انجليزي|بالعربيه|بالعربي|بالانجليزيه|بالانجليزي|بالانكليزيه|باللغه|العربيه|الانجليزيه|ثلاث|ثلاثه|جمل|اسطر)$/u;
const VERB_AR = /^(?:و)?(?:اجب|اجبني|رد|اكتب|اكتبها|اكتبه|اعطني|اعطيني|قدم|قدمها|اذكر|اذكرها|اشرح|اشرحها|لخص|لخصها|صغ|صغها|قل|قلها)(?:\s+لي)?$/u;
const OBJECT_AR = /^(?:ال)?(?:نتيجه|ناتج|جواب|اجابه|رد)$/u;
const BRIEF_AR = /^(?:و)?(?:باختصار|بايجاز|باقتضاب|اختصر|مختصرا|مختصر)$/u;
const FIELD_VERB_AR = /^(?:و)?(?:اعطني|اعطيني|اذكر|ارسل|اعرض|قدم|انقل|اكتب)(?:\s+لي)?$/u;
const FIELD_NOUN_AR: [RegExp, ReplyField][] = [
  [/^(?:و)?(?:ال)?عنوان(?:ها|ه)?$/u, 'title'], [/^(?:و)?(?:ال)?(?:رابط|مصدر)(?:ها|ه)?$/u, 'link'],
  [/^(?:و)?(?:ال)?(?:جمله الاولي|اول جمله)$/u, 'first_sentence'],
];

function englishDirective(clause: string): Omit<ReplyDirective, 'text'> | null {
  const text = clause.replace(/[.!؟?]+$/u, '').trim();
  const sentences = SENTENCES_EN.exec(text);
  if (sentences) {
    const [, count, lang1, , lang2] = sentences;
    const lang = (lang1 ?? lang2)?.toLowerCase();
    return { sentences: COUNT_EN[count!.toLowerCase()] ?? 1, ...(lang ? { lang: lang === 'arabic' ? 'ar' : 'en' } : {}),
      ...(new RegExp(`\\b${ADJ_EN}\\b`, 'iu').test(text) ? { brief: true } : {}) };
  }
  const language = LANGUAGE_EN.exec(text);
  if (language) return { lang: language[1]!.toLowerCase() === 'arabic' ? 'ar' : 'en' };
  if (BRIEF_EN.test(text)) return { brief: true };
  const verb = FIELD_VERB_EN.exec(text);
  if (verb) {
    const nouns = text.slice(verb[0].length).replace(/\b(?:the|its|their|a|an)\b/giu, ' ').split(/\s*(?:,|&|\band\b|\bplus\b)\s*/iu).map(part => part.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    const fields = nouns.map(noun => FIELD_NOUN_EN.find(([pattern]) => pattern.test(noun))?.[1]);
    if (nouns.length && fields.every(Boolean)) return { fields: [...new Set(fields as ReplyField[])] };
  }
  return null;
}

function arabicDirective(clause: string): Omit<ReplyDirective, 'text'> | null {
  const words = fold(clause).replace(/[.!؟?،,]+/gu, ' ').split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  let at = 0;
  const lead = words.slice(0, 2).join(' ');
  if (words.length > 1 && VERB_AR.test(lead)) at = 2; else if (VERB_AR.test(words[0]!)) at = 1;
  if (words[at] && OBJECT_AR.test(words[at]!)) at++;
  if (at === words.length) return null;
  const rest = words.slice(at);
  if (rest.length === 1 && BRIEF_AR.test(rest[0]!)) return { brief: true };
  // «في جملة واحدة قصيرة بالعربية», «بجملة عربية قصيرة», «بجملتين».
  let first = rest[0]!.replace(/^(?:في|ب)(?=\S)/u, '');
  let start = 0;
  if (rest[0] === 'في' || rest[0] === 'ب') { first = rest[1] ?? ''; start = 1; }
  if (Object.hasOwn(COUNT_AR, first)) {
    const modifiers = rest.slice(start + 1);
    if (!modifiers.every(word => MODIFIER_AR.test(word))) return null;
    const joined = modifiers.join(' ');
    const lang = /عربي/u.test(joined) ? 'ar' : /انجليزي|انكليزي/u.test(joined) ? 'en' : undefined;
    const count = /ثلاث/u.test(joined) ? 3 : COUNT_AR[first]!;
    return { sentences: count, ...(lang ? { lang } : {}), ...(/قصير|مختصر|بسيط/u.test(joined) ? { brief: true } : {}) };
  }
  // «بالعربية», «باللغة العربية», «أجب بالإنجليزية فقط».
  const plain = rest.filter(word => word !== 'فقط').join(' ');
  const language = LANG_AR.find(([pattern]) => pattern.test(plain))?.[1];
  if (language) return { lang: language };
  // «وأعطني العنوان والرابط»: a field list after a verb.
  if (at > 0 && FIELD_VERB_AR.test(words.slice(0, at).join(' ').replace(/\s+(?:ال)?(?:نتيجه|ناتج|جواب|اجابه)$/u, '')) || FIELD_VERB_AR.test(words[0]!)) {
    const nouns = (at > 0 ? rest : words.slice(1)).filter(word => word !== 'لي');
    const fields = nouns.map(noun => FIELD_NOUN_AR.find(([pattern]) => pattern.test(noun))?.[1]);
    if (nouns.length && fields.every(Boolean)) return { fields: [...new Set(fields as ReplyField[])] };
  }
  return null;
}

/** Each directive clause of a tail, or null when any clause is something other than a directive. */
function directiveOf(tail: string): ReplyDirective | null {
  // A field list keeps its «and»: «Return the page title and source link» is one clause.
  const whole = /\p{Script=Arabic}/u.test(tail) ? arabicDirective(tail) : englishDirective(tail);
  if (whole) return { ...whole, text: tail.trim() };
  const clauses = tail.split(/\s*(?:[,،;؛]|(?<!\d)\.(?!\d)|!|\s(?:and|then)\s|\s+و(?=(?:اجب|رد|اكتب|اعطني|اعطيني|اذكر|قدم|ارسل|اعرض|انقل|باختصار|بايجاز)))\s*/iu)
    .map(part => part.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 4) return null;
  const merged: ReplyDirective = { text: tail.trim() };
  for (const clause of clauses) {
    const found = /\p{Script=Arabic}/u.test(clause) ? arabicDirective(clause) : englishDirective(clause);
    if (!found) return null;
    if (found.lang) merged.lang = found.lang;
    if (found.sentences) merged.sentences = found.sentences;
    if (found.brief) merged.brief = true;
    if (found.fields) merged.fields = [...new Set([...(merged.fields ?? []), ...found.fields])];
  }
  return merged;
}

/** Where a closing directive may start: a sentence end, a comma, «and», «و» before a directive verb, or «in …». */
const SPLIT_POINTS = /(?<!\d)\.(?=\s)|[!?؟;؛](?=\s)|[,،](?=\s)|\s(?=and\s)|\s(?=و(?:اجب|رد|اكتب|اعطني|اعطيني|اذكر|قدم|ارسل|اعرض|انقل|باختصار|بايجاز))|\s(?=(?:in|using)\s+(?:a|an|one|two|three|single|[123]|arabic|english)\b)|\s(?=(?:في\s+|ب)?(?:جمله|جملتين|جملتان|سطر|سطرين)(?:\s|$))|\s(?=(?:بالعربيه|بالعربي|بالانجليزيه|بالانجليزي|باللغه|باختصار|بايجاز)(?:\s|$))/giu;

/**
 * The request, its label and its closing directive. The earliest split whose whole remainder is directives wins, so
 * «Calculate 37 × 24 and reply with the result in one short Arabic sentence.» gives the body «Calculate 37 × 24».
 */
export function splitReplyDirective(text: string): ReplyFraming {
  const none: ReplyFraming = { body: typeof text === 'string' ? text.trim() : '', label: null, directive: null };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return none;
  const labelled = incidentalLabel(text);
  const working = labelled ? labelled.rest : text.trim();
  // The matching copy keeps every offset of `working`: folding here only changes letters one for one, never their count.
  const matching = working.replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
  let directive: ReplyDirective | null = null, body = working;
  for (const point of matching.matchAll(SPLIT_POINTS)) {
    const at = point.index;
    if (at < 3) continue;
    const tail = working.slice(at).replace(/^[\s.!?؟;؛,،]+/u, '').replace(/^(?:and|then)\s+/iu, '');
    if (!tail.trim()) continue;
    const found = directiveOf(tail);
    if (found) { directive = found; body = working.slice(0, at).replace(/[\s,،;؛]+$/u, '').trim(); break; }
  }
  if (!directive && !labelled) return none;
  if (!body || body.length < 2) return none;
  return { body, label: labelled?.label ?? null, directive };
}

/** «ar»/«en» for a request by its letters, as the rest of the assistant decides. */
export const requestLanguage = (text: string): ReplyLanguage => /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
