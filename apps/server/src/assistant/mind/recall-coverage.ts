/**
 * Conservative field/subject coverage for retrieved facts. This checks whether
 * quoted evidence addresses a requested field, not whether a stored fact is true.
 * Titles may identify a document's subject; they cannot supply its missing value
 * or property. All inputs remain data and no claim grants execution authority.
 */
import { memoryRecallFormat } from '../memory-recall.js';
import { parsePreferredLanguageFact, recognizePreferredLanguageRequest } from '../preferred-language-fact.js';
import type { Evidence } from './contract.js';

export interface RecallCoverageEvidence {
  quote: string;
  title?: string;
  sourceRef?: string;
  /** Trusted host source metadata; never inferred from a quote or document title. */
  source?: Evidence['source'];
}
export interface RecallCoverage {
  status: 'complete' | 'partial' | 'missing' | 'unknown';
  requestedProperties: string[];
  coveredProperties: string[];
  missingProperties: string[];
  subjectTerms: string[];
  matchedEvidenceIndices: number[];
  matches: { property: string; evidenceIndices: number[] }[];
}
export interface RecallCoverageOptions { contextTopic?: string }

const MAX_REQUEST = 4000;
const MAX_EVIDENCE = 100;
const MAX_PROPERTIES = 12;
const MAX_SUBJECT_TERMS = 24;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase()
  .replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .replace(/ؤ/gu, 'و').replace(/ئ/gu, 'ي').replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));

// Field vocabulary is shared across arbitrary subjects; it is not a list of
// complete accepted questions or a source of invented values.
const PROPERTY_WORDS: Record<string, readonly string[]> = {
  name: ['name', 'names', 'اسم', 'اسما'],
  location: ['address', 'addresses', 'location', 'locations', 'headquarters', 'located', 'عنوان', 'عناوين', 'موقع', 'مقر', 'مكان', 'يقع', 'تقع'],
  city: ['city', 'cities', 'مدينه', 'مدن'],
  identifier: ['code', 'codes', 'identifier', 'identifiers', 'id', 'reference', 'references', 'number', 'رمز', 'رموز', 'كود', 'معرف', 'رقم'],
  budget: ['budget', 'budgets', 'ميزانيه'],
  amount: ['amount', 'amounts', 'sum', 'مبلغ', 'مبالغ'],
  price: ['price', 'prices', 'cost', 'costs', 'fee', 'fees', 'سعر', 'اسعار', 'تكلفه', 'رسوم', 'ثمن'],
  date: ['date', 'dates', 'year', 'years', 'when', 'تاريخ', 'تواريخ', 'عام', 'سنه', 'سنوات', 'موعد', 'مواعيد', 'متي'],
  time: ['time', 'times', 'hour', 'hours', 'وقت', 'توقيت', 'ساعه', 'ساعات'],
  capacity: ['capacity', 'capacities', 'seats', 'accommodates', 'fits', 'سعه', 'يستوعب', 'تستوعب', 'مقاعد'],
  quantity: ['quantity', 'quantities', 'count', 'counts', 'عدد', 'كميه'],
  color: ['color', 'colors', 'colour', 'colours', 'لون', 'الوان'],
  length: ['length', 'height', 'طول', 'ارتفاع'],
  duration: ['duration', 'مده', 'يستغرق', 'تستغرق'],
};
const SUBJECT_WORDS: Record<string, readonly string[]> = {
  company: ['company', 'companies', 'business', 'شركه', 'موسسه'],
  office: ['office', 'مكتب'],
  depot: ['depot', 'مستودع'],
  warehouse: ['warehouse', 'مخزن'],
  workshop: ['workshop', 'ورشه'],
  hall: ['hall', 'قاعه'],
  boat: ['boat', 'قارب'],
  bay: ['bay', 'رصيف'],
  booking: ['booking', 'reservation', 'حجز'],
  opening: ['open', 'opened', 'opening', 'افتتاح', 'افتتح', 'افتتحت', 'فتح'],
  closing: ['close', 'closed', 'closing', 'اغلاق', 'اغلق', 'اغلقت'],
};
const STOP = new Set(normalize(`a an the and or but of on at in from for to with by as is are was were be been has have had do does did
  i me my mine our ours your yours its their his her it this that these those what which who where how many much all both each
  tell give return reply respond output write read find search look up check please only just exactly nothing else
  according memory memories memorized recall remembered saved stored recorded personal private own notes note record records document documents
  current currently now today latest recent recently
  file files guide manual handbook information data fact facts answer question source sources string numeric integer json keys key fields field properties property
  disagrees disagree competing conflicting compare comparison know about named called number only
  في من الي عن مع هو هي هما كان كانت ما ماذا متي اين هل كيف كم انا انت ان اسمي لي لدي عندي لنا لك فقط كما هذا هذه ذلك تلك الذي التي جميع كل كلا
  اعطني قل اذكر اعد اجب اكتب ارجع ابحث اقرأ اقرا ما هي ما هو رقم فقط
  الذاكره ذاكرتي ذاكرتك ذاكرتنا ملاحظاتي ملاحظات السجل سجلاتي سجلات
  محفوظ المحفوظ محفوظه المحفوظه مخزن المخزن مخزنه المخزنه مسجل المسجل المسجله خاص الخاص خاصه الخاصه
  معلومات المعلومه مستند مستندات دليل دليلي ملف وثيقه وثائق اسمها اسمه فيها فيه عنها عنه حاليا اليوم الان اخر احدث
  بصيغه بتنسيق شكل قائمه جدول نص كنص نصي عددي رقمي قيمه القيمه وحدها وحده دون شرح`).split(/\s+/u));
