import { z } from 'zod';
import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';
import { routingCapabilities, type RequestRoutingDecision } from './routing-decision.js';
import { fixedReply, type LocalReply } from './mind/limits.js';
import { matchText, normalizeRequest, stripCourtesyTail } from './mind/normalize.js';

export type CapabilityReplyRouting = Pick<RequestRoutingDecision, 'route' | 'intent' | 'handler' | 'availability' | 'missingCapabilities' | 'reason'>;
export interface CapabilityReplyOptions {
  /** Set only after the existing deterministic handlers have declined this request. */
  handlersExhausted?: boolean;
  /** A feature question must still match a complete availability-question form. */
  purpose?: 'task' | 'capability_question';
  /** The host must know that no operation was attempted before selecting not_started. */
  execution?: 'not_started' | 'unconfirmed';
  /** Independently checked host output only; provider claims are not partial progress. */
  partialResult?: LocalReply;
  alternatives?: readonly ('letter_template' | 'local_calculation')[];
}

const routes = ['web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute', 'ads', 'pc', 'writing', 'planning', 'coding', 'chat', 'unsupported', 'image', 'media', 'reply', 'clarify'] as const;
const RoutingSchema = z.object({
  route: z.enum(routes), intent: z.string().max(40).optional(), handler: z.string().max(80).optional(),
  availability: z.enum(['ready', 'needs_context', 'missing_capability', 'restricted']),
  missingCapabilities: z.array(z.enum(routingCapabilities)).max(routingCapabilities.length).default([]),
  reason: z.string().max(80).optional(),
});
type ParsedRouting = z.infer<typeof RoutingSchema>;
type Route = (typeof routes)[number];

const LABEL: Record<Route, { ar: string; en: string }> = {
  reminder: { ar: 'التذكير والجدولة', en: 'reminders and scheduling' },
  writing: { ar: 'الكتابة الحرة أو الترجمة', en: 'free writing or translation' },
  pc: { ar: 'التحكم بالكمبيوتر', en: 'computer control' },
  memory: { ar: 'قراءة الذاكرة أو حفظها', en: 'memory lookup or saving' },
  compute: { ar: 'هذا النوع من الحساب', en: 'this kind of calculation' },
  browser_command: { ar: 'تنفيذ طلب المتصفح', en: 'this browser operation' },
  web_search: { ar: 'البحث وقراءة المصادر', en: 'searching and reading sources' },
  news: { ar: 'قراءة الأخبار الحديثة', en: 'reading current news' },
  ads: { ar: 'إعداد الحملة الإعلانية', en: 'preparing the advertising campaign' },
  coding: { ar: 'تعديل المشروع البرمجي', en: 'editing the coding project' },
  planning: { ar: 'هذا النوع من التخطيط', en: 'this kind of planning' },
  chat: { ar: 'صياغة جواب حر لهذا الطلب', en: 'a free-form answer to this request' },
  image: { ar: 'إنشاء الصور', en: 'image generation' },
  media: { ar: 'إنشاء الوسائط', en: 'media generation' },
  unsupported: { ar: 'هذا الطلب', en: 'this request' }, reply: { ar: 'هذا الطلب', en: 'this request' }, clarify: { ar: 'هذا الطلب', en: 'this request' },
};

const FEATURE: Partial<Record<Route, string>> = {
  reminder: 'reminders?|scheduling|reminder scheduling|calendar reminders|التذكير|التذكيرات|الجدوله|التنبيهات',
  writing: 'free writing|creative writing|translation|text rewriting|الكتابه الحره|الكتابه الابداعيه|الترجمه|اعاده الصياغه',
  pc: 'computer control|desktop control|screen reading|التحكم بالكمبيوتر|التحكم بالجهاز|قراءه الشاشه',
  memory: 'memory|saved memory|memory lookup|الذاكره|استرجاع الذاكره|حفظ الذاكره',
  compute: 'advanced calculations|symbolic mathematics|symbolic math|الحساب الرمزي|الحسابات المتقدمه',
  browser_command: 'browser control|web browsing|التحكم بالمتصفح|تصفح المواقع',
  web_search: 'web search|public search|البحث في الويب|البحث العام',
  news: 'news search|current news|البحث عن الاخبار|الاخبار الحديثه',
  ads: 'advertising campaigns|google ads campaigns|ad campaign preparation|الحملات الاعلانيه|اعداد الحملات',
  coding: 'code editing|project editing|تعديل الكود|تعديل المشاريع',
  planning: 'task planning|weekly planning|تخطيط المهام|التخطيط الاسبوعي',
  chat: 'general conversation|free conversation|المحادثه العامه|المحادثه الحره',
  image: 'image generation|انشاء الصور|توليد الصور',
  media: 'media generation|انشاء الوسائط|توليد الوسائط',
};

