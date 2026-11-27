import { matchText } from './mind/normalize.js';
import { maskRequestLiteralData } from './request-constraints.js';

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
 * `splitReplyDirective` returns the request itself (`body`), the label (set aside) and the directive. It changes no word
 * of the body. A label is only a short tag that names a test, a case or a note
 * («QA test 2026-11-23:», «Case 4:», «سؤال ٣:»); it is never an instruction, a field of a document («Title:»), or a topic
 * («Unit tests:» stays, see `incidentalLabel`). A directive is a closing clause that only says the reply's language,
 * length or fields. Callers use the body only when it is complete on its own (a calculation that computes, a full
 * question), so a wrong split never changes what is done.
 */
export type ReplyLanguage = 'ar' | 'en';
export type ReplyField = 'title' | 'link' | 'heading' | 'first_sentence';
export interface ReplyConstraints {
  /** The language the reply is asked in, when the request names one. */
  lang?: ReplyLanguage;
  /** «in one sentence», «في جملتين»: how many sentences, 1 to 3. */
  sentences?: number;
  /** «short», «قصيرة», «briefly», «باختصار». */
  brief?: boolean;
  /** Explicitly request a list or prose. */
  list?: boolean;
  /** An upper limit on links. */
  links?: number;
  /** «Return the page title and source link»: what the reply should name. */
  fields?: ReplyField[];
}
export interface ReplyDirective extends ReplyConstraints {
  /** The owner's own words of the directive, as written. */
  text: string;
}
export interface ReplyFraming { body: string; label: string | null; directive: ReplyDirective | null }
export type ReplyPreferences = Omit<ReplyConstraints, 'fields'>;
export type ReplyPreferencePatch = { [Key in keyof ReplyPreferences]?: ReplyPreferences[Key] | null };
type ReplyOverrides = ReplyPreferencePatch & Pick<ReplyConstraints, 'fields'>;
export interface ReplyRequest extends ReplyFraming {
  overrides: ReplyOverrides;
  preferences: ReplyPreferencePatch;
  preferenceOnly: boolean;
}