const propertyByWord = new Map<string, string>();
const subjectByWord = new Map<string, string>();
for (const [property, words] of Object.entries(PROPERTY_WORDS)) for (const word of words) propertyByWord.set(normalize(word), property);
for (const [subject, words] of Object.entries(SUBJECT_WORDS)) for (const word of words) subjectByWord.set(normalize(word), subject);

function forms(word: string) {
  const base = word.replace(/^(?:وال|بال|لل|ال)(?=\p{L}{3})/u, '');
  const values = [base];
  if (/\p{Script=Arabic}/u.test(base)) {
    if (/(?:تي|تنا)$/u.test(base)) values.push(base.replace(/(?:تي|تنا)$/u, 'ه'));
    for (const suffix of ['ها', 'هم', 'نا', 'ه', 'ي']) if (base.endsWith(suffix) && base.length - suffix.length >= 3) values.push(base.slice(0, -suffix.length));
    if (base.endsWith('ت')) values.push(`${base.slice(0, -1)}ه`);
  } else if (base.endsWith('s') && base.length > 4) values.push(base.slice(0, -1));
  return [...new Set(values)];
}

function words(text: string) { return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []; }
function fieldFor(word: string) { return forms(word).map(form => propertyByWord.get(form)).find(Boolean); }

function properties(text: string): string[] {
  const normalized = normalize(text);
  const found = words(text).flatMap(word => fieldFor(word) ?? []);
  if (/\bhow many\b|\bnumber of\b|(?:^|\s)كم عدد(?=\s|$)/u.test(normalized)) {
    found.push('quantity');
    if (/\bnumber of\b/u.test(normalized)) return [...new Set(found.filter(field => field !== 'identifier'))];
  }
  return [...new Set(found)];
}

function subjectTerms(text: string): string[] {
  return [...new Set(words(text).flatMap(word => {
    if (STOP.has(word) || forms(word).some(form => STOP.has(form)) || fieldFor(word)) return [];
    const known = forms(word).map(form => subjectByWord.get(form)).find(Boolean);
    const base = forms(word)[0];
    return [known ?? (/\p{Script=Arabic}/u.test(base) && base.length > 3 ? base.replace(/ه$/u, '') : base)];
  }))];
}