function isAvailabilityQuestion(request: string, route: Route): boolean {
  const feature = FEATURE[route];
  if (!feature) return false;
  const text = stripCourtesyTail(matchText(normalizeRequest(request).text));
  // Deliberately excludes modal action requests such as "Can you remind me
  // tomorrow?" and "هل يمكنك كتابة قصة؟", even when a caller sets purpose.
  return new RegExp(`^(?:do you support (?:${feature})|(?:is|are) (?:the )?(?:${feature})(?: feature)? (?:available|supported)|هل (?:تدعم|لديك|عندك) (?:ميزه )?(?:${feature})|هل (?:ميزه )?(?:${feature}) (?:متاحه|متاح|مدعومه|مدعوم))[\\s.!?؟،,]*$`, 'iu').test(text);
}

const boundedText = z.string().min(1).max(2000).regex(/^[^\u0000]*$/u).refine(value => Boolean(value.trim()));
const PartialReplySchema = z.object({
  status: z.literal('partial'), text: boundedText,
  claims: z.array(z.object({ text: boundedText, support: z.array(z.string().min(1).max(160)).max(16),
    status: z.enum(['confirmed', 'single_source', 'conflict', 'not_found', 'fixed']) }).strict()).min(1).max(16),
  evidence: z.array(z.object({ id: z.string().min(1).max(160), source: z.enum(['computed', 'memory', 'knowledge', 'site', 'index', 'web']),
    quote: boundedText, value: z.string().max(2000).optional(), title: z.string().max(300).optional(), sourceRef: z.string().max(500).optional(),
    url: z.string().max(2500).optional(), fetchedAt: z.string().max(80).optional(), pageDate: z.string().max(80).nullable().optional(), official: z.boolean().optional(),
    observation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('http_status'), status: z.number().int().min(100).max(599) }).strict(),
      z.object({ kind: z.literal('redirect'), status: z.number().int().min(100).max(599), to: z.string().max(2500) }).strict(),
      z.object({ kind: z.literal('metadata'), field: z.enum(['protocol', 'title', 'language', 'last_modified', 'page_date', 'content_type', 'content_hash', 'identity']), value: z.string().max(2000) }).strict(),
    ]).optional(),
  }).strict()).min(1).max(16),
}).strict();

function partialResult(value: LocalReply | undefined): LocalReply | null {
  const parsed = PartialReplySchema.safeParse(value);
  if (!parsed.success) return null;
  const reply = parsed.data;
  const ids = new Set(reply.evidence.map(item => item.id));
  if (ids.size !== reply.evidence.length || reply.claims.some(claim => claim.support.some(id => !ids.has(id)))
      || !reply.claims.some(claim => ['confirmed', 'single_source', 'conflict'].includes(claim.status) && claim.support.length > 0)) return null;
  try {
    const encoded = JSON.stringify(reply);
    if (encoded.length > 14_000 || redactCredentialText(redactSecrets(encoded)) !== encoded
        || /(?:api[_ -]?key|access[_ -]?token|password|passcode|secret|كلمه المرور|رمز التحقق|المفتاح السري)\s*[:=]/iu.test(matchText(encoded))) return null;
    return reply;
  } catch { return null; }
}

