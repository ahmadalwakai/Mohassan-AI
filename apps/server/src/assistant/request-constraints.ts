import { z } from 'zod';
import type { LocalReply } from './mind/limits.js';

/** Current outer-user prohibitions. Absence of a prohibition never grants authority. */
export const forbiddenRequestCapabilities = ['public_search', 'browser_navigation', 'browser_action', 'memory_read', 'memory_write', 'knowledge_read', 'computer_read', 'computer_action'] as const;
export type ForbiddenRequestCapability = (typeof forbiddenRequestCapabilities)[number];
const Span = z.object({ start: z.number().int().min(0).max(8000), end: z.number().int().min(1).max(8000) }).strict().refine(value => value.end > value.start);
const Capabilities = z.array(z.enum(forbiddenRequestCapabilities)).max(forbiddenRequestCapabilities.length);
export const UserRequestConstraintsSchema = z.object({
  version: z.literal(1), forbiddenCapabilities: Capabilities,
  prohibitions: z.array(z.object({ capabilities: Capabilities, span: Span }).strict()).min(1).max(12),
  standalone: z.boolean(), ambiguous: z.boolean(), safeActionText: z.string().min(1).max(8000).nullable(), positiveSpan: Span.optional(),
}).strict().superRefine((value, context) => {
  if ((value.standalone || value.ambiguous) && (value.safeActionText !== null || value.positiveSpan)) context.addIssue({ code: 'custom', message: 'A standalone or ambiguous constraint cannot supply an action.' });
  if ((value.safeActionText === null) !== (value.positiveSpan === undefined)) context.addIssue({ code: 'custom', message: 'An action and its original span must exist together.' });
  if (new Set(value.forbiddenCapabilities).size !== value.forbiddenCapabilities.length) context.addIssue({ code: 'custom', message: 'Prohibitions must be unique.' });
});
export type UserRequestConstraints = z.infer<typeof UserRequestConstraintsSchema>;