function stripPresentation(text: string): string {
  // Presentation clauses cannot add a second requested fact such as "number"
  // when the owner asked for a monetary amount and then said "number only".
  return text.replace(/\bas (?:a |an )?(?:string|number|integer|text)\b/giu, ' ')
    .replace(/(?:[.!?؟,،;؛]\s*|\s+)(?:(?:return|reply|respond|output|give|write)\s+(?:the\s+)?(?:number|value|result)\s+only|(?:اذكر|[اأإ]عطني|[اأإ]جب|[اأإ]عد|اكتب|ارجع)\s+(?:الرقم|القيمه|القيمة|الناتج)\s+(?:فقط|وحده|وحدها|لا غير))[.!?؟]*/giu,
      (match, index: number) => properties(text.slice(0, index)).length ? ' ' : match);
}

function stripMemoryReadPrefix(text: string): string {
  // Retrieval verbs and their reading-purpose complement are scaffolding only
  // at the start of an explicit memory lookup, not global subject stop words.
  const body = normalize(text);
  return body.replace(/^(?:(?:من فضلك|لو سمحت|رجاء)[،,\s]+)?(?:(?:استرجع|استخرج|راجع|ذكرني|ابحث|فتش)\s+(?:لي\s+)?(?:من|في)\s+(?:ذاكرتي|الذاكره المحفوظه)|(?:ارجع|عد)\s+الي\s+ذاكرتي)(?:\s+ل(?:قراءه|استرجاع|معرفه))?\s*/u, '');
}

/** A presentation-key alias must not turn the temporal modifier اليوم into a requested fact. */
export function recallOutputFieldKey(key: string): string {
  return /^(?:اليوم|يوم|day|weekday)$/u.test(normalize(key)) ? 'date' : key;
}

type Requirement = { property: string | null; subject: string[] };
function semanticRequirements(body: string, contextTopic?: string): Requirement[] {
  body = stripMemoryReadPrefix(body);
  const currentProperties = properties(body);
  const inheritedProperties = contextTopic ? properties(contextTopic) : [];
  const wanted = currentProperties.length ? currentProperties : inheritedProperties;
  const currentSubject = subjectTerms(body);
  const inheritedSubject = contextTopic ? subjectTerms(contextTopic) : [];
  const sharedSubject = currentSubject.length ? currentSubject : inheritedSubject;
  if (!wanted.length) return [{ property: null, subject: sharedSubject }];
  const clauses = body.split(/\s+(?:and|&)\s+|\s+و(?=اسم|عنوان|موقع|رمز|ميزاني|سع|موعد|تاريخ|لون|رقم|مدين)/iu);
  if (clauses.length > 1) {
    const explicit = clauses.flatMap(clause => {
      const fields = properties(clause);
      const localSubject = subjectTerms(clause);
      return fields.map(property => ({ property, subject: localSubject.length ? localSubject : sharedSubject }));
    });
    if (explicit.length) return explicit;
  }
  return wanted.map(property => ({ property, subject: sharedSubject }));
}

/** Keep the requested fact/topic, excluding JSON keys and their type hints. */
function jsonSemanticBody(request: string): string {
  const json = [...request.matchAll(/\bjson\b/giu)].at(-1);
  let body = request;
  if (json) {
    // Match the existing format parser's declaration boundary; quoted key names
    // describe output labels, not additional primary entities.
    const after = request.slice(json.index + json[0].length);
    const declaration = /\b(?:keys?|fields?|properties)\b|(?<!\p{L})ب?(?:ال)?(?:مفاتيح|مفتاح(?:ين|ان)?|حقول|حقل(?:ين|ان)?|خصائص)(?!\p{L})/iu.exec(after);
    if (declaration) body = request.slice(0, json.index + json[0].length + declaration.index);
  }
  return stripPresentation(body)
    .replace(/\b(?:json\s+(?:as\s+(?:an?|the)\s+)?(?:object|array)|(?:object|array)\s+(?:in\s+)?json)\b|(?<!\p{L})(?:كائن|مصفوف[ةه])\s+(?:بصيغ[ةه]\s+)?json\b/giu, ' ')
    .replace(/\bjson\b/giu, ' ');
}

const sameSubject = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(term => right.includes(term));
const compatibleSubject = (left: readonly string[], right: readonly string[]) => left.every(term => right.includes(term)) || right.every(term => left.includes(term));