function blockedCopy(route: Route, routing: ParsedRouting | null, lang: 'ar' | 'en', options: CapabilityReplyOptions): string {
  const restricted = routing?.availability === 'restricted';
  const missing = routing?.availability === 'missing_capability';
  const neverStarted = options.execution === 'not_started' && !options.partialResult;
  const start = lang === 'ar' ? neverStarted ? 'لم أنفّذ هذا الطلب.' : 'لم أؤكد إتمام هذا الطلب.'
    : neverStarted ? 'I haven’t performed this request.' : 'I haven’t verified completion of this request.';
  if (restricted) return lang === 'ar'
    ? `${start} هذا المسار غير متاح للحساب الحالي. استخدم حسابًا مخوّلًا بالإجراء المحدد.`
    : `${start} This route is unavailable to the current account. Use an account authorized for the specific operation.`;
  if (route === 'clarify' || routing?.availability === 'needs_context') return lang === 'ar'
    ? `${start} حدّد الشيء المقصود والنتيجة التي تريدها في رسالة واحدة.`
    : `${start} Name the subject and the result you want in one message.`;
  if (route === 'reminder') return lang === 'ar'
    ? `${start} ${missing ? 'أداة التذكير والجدولة غير متاحة في هذه المحادثة حاليًا.' : 'لم يُنجز مسار الجدولة هذا الطلب.'} لا يوجد تنبيه مؤكّد من هذا الرد.`
    : `${start} ${missing ? 'The reminder and scheduling tool is unavailable in this conversation.' : 'The scheduling route did not complete this request.'} This reply does not confirm an alert.`;
  if (route === 'memory') return lang === 'ar'
    ? `${start} ${missing ? 'أداة الذاكرة غير متاحة في هذه المحادثة.' : 'لم يثبت هذا المسار قراءة المعلومة أو حفظها.'} اكتب المعلومة هنا إذا كان طلبك يعتمد عليها.`
    : `${start} ${missing ? 'The memory tool is unavailable in this conversation.' : 'This route did not establish that the information was retrieved or saved.'} Include the information here if the request depends on it.`;
  if (route === 'pc') return lang === 'ar'
    ? `${start} ${missing ? 'أداة التحكم بالكمبيوتر غير متاحة في هذه المحادثة.' : 'لم يُنجز هذا المسار الإجراء المطلوب على الكمبيوتر.'} اذكر اسم التطبيق والإجراء المحدد.`
    : `${start} ${missing ? 'The computer-control tool is unavailable in this conversation.' : 'This route did not complete the requested computer operation.'} Name the application and exact operation.`;
  if (route === 'compute') return lang === 'ar'
    ? `${start} هذا النوع من الحساب لم يُحلّ بالقدرات المحلية المتاحة.${options.alternatives?.includes('local_calculation') ? ' يمكنك كتابة تعبير بالأرقام وعلامات العمليات، أو تحديد وحدتي التحويل.' : ''}`
    : `${start} This kind of calculation was not solved by the available local capabilities.${options.alternatives?.includes('local_calculation') ? ' You can provide a numeric expression with operators, or name the two conversion units.' : ''}`;
  if (route === 'writing') return lang === 'ar'
    ? `${start} ${missing ? 'الكتابة الحرة أو الترجمة المطلوبة غير متاحة في هذه المحادثة حاليًا.' : 'لم يُنتج مسار الكتابة النص المطلوب.'}${options.alternatives?.includes('letter_template') ? ' لترتيب رسالة من قالب، اذكر المستلم والغرض والتفاصيل والتوقيع بكلماتك.' : ''}`
    : `${start} ${missing ? 'The requested free writing or translation is unavailable in this conversation.' : 'The writing route did not produce the requested text.'}${options.alternatives?.includes('letter_template') ? ' For a template letter, provide the recipient, purpose, details and signature in your own words.' : ''}`;
  if (route === 'web_search' || route === 'news' || route === 'browser_command') return lang === 'ar'
    ? `${start} ${missing ? 'مسار البحث أو التصفح المطلوب غير متاح بالكامل.' : 'لم يتحقق مسار البحث أو التصفح من النتيجة المطلوبة.'} لم أؤكد فتح الصفحة أو صحة معلومة حديثة.`
    : `${start} ${missing ? 'The required search or browsing route is not fully available.' : 'The search or browsing route did not verify the requested result.'} I have not confirmed a page opening or a current fact.`;
  const label = LABEL[route][lang];
  return lang === 'ar' ? `${start} ${label} ${missing ? 'غير متاح بالقدرات المهيأة لهذه المحادثة حاليًا.' : 'لم يكتمل عبر المسارات المتاحة حاليًا.'}`
    : `${start} ${label[0].toUpperCase() + label.slice(1)} ${missing ? 'is unavailable with the capabilities configured for this conversation.' : 'was not completed by the available routes.'}`;
}

/**
 * A host-owned capability explanation, never execution, permission or evidence
 * that an effect occurred. Route facts and partialResult must come from trusted
 * controller state, not provider JSON. No raw request text is echoed.
 */
export function evaluateCapabilityReply(request: string, routing: CapabilityReplyRouting | unknown,
    options: CapabilityReplyOptions = {}): LocalReply | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 4000) return null;
  const lang = normalizeRequest(request).lang;
  const parsed = RoutingSchema.safeParse(routing);
  const facts = parsed.success ? parsed.data : null;
  const route = facts?.route ?? 'unsupported';
  const question = options.purpose === 'capability_question' && isAvailabilityQuestion(request, route);
  if (question && facts && facts.availability !== 'needs_context') {
    const text = lang === 'ar' ? facts.availability === 'ready'
      ? 'هذه القدرة مهيأة في هذه المحادثة للطلبات المدعومة.'
      : facts.availability === 'restricted' ? 'هذه القدرة غير متاحة للحساب الحالي في هذه المحادثة.'
        : 'هذه القدرة غير متاحة بالقدرات المهيأة لهذه المحادثة حاليًا.'
      : facts.availability === 'ready'
        ? 'This capability is configured for supported requests in this conversation.'
        : facts.availability === 'restricted' ? 'This capability is unavailable to the current account in this conversation.'
          : 'This capability is unavailable with the capabilities configured for this conversation.';
    return fixedReply(text, 'completed');
  }
  if (!options.handlersExhausted && (!facts || facts.availability === 'ready' || facts.availability === 'needs_context')) return null;
  const text = blockedCopy(route, facts, lang, options);
  const partial = partialResult(options.partialResult);
  return partial ? { status: 'partial', text: `${partial.text}\n\n${text}`, evidence: partial.evidence,
    claims: [...partial.claims, { text, support: [], status: 'fixed' }] } : fixedReply(text, 'blocked');
}