const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim();
const leadText = (text: string) => fold(text).replace(/^(?:(?:please|kindly|من فضلك|لو سمحت|طيب|طب|حسنا|تمام|okay|ok|well)[,،:\s]+)+/u, '');
const LITERAL = /```[\s\S]*?(?:```|$)|`(?:\\.|[^`\\\r\n])*(?:`|$)|«[^»]*(?:»|$)|“[^”]*(?:”|$)|"(?:\\.|[^"\\\r\n])*(?:"|$)|(?<![\p{L}\p{N}])['‘](?:\\.|[^'’\\\r\n])*['’](?![\p{L}\p{N}])/gu;
const REPORT_LEAD = /^(?:(?:the|this|a)\s+)?(?:note|document|file|page|email|message|quote|text)\s+(?:says|reads|contains|states|includes)\b|^(?:النص|الرساله|الصفحه|الملف|المستند|الملاحظه)\s+(?:يقول|تقول|يحتوي|تحتوي|مكتوب)/iu;
const TRANSFORM_LEAD = /^(?:translate|rewrite|summari[sz]e|paraphrase|proofread|explain (?:this|the) (?:text|sentence)|describe\s+(?:(?:this|the|following|provided|supplied|attached|pasted)\s+){0,3}(?:text|sentence|phrase|message|paragraph|content)|ترجم|لخص|اعد صياغه|صحح|اشرح (?:النص|الجمله))\b|^(?:ترجم|لخص|اعد صياغه|صحح|اشرح (?:النص|الجمله)|صف\s+(?:(?:هذا|هذه)\s+)?(?:النص|الجمله|الرساله|الفقره))(?=\s|$)/iu;
const POSITIVE = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)?(?:what|who|when|where|why|how|which|is|are|does|do|can|will|search|look up|read|recall|retrieve|open|visit|navigate|write|draft|translate|describe|summari[sz]e|calculate|compute|convert|weather|news|i want to know)\b|^(?:ماهو|ماهي|ما|ماذا|كم|كيف|متي|اين|وين|من|مين|هل|اي|وش|شو|ايش|ابحث|دور|اقرا|استرجع|افتح|اكتب|ترجم|صف|لخص|احسب|حول|طقس|اخبار|اريد (?:معرفه|اعرف))(?=\s|$)/iu;
const REFERENCE = /\b(?:it|its|them|that|there|same)\b|(?:^|\s)(?:عنه|عنها|فيه|فيها|له|لها|نفسه|نفسها)(?=\s|[\p{P}]|$)/iu;
const NEGATIVE_HEAD = /^(?:(?:do not|don't|don’t|never|avoid|no|without)\s+|لا(?:\s+|(?=ت))|ممنوع\s+|بلاش\s+|ما\s*(?=ت)|تجنب\s+|بدون\s+|دون\s+)/iu;

/** Same-length matching view: literal/data instructions cannot become host commands. */
export function maskRequestLiteralData(text: string): string {
  let masked = text.replace(LITERAL, value => ' '.repeat(value.length));
  for (const found of masked.matchAll(/[:：]/gu)) {
    const before = masked.slice(0, found.index);
    if (/https?(?::\/\/\S*)?$/iu.test(before)) continue;
    const boundary = Math.max(before.lastIndexOf(';'), before.lastIndexOf('؛'), before.lastIndexOf('\n'), before.lastIndexOf('،'), before.lastIndexOf(','));
    if (TRANSFORM_LEAD.test(leadText(before)) || TRANSFORM_LEAD.test(leadText(before.slice(boundary + 1)))) {
      masked = masked.slice(0, found.index + 1) + ' '.repeat(masked.length - found.index - 1); break;
    }
  }
  return masked;
}
function trimmedSpan(text: string, start: number, end: number) {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return { start, end };
}
/** Matching normalization with literal UTF-16 offsets, including expanding NFKC glyphs. */
function conjunctionSpans(original: string, masked: string, span: { start: number; end: number }): Array<{ start: number; end: number }> {
  let view = '', source = span.start;
  const offsets: number[] = [];
  for (const point of masked.slice(span.start, span.end)) {
    const normalized = point.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
      .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();
    view += normalized;
    for (let index = 0; index < normalized.length; index++) offsets.push(source);
    source += point.length;
  }
  const parts: Array<{ start: number; end: number }> = [];
  let start = span.start;
  for (const match of view.matchAll(/\b(?:and|or|nor)\s+|\s+(?:او|و)\s*/giu)) {
    const after = match.index + match[0].length;
    if (!NEGATIVE_HEAD.test(leadText(view.slice(after)))) continue;
    const boundary = offsets[match.index] ?? span.end, next = offsets[after] ?? span.end;
    const before = trimmedSpan(original, start, boundary);
    if (before.end <= before.start || next <= start || next >= span.end) continue;
    parts.push(before); start = next;
  }
  const last = trimmedSpan(original, start, span.end);
  if (last.end > last.start) parts.push(last);
  return parts;
}

type ProhibitedTarget = { kind: 'memory' | 'knowledge' | 'computer' | 'web' | null; marked: boolean; tail: string };
function prohibitedTarget(operand: string): ProhibitedTarget {
  const source = operand.replace(/^(?:(?:in|inside|within|through|from|to|في|داخل|ضمن|عبر|من|الى|الي|علي)\s+)+/u, '')
    .replace(/^(?:(?:my|your|our|the|a|an|any|all|local)\s+)+/u, '');
  const targets = [
    ['memory', /^(?:memory|memories|saved notes|saved records|previous conversation|ذاكرتي|ذاكرتك|الذاكره|ذاكره|ملاحظاتي|ملاحظات|سجلاتي|الملاحظات المحفوظه|السجلات المحفوظه)(?=\s|$)/u],
    ['knowledge', /^(?:documents?|files?|knowledge|المستندات|المستند|مستند|الوثائق|الوثيقه|وثيقه|الملفات|الملف|ملف|المعرفه|مستنداتي|ملفاتي|وثائقي)(?=\s|$)/u],
    ['computer', /^(?:computer|pc|desktop|terminal|screen|window|folder|notepad|جهازي|الكمبيوتر|الحاسوب|الشاشه|سطح المكتب|طرفيه|المجلد|مجلد|النافذه|نافذه)(?=\s|$)/u],
    ['web', /^(?:web|internet|browser|browsing|website|site|webpage|web page|الويب|الانترنت|المتصفح|الموقع|موقع|الصفحه|صفحه)(?=\s|$)/u],
  ] as const;
  for (const [kind, pattern] of targets) {
    const matched = pattern.exec(source);
    if (matched) return { kind, marked: source !== operand, tail: source.slice(matched[0].length).trim() };
  }
  return { kind: null, marked: source !== operand, tail: source };
}
function searchProhibition(operation: string): ForbiddenRequestCapability[] {
  const operand = operation.replace(/^(?:search|look up|تبحث|تدور|تفتش|البحث|بحث)(?=\s|$)/u, '').trim();
  // A source is the immediate operand, not a noun appearing later in the query.
  // "search the web for memory techniques" must retain its public-search veto.
  const target = prohibitedTarget(operand);
  if (target.kind === 'memory' || target.kind === 'knowledge') {
    const privateRead = target.kind === 'memory' ? 'memory_read' as const : 'knowledge_read' as const;
    return target.marked || !target.tail || /^(?:for|about|regarding|عن|حول)(?=\s|$)/u.test(target.tail)
      ? [privateRead] : ['public_search', privateRead];
  }
  // An explicit private object following "for" has ambiguous search scope.
  // Veto both lookups rather than silently allowing the private read.
  if (/^for\s+(?:my|your|our)\s+(?:memory|memories|saved notes|saved records|previous conversation)(?=\s|$)/u.test(operand)) return ['public_search', 'memory_read'];
  return ['public_search'];
}
function prohibition(clause: string): ForbiddenRequestCapability[] | null {
  const text = leadText(clause);
  if (/^(?:do not|don't|don’t|never)\s+forget\b|^لا\s+تنس(?:ي)?(?=\s|$)/u.test(text)) return null;
  const prefix = /^(?:(?:do not|don't|don’t|never|avoid)\s+|لا\s+(?=ت)|لا(?=ت(?:بحث|فتح|ستخدم|حفظ|تصفح|كتب|قرا|ضغط|نقر|شغل|زور|خزن|سجل|سترجع))|ممنوع\s+|بلاش\s+|ما\s*(?=ت\p{L}*ش(?:\s|$))|تجنب\s+)/u.exec(text);
  const noun = /^(?:no|without)\s+(?=(?:web search|browsing|memory|computer access)\b)|^(?:بدون|دون)\s+(?=(?:بحث|تصفح|ذاكره|استخدام)(?=\s|$))/u.exec(text);
  if (!prefix && !noun) return null;
  let operation = text.slice((prefix ?? noun)![0].length);
  if (/^ما/u.test(prefix?.[0] ?? '')) operation = operation.replace(/^(ت\p{L}*)ش(?=\s|$)/u, '$1');
  operation = operation.replace(/^(searching|browsing|opening|using|reading|saving|storing|accessing)(?=\s|$)/u, word => ({ searching: 'search', browsing: 'browse', opening: 'open', using: 'use', reading: 'read', saving: 'save', storing: 'store', accessing: 'access' })[word]!);
  const computer = /\b(?:computer|pc|desktop|terminal|screen|window|file|folder)\b|(?:جهازي|الكمبيوتر|الحاسوب|الشاشه|سطح المكتب|طرفيه|الملف)/u.test(operation);
  if (/^(?:search|look up|تبحث|تدور|تفتش|البحث|بحث)(?=\s|$)/u.test(operation)) return searchProhibition(operation);
  if (/^(?:browse|browsing|تتصفح|تصفح)(?=\s|$)/u.test(operation)) return ['public_search', 'browser_navigation', 'browser_action'];
  if (/^(?:open|visit|navigate|launch|تفتح|تزور|تشغل)(?=\s|$)/u.test(operation)) {
    const target = prohibitedTarget(operation.replace(/^(?:open|visit|navigate|launch|تفتح|تزور|تشغل)(?=\s|$)/u, '').trim());
    return target.kind === 'computer' || target.kind === 'knowledge' ? ['computer_action']
      : target.kind === 'web' ? ['browser_navigation'] : ['browser_navigation', 'computer_action'];
  }
  if (/^(?:click|press|type|submit|تضغط|تنقر|تكتب)(?=\s|$)/u.test(operation)) return ['browser_action', 'computer_action'];
  if (/^(?:save|store|record|remember|تحفظ|تخزن|تسجل|تتذكر)(?=\s|$)/u.test(operation)) return ['memory_write', ...(computer ? ['computer_action' as const] : [])];
  if (/^(?:read|recall|retrieve|تقرا|تسترجع)(?=\s|$)/u.test(operation)) {
    const target = prohibitedTarget(operation.replace(/^(?:read|recall|retrieve|تقرا|تسترجع)(?=\s|$)/u, '').trim());
    return target.kind === 'memory' ? ['memory_read'] : target.kind === 'knowledge' ? ['knowledge_read'] : target.kind === 'computer' ? ['computer_read']
      : target.kind === 'web' ? ['public_search', 'browser_navigation', 'browser_action'] : [];
  }
  if (/^(?:use|access|consult|تستخدم|تستعمل|استخدام)(?=\s|$)/u.test(operation)
    || noun && /^(?:memory|ذاكره)(?=\s|$)/u.test(operation)) {
    const target = prohibitedTarget(operation.replace(/^(?:use|access|consult|تستخدم|تستعمل|استخدام)(?=\s|$)/u, '').trim());
    if (target.kind === 'memory') return ['memory_read', 'memory_write'];
    if (target.kind === 'knowledge') return ['knowledge_read'];
    if (target.kind === 'computer') return ['computer_read', 'computer_action'];
    if (target.kind === 'web') return ['public_search', 'browser_navigation', 'browser_action'];
  }
  return [];
}

function hasUnboundActionConjunction(clause: string): boolean {
  const text = fold(clause);
  if (/\b(?:but|then)\b|(?:^|\s)(?:لكن|ثم)(?=\s)/iu.test(text)) return true;
  for (const found of text.matchAll(/\b(?:and|or|nor)\s+|\s+(?:او|و)\s*/giu)) {
    const tail = leadText(text.slice(found.index + found[0].length));
    // Reuse the closed prohibition-operation vocabulary for a matching-only
    // check. These synthetic prefixes never become permissions or stored spans.
    if ((prohibition(`do not ${tail}`)?.length ?? 0) > 0 || (prohibition(`لا ${tail}`)?.length ?? 0) > 0) return true;
    // Additional effect/formatting heads are unsupported conjunctions here.
    // A noun coordination such as NASA and ESA remains an ordinary operand.
    if (/^(?:what|how|write|draft|describe|calculate|compute|convert|translate|summari[sz]e|delete|remove|erase|run|execute|close|send|email|mail|deliver|publish|post)(?!\p{L})/iu.test(tail)
      || /^(?:افتح|ابحث|دور|فتش|تصفح|اكتب|احسب|حول|ترجم|لخص|صف|اضغط|انقر|شغل|اغلق|اقرا|اعرض|احفظ|خزن|سجل|تذكر|استرجع|استخدم|احذف|امسح|نفذ|ارسل|انشر|ما|كيف)(?!\p{L})/u.test(tail)
      || /\b(?:do not|don't|don’t|never|avoid)\b|(?:^|\s)(?:لا|ممنوع|بلاش)(?=\s)/u.test(tail)) return true;
  }
  return false;
}

/** A bare literal carries data without an outer instruction. No operation is inferred. */
export function isEntireLiteralRequest(value: string): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) return false;
  const text = value.trim();
  const pair = text.startsWith('```') ? ['```', '```'] : ({ '"': ['"', '"'], "'": ["'", "'"], '‘': ['‘', '’'], '“': ['“', '”'], '«': ['«', '»'], '`': ['`', '`'] } as Record<string, string[]>)[text[0]!];
  if (!pair) return false;
  let end = -1;
  for (let index = pair[0]!.length; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text.startsWith(pair[1]!, index)) { end = index + pair[1]!.length; break; }
  }
  return end < 0 || /^[\s.!?؟]*$/u.test(text.slice(end));
}

/** Null means no outer imperative prohibition was recognized, not permission. */
export function parseUserRequestConstraints(original: string): UserRequestConstraints | null {
  if (typeof original !== 'string' || !original.trim() || original.length > 8000 || REPORT_LEAD.test(leadText(original))) return null;
  const masked = maskRequestLiteralData(original);
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of masked.matchAll(/[;؛!?؟،,\r\n]+|\.(?=\s|$)/gu)) {
    const span = trimmedSpan(original, start, match.index);
    if (span.end > span.start) segments.push(span);
    start = match.index + match[0].length;
  }
  const last = trimmedSpan(original, start, masked.length);
  if (last.end > last.start) segments.push(last);
  const prohibitions: UserRequestConstraints['prohibitions'] = [], positives: Array<{ start: number; end: number }> = [];
  let unsupported = false, ambiguousTail = false;
  for (const span of segments.flatMap(item => conjunctionSpans(original, masked, item))) {
    const capabilities = prohibition(masked.slice(span.start, span.end));
    if (capabilities !== null) {
      prohibitions.push({ capabilities, span }); unsupported ||= capabilities.length === 0;
      ambiguousTail ||= hasUnboundActionConjunction(masked.slice(span.start, span.end));
    }
    else positives.push(span);
  }
  if (!prohibitions.length) return null;
  const standalone = positives.length === 0;
  let positiveSpan: { start: number; end: number } | undefined;
  let safeActionText: string | null = null;
  if (positives.length === 1 && !unsupported) {
    const span = positives[0]!;
    const lead = /^(?:but|then|لكن|ثم)\s+/iu.exec(masked.slice(span.start, span.end));
    const candidate = { start: span.start + (lead?.[0].length ?? 0), end: span.end };
    const matching = fold(masked.slice(candidate.start, candidate.end));
    if (POSITIVE.test(matching) && !REFERENCE.test(matching)) { positiveSpan = candidate; safeActionText = original.slice(candidate.start, candidate.end); }
  }
  const result: UserRequestConstraints = { version: 1, forbiddenCapabilities: [...new Set(prohibitions.flatMap(item => item.capabilities))], prohibitions: prohibitions.slice(0, 12),
    standalone, ambiguous: !standalone && safeActionText === null || prohibitions.length > 12 || ambiguousTail, safeActionText, ...(positiveSpan ? { positiveSpan } : {}) };
  if (result.ambiguous) { result.safeActionText = null; delete result.positiveSpan; }
  return UserRequestConstraintsSchema.parse(result);
}

/** A veto only; true does not establish tool permission or task authority. */
export function requestCapabilityAllowed(value: UserRequestConstraints | null, capability: ForbiddenRequestCapability): boolean {
  return !value || !value.ambiguous && !value.standalone && !value.forbiddenCapabilities.includes(capability);
}
/** Use for an outer standalone prohibition before any dispatch. */
export function requestConstraintReply(value: UserRequestConstraints | null, lang: 'ar' | 'en'): LocalReply | null {
  if (!value?.standalone || value.ambiguous) return null;
  const text = lang === 'ar' ? 'حاضر، سألتزم بالقيد في هذا الطلب.' : 'Understood. I will respect that constraint for this request.';
  return { status: 'completed', text, claims: [{ text, support: [], status: 'fixed' }], evidence: [] };
}
