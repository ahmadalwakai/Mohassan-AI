import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';
import { analyzeCompoundRequest } from './compound-request.js';
import { matchText } from './mind/normalize.js';
import { openStructuredMemorySubject, resolveStructuredMemoryTarget, subjectOf, targetFor, type StructuredMemoryProperty, type StructuredMemoryTarget } from './structured-memory-lexicon.js';
import { assessUserFactMemoryRequest } from './user-fact-memory-receipt.js';

export type { StructuredMemoryProperty, StructuredMemoryTarget };

interface StructuredFactAssignment {
  target: StructuredMemoryTarget;
  statement: string;
  value: string;
  since: string | null;
  until: string | null;
  explicit: boolean;
}

export type StructuredMemoryIntent =
  | { kind: 'none' }
  | { kind: 'secret' }
  | (StructuredFactAssignment & { kind: 'statement' | 'correction' })
  | { kind: 'recall'; target: StructuredMemoryTarget; query?: string }
  | { kind: 'forget'; target: StructuredMemoryTarget };

const COURTESY = /^(?:(?:please|kindly|من فضلك|لو سمحت|اذا سمحت|رجاء|ارجوك)[,،:\s]+)+/u;
const REMEMBER = /^(?:remember(?: that)?|don't forget(?: that)?|keep in mind(?: that)?|(?:save|store|record) (?:this|that|it)(?: in (?:my |your |the )?memory)?|(?:تذكر|افتكر|اتذكر|لا تنس|لا تنسي|احفظ(?: (?:في )?(?:ذاكرتي|ذاكرتك|الذاكره))?|سجل|دون|خلي (?:(?:في |ب ?)(?:ذاكرتك|الذاكره)|ببالك))(?: ان(?:ن?ي|نا)?)?)(?:\s*[:,،]\s*|\s+)(?=\S)/u;
const REPEATED_SAVE = /[.!]\s*(?:(?:save|remember) (?:it|this|that)|(?:احفظ|تذكر|افتكر|سجل)(?:ه|ها|هم))[.!]?$/u;
const CORRECTION = /^(?:(?:change|update|correct|set)\s+|(?:غير|عدل|حدث|صحح|بدل)\s+)/u;
const REPARATION = /^(?:(?:no|لا)\s*[،,:]\s*|(?:actually|correction|بل|تصحيح)[،,:\s]+)(?=\S)/u;
const FORGET = /^(?:forget|انس|انسي)\s+(?=\S)/u;
const FORGET_ALTERNATIVE = /^(?:remove|delete|erase|امسح|احذف|ازل)\s+(.+?)\s+(?:from (?:my |your |the )?(?:saved )?memory|من (?:ذاكرتي|ذاكرتك|الذاكره))$/u;
const LOOKUP_PREFIX = /^(?:(?:tell me|remind me)(?: of| about)?|(?:ما هو|ما هي|ماهو|ماهي|ما|ماذا|وش|وشو|ايش|شو|شنو|ايه|متي|امتي|كم|كام|شكد|انهي|ذكرني(?: ب)?|قل لي)|(?:what|which|when|where|who)(?: is| are| was|'s)?)\s+/u;
const LOOKUP_SUFFIX = /\s+(?:وش|ايش|ايه|كام|كم)$/u;
const RESIDENCE_QUESTION = /^(?:where (?:do|did) (?:i|we) (?:currently )?(?:live|reside|stay)(?: now)?|where (?:am i|are we) (?:living|staying|based)|(?:اين|وين|فين|وينه)\s+(?:(?:انا|نحن|احنا)\s+)?(?:اسكن|باسكن|بسكن|نسكن|اقيم|نقيم|اعيش|نعيش|ساكن(?:ه|ين)?|مقيم(?:ه|ين)?|عايش(?:ه|ين)?)(?:\s+(?:انا|نحن|احنا))?(?:\s+(?:الحين|دلوقتي|هلا|الان))?)$/u;
const LOCATION_QUESTION = /^(?:where(?: is| are|'s)|اين|وين|فين)\s+(.+)$/u;
const MEMORY_FRAME = /(?:^|[ ,،])(?:from (?:my |your |the )?memory|in (?:my|your|the) memory|(?:من|في|ب) ?(?:ذاكرتي|ذاكرتك|الذاكره))(?=$|[ ,،])/gu;
const MEMORY_REFERENCE = /(?:^|[ ,،])(?:remember(?:ed)?|saved|stored|recorded|(?:ال)?محفوظ(?:ه)?|حفظ(?:ت|ته|تها|تهم|تهما)|حافظ(?:ه|ها|هم)|(?:ت)?حفظ(?:ه|ها|هم)|تذكر(?:ت|ته|تها)?|(?:كنت )?قلت ?لك)(?=$|[ ,،])/u;
const MEMORY_REMINDER = /^(?:remind me|do you remember|هل تتذكر|هل تذكر|ذكرني)(?: about| of)?\s+/u;
const MEMORY_RELATIVE = / (?:that|which|اللي|الذي|التي) /u;
const MEMORY_ADJECTIVE = /(?:^| )(?:saved|remembered|stored|recorded|(?:ال)?محفوظ(?:ه)?)(?= |$)/gu;
const PRIOR_MEMORY_INSTRUCTION = /(?:^| )(?:i (?:asked|told) you to|did i (?:ask|tell) you to) (?:save|store|remember|record|keep in mind)(?: |$)/u;
const MEMORY_ACTION = /(?:^| )(?:you (?:have|keep)(?: [\p{L}\p{N}]+){0,3} on record|you (?:have |had )?(?:saved|stored|remembered)|(?:كنت )?قلت ?لك|(?:ت)?حفظ(?:ته|تها|تهم|تهما|ه|ها|هم)|حافظ(?:ه|ها|هم)|تذكر(?:ته|تها))(?=$|[ ,،])/u;
const EXTERNAL_ARTIFACT = /(?:^| )(?:saved|stored|recorded) (?:report|document|file|spreadsheet|page|recording)(?: |$)|(?:^| )(?:ال)?(?:تقرير|ملف|مستند|صفحه)\p{L}* (?:ال)?محفوظ(?:ه)?(?: |$)/u;

const RESIDENCE = /^(?:(?:i|we) (?:live|reside|lived|resided|am living|are living|am based|are based|am staying|are staying) (?:in|at)\s+|(?:(?:انا|انني|نحن|احنا)\s+)?(?:اسكن|باسكن|بسكن|نسكن|سكنت|اقيم|نقيم|اعيش|نعيش|ساكن(?:ه|ين)?|مقيم(?:ه|ين)?|عايش(?:ه|ين)?)\s+(?:في\s+|ب\s*))/u;
const LANGUAGE = /^(?:(?:i|we) prefer\s+|(?:(?:انا|اني|انني|نحن|احنا)\s+)?(?:افضل|بفضل|نفضل)\s+)/u;
const LANGUAGE_VALUE = /^(?:arabic|english|العربيه|الانجليزيه)(?=\s|$)/u;
const ARABIC_PREFERENCE = /^(?<topic>.+?) (?:عن طريق |باستخدام |ب ?)(?<value>.+)$/du;
const NAMED = /^(?<subject>.+?) (?:is|are) (?:called|named)\s+(?<value>.+)$/du;
const ASSIGNMENT = /^(?<target>.+?)(?: (?:is|are|و?هو|و?هي)\s+|\s*[:=]\s*)(?<value>.+)$/du;
const CHANGE_ASSIGNMENT = /^(?<target>.+?) (?:(?:to|الي)\s+|ل\s*)(?<value>.+)$/du;
const UNSUPPORTED_VALUE = /^(?:not|no|none|unknown|maybe|possibly|probably|if|unless|i think|it|there|null|undefined|غير|ليس|ليست|ما ادري|ما اعرف|مجهول|ربما|يمكن|لو|اذا|نفسه|نفسها|هنا|هناك)(?![\p{L}\p{M}])|[<>\[\]{}\x60]|:\/\/|[!?؟؛;\r\n]|(?<!\d)\.(?=\s)|(?:^|[,،]\s*|\s(?:and|or|و)\s+)(?:if|unless|اذا|لو|ارسل|ابعث|افتح|انشر|احذف|انس|تجاهل|send|post|open|delete|forget|ignore)(?=\s|$)/u;
const REFERRED_VALUE = /^(?:what(?:ever)? (?:i|we|you|they) (?:told|said|wrote|mentioned|gave|showed)|the (?:same|one (?:i|we|you|they) (?:told|said|wrote|mentioned|gave|showed))|as (?:above|before|mentioned)|according to|(?:shown|listed|written|mentioned) (?:on|in|above|below)|(?:on|in|from) (?:this|that|the) (?:page|file|document|message|note)|(?:حسب|علي حسب|وفقا ل)|(?:ما|اللي|الي|الذي|التي) (?:قلت|قلته|ذكرته|ذكرتها|كتبته|كتبتهما|اعطيت|ذكرت|كتب|ورد|يقوله|تقوله)|(?:المذكور|المكتوب|الموجود)(?:ه|ه? في)|(?:في|من) (?:هذه |هذا |تلك |ذلك )?(?:الصفحه|الملف|المستند|الرساله))(?=\s|$)|^(?:ours|mine|yours|theirs|his|hers|somewhere|something|someone|somebody|له|لها|لهم|اياها|اياه|مدينتها|بلدهم|عنوانه)$/u;
const QUOTE_PAIRS: Readonly<Record<string, string>> = { '"': '"', '“': '”', '«': '»' };
const TIME_MARK = /\s+(since|until|till|منذ|حتي|لحد|لغايه|الي غايه|(?:من|الي)(?=\s+(?:\d|سنه\s|عام\s|يوم\s)))\s+/gu;
const SECOND_ASSERTION = /\s+(?:and|or)\s+(?:i|we|my|our)\s+|\s+و\s*(?:انا|انني|نحن|احنا)\s+/u;
const CONDITIONAL_VALUE = /(?:^|\s)(?:if|unless|whether|اذا|لو|لولا)(?=\s|$)/u;
const ALTERNATIVE_OR_ACTION = /(?:^|\s)(?:or|او)\s+|\s+(?:and\s+|و\s*)(?:use|transfer|photograph|upload|download|install|حول المال|حول فلوس|استخدم|استعمل|صور|ارفع|حمل|نزل|ثبت)(?=\s|$)/u;
const EXTERNAL_UPDATE = /\s+(?:(?:on|in) (?:my|our|the) (?:account|profile|website|portal)|(?:في|علي) (?:حسابي|حسابنا|الحساب|الموقع|المنصه|الملف الشخصي))(?=\s|$)/u;

const SECRET_FIELD = [
  'password|passphrase|passwd|passcode|pin(?: number)?|otp|2fa code|mfa code',
  '(?:one[- _]?time|temporary|verification|security|authentication) (?:code|password|pin)',
  '(?:access|entry|door|alarm|unlock) code|(?:safe|lock|locker) combination',
  'api[- _]?key|(?:access|refresh|auth|session|bearer)[- _]?token|client[- _]?secret|private key',
  "(?:credit |debit |bank |payment )?card(?:'s)? (?:number|#)|credit card|debit card|card (?:pin|security code)|cvv2?|cvc",
  '(?:كلمه|باسورد|رمز) (?:المرور|السر|مروري|سري)|(?:كلمه مرور|باسورد)(?: حسابي)?|(?:ال)?رقم (?:السري|سري)',
  '(?:رمز|كود|رقم) (?:الدخول|التحقق|التاكيد|التوثيق|الامان|الموقت|المؤقت|لمره واحده|لمره واحده فقط|التعريف الشخصي)',
  '(?:رمز|كود) التحقق (?:بخطوتين|لمره واحده)|(?:رمز|كود) دخولي',
  '(?:رقم )?(?:بطاقه|بطاقتي)(?: (?:الائتمانيه|البنكيه|المصرفيه|الخصم|الدفع|الامانه|البنك))?',
  'مفتاح (?:سري|خاص|api|واجهه البرمجه)',
].join('|');
const SECRET_OWNER = "(?:(?:my|our|the)(?: (?:account|email|database|login|work|bank|company|business|device|phone|wife|husband)(?:'s)?)? )?";
const SECRET_ASSIGNMENT = new RegExp(String.raw`^${SECRET_OWNER}(?:${SECRET_FIELD})(?: (?:الخاصه? بي|لحسابي|لي))?(?:\s*[:=]\s*|\s+(?:is|are|was|هو|هي|to|الي)\s+)(?=\S)`, 'u');
const SECRET_SCALAR = new RegExp(String.raw`^${SECRET_OWNER}(?:${SECRET_FIELD})(?:\s+\S+)?[.!]?$`, 'u');
const SECRET_EMBEDDED_ASSIGNMENT = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}])(?:${SECRET_FIELD})\s*[:=]\s*\S`, 'u');
const NESTED_SECRET_ASSIGNMENT = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}])(?:${SECRET_FIELD})\s+(?:is|are|was|و?هو|و?هي|to|الي)\s+\S`, 'u');
const EXACT_NOTE_PREFIX = /^(?:exactly this note|النص التالي):\s*/u;
const REDACTED = /\[(?:REDACTED|(?:اعتماد|مفتاح) محجوب|محجوب)\]/iu;

function containsCardNumber(text: string): boolean {
  for (const match of text.matchAll(/(?<![\d+])\d(?:[ .-]?\d){12,18}(?!\d|[ .-]\d)/gu)) {
    const digits = match[0].replace(/\D/gu, '');
    // Standard card checksum. Labels above still reject fabricated or invalid numbers.
    const total = [...digits].reduce((sum, digit, index) => {
      const number = Number(digit);
      const doubled = number * 2;
      return sum + ((digits.length - index) % 2 === 0 ? doubled > 9 ? doubled - 9 : doubled : number);
    }, 0);
    if (digits.length >= 13 && total % 10 === 0) return true;
  }
  return false;
}

/** Classifies recognizable credential disclosures without returning any secret material. */
export function hasStructuredMemorySecret(raw: string): boolean {
  const visible = raw.normalize('NFKC').replace(/\p{Cf}/gu, '');
  if (redactCredentialText(redactSecrets(raw)) !== raw || redactCredentialText(redactSecrets(visible)) !== visible || REDACTED.test(visible)) return true;
  const text = matchText(visible).replace(/’/gu, "'").replace(/\s+/gu, ' ').trim().replace(COURTESY, '');
  if (containsCardNumber(text)) return true;
  const directive = REMEMBER.exec(text) ?? CORRECTION.exec(text) ?? REPARATION.exec(text);
  const body = text.slice(directive?.[0].length ?? 0);
  const literalNote = Boolean(directive && EXACT_NOTE_PREFIX.test(body));
  const payload = directive ? body.replace(EXACT_NOTE_PREFIX, '').replace(/^["«“]\s*/u, '').replace(/\s*["»”]$/u, '') : body;
  const assigned = SECRET_ASSIGNMENT.exec(payload);
  // Exact notes are prose. Preserve the existing disclosure policy there, plus
  // recognizable credential scalars and card numbers detected by this parser.
  if (literalNote && assessUserFactMemoryRequest(raw).reason === 'credential_material') return true;
  if (assigned && (!literalNote || /^(?:\S+|[\d .-]+)$/u.test(payload.slice(assigned[0].length)))) return true;
  if (!/[?؟]$/u.test(payload) && SECRET_SCALAR.test(payload)) return true;
  if (!literalNote && (directive || /^(?:my|our|the) /u.test(payload)) && NESTED_SECRET_ASSIGNMENT.test(payload)) return true;
  if (!SECRET_EMBEDDED_ASSIGNMENT.test(payload)) return false;
  return Boolean(directive || parseAssignment(payload, false));
}

interface MatchingSource {
  text: string;
  original(start: number, end?: number): string;
}

function matchingSource(raw: string): MatchingSource {
  let text = '', offset = 0;
  const starts: number[] = [];
  for (const point of raw) {
    const normalized = matchText(point).replace(/’/gu, "'").replace(/\s/gu, ' ');
    for (const unit of normalized.split('')) {
      if (unit === ' ' && text.endsWith(' ')) continue;
      starts.push(offset);
      text += unit;
    }
    offset += point.length;
  }
  return {
    text,
    original(start, end = text.length) {
      return raw.slice(starts[start] ?? raw.length, starts[end] ?? raw.length).trim();
    },
  };
}

type Recall = Extract<StructuredMemoryIntent, { kind: 'recall' }>;

function recallIntent(text: string, interrogative: boolean): Recall | undefined {
  if (RESIDENCE_QUESTION.test(text)) return { kind: 'recall', target: targetFor('user', 'address') };
  const location = LOCATION_QUESTION.exec(text);
  const place = location && subjectOf(location[1]!);
  if (place) return { kind: 'recall', target: targetFor(place, 'location') };
  const framed = text.replace(MEMORY_FRAME, ' ').replace(/^[ ,،]+|[ ,،]+$/gu, '').replace(/ +/gu, ' ');
  const prefix = MEMORY_REMINDER.exec(framed) ?? LOOKUP_PREFIX.exec(framed);
  const suffix = LOOKUP_SUFFIX.exec(framed);
  if (!prefix && !suffix && !interrogative) return undefined;
  const phrase = framed.slice(prefix?.[0].length ?? 0, suffix?.index).replace(/^(?:هو|هي)\s+/u, '');
  const framedMemory = framed !== text || MEMORY_REMINDER.test(text);
  const action = MEMORY_ACTION.test(phrase) || PRIOR_MEMORY_INSTRUCTION.test(phrase);
  const memory = framedMemory || action || MEMORY_REFERENCE.test(phrase);
  const target = resolveStructuredMemoryTarget(phrase)
    ?? (/^(?:ذكرني|قل لي)/u.test(text) ? resolveStructuredMemoryTarget(phrase.replace(/^ب/u, '')) : undefined);
  if (target) return { kind: 'recall', target, ...(memory ? { query: phrase } : {}) };
  if (!phrase || /[!?؟؛;]/u.test(phrase) || !framedMemory && EXTERNAL_ARTIFACT.test(phrase)) return undefined;
  if (!memory) {
    // An owned, named entity is already an unambiguous private memory target.
    const owned = resolveStructuredMemoryTarget(phrase, true);
    return owned?.property === 'name' && owned.subject?.startsWith('entity:')
      && /^(?:my|our) |(?:[\p{Script=Arabic}]{2,}(?:ي|نا)|مالتي|تبعتي|بتاعي|بتاعتي|حقي|حقتي)$/u.test(phrase)
      ? { kind: 'recall', target: owned } : undefined;
  }

  // A relative that describes the act of retaining the fact is not part of its label.
  const relative = MEMORY_RELATIVE.exec(phrase);
  const label = (relative && MEMORY_REFERENCE.test(phrase.slice(relative.index)) ? phrase.slice(0, relative.index) : phrase)
    .replace(MEMORY_ADJECTIVE, '').replace(/ +/gu, ' ')
    .split(/[,،]/u, 1)[0]!.trim();
  const exact = resolveStructuredMemoryTarget(label, true);
  if (exact) return { kind: 'recall', target: exact, query: phrase };
  return framedMemory || action
    ? { kind: 'recall', target: targetFor(null, 'descriptor:query'), query: phrase }
    : undefined;
}

interface ParsedAssignment {
  target: StructuredMemoryTarget;
  valueStart: number;
}

function parseAssignment(text: string, correctionCommand: boolean, open = false): ParsedAssignment | undefined {
  const named = NAMED.exec(text);
  const noun = named?.groups!.subject;
  const subject = noun && (open ? openStructuredMemorySubject(noun, true) : subjectOf(noun));
  if (!correctionCommand && subject) return { target: targetFor(subject, 'name'), valueStart: named!.indices!.groups!.value![0] };
  const assignment = (correctionCommand ? CHANGE_ASSIGNMENT : ASSIGNMENT).exec(text);
  if (assignment) {
    const target = resolveStructuredMemoryTarget(assignment.groups!.target!, open);
    if (target) return { target, valueStart: assignment.indices!.groups!.value![0] };
  }
  if (correctionCommand) return undefined;
  const residence = RESIDENCE.exec(text);
  if (residence) return { target: targetFor('user', 'address'), valueStart: residence[0].length };
  const language = LANGUAGE.exec(text);
  if (language && LANGUAGE_VALUE.test(text.slice(language[0].length))) {
    return { target: targetFor('user', 'language'), valueStart: language[0].length };
  }
  if (open && language && /\p{Script=Arabic}/u.test(text)) {
    const preference = ARABIC_PREFERENCE.exec(text.slice(language[0].length));
    const topic = preference?.groups!.topic;
    if (topic && /^[\p{Script=Arabic}]+(?: [\p{Script=Arabic}]+){0,3}$/u.test(topic)) {
      const label = topic.replace(/^ال/u, '');
      return { target: targetFor('user', `descriptor:${label} preference`), valueStart: language[0].length + preference!.indices!.groups!.value![0] };
    }
  }
  if (!/\p{Script=Arabic}/u.test(text) || /[:=]/u.test(text)) return undefined;
  const spaces = [...text.matchAll(/ /gu)];
  for (const { index } of [...spaces].reverse()) {
    const target = resolveStructuredMemoryTarget(text.slice(0, index));
    if (target && !target.subject?.includes(':')) return { target, valueStart: index + 1 };
  }
  if (open) {
    for (const { index } of spaces) {
      const label = text.slice(0, index);
      const value = text.slice(index + 1);
      const target = resolveStructuredMemoryTarget(label, true);
      if (!target?.subject?.startsWith('entity:')) continue;
      const owned = /(?:[\p{Script=Arabic}]{2,}(?:ي|نا)|my [\w-]+|our [\w-]+|عندي|مالتي|تبعتي|حقتي|حقي|بتاعتي|بتاعي)$/u.test(label);
      const typedValue = target.property === 'number' && /^\d+$/u.test(value)
        || target.property === 'deadline' && /^(?:\d|(?:ال)?(?:سبت|احد|اثنين|ثلاثاء|اربعاء|خميس|جمعه)(?: |$))/u.test(value);
      if (owned || typedValue) return { target, valueStart: index + 1 };
    }
  }
  return undefined;
}

function literalValue(source: MatchingSource, start: number, end: number, property: StructuredMemoryProperty) {
  const inner = source.text.slice(start, end);
  if (!inner || UNSUPPORTED_VALUE.test(inner) || SECOND_ASSERTION.test(inner) || CONDITIONAL_VALUE.test(inner)
    || ALTERNATIVE_OR_ACTION.test(inner) || /^(?:هو|هي)(?![\p{L}\p{M}])/u.test(inner)) return null;
  const close = QUOTE_PAIRS[inner[0] ?? ''];
  const closeIndex = close ? inner.indexOf(close, 1) : -1;
  if (close && closeIndex < 0) return null;
  const markers = [...inner.matchAll(TIME_MARK)].filter(marker => marker.index > closeIndex);
  let value = source.original(start, start + (markers[0]?.index ?? inner.length));
  if (close) {
    if (!value.endsWith(close) || value.slice(1, -1).includes(close)) return null;
    value = value.slice(1, -1).trim();
  }
  if (!value || value.length > 400 || !/[\p{L}\p{N}]/u.test(value) || /["“”«»]/u.test(value)) return null;
  if (REFERRED_VALUE.test(matchText(value))) return null;
  if (property === 'phone') {
    const phone = matchText(value);
    if (!/^\+?[\d(). -]+$/u.test(phone) || !/^\d{7,15}$/u.test(phone.replace(/\D/gu, ''))) return null;
  }
  if (property === 'email' && !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/u.test(value)) return null;

  let since: string | null = null;
  let until: string | null = null;
  for (const [index, marker] of markers.entries()) {
    const date = source.original(start + marker.index + marker[0].length, start + (markers[index + 1]?.index ?? inner.length));
    if (!date || date.length > 100 || !/[\p{L}\p{N}]/u.test(date) || REFERRED_VALUE.test(matchText(date))) return null;
    if (/^(?:since|منذ|من)$/u.test(marker[1]!)) {
      if (since !== null || until !== null) return null;
      since = date;
    } else {
      if (until !== null) return null;
      until = date;
    }
  }
  return { value, since, until };
}

/** A trailing command can only repeat the initial save, with no target or extra action. */
export function structuredMemoryInstruction(raw: string): string {
  const trimmed = raw.trim();
  const source = matchingSource(trimmed);
  const repetition = REPEATED_SAVE.exec(source.text);
  if (!repetition || !REMEMBER.test(source.text.replace(COURTESY, ''))) return trimmed;
  return source.original(0, repetition.index + 1);
}

/** Recognize current input, or a previously stored assertion after its owner provenance was checked. */
export function parseStructuredMemoryRequest(raw: string, { storedAssertion = false } = {}): StructuredMemoryIntent {
  if (hasStructuredMemorySecret(raw)) return { kind: 'secret' };
  if (raw.length > 1500 || /[\p{Cc}\p{Cf}\u2028\u2029\ud800-\udfff]/u.test(raw)) return { kind: 'none' };
  const source = matchingSource(structuredMemoryInstruction(raw));
  const courtesyEnd = COURTESY.exec(source.text)?.[0].length ?? 0;
  const text = source.text.slice(courtesyEnd).replace(/[.!?؟]+$/u, '').trimEnd();
  const interrogative = /[?؟]\s*$/u.test(source.text);
  const recall = recallIntent(text, interrogative);
  if (recall) return recall;
  if (interrogative || /[!?؟;؛]/u.test(text)) return { kind: 'none' };

  const forget = FORGET.exec(text);
  const forgetPhrase = forget ? text.slice(forget[0].length).replace(/\s+(?:from (?:my |your |the )?(?:saved )?memory|من (?:ذاكرتي|ذاكرتك|الذاكره))$/u, '')
    : FORGET_ALTERNATIVE.exec(text)?.[1];
  if (forgetPhrase) {
    const target = resolveStructuredMemoryTarget(forgetPhrase, true);
    return target ? { kind: 'forget', target } : { kind: 'none' };
  }

  const beforeStatement = REMEMBER.exec(text)?.[0].length ?? 0;
  const statementOffset = courtesyEnd + beforeStatement;
  const corrected = REPARATION.exec(text.slice(beforeStatement))?.[0].length ?? 0;
  const commandOffset = beforeStatement + corrected;
  const command = CORRECTION.exec(text.slice(commandOffset))?.[0].length ?? 0;
  const assignmentStart = commandOffset + command;
  if (beforeStatement && EXACT_NOTE_PREFIX.test(text.slice(beforeStatement))) return { kind: 'none' };
  const assignment = parseAssignment(text.slice(assignmentStart), command > 0, storedAssertion || beforeStatement > 0 || command > 0 || corrected > 0);
  if (!assignment) return { kind: 'none' };
  const correction = command > 0 || corrected > 0;
  if (assignment.target.subject === null && !correction) return { kind: 'none' };
  const fact = literalValue(source, courtesyEnd + assignmentStart + assignment.valueStart, courtesyEnd + text.length, assignment.target.property);
  const statement = source.original(statementOffset);
  if (!fact || correction && EXTERNAL_UPDATE.test(matchText(fact.value)) || analyzeCompoundRequest(statement).kind !== 'single') return { kind: 'none' };
  return { kind: correction ? 'correction' : 'statement', target: assignment.target, statement, ...fact, explicit: correction || beforeStatement > 0 };
}
