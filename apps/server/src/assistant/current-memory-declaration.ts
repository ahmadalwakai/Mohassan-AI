import { createHash } from 'node:crypto';
import { asksToRemember, deniesMemoryWrite } from './brain.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { maskRequestLiteralData, parseUserRequestConstraints, requestCapabilityAllowed } from './request-constraints.js';

export type CurrentMemoryDeclarationReason = 'invalid_input' | 'not_affirmative' | 'request_constraint' | 'source_or_reference'
  | 'credential_material' | 'sequence_or_condition' | 'unsupported_declaration';
export type CurrentMemoryDeclarationScan = { status: 'rejected'; reason: CurrentMemoryDeclarationReason }
  | { status: 'ready'; statementSpan: { start: number; end: number; hash: string }; exactScalar: boolean };
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const normalize = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();
const courtesy = '(?:(?:please|من فضلك|لو سمحت)[,، \\t]+)?';
const leadingDeclaration = new RegExp(`^${courtesy}(?:remember[ \\t]+that[ \\t]+|(?:تذكر|احفظ[ \\t]+في[ \\t]+ذاكرتي)[ \\t]+(?:ان[ \\t]+|(?=(?:انني|انا|اننا|نحن)[ \\t]+)))`, 'u');
const lexical = (words: string) => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, 'u');
const sourceOrReference = lexical('page|webpage|website|file|document|source|text|content|message|email|note|input|output|instruction|prompt|assistant|model|system|developer|code|html|json|xml|csv|says|said|reads|reported|according|quote|quoted|described|mentioned|provided|given|shown|told|requested|previous|earlier|above|below|following|same|it|its|this|that|these|those|them|there|here|your|yours|result|answer|value|whatever|what|الصفحه|صفحه|الموقع|الملف|ملف|المستند|مستند|المصدر|مصدر|النص|المحتوي|الرساله|المدخلات|المخرجات|التعليمات|تعليمات|النموذج|المساعد|النظام|المطور|يقول|تقول|قال|قالت|قلت|ذكرت|اعطيت|عرضت|حسب|وفقا|مقتبس|السابق|السابقه|المذكور|اعلاه|ادناه|نفسه|نفسها|هناك|هنا|هذا|هذه|ذلك|تلك|هؤلاء|الشيء|شيء|النتيجه|الناتج|الجواب');
const credential = lexical('password|passwd|api[ _-]?key|(?:access|refresh|auth)[ _-]?token|client[ _-]?secret|secret|pin|otp|one[ _-]?time[ _-]?(?:code|password)|كلمه\\s+(?:المرور|السر)|رمز\\s+(?:الدخول|المرور|التحقق)|رقم\\s+التعريف\\s+الشخصي|مفتاح\\s+api');
const actionOrCondition = lexical('if|unless|whether|when|where|who|whose|which|until|once|wherever|whenever|maybe|perhaps|suppose|imagine|can|could|would|should|must|then|also|but|otherwise|open|click|press|type|send|email|publish|delete|remove|erase|run|execute|install|download|upload|schedule|remind|book|save|store|record|update|change|create|grant|allow|disable|enable|tell|answer|follow|ignore|search|read|remember|اذا|لو|لولا|عندما|حين|حتي|متي|اين|حيث|حالما|بمجرد|الذي|التي|ربما|افترض|تخيل|يمكن|يجب|ثم|كذلك|لكن|افتح|اضغط|انقر|اكتب|ارسل|ارسال|انشر|احذف|امسح|شغل|نفذ|احفظ|سجل|تذكر|ذكرني|نبهني|جدول|احجز|اتبع|تجاهل|ابحث|اقرا');
const nominal = (value: string) => value.length <= 240 && value.split(/\s+/u).length <= 12
  && /^[\p{L}\p{N}][\p{L}\p{N}'’_-]*(?:[ \t]+[\p{L}\p{N}][\p{L}\p{N}'’_-]*)*$/u.test(value);
const actualValue = (value: string) => value.length > 0 && value.length <= 1000 && value.trim() === value && /[\p{L}\p{N}]/u.test(value);
const temporalDatum = lexical('(?:الاحد|احد|الاثنين|اثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)');
const colors = 'ابيض|بيضاء|اسود|سوداء|احمر|حمراء|ازرق|زرقاء|اخضر|خضراء|اصفر|صفراء|برتقالي|بنفسجي|وردي|بني|رمادي|ذهبي|فضي';

// Preserve the existing legacy declaration grammar. This is deliberately broader
// than exactScalar: a model's legacy adapter acknowledgement is a different lane.
function declaration(body: string): boolean {
  const englishNominal = /^(my|our|the) (.+?) (is|are|was|were) (.+)$/u.exec(body);
  if (englishNominal) return nominal(englishNominal[2]!) && actualValue(englishNominal[4]!);
  const englishSelf = /^i (?:am|prefer|live in|work at|speak|have) (.+)$/u.exec(body);
  if (englishSelf) return actualValue(englishSelf[1]!);
  const arabicSelf = /^(?:انني|انا|اننا|نحن) (?:افضل|اعيش في|اعمل في|اتحدث|لدي) (.+)$/u.exec(body);
  if (arabicSelf) return actualValue(arabicSelf[1]!);
  const arabicCopula = /^(.+?) (?:هو|هي) (.+)$/u.exec(body);
  if (arabicCopula) return nominal(arabicCopula[1]!) && actualValue(arabicCopula[2]!);
  const arabicTime = /^(.+?) (?:في|كل|يوم|الساعه|اول) (.+)$/u.exec(body);
  if (arabicTime) return nominal(arabicTime[1]!) && actualValue(arabicTime[2]!)
    && (/[0-9٠-٩۰-۹]/u.test(arabicTime[2]!) || temporalDatum.test(arabicTime[2]!));
  const arabicScalar = new RegExp(`^(.+?) (${colors}|[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?|[a-z]{1,8}-?[0-9٠-٩۰-۹]{1,12})$`, 'u').exec(body);
  return !!arabicScalar && /\p{Script=Arabic}/u.test(arabicScalar[1]!) && nominal(arabicScalar[1]!);
}