function requirements(request: string, contextTopic?: string): Requirement[] | null {
  // A closed current self-preference question cannot be broadened by context,
  // titles, quoted instructions, or a generic language-valued field.
  if (recognizePreferredLanguageRequest(request)) return [{ property: 'preferred_language', subject: ['self'] }];
  const format = memoryRecallFormat(request);
  if (format?.kind !== 'json' || !format.keys?.length) return semanticRequirements(stripPresentation(request), contextTopic);
  const primary = semanticRequirements(jsonSemanticBody(request));
  const inherited = contextTopic ? subjectTerms(jsonSemanticBody(contextTopic)) : [];
  const keys = format.keys.flatMap<Requirement>(key => {
    const semanticKey = recallOutputFieldKey(key);
    const fields = properties(semanticKey), subject = subjectTerms(semanticKey);
    return fields.length ? fields.map(property => ({ property, subject })) : [{ property: null, subject }];
  });
  const primaryProperties = primary.flatMap(item => item.property ?? []);
  // A format key cannot silently replace a different currently requested fact.
  if (primaryProperties.some(property => !keys.some(key => key.property === property))) return null;
  const matchedPrimary = new Set<number>();
  const bound: Requirement[] = [];
  for (const key of keys) {
    const relevant = primary.flatMap((item, index) => (item.property === null || item.property === key.property) && item.subject.length ? [{ ...item, index }] : []);
    if (!relevant.length) {
      // Explicit current key subjects override only inherited context. A generic
      // key instead inherits the prior topic when no current subject exists.
      bound.push({ property: key.property, subject: key.subject.length ? key.subject : inherited });
      continue;
    }
    const compatible = key.subject.length ? relevant.filter(item => compatibleSubject(item.subject, key.subject)) : relevant;
    if (!compatible.length || compatible.some(item => !sameSubject(item.subject, compatible[0]!.subject))) return null;
    compatible.forEach(item => matchedPrimary.add(item.index));
    bound.push({ property: key.property, subject: [...new Set([...compatible[0]!.subject, ...key.subject])] });
  }
  // Different current entities must each have a field. Never pick the first
  // entity or collapse both into one generic JSON key.
  if (primary.some((item, index) => item.subject.length && !matchedPrimary.has(index))) return null;
  return bound;
}

