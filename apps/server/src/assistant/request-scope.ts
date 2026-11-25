import { z } from 'zod';
import { parseUserRequestConstraints, isEntireLiteralRequest, maskRequestLiteralData, UserRequestConstraintsSchema, type UserRequestConstraints } from './request-constraints.js';
export { parseUserRequestConstraints, isEntireLiteralRequest, requestCapabilityAllowed, requestConstraintReply, maskRequestLiteralData, UserRequestConstraintsSchema, type UserRequestConstraints, type ForbiddenRequestCapability } from './request-constraints.js';
import { publicSearchScan, publicSearchText } from '@mohassan/browser';
import { isCurrentComputerReadRequest } from './computer-request-language.js';
import { explicitKnowledgeDocumentRequest, requestsKnowledgeSummary } from './knowledge-document-request.js';
import { parseQuestionRewriteRequest } from './question-rewrite-request.js';
import { questionCoreferenceText, startsFactualQuestion } from './public-question-syntax.js';

/** Source classification is independent of tool availability and model output. */
export const requestSources = ['public_lookup', 'prior_conversation', 'local_state', 'supplied_content', 'unresolved'] as const;
export const requestOperations = ['lookup', 'transform', 'compute', 'act', 'converse', 'unknown'] as const;
export const requestScopeReasons = ['public_subject', 'nominal_public_subject', 'explicit_public_lookup', 'public_document_reference', 'prior_conversation_reference', 'owned_record', 'visible_local_surface', 'supplied_transformation', 'new_content_request', 'numeric_operation', 'missing_target', 'unresolved_reference', 'inherited_source', 'explicit_new_task', 'invalid_previous_scope', 'invalid_input', 'credential_material', 'non_lookup_operation', 'explicit_prohibition'] as const;
export type RequestSource = (typeof requestSources)[number];
export type RequestOperation = (typeof requestOperations)[number];
export type RequestScopeDestination = 'memory' | 'pc' | 'writing' | 'compute' | 'web_search' | 'browser_command' | 'unknown';

export const RequestScopeAssessmentSchema = z.object({
  version: z.literal(1),
  source: z.enum(requestSources),
  operation: z.enum(requestOperations),
  scope: z.enum(['public', 'private', 'unknown']),
  destination: z.enum(['memory', 'pc', 'writing', 'compute', 'web_search', 'browser_command', 'unknown']),
  publicQueryEligible: z.boolean(),
  reasons: z.array(z.enum(requestScopeReasons)).min(1).max(requestScopeReasons.length),
  constraints: UserRequestConstraintsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.publicQueryEligible && (value.source !== 'public_lookup' || value.scope !== 'public'
    || !['lookup', 'transform'].includes(value.operation))) context.addIssue({ code: 'custom', message: 'Only a public lookup source can supply a public query.' });
  if (['prior_conversation', 'local_state', 'supplied_content'].includes(value.source) && value.scope !== 'private') context.addIssue({ code: 'custom', message: 'A non-public source must remain private.' });
  if (value.source === 'unresolved' && (value.scope !== 'unknown' || value.publicQueryEligible)) context.addIssue({ code: 'custom', message: 'An unresolved source cannot authorize public lookup.' });
});
export type RequestScopeAssessment = z.infer<typeof RequestScopeAssessmentSchema>;
export interface RequestScopeOptions {
  contextKind?: 'new' | 'follow_up' | 'answer' | 'ambiguous';
  /** Host-persisted source assessment; never page text or model self-certification. */
  previous?: unknown;
}

const fold = (value: string) => value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0))
  .toLowerCase().replace(/\s+/gu, ' ').trim();