const coordination = lexical('and|or|nor|plus|و|او');
const unresolvedAtom = /^(?:i|me|my|mine|myself|we|us|our|ours|ourselves|you|your|yours|yourself|yourselves|he|him|his|himself|she|her|hers|herself|it|its|itself|they|them|their|theirs|themselves|oneself|this|that|these|those|unknown|unavailable|unspecified|somewhere|something|someone|somebody|هو|هي|هما|هم|هن|انت|انتي|انتم|انتما|انتن|انا|نحن|اياي|ايانا|اياك|اياكم|اياه|اياها|اياهم|اياهن|اياهما|نفسي|انفسنا|انفسهم|لي|لنا|له|لها|لهم|لك|لكم|مجهول|مجهوله)$/u;
// Reject unresolved possessives only in the native subset. Do not apply a broad
// Arabic suffix ban: ordinary literal places such as أبها must stay eligible.
const nominalReferenceAtom = /^(?:مدين(?:ه|ت)|مكان|بلد(?:ه|ت)?|عنوان|اسم|موعد|منزل|بيت|موطن)(?:ه|ها|هما|هم|هن)$/u;
const atom = (value: string) => value.length <= 80 && !unresolvedAtom.test(value) && !nominalReferenceAtom.test(value)
  && !/['’]s$/u.test(value) && (/^[\p{L}\p{N}][\p{L}\p{N}'’_-]*$/u.test(value)
  || /^[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?$/u.test(value));
const singleSubject = (value: string) => nominal(value) && !coordination.test(value)
  && !value.split(' ').some((word, index) => index > 0 && word.startsWith('و'));
function exactScalar(body: string, originalBody: string): boolean {
  if (coordination.test(body) || /[!,،]/u.test(body) || normalize(originalBody).endsWith('!')) return false;
  const englishNominal = /^(?:my|our|the) (.+?) (?:is|are) (\S+)$/u.exec(body);
  if (englishNominal) return singleSubject(englishNominal[1]!) && atom(englishNominal[2]!);
  const englishSelf = /^i (?:am|prefer|live in|work at|speak|have) (\S+)$/u.exec(body);
  if (englishSelf) return atom(englishSelf[1]!);
  const arabicCopula = /^(.+?) (?:هو|هي) (\S+)$/u.exec(body);
  if (arabicCopula) return singleSubject(arabicCopula[1]!) && atom(arabicCopula[2]!);
  const arabicSelf = /^(?:انني|انا|اننا|نحن) (?:افضل|اعيش في|اعمل في|اتحدث|لدي) (\S+)$/u.exec(body);
  return !!arabicSelf && atom(arabicSelf[1]!);
}

/**
 * Bounded original-user syntax only, never permission, model payload or memory
 * proof. Callers must bind raw bytes to trusted host input and retain every
 * account, quota, scrub and execution fence. No factory/availability dependency.
 */
export function scanCurrentMemoryDeclaration(raw: unknown): CurrentMemoryDeclarationScan {
  const reject = (reason: CurrentMemoryDeclarationReason): CurrentMemoryDeclarationScan => ({ status: 'rejected', reason });
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 4000 || /[\u0000\ud800-\udfff]/u.test(raw)) return reject('invalid_input');
    if (!asksToRemember(raw) || deniesMemoryWrite(raw)) return reject('not_affirmative');
    if (!requestCapabilityAllowed(parseUserRequestConstraints(raw), 'memory_write')) return reject('request_constraint');
    if (maskRequestLiteralData(raw) !== raw || /https?:\/\/|[<>\[\]{}]|\/\*|\*\/|(?:^|\s)\/\//iu.test(raw)) return reject('source_or_reference');
    if (analyzeCompoundRequest(raw).kind !== 'single') return reject('sequence_or_condition');
    let matching = '', offset = 0;
    const ends: number[] = [];
    for (const point of raw) {
      const normalized = normalize(point); matching += normalized;
      for (let index = 0; index < normalized.length; index++) ends.push(offset + point.length);
      offset += point.length;
    }
    const prefix = leadingDeclaration.exec(matching);
    if (!prefix) return reject('unsupported_declaration');
    const start = ends[prefix[0].length - 1]!;
    const originalBody = raw.slice(start), body = normalize(originalBody).replace(/[.!]$/u, '').replace(/[ \t]+/gu, ' ');
    if (!body || body.length > 1500 || body.trim() !== body || body.split(/\s+/u).length > 80) return reject('unsupported_declaration');
    if (credential.test(body)) return reject('credential_material');
    if (sourceOrReference.test(body)) return reject('source_or_reference');
    if (actionOrCondition.test(body) || /[?؟;؛!\r\n]|(?<!\d)\.|\.(?!\d)/u.test(body)) return reject('sequence_or_condition');
    if (!declaration(body)) return reject('unsupported_declaration');
    return { status: 'ready', statementSpan: { start, end: raw.length, hash: hash(originalBody) }, exactScalar: exactScalar(body, originalBody) };
  } catch { return reject('invalid_input'); }
}