const COPULA = /\s+(?:(?:is|are|was|were|has|have|equals|weighs|measures)\s+|(?:هو|هي|هما|يبلغ|تبلغ|بلغ|يساوي|تساوي|كان|كانت)\s+)/iu;
const RECORD_DATE = /^\d{4}-\d{2}-\d{2}\s*[:–—]\s*/u;
const INSTRUCTION = /\b(?:ignore|disregard|override|bypass)\b[^.!?؟]*(?:instructions?|prompt|system|developer|user)|^(?:system|developer|assistant)\s*:|(?:تجاهل|تخط|تجاوز)[^.!?؟]*(?:التعليمات|الطلب|السابق)/iu;
// A number mentioned in a denial, estimate or bound is not an exact asserted
// value. Apply this at the shared evidence boundary so both local recall and
// verification of a model's scalar/JSON proposal retain the same restriction.
const NUMERIC_QUALIFIER = /(?<![\p{L}\p{N}_-])(?:not|no|never|(?:isn|aren|wasn|weren)['’]t|less than|fewer than|more than|greater than|at least|at most|up to|over|under|about|around|approximately|roughly|nearly|between|minimum|maximum|or fewer|or less|or more|if|unless|maybe|perhaps|ليس|ليست|لا|لم|لن|غير|اقل من|اكثر من|علي الاقل|علي الاكثر|بحد ادني|بحد اقصي|حوالي|نحو|تقريبا|قرابه|بين|ربما|قد|اذا|لو|بشرط)(?![\p{L}\p{N}_-])/u;
const NUMERIC_BOUND = /[<>≤≥≠≈~]|\p{Nd}\s*(?:[-–—]|to|الي|الى)\s*[+-]?\p{Nd}/u;
const NUMERIC_PROPERTIES = new Set(['budget', 'amount', 'price', 'capacity', 'quantity', 'length', 'duration']);

function qualifiedNumericAssertion(quote: string): boolean {
  const relation = COPULA.exec(quote), colon = quote.indexOf(':');
  const value = normalize(relation ? quote.slice(relation.index + relation[0].length) : colon >= 0 ? quote.slice(colon + 1) : quote);
  return /\p{Nd}/u.test(value) && (NUMERIC_QUALIFIER.test(value) || NUMERIC_BOUND.test(value));
}
export interface RecallFactAtom {
  property: 'quantity' | 'date';
  value: string;
  valueSpan: { start: number; end: number };
  subject: string[];
}
type RecallFactAtoms = { kind: 'none' | 'unsupported'; atoms: [] } | { kind: 'atoms'; atoms: RecallFactAtom[] };
/** Literal atoms from one complete bounded statement; no synthesized source quote. */
export function extractRecallFactAtoms(quote: string): RecallFactAtoms {
  if (!/^عدد\s/u.test(quote) || !/\p{Nd}/u.test(quote)) return { kind: 'none', atoms: [] };
  const unsupported: RecallFactAtoms = { kind: 'unsupported', atoms: [] };
  if (quote.length > 320 || /(?:^|\s)(?:اذا|لو|بشرط|لكن|الا|ليس|ليست|لا|لم|لن|غير|بدون|بدل|بدلا|عدا|باستثناء|ربما|قد|يمكن)(?=\s|$)/u.test(normalize(quote))) return unsupported;
  if (/(?:^|\s)(?:(?:اكثر|اقل)\s+من|علي\s+(?:الاقل|الاكثر)|حوالي|نحو|تقريبا|قرابه)(?=\s|$)/u.test(normalize(quote))) return unsupported;
  const match = /^عدد\s+([\p{L}\p{M}][\p{L}\p{M} -]{0,180}?)\s+([\p{Nd}]+)(?:\s+و(?:موعد|تاريخ)\s+تسليم(?:ها|ه)\s+([\p{L}\p{M}]+))?[.!؟?]?$/u.exec(quote);
  if (!match) return unsupported;
  const [, label, quantity, day] = match;
  if (day && !/^(?:الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|الاحد)$/u.test(normalize(day))) return unsupported;
  const subject = subjectTerms(label!);
  if (!subject.length) return unsupported;
  const start = quote.indexOf(quantity!, quote.indexOf(label!) + label!.length);
  if (start < 0) return unsupported;
  const atoms: RecallFactAtom[] = [{ property: 'quantity', value: quantity!, valueSpan: { start, end: start + quantity!.length }, subject }];
  if (day) {
    const dayStart = quote.lastIndexOf(day);
    atoms.push({ property: 'date', value: day, valueSpan: { start: dayStart, end: dayStart + day.length }, subject: [...subject] });
  }
  return { kind: 'atoms', atoms };
}

interface EvidenceScope {
  fields: string[];
  subject: Set<string>;
  explicitSubject: Set<string>;
  atoms?: { property: string; subject: Set<string>; explicitSubject: Set<string> }[];
}
function evidenceScope(item: RecallCoverageEvidence): EvidenceScope | null {
  // Only a host-labelled memory quote can provide this special self field.
  // The leaf preserves the source statement/value bytes and rejects other
  // owners, programming/client fields, reports, and literal command bodies.
  const preference = item.source === 'memory' ? parsePreferredLanguageFact(item.quote) : null;
  if (preference) return { fields: [preference.property], subject: new Set([preference.subject]), explicitSubject: new Set([preference.subject]) };
  const quote = item.quote.replace(RECORD_DATE, '');
  const literal = extractRecallFactAtoms(quote);
  if (literal.kind === 'unsupported') return null;
  if (literal.kind === 'atoms') {
    const atoms = literal.atoms.map(atom => ({ property: atom.property, subject: new Set(atom.subject), explicitSubject: new Set(atom.subject) }));
    return { fields: atoms.map(atom => atom.property), subject: new Set(literal.atoms.flatMap(atom => atom.subject)),
      explicitSubject: new Set(literal.atoms.flatMap(atom => atom.subject)), atoms };
  }
  const relation = COPULA.exec(quote);
  const colon = quote.indexOf(':');
  const label = relation ? quote.slice(0, relation.index) : colon >= 0 ? quote.slice(0, colon) : quote;
  const fields = properties(label);
  const tail = relation ? quote.slice(relation.index + relation[0].length) : '';
  if (/^(?:located|based|situated)\s+(?:in|at)\b/iu.test(tail)) fields.push('location');
  if (!fields.length && /\b(?:has|have)\s+\d+\b|(?:يضم|تضم)\s+[\d٠-٩]+/iu.test(quote)) fields.push('quantity');
  if (!fields.length && /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|(?:الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|الاحد)/iu.test(normalize(quote))) fields.push('date');
  if (!fields.length && /\b\d{1,2}:\d{2}\b/u.test(quote)) fields.push('time');
  // Numeric bounds have meaning for quantities, not opaque identifiers, ISO
  // dates or addresses whose literal value can also contain digits and dashes.
  if (fields.some(field => NUMERIC_PROPERTIES.has(field)) && qualifiedNumericAssertion(quote)) return null;
  const explicitSubject = subjectTerms(label);
  const scope = [...explicitSubject, ...subjectTerms(item.title ?? '')];
  if (fields.includes('quantity') || fields.includes('capacity')) scope.push(...subjectTerms(quote));
  return { fields: [...new Set(fields)], subject: new Set(scope), explicitSubject: new Set(explicitSubject) };
}

/** Source alignment alone is insufficient: every requested field needs matching subject evidence. */
export function assessRecallCoverage(request: string, evidence: readonly RecallCoverageEvidence[], options: RecallCoverageOptions = {}): RecallCoverage {
  const empty: RecallCoverage = { status: 'unknown', requestedProperties: [], coveredProperties: [], missingProperties: [], subjectTerms: [], matchedEvidenceIndices: [], matches: [] };
  if (!request.trim() || request.length > MAX_REQUEST || evidence.length > MAX_EVIDENCE
    || options.contextTopic && options.contextTopic.length > MAX_REQUEST
    || evidence.some(item => typeof item.quote !== 'string' || item.quote.length > 4000 || item.title && item.title.length > 500)) return empty;
  const wanted = requirements(request, options.contextTopic);
  if (!wanted) return empty;
  const subjects = [...new Set(wanted.flatMap(item => item.subject))];
  if (wanted.length > MAX_PROPERTIES || subjects.length > MAX_SUBJECT_TERMS) return empty;
  const scopes = evidence.map(item => INSTRUCTION.test(item.quote) || item.title && INSTRUCTION.test(item.title) ? null : evidenceScope(item));
  const matches = wanted.map(requirement => ({
    property: requirement.property ?? 'unspecified',
    evidenceIndices: scopes.flatMap((scope, index) => {
      if (!scope || requirement.property && !scope.fields.includes(requirement.property)) return [];
      // Document scope may fill an omitted subject, but must not overwrite an
      // explicit different entity in the quoted sentence (North Hall vs South
      // Hall, or an office address inside a warehouse handbook).
      const alignments = scope.atoms && requirement.property ? scope.atoms.filter(atom => atom.property === requirement.property) : [scope];
      return alignments.some(alignment => {
        if (!requirement.subject.every(term => alignment.subject.has(term))) return false;
        const metadataNeeded = requirement.subject.some(term => !alignment.explicitSubject.has(term));
        return !(metadataNeeded && requirement.subject.length && [...alignment.explicitSubject].some(term => !requirement.subject.includes(term)));
      }) ? [index] : [];
    }),
  }));
  const requested = [...new Set(wanted.flatMap(item => item.property ?? []))];
  const covered = requested.filter(property => matches.filter(item => item.property === property).every(item => item.evidenceIndices.length > 0));
  const matched = [...new Set(matches.flatMap(item => item.evidenceIndices))];
  const all = matches.length > 0 && matches.every(item => item.evidenceIndices.length > 0);
  return { status: !requested.length ? matched.length ? 'unknown' : 'missing' : all ? 'complete' : matched.length ? 'partial' : 'missing',
    requestedProperties: requested, coveredProperties: covered, missingProperties: requested.filter(item => !covered.includes(item)),
    subjectTerms: subjects, matchedEvidenceIndices: matched, matches };
}