const stripLead = (value: string) => value.replace(/^(?:(?:من فضلك|لو سمحت|رجاء|(?:هل )?(?:يمكنك|تستطيع|تقدر|ممكنك|ممكن)(?:\s+ان)?|please|kindly|could you|can you|would you|now|الان|والان)[،,\s]+)+/iu, '').trim();
/** Matching-only text: displayed literals, tool arguments and original instructions stay unchanged. */
export function requestOperationText(value: string): string {
  return stripLead(fold(value)).replace(/^(?:تكتب|كتابه)(?=\s|$)/u, 'اكتب')
    .replace(/^(?:تترجم|ترجمه)(?=\s|$)/u, 'ترجم')
    .replace(/^تعيد صياغه(?=\s|$)/u, 'اعد صياغه')
    .replace(/^(?:تلخص|تلخيص)(?=\s|$)/u, 'لخص')
    .replace(/^تصحح(?=\s|$)/u, 'صحح');
}
const quoted = /«[^»]{1,2000}»|“[^”]{1,2000}”|"[^"\r\n]{1,2000}"|'[^'\r\n]{1,2000}'/gu;
const TRANSFORM = /^(?:اكتب(?:لي)?|صغ|ترجم|لخص(?:لي)?|اختصر|اعد صياغه|صحح|رتب (?:النص|الجمله)|اشرح (?:الجمله|النص)|(?:اجعل|خلي|خل)\s+(?:الرساله|النص|الجمله|الملخص)|(?:make|change)\s+(?:the\s+)?(?:letter|message|text|summary)|write|draft|compose|translate|rewrite|paraphrase|summari[sz]e|shorten|proofread|reword|edit|polish)(?!\p{L})/iu;
const DESCRIBE_CONTENT = /^(?:describe\s+(?:(?:this|the|following|provided|supplied|attached|pasted)\s+){0,3}(?:text|sentence|phrase|message|paragraph|content)(?!\p{L})|describe\s+["'«“`]|صف\s+(?:(?:هذا|هذه)\s+)?(?:النص|الجمله|الرساله|الفقره)(?!\p{L})|صف\s+["'«“`])/iu;
const DESCRIBE_LOCAL = /^(?:describe\s+(?:(?:the|my)\s+)?(?:current|currently (?:open|shared|visible)|shared|visible|displayed)\s+(?:(?:pc|computer|notepad|terminal|application)\s+)?(?:window|screen|dialog|taskbar)(?!\p{L})|صف\s+(?:النافذه|نافذه|الشاشه|شاشه)(?:\s+(?:الكمبيوتر|الحاسوب|البرنامج|الطرفيه))?\s+(?:الحاليه|الظاهره|المشاركه|المفتوحه)(?!\p{L}))/iu;
const PUBLIC_ACTION = /^(?:ابحث|دور|فتش)(?!\p{L})|^(?:search|look up|find (?:the )?(?:official|public|published)|check (?:the )?(?:official|public|published))\b/iu;
const PUBLIC_SOURCE = /(?:^|\s)(?:الويب|الانترنت|الموقع العام|الموقع الرسمي|المنشور|المنشوره|العامه|مصادر عامه|مصادر منشوره)(?=\s|[\p{P}]|$)|\b(?:public|official|published|online|on the web|internet|website)\b/iu;
const DOCUMENT = /(?:^|\s)(?:وثيقه|تقرير|كتاب|مقال|بحث|دراسه|دليل|سياسه)(?=\s|[\p{P}]|$)|\b(?:document|report|book|article|paper|study|manual|policy)\b/iu;
const NAMED_TITLE = /(?:بعنوان|المعنون(?:ه)?|تحت عنوان)|\b(?:titled|entitled|called)\b/iu;
const URL = /https?:\/\/[^\s<>"'«»]+/iu;
const PROVIDED = /(?:^|\s)(?:هذا|هذه|التالي|التاليه|المرفق|المرفقه|المعطي|المعطاه|الملصق|الملصقه|ادناه)(?=\s|[\p{P}]|$)|\b(?:this|following|below|provided|supplied|attached|pasted)\b/iu;
const CONTENT_OBJECT = /(?:^|\s)(?:نص|النص|جمله|الجمله|رساله|الرساله|ملاحظه|الملاحظه|فقره|الفقره|وثيقه|الوثيقه|ملف|الملف)(?=\s|[\p{P}]|$)|\b(?:text|sentence|message|note|paragraph|document|file|content)\b/iu;
const MEMORY_ACTION = /^(?:تذكر|تتذكر|احفظ|استرجع|استعد|remember|recall)(?=\s|[\p{P}]|$)/iu;
const OWNED_RECORD = /(?:^|\s)[وبلكف]{0,2}(?:تفضيلات|ملاحظات|سجلات|مواعيد|بيانات|ملفات|حسابات|رسائل|تقارير|وثائق|دفاتر|شركت|متجر|عملاء|عملائ|مشروع|ذاكرت)(?:ي|نا)(?=\s|[\p{P}]|$)|\b(?:my|our)\s+(?:saved|stored|recorded|personal|private)\b|\b(?:my|our)\s+(?:(?:previous)\s+){0,2}(?:name|company|business|account|preferences?|notes?|records?|appointments?|files?|reports?|documents?|messages?|customers?|clients?|projects?|memory|memories|password|address)\b/iu;
const PRIOR_RELATION = /(?:^|\s)(?:(?:قلت|ذكرت|اخبرت|اعطيت|ارسلت)(?:ه|ها|هم)?\s*(?:لك|ك|اليك)|(?:قلت|ذكرت|اخبرت|اعطيت|ارسلت)(?:ك|ك به|ك بها))(?=\s|[\p{P}]|$)|(?:^|\s)(?:من ذاكرتك|في ذاكرتك|في الذاكره|فاكر|بتتذكر|تتذكر)(?=\s|[\p{P}]|$)|\b(?:did\s+)?(?:i|we)\s+(?:tell|give|send|mention|provide|share|ask|told|gave|sent|mentioned|provided|shared|asked)\s+(?:it\s+|that\s+)?(?:to\s+)?you\b|\b(?:you (?:saved|stored|recorded|remembered)|(?:from|in) (?:our|my|the) (?:earlier|previous|saved|stored) (?:conversation|chat|notes?|records?))\b/iu;
const LOCAL_SURFACE = /(?:^|\s)(?:نافذه|النافذه|النوافذ|نوافذ|شاشه|الشاشه|شريط المهام|سطح المكتب|الطرفيه|الكمبيوتر|الحاسوب|جهازي|حاسوبي|كمبيوتري|برنامج|البرنامج|برساله الخطا|رساله الخطا|ملف|الملف)(?=\s|[\p{P}]|$)|\b(?:window|screen|taskbar|desktop|terminal|computer|pc|application|spreadsheet|dialog|error message|file)\b/iu;
const LOCAL_ANCHOR = /(?:^|\s)(?:المفتوح|المفتوحه|مفتوح|مفتوحه|ظاهر|الظاهر|ظاهره|معروض|المعروض|المعروضه|قدامك|امامك|عندي|علي جهازي|علي الكمبيوتر|المحلي|المحليه|المشاركه)(?=\s|[\p{P}]|$)|\b(?:currently (?:open|shared|visible)|visible|displayed|shared|on (?:my|the) (?:screen|computer|pc|desktop)|in (?:my|the) (?:open|local|shared)|my (?:computer|pc|desktop))\b/iu;
const LOCAL_ACT = /^(?:افتح|شغل|اغلق|كبر|صغر|اضغط|انقر|اقرا|اعرض|شوف|بص|انتقل|open|launch|close|minimi[sz]e|maximi[sz]e|click|press|read|show|focus)(?!\p{L})/iu;
const REFERENCE = /(?:^|\s)(?:عنه|عنها|فيه|فيها|له|لها|(?:هذا|هذه|ذلك|تلك)(?!\s+(?:الاسبوع|الشهر|العام|الصباح|المساء|اليوم))|نفسه|نفسها|المقصود|اقصده|اقصدها|الذي اعنيه|التي اعنيها)(?=\s|[\p{P}]|$)|\b(?:it|its|(?:this|that)(?!\s+(?:week|month|year|morning|evening|afternoon|day))|them|there|the same|the (?:one|document|file|item) i mean)\b/iu;
const FOLLOW = /^(?:(?:طيب|طب|تمام|حسنا)[،,\s]+|(?:what|how) about\b|and\s+|(?:اجعلها|اجعله|خليها|خليه|خلها|خله|بدلها|بدله)(?=\s|[\p{P}]|$))/iu;
const CLITIC_REFERENCE = /^(?:افتح|اغلق|احذف|ارسل|احفظ|غير|بدل|كبر|صغر|اقرا|اعرض|انقل|اختصر|لخص|ترجم|صحح|اعد صياغت)(?:ه|ها|هم|هن)(?:لي|لنا)?(?=\s|[\p{P}]|$)/iu;
// «Explain why rain falls», «describe how vaccines work», «اشرح لماذا تسقط الأمطار»: a question about the world asked as
// an instruction to explain. Until 2026-11-23 it matched no question form, ended as `missing_target`, and the search
// guard refused «Explain why rain falls in two short Arabic sentences.» as possibly private (live test). A reference or an
// owned record in it («explain why my account was blocked») is still found first and keeps the request private.
const EXPLAIN_QUESTION = /^(?:explain|describe|tell me|teach me)(?:\s+(?:to me|for me|briefly|simply|in simple terms))?\s+(?:why|how|what|when|where|which|who)\s+[\p{L}\p{N}]|^(?:اشرح|وضح|فسر|بين|علمني)(?:\s+لي)?\s+(?:لماذا|ليش|ليه|كيف|ما|ماذا|متي|اين|من|سبب)\s+[\p{L}\p{N}]/iu;
const isQuestion = (text: string) => startsFactualQuestion(text) || EXPLAIN_QUESTION.test(text);
const NEWS = /(?:^|\s)(?:اخبار|الاخبار|طقس|الطقس|سعر الصرف|صرف العملات)(?=\s|[\p{P}]|$)|\b(?:news|headlines|weather|exchange rate)\b/iu;
const CONVERSE = /^(?:مرحبا|اهلا|هلا|شكرا|تسلم|السلام عليكم|hi|hello|hey|thanks|thank you|good morning|good evening)(?=\s|[\p{P}]|$)/iu;
const SOCIAL_QUESTION = /^(?:كيف حالك|كيفك|كيف الحال|how are you|how do you do|how are you doing)[.!?؟]*$/iu;
const NUMBER = /[0-9]+(?:[.٫][0-9]+)?/gu;
const NUMERIC_OPERATION = /[0-9)]\s*[+*/×÷^−-]\s*[(0-9]|(?:^|\s)(?:حساب|احسب|احسبي|قس?م|قسم|اقسم|قسمه|اضرب|ضرب|اجمع|اطرح|زود|زود|ناقص|المتوسط|متوسط|اكبر|اصغر|مساحه|المساحه|باقي|ضل|صرف(?:ت)?)(?=\s|[\p{P}]|$)|\b(?:calculat(?:e|ion)|compute|multiply|divide|add|subtract|minus|plus|times|average|mean|larger|smaller|area|remainder|spent|remaining)\b/iu;
const EXCHANGE = /(?:^|\s)(?:سعر الصرف|صرف العملات|مقابل|بالجنيه|بالدولار|باليورو)(?=\s|[\p{P}]|$)|\b(?:exchange|exchange rate|(?:usd|gbp|eur|jpy|dollars?|pounds?|euros?) (?:in|to|into) (?:usd|gbp|eur|jpy|dollars?|pounds?|euros?))\b/iu;
const UNKNOWN_ACTION = /^(?:افعل|اعمل|نفذ|غير|بدل|انقل|اسق|امسك|احجز|ارسل|احذف|احفظ|انشئ|اصنع|جهز|صمم|ولد|(?:سو|سوي)(?:لي|لنا)?|do|make|create|generate|change|move|carry|pick up|water|measure|book|send|delete|save)(?!\p{L})/iu;
// An explicit outer project/code repair is an action on owned material, not a
// memory lookup merely because its operand is "my project". It grants no tool
// permission: target validation, owner access and Runtime review remain separate.
const CURRENT_CODE_ACTION = /^(?:(?:اصلح|اعد هيكله)\s+(?:مشروعي|مشروعنا|المشروع|مشروع|الكود|كودي|كودنا|الشفره|شفرتي|شفرتنا)(?!\p{L})|(?:fix|repair|debug|refactor)\s+(?:(?:my|our|the)\s+)?(?:project|code|repository|repo|workspace)\b)(?:(?:\s+(?:again|now|please|مره اخري|الان|من فضلك))+|\s+(?:by (?:correcting|fixing|repairing|refactoring|adding|removing|updating)|to (?:correct|fix|repair|refactor|add|remove|update)|[بل](?:اصلاح|تصحيح|تحديث|اضافه|ازاله|اعاده هيكله))\s+[^.!?؟;؛:：\r\n]{1,300})?[.!?؟]*$/iu;
const NAVIGATE = /^(?:افتح|اذهب|ادخل|open|visit|navigate|go to)(?!\p{L})/iu;
const FIND_PUBLIC_FACT = /^find\s+(?:the\s+)?(?:(?:latest|current|official|public)\s+)?(?:opening hours|working hours|timetables?|prices?|fees?|dates?|address|location|news|headlines|documentation|website|reports?|articles?|papers?)\b/iu;

/** Remove a greeting clause only when a complete task follows its delimiter. */
export function requestScopeActionText(value: string): string {
  value = parseUserRequestConstraints(value)?.safeActionText ?? value;
  value = value.replace(/^(?:(?:طيب|طب|حسنا|حسنًا|تمام|okay|ok|well)[،,\s]+)+/iu, '');
  if (typeof value !== 'string' || value.length > 8000) return typeof value === 'string' ? value : '';
  let text = value.trim();
  for (let round = 0; round < 2; round++) {
    const greeting = /^([^،,!.؟?]{1,100})[،,!.؟?]\s*(.+)$/iu.exec(text);
    if (!greeting || !/^(?:(?:مرحبا|اهلا|هلا|شكرا|تسلم|السلام عليكم)(?:\s+يا\s+[\p{L}]{1,30})?|(?:hello|hi|hey|thanks|thank you|good morning|good evening)(?:\s+[\p{L}]{1,30})?)$/iu.test(fold(greeting[1]))) break;
    const rest = stripLead(fold(greeting[2]));
    if (SOCIAL_QUESTION.test(rest)) break;
    if (!isQuestion(rest) && ![PUBLIC_ACTION, FIND_PUBLIC_FACT, TRANSFORM, DESCRIBE_CONTENT, DESCRIBE_LOCAL, LOCAL_ACT, UNKNOWN_ACTION, NEWS, MEMORY_ACTION, NAVIGATE].some(pattern => pattern.test(rest))) break;
    text = greeting[2].trim();
  }
  return text;
}

function transformationDelimiter(value: string): number | null {
  for (const found of value.matchAll(/[:：]/gu)) {
    if (!/https?$/iu.test(value.slice(Math.max(0, found.index - 5), found.index))) return found.index;
  }
  return null;
}

export function parseRequestScopeAssessment(value: unknown): RequestScopeAssessment | null {
  const parsed = RequestScopeAssessmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Describes where the requested information comes from, not whether a tool may
 * execute. Content after an explicit transformation delimiter stays data, and a
 * quoted public title does not become a private document merely because quoted.
 */
export function assessRequestScope(value: string, options: RequestScopeOptions = {}): RequestScopeAssessment {
  if (typeof value === 'string' && parseQuestionRewriteRequest(value)) {
    return { version: 1, source: 'supplied_content', scope: 'private', operation: 'transform', destination: 'writing',
      publicQueryEligible: false, reasons: ['supplied_transformation'] };
  }
  const constraints: UserRequestConstraints | null = typeof value === 'string' ? parseUserRequestConstraints(value) : null;
  const make = (source: RequestSource, operation: RequestOperation, destination: RequestScopeDestination, reasons: RequestScopeAssessment['reasons']): RequestScopeAssessment => ({
    version: 1, source, operation, destination,
    scope: ['prior_conversation', 'local_state', 'supplied_content'].includes(source) ? 'private' : source === 'public_lookup' ? 'public' : 'unknown',
    publicQueryEligible: source === 'public_lookup' && ['lookup', 'transform'].includes(operation) && !constraints?.forbiddenCapabilities.includes('public_search'), reasons, ...(constraints ? { constraints } : {}),
  });
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) return make('unresolved', 'unknown', 'unknown', ['invalid_input']);
  if (isEntireLiteralRequest(value)) return make('supplied_content', 'unknown', 'unknown', ['missing_target']);
  if (constraints?.standalone || constraints?.ambiguous) return make('unresolved', constraints.standalone && !constraints.ambiguous ? 'converse' : 'unknown', 'unknown', ['explicit_prohibition']);
  const original = value.trim(), actionText = requestScopeActionText(original), text = requestOperationText(actionText);
  if (SOCIAL_QUESTION.test(text)) return make('unresolved', 'converse', 'unknown', ['non_lookup_operation']);
  const credentialScan = publicSearchScan(original);
  if (publicSearchText(credentialScan) !== credentialScan) return make('supplied_content', 'unknown', 'unknown', ['credential_material']);
  const descriptiveContent = DESCRIBE_CONTENT.test(text);
  const transformation = TRANSFORM.test(text) || descriptiveContent;
  const explicitPublic = PUBLIC_ACTION.test(text), findPublicFact = FIND_PUBLIC_FACT.test(text);
  const delimiterIndex = transformation ? transformationDelimiter(actionText) : null;
  const instruction = delimiterIndex === null ? actionText : actionText.slice(0, delimiterIndex);
  const instructionText = requestOperationText(instruction);
  const navigation = NAVIGATE.test(text) && URL.test(instruction);
  const hasPublicDocument = (URL.test(instruction) || DOCUMENT.test(instructionText) && NAMED_TITLE.test(instructionText))
    && (explicitPublic || transformation || PUBLIC_SOURCE.test(instructionText) || navigation);
  // A title is a lookup operand; a supplied quotation is transformation data.
  const outer = hasPublicDocument || explicitPublic ? text.replace(quoted, ' public-title ') : text;
  const delimiter = delimiterIndex !== null && actionText.slice(delimiterIndex + 1).trim().length > 0;
  const quotedPayload = transformation && !hasPublicDocument && (quoted.test(original)
    || descriptiveContent && maskRequestLiteralData(actionText) !== actionText);
  quoted.lastIndex = 0;
  const literalEnvelope = text.replace(quoted, ' supplied_literal ');
  quoted.lastIndex = 0;
  const suppliedLanguageQuestion = /^(?:how (?:do|can|would) (?:i|you) (?:say|translate|write)\s+supplied_literal\s+(?:in|into)\s+[\p{L}][\p{L} -]{0,40}|what does\s+(?:(?:the|this)\s+)?(?:(?:phrase|sentence|text)\s+)?supplied_literal\s+mean|what is\s+(?:the\s+)?translation of\s+supplied_literal(?:\s+(?:in|into)\s+[\p{L}][\p{L} -]{0,40})?)[.!?؟]*$/iu.test(literalEnvelope.replace(/\s+/gu, ' ').trim());
  if (suppliedLanguageQuestion && !hasPublicDocument) return make('supplied_content', 'transform', 'writing', ['supplied_transformation']);
  const currentComputerRead = isCurrentComputerReadRequest(actionText);
  if (!hasPublicDocument && !explicitPublic && !currentComputerRead && explicitKnowledgeDocumentRequest(actionText)
      && (!transformation || requestsKnowledgeSummary(actionText))) return make('prior_conversation', 'lookup', 'memory', ['owned_record']);
  if (transformation && !hasPublicDocument && (delimiter || quotedPayload || !descriptiveContent && PROVIDED.test(outer) && CONTENT_OBJECT.test(outer))) {
    return make('supplied_content', 'transform', 'writing', ['supplied_transformation']);
  }
  if (currentComputerRead) return make('local_state', 'lookup', 'pc', ['visible_local_surface']);
  const memoryAction = MEMORY_ACTION.test(outer), owned = OWNED_RECORD.test(outer), prior = PRIOR_RELATION.test(outer);
  const describeLocal = DESCRIBE_LOCAL.test(outer);
  const local = LOCAL_SURFACE.test(outer) && (LOCAL_ANCHOR.test(outer) || describeLocal
    || LOCAL_ACT.test(outer) && !explicitPublic && !PUBLIC_SOURCE.test(outer) && !hasPublicDocument);
  if (local) return make('local_state', !describeLocal && LOCAL_ACT.test(outer) && !/^(?:اقرا|اعرض|شوف|بص|read|show)(?!\p{L})/iu.test(outer) ? 'act' : 'lookup', 'pc', ['visible_local_surface']);
  if (memoryAction || prior || owned) {
    const memoryWrite = memoryAction && /^(?:احفظ|تذكر|remember)(?=\s|[\p{P}]|$)/iu.test(outer);
    const operation: RequestOperation = transformation ? 'transform' : memoryWrite || UNKNOWN_ACTION.test(outer) || CURRENT_CODE_ACTION.test(outer) ? 'act' : 'lookup';
    return make('prior_conversation', operation, transformation ? 'writing' : operation === 'lookup' || memoryWrite ? 'memory' : 'unknown', [prior ? 'prior_conversation_reference' : 'owned_record']);
  }
  // A new letter is an explicit object within this request. Its later "send it"
  // refers to that draft; it is not evidence of a missing earlier conversation.
  // Body references ("write a letter about it") still require their own source.
  const createsLetter = /^(?:(?:write|draft|compose)\s+(?:(?:me|a|an|the|formal|polite|professional|short|thank-you|thank you)\s+){0,6}(?:letter|email|e-mail|message|note)\b|(?:اكتب|صغ)(?:لي)?(?:\s+لي)?\s+(?:رساله|بريد|ايميل|خطاب|اشعار)(?!\p{L}))/iu.test(outer);
  const withoutDeliveryReference = outer.replace(/(?:\b(?:and(?: then)?|then|also)\s+(?:send|email|mail|publish|post|save|deliver)\s+(?:it|the (?:letter|email|message|draft))\b|(?:\s+(?:ثم|وبعدها)\s+|\s+و)(?:ارسل|انشر|احفظ|ابعت|ابعث)(?:ها|ه)(?!\p{L}))/giu, '');
  if (createsLetter && !REFERENCE.test(withoutDeliveryReference) && !CLITIC_REFERENCE.test(withoutDeliveryReference)) {
    return make('supplied_content', 'transform', 'writing', ['new_content_request']);
  }
  const numbers = text.match(NUMBER) ?? [];
  if (!explicitPublic && numbers.length > 0 && NUMERIC_OPERATION.test(outer) && !EXCHANGE.test(outer) && !NEWS.test(outer)) return make('supplied_content', 'compute', 'compute', ['numeric_operation']);

  const parsedPrevious = options.previous === undefined ? null : parseRequestScopeAssessment(options.previous);
  const reference = REFERENCE.test(questionCoreferenceText(outer)) || FOLLOW.test(outer) || CLITIC_REFERENCE.test(outer);
  const independentQuestion = (isQuestion(outer) || NEWS.test(outer)) && !reference && options.contextKind !== 'answer';
  const selfContainedPublic = (explicitPublic || findPublicFact) && !reference || hasPublicDocument || independentQuestion;
  if (selfContainedPublic) return make('public_lookup', navigation ? 'act' : transformation ? 'transform' : 'lookup', navigation ? 'browser_command' : 'web_search', [hasPublicDocument ? 'public_document_reference' : explicitPublic ? 'explicit_public_lookup' : 'public_subject', 'explicit_new_task']);
  if (options.contextKind === 'follow_up' || options.contextKind === 'answer') {
    if (parsedPrevious && parsedPrevious.source !== 'unresolved') {
      const { constraints: _previousConstraints, ...inherited } = parsedPrevious;
      return {
      ...inherited, reasons: ['inherited_source'], ...(constraints ? { constraints } : {}),
      operation: transformation ? 'transform' : parsedPrevious.operation,
      publicQueryEligible: parsedPrevious.source === 'public_lookup' && parsedPrevious.scope === 'public' && ['lookup', 'transform'].includes(transformation ? 'transform' : parsedPrevious.operation)
        && !constraints?.forbiddenCapabilities.includes('public_search'),
    }; }
    return make('unresolved', transformation ? 'transform' : 'unknown', transformation ? 'writing' : 'unknown', [options.previous !== undefined && !parsedPrevious ? 'invalid_previous_scope' : 'missing_target']);
  }
  if (reference || transformation && !hasPublicDocument && !NEWS.test(outer)) return make('unresolved', transformation ? 'transform' : 'unknown', transformation ? 'writing' : 'unknown', [reference ? 'unresolved_reference' : 'missing_target']);
  if (options.contextKind === 'ambiguous') return make('unresolved', 'unknown', 'unknown', ['missing_target']);
  if (NEWS.test(outer) || explicitPublic || isQuestion(outer)) return make('public_lookup', 'lookup', 'web_search', [explicitPublic ? 'explicit_public_lookup' : 'public_subject']);
  if (CONVERSE.test(outer)) return make('unresolved', 'converse', 'unknown', ['non_lookup_operation']);
  if (UNKNOWN_ACTION.test(outer) || CURRENT_CODE_ACTION.test(outer)) return make('unresolved', 'act', 'unknown', ['missing_target']);
  const words = outer.match(/[\p{L}][\p{L}\p{N}'’-]*/gu) ?? [];
  // A dot inside a token («Node.js», «v1.2») is not sentence punctuation, so such a short noun phrase stays a
  // nominal public subject; a dot before a space or at the end still is («Describe a stack data structure.»).
  // Measured 2026-11-22: «Node.js latest version» ended as missing_target and the run failed.
  const sentence = /[!?؟:：;؛\r\n]|\.(?![\p{L}\p{N}])|\b(?:is|are|was|were|has|have|will|would|should|needs?)\b|(?:^|\s)(?:سوف|كان|كانت|تم)(?=\s|$)/iu.test(outer);
  if (outer.length <= 200 && words.length >= 2 && words.length <= 12 && !sentence && !LOCAL_ACT.test(outer)) return make('public_lookup', 'lookup', 'web_search', ['nominal_public_subject']);
  return make('unresolved', 'unknown', 'unknown', ['missing_target']);
}

export interface PublicProjectionReview {
  eligible: boolean;
  source: RequestScopeAssessment;
  reason: 'eligible' | 'source_not_public' | 'query_not_public' | 'private_context_expansion' | 'prohibited_content_expansion' | 'invalid_query';
}

/**
 * Check the request and its proposed projection. A new public task cannot carry
 * extra words from an earlier private task. Literal public titles retain their
 * role as quoted lookup data, including words such as "my notes" in a title.
 */
export function reviewPublicProjection(request: string, query: string, options: RequestScopeOptions = {}): PublicProjectionReview {
  const source = assessRequestScope(request, options);
  if (!source.publicQueryEligible) return { eligible: false, source, reason: 'source_not_public' };
  if (typeof query !== 'string' || !query.trim() || query.length > 8000) return { eligible: false, source, reason: 'invalid_query' };
  const projected = assessRequestScope(query, { contextKind: 'new' });
  if (projected.reasons.includes('credential_material')) return { eligible: false, source, reason: 'query_not_public' };
  const tokens = (text: string) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const constraints = parseUserRequestConstraints(request);
  const currentTokens = new Set(tokens(constraints?.safeActionText ?? request));
  if (constraints?.safeActionText) {
    const deniedOnly = new Set(constraints.prohibitions.flatMap(item => tokens(request.slice(item.span.start, item.span.end))).filter(token => !currentTokens.has(token)));
    if (tokens(query).some(token => deniedOnly.has(token))) return { eligible: false, source, reason: 'prohibited_content_expansion' };
  }
  const fromCurrent = tokens(query).every(token => currentTokens.has(token));
  const previous = parseRequestScopeAssessment(options.previous);
  if (previous && previous.scope !== 'public' && !source.reasons.includes('inherited_source') && !fromCurrent) return { eligible: false, source, reason: 'private_context_expansion' };
  if (projected.scope === 'private' && !fromCurrent) return { eligible: false, source, reason: 'query_not_public' };
  return { eligible: true, source, reason: 'eligible' };
}