const MAX_TEXT = 4000;
/** Matching key only: Arabic letter forms folded, lower case, single spaces. The original text is never changed. */
const fold = (value: string) => matchText(value).replace(/\s+/gu, ' ').trim();

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
const BRIEF_EN = /^(?:please\s+)?(?:(?:reply|respond|answer|keep\s+it|be|keep (?:the |your )?(?:answers?|replies|responses))\s+)?(?:briefly|concisely|short|brief|concise)(?:\s+(?:answers?|replies|responses))?$/iu;
const DETAIL_EN = /^(?:please\s+)?(?:(?:reply|respond|answer|explain(?:\s+it)?)\s+)?(?:in (?:more |full )?detail|detailed (?:answers?|replies|responses))$/iu;
const NO_LIST_EN = /^(?:please\s+)?(?:(?:reply|respond|answer)\s+)?(?:(?:no|without(?: any)?|(?:do not|don't) use) (?:a )?(?:lists?|(?:bullet|numbered) points|bullets)|(?:in )?(?:plain|continuous) prose)$/iu;
const LIST_EN = /^(?:please\s+)?(?:(?:reply|respond|answer|format it)\s+)?(?:as|in|use|with) (?:an? )?(?:(?:bulleted|numbered) list|list|bullet points|bullets)$/iu;
const LINKS_EN = /^(?:please\s+)?(?:(?:reply|respond|answer)\s+)?(?:(?:give(?: me)?|with|include|use|cite|add|provide)\s+)?(?:(?:only|up to|at most|no more than)\s+)?(zero|one|two|three|[0-9]+)\s+(?:source\s+)?links?(?:\s+only)?$/iu;
const NO_LINKS_EN = /^(?:please\s+)?(?:(?:reply|respond|answer)\s+)?(?:no|without(?: any)?|(?:do not|don't) (?:include|use)) (?:source )?links$/iu;
/** «Return the page title and source link», «give me the link», «with the source link», «include the title and URL». */
const FIELD_VERB_EN = /^(?:please\s+)?(?:(?:return|give|show|tell|send|provide|include|report|list|share|quote|cite)(?:\s+me)?|with|and)\s+/iu;
const FIELD_NOUN_EN: [RegExp, ReplyField][] = [
  [/^(?:main\s+)?(?:heading|headline|h1)$/iu, 'heading'], [/^(?:page\s+)?(?:title|name)$/iu, 'title'],
  [/^(?:source\s+)?(?:link|url|address|source)$/iu, 'link'], [/^first\s+(?:sentence|line|paragraph)$/iu, 'first_sentence'],
];

const LANG_AR: [RegExp, ReplyLanguage][] = [[/^(?:بال)?عربي(?:ه)?$|^باللغه العربيه$|^العربيه$/u, 'ar'], [/^(?:بال)?(?:انجليزي|انكليزي|إنجليزي)(?:ه)?$|^باللغه الانجليزيه$|^الانجليزيه$/u, 'en']];
const COUNT_AR: Record<string, number> = { جمله: 1, سطر: 1, فقره: 1, جملتين: 2, جملتان: 2, سطرين: 2, فقرتين: 2 };
const MODIFIER_AR = /^(?:واحده|واحد|قصيره|قصيرتين|قصيرتان|قصير|مختصره|مختصرتين|بسيطه|بسيطتين|واضحه|فقط|عربيه|عربي|انجليزيه|انجليزي|بالعربيه|بالعربي|بالانجليزيه|بالانجليزي|بالانكليزيه|باللغه|العربيه|الانجليزيه|ثلاث|ثلاثه|جمل|اسطر)$/u;
const REPLY_VERB_AR = '(?:و)?(?:(?:اجب|جاوب)(?:ني| (?:لي|علي))?|رد(?: (?:لي|علي))?|تكلم معي|اريد (?:ال)?(?:اجابات|ردود))';
const REPLY_LEAD_AR = new RegExp(`^${REPLY_VERB_AR}(?= |$)`, 'u');
const VERB_AR = /^(?:و)?(?:اجب|اجبني|رد|جاوب|اكتب|اكتبها|اكتبه|اعطني|اعطيني|قدم|قدمها|اذكر|اذكرها|اشرح|اشرحها|لخص|لخصها|صغ|صغها|قل|قلها)(?:\s+لي)?$/u;
const OBJECT_AR = /^(?:ال)?(?:نتيجه|ناتج|جواب|اجابه|رد)$/u;
const BRIEF_AR = /^(?:و)?(?:باختصار|بايجاز|باقتضاب|اختصر|مختصرا|مختصر)$/u;
const SHORT_REPLIES_AR = '(?:ال)?(?:اجابات|ردود) (?:ال)?(?:قصيره|مختصره)';
const BRIEF_PHRASE_AR = new RegExp(`^(?:بشكل مختصر|${SHORT_REPLIES_AR})$`, 'u');
const NO_LIST_AR = /^(?:بدون|بلا|من دون|دون|لا تستخدم) (?:نقاط(?: تعداد)?|قوائم|قائمه)$/u;
const LIST_AR = /^(?:(?:علي شكل|في|استخدم) (?:قائمه(?: مرقمه)?|نقاط)|بنقاط|بقائمه(?: مرقمه)?)$/u;
const NO_LINKS_AR = /^(?:بدون|بلا|من دون|دون|لا (?:تضف|تذكر|ترسل)) (?:اي )?(?:رابط|روابط)$/u;
const LINKS_AR = /^(?:(?:مع|اضف|ارفق|اذكر|اعطني|قدم) )?(?:فقط )?(رابط واحد|رابطين|رابطان|([0-9]+) (?:روابط|رابط))(?:(?: كحد اقصي)? فقط| كحد اقصي)?$/u;
const FIELD_VERB_AR = /^(?:و)?(?:اعطني|اعطيني|اذكر|ارسل|اعرض|قدم|انقل|اكتب)(?:\s+لي)?$/u;
const FIELD_NOUN_AR: [RegExp, ReplyField][] = [
  [/^(?:و)?(?:ال)?عنوان(?:ها|ه)?$/u, 'title'], [/^(?:و)?(?:ال)?(?:رابط|مصدر)(?:ها|ه)?$/u, 'link'],
  [/^(?:و)?(?:ال)?(?:جمله الاولي|اول جمله)$/u, 'first_sentence'],
];

function englishDirective(text: string): ReplyConstraints | null {
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
  if (DETAIL_EN.test(text)) return { brief: false };
  if (NO_LIST_EN.test(text)) return { list: false };
  if (LIST_EN.test(text)) return { list: true };
  if (NO_LINKS_EN.test(text)) return { links: 0 };
  const links = LINKS_EN.exec(text)?.[1];
  if (links) {
    const count = links === 'zero' ? 0 : COUNT_EN[links] ?? Number(links);
    if (Number.isSafeInteger(count)) return { links: count };
  }
  const verb = FIELD_VERB_EN.exec(text);
  if (verb) {
    const nouns = text.slice(verb[0].length).replace(/\b(?:the|its|their|a|an)\b/giu, ' ').split(/\s*(?:,|&|\band\b|\bplus\b)\s*/iu).map(part => part.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    const fields = nouns.map(noun => FIELD_NOUN_EN.find(([pattern]) => pattern.test(noun))?.[1]);
    if (nouns.length && fields.every(Boolean)) return { fields: [...new Set(fields as ReplyField[])] };
  }
  return null;
}

function arabicDirective(text: string): ReplyConstraints | null {
  const plainStyle = text.replace(/^(?:من فضلك|لو سمحت|رجاءا?) +/u, '').replace(REPLY_LEAD_AR, '');
  const words = plainStyle.replace(/[.!؟?،,]+/gu, ' ').split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  let at = 0;
  const lead = words.slice(0, 2).join(' ');
  if (words.length > 1 && VERB_AR.test(lead)) at = 2; else if (VERB_AR.test(words[0]!)) at = 1;
  if (words[at] && OBJECT_AR.test(words[at]!)) at++;
  if (at === words.length) return null;
  const rest = words.slice(at);
  const phrase = rest.join(' ').replace(/^و(?=(?:بدون|بلا|مع|في|بنقاط|بالتفصيل|دون))/u, '');
  if (rest.length === 1 && BRIEF_AR.test(rest[0]!)) return { brief: true };
  if (BRIEF_PHRASE_AR.test(phrase)) return { brief: true };
  if (/^(?:بالتفصيل|بشكل مفصل|(?:اجابات|ردود) مفصله)$/u.test(phrase)) return { brief: false };
  if (NO_LIST_AR.test(phrase)) return { list: false };
  if (LIST_AR.test(phrase)) return { list: true };
  if (NO_LINKS_AR.test(phrase)) return { links: 0 };
  const links = LINKS_AR.exec(phrase);
  if (links) {
    const count = links[2] ? Number(links[2]) : links[1] === 'رابط واحد' ? 1 : 2;
    if (Number.isSafeInteger(count)) return { links: count };
  }
  // «في جملة واحدة قصيرة بالعربية», «بجملة عربية قصيرة», «بجملتين».
  let first = rest[0]!.replace(/^(?:في|ب)(?=\S)/u, '');
  let start = 0;
  if (rest[0] === 'في' || rest[0] === 'ب') { first = rest[1] ?? ''; start = 1; }
  const three = /^(?:ثلاث|ثلاثه|3)$/u.test(first) && /^(?:جمل|اسطر)$/u.test(rest[start + 1] ?? '');
  if (three || Object.hasOwn(COUNT_AR, first)) {
    const modifiers = rest.slice(start + (three ? 2 : 1));
    if (!modifiers.every(word => MODIFIER_AR.test(word))) return null;
    const joined = modifiers.join(' ');
    const lang = /عربي/u.test(joined) ? 'ar' : /انجليزي|انكليزي/u.test(joined) ? 'en' : undefined;
    const count = three ? 3 : COUNT_AR[first]!;
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

const PREFERENCE_MARKER = 'always|from now on|going forward|for (?:the rest of )?this (?:conversation|chat)|دايما|دائما|من الان(?: فصاعدا)?|بعد الان|في هذه المحادثه';
const PREFERENCE_START = new RegExp(String.raw`^(?:(?:please|من فضلك) +)?(?:${PREFERENCE_MARKER})[ ,،:]+|^(?:(?:remember (?:that )?)?i prefer|(?:تذكر انني )?افضل) +`, 'u');
const REPLY_VERB = `(?:(?:please|من فضلك|لو سمحت|رجاءا?) )?(?:${REPLY_VERB_AR}|(?:reply|answer|respond)(?: to me)?)`;
const REPLY_ONLY = new RegExp(`^${REPLY_VERB}$`, 'u');
const PREFERENCE_MIDDLE = new RegExp(`^(${REPLY_VERB}) (?:${PREFERENCE_MARKER})(?:[ ,،:]+|$)`, 'u');
const PREFERENCE_END = new RegExp(String.raw`[ ,،]+(?:${PREFERENCE_MARKER})$`, 'u');
const STANDALONE_BREVITY = new RegExp(`^(?:(?:short|brief|concise) (?:answers|replies|responses)|${SHORT_REPLIES_AR})$`, 'u');
const TURN_ONLY_START = /^(?:this time|for this (?:reply|answer)|هذه المره|لهذا الرد|في هذا الرد|لهذه الاجابه)[ ,،:]+/u;
const TURN_ONLY_END = /[ ,،]+(?:this time|for this (?:reply|answer)|هذه المره|لهذا الرد|في هذا الرد|لهذه الاجابه)$/u;
const CLEAR_LENGTH = /^(?:(?:no need to (?:answer |reply )?(?:briefly|be brief)|(?:don't|do not) (?:keep (?:it|answers) brief|(?:answer|reply) briefly|be brief)) (?:anymore|any longer)|(?:forget|clear|reset|remove) (?:my |the )?(?:brevity|reply length|reply-length) preference|stop (?:answering|replying|responding) (?:briefly|concisely)|(?:لا داعي (?:للاختصار|للايجاز|للرد باختصار)|لا تختصر) (?:بعد الان|من الان)|الغ (?:تفضيل|شرط) (?:الاختصار|الايجاز)|توقف عن (?:الاختصار|الايجاز))$/u;
const CLEAR_LANGUAGE = /^(?:(?:forget|clear|reset|remove) (?:my |the )?(?:reply )?language preference|no need to (?:answer|reply|respond) in (?:english|arabic) (?:anymore|any longer)|لا داعي (?:للاجابه|للرد) ب(?:اللغه )?(?:العربيه|الانجليزيه) بعد الان|الغ (?:تفضيل|شرط) (?:لغه الرد|اللغه))$/u;
const CLEAR_LIST = /^(?:forget|clear|reset|remove) (?:my |the )?(?:list|list format) preference$|^الغ (?:تفضيل|شرط) (?:القوائم|القائمه)$/u;
const CLEAR_LINKS = /^(?:forget|clear|reset|remove) (?:my |the )?(?:link|link count) preference$|^الغ (?:تفضيل|شرط) (?:الروابط|عدد الروابط)$/u;

interface DirectiveGroup {
  overrides: ReplyOverrides;
  preferences: ReplyPreferencePatch;
}

const directiveText = (clause: string) => fold(clause).replace(/[.!؟?]+$/u, '').replace(/[’‘]/gu, "'").trim();
const preferenceStyle = (text: string) => text.replace(PREFERENCE_START, '').replace(PREFERENCE_MIDDLE, '$1 ').replace(PREFERENCE_END, '').trim();

function clauseOf(clause: string): DirectiveGroup | null {
  const text = directiveText(clause);
  const clear = CLEAR_LENGTH.test(text) ? { brief: null, sentences: null }
    : CLEAR_LANGUAGE.test(text) ? { lang: null }
    : CLEAR_LIST.test(text) ? { list: null }
    : CLEAR_LINKS.test(text) ? { links: null } : null;
  if (clear) return { overrides: clear, preferences: clear };

  const preferred = preferenceStyle(text);
  const style = preferred.replace(TURN_ONLY_START, '').replace(TURN_ONLY_END, '').trim();
  const constraints = englishDirective(style) ?? arabicDirective(style);
  if (!constraints) return null;
  const { fields, ...preferences } = constraints;
  if (fields && preferred !== text) return null;
  // A new length replaces the previous length. Both stay active when a clause asks for short sentences.
  const patch: ReplyPreferencePatch = { ...preferences };
  if (constraints.sentences !== undefined && constraints.brief === undefined) patch.brief = null;
  if (constraints.brief !== undefined && constraints.sentences === undefined) patch.sentences = null;
  return { overrides: fields ? { ...patch, fields } : patch, preferences: preferred !== text ? patch : {} };
}

function combineDirectives(first: DirectiveGroup, last: DirectiveGroup): DirectiveGroup {
  const overrides = { ...first.overrides, ...last.overrides };
  if (first.overrides.fields && last.overrides.fields) {
    overrides.fields = [...new Set([...first.overrides.fields, ...last.overrides.fields])];
  }
  return { overrides, preferences: { ...first.preferences, ...last.preferences } };
}

const CLAUSE_BREAKS = /[,،;؛!?؟\n]|(?<!\d)\.(?!\d)|\s+(?:and|then|but|ثم|لكن)\s+|\s+(?=و(?:[اأ]جب|رد|اكتب|اعطني|اعطيني|اذكر|قدم|ارسل|اعرض|انقل|باختصار|بايجاز))/giu;

/** Try whole clauses first so «return the page title and source link» keeps its conjunction. */
function directiveOf(tail: string): DirectiveGroup | null {
  const whole = clauseOf(tail);
  if (whole) return whole;
  const breaks = [...tail.matchAll(CLAUSE_BREAKS)];
  if (breaks.length > 12) return null;
  const groups: (DirectiveGroup | null)[] = [];
  for (let to = 0; to <= breaks.length; to++) {
    const end = breaks[to]?.index ?? tail.length;
    let group: DirectiveGroup | null = null;
    for (let from = -1; from < to; from++) {
      const previous = groups[from];
      if (from >= 0 && !previous) continue;
      const start = from < 0 ? 0 : breaks[from]!.index + breaks[from]![0].length;
      const part = tail.slice(start, end).trim();
      const current = part ? clauseOf(part) : previous;
      if (current) {
        group = previous && part ? combineDirectives(previous, current) : current;
        break;
      }
    }
    groups.push(group);
  }
  return groups.at(-1) ?? null;
}

/** Where a closing directive may start, including inline language, length, list, and link limits. */
const SPLIT_POINTS = /(?<!\d)\.(?=\s)|[!?؟;؛,،\n](?=\s*\S)|\s(?=(?:and|then|but|ثم|لكن)\s)|\s(?=و(?:اجب|رد|اكتب|اعطني|اعطيني|اذكر|قدم|ارسل|اعرض|انقل|باختصار|بايجاز))|\s(?=(?:in|using)\s+(?:a|an|one|two|three|single|[123]|arabic|english|detail|bullet|plain)\b)|\s(?=(?:في\s+|ب)?(?:جمله|جملتين|جملتان|ثلاث|ثلاثه|[٣3]|سطر|سطرين)(?:\s|$))|\s(?=(?:briefly|concisely|without|with|at most|no (?:links|lists|bullet))\b|(?:بالعربيه|بالعربي|بالانجليزيه|بالانجليزي|باللغه|باختصار|بايجاز|بالتفصيل|بنقاط|بقائمه|بدون|بلا|علي شكل|في نقاط|مع رابط(?:ين)?)(?!\p{L}))/giu;

export function mergeReplyConstraints(parsed: ReplyRequest, saved: ReplyPreferences = {}): ReplyConstraints {
  return Object.fromEntries(Object.entries({ ...saved, ...parsed.overrides }).filter(([, value]) => value != null));
}

/** Read directives around the request once, preserving scope and order for conflicting settings. */
export function parseReplyRequest(text: string): ReplyRequest {
  const none: ReplyRequest = { body: typeof text === 'string' ? text.trim() : '', label: null, directive: null,
    overrides: {}, preferences: {}, preferenceOnly: false };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return none;
  const labelled = incidentalLabel(text);
  const working = labelled?.rest ?? text.trim();
  // Literal data and quoted text cannot set reply preferences. The matching copy preserves offsets.
  const matching = maskRequestLiteralData(working).replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
  const standalone = directiveText(working);
  const standaloneStyle = preferenceStyle(standalone);
  const incompletePreference = standaloneStyle !== standalone && REPLY_ONLY.test(standaloneStyle);
  const whole = incompletePreference ? { overrides: {}, preferences: {} } : directiveOf(working);
  if (whole && STANDALONE_BREVITY.test(standalone)) whole.preferences = { brief: true, sentences: null };
  let group = whole;
  let body = working, style = group ? working : '';
  if (!group) {
    let start = 0;
    for (const point of matching.matchAll(CLAUSE_BREAKS)) {
      const end = point.index + point[0].length;
      if (!working.slice(end).trim()) continue;
      const prefix = working.slice(0, point.index).trim();
      const parsed = directiveOf(prefix);
      // Leading field verbs such as «give me the link» can be a primary request.
      if (!parsed || parsed.overrides.fields) continue;
      start = end;
      group = parsed;
      style = prefix;
    }
    body = working.slice(start).trim();
    // Do not look inside an already consumed leading directive for a suffix.
    for (const point of matching.matchAll(SPLIT_POINTS)) {
      const at = point.index;
      if (at <= start || working.slice(start, at).trim().length < 2) continue;
      const tail = working.slice(at).replace(/^[\s.!?؟;؛,،]+/u, '').replace(/^(?:and|then|but|ثم|لكن)\s+/iu, '');
      const parsed = directiveOf(tail);
      if (!parsed) continue;
      group = group ? combineDirectives(group, parsed) : parsed;
      style = [style, tail].filter(Boolean).join(' ');
      body = working.slice(start, at).replace(/[\s,،;؛]+$/u, '').trim();
      break;
    }
  }
  const preferenceOnly = incompletePreference || Boolean(group && Object.keys(group.preferences).length
    && (whole || REPLY_ONLY.test(directiveText(body))));
  if (preferenceOnly) { body = ''; style = working; }
  if (!group || (!preferenceOnly && body.length < 2)) return { ...none, body: working, label: labelled?.label ?? null };
  const parsed: ReplyRequest = { body, label: labelled?.label ?? null, directive: null, preferenceOnly, ...group };
  return { ...parsed, directive: { ...mergeReplyConstraints(parsed), text: style } };
}

/** Compatibility for callers that expect a request body and a directive attached to it. */
export function splitReplyDirective(text: string): ReplyFraming {
  const { body, label, directive, preferenceOnly } = parseReplyRequest(text);
  if (preferenceOnly) return { body: directive!.text, label, directive: null };
  return { body, label, directive: body === directive?.text ? null : directive };
}

/** «ar»/«en» for a request by its letters, as the rest of the assistant decides. */
export const requestLanguage = (text: string): ReplyLanguage => /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
