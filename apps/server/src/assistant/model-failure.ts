import { BrowserError } from '@mohassan/browser';
import { ProviderError } from '@mohassan/providers';

/**
 * Names the real reason a chat turn got no model answer. Before this, every provider
 * failure reached the owner as one generic "could not reach the model", so a closed
 * gateway tunnel, a rejected key and a rate limit all looked the same.
 *
 * Only fixed text is shown: a provider's own message never reaches the conversation.
 */
type Failure = readonly [code: string, status: number, message: string];

const GATEWAY: Failure = ['CHAT_GATEWAY_UNREACHABLE', 503,
  'بوابة النماذج المجانية FreeLLMAPI لا تستجيب على العنوان المضبوط في الخادم، فلم يصل طلبك إلى أي نموذج. إعداد «المجاني فقط» يمنع تحويله إلى مزود آخر. شغّل البوابة أو افتح نفقها، أو راجع المزود في «الأدوات المتقدمة ← الاتصالات»، ثم أرسل «تابع».'];
const NO_PROVIDERS: Failure = ['CHAT_GATEWAY_NO_PROVIDERS', 409,
  'بوابة FreeLLMAPI متصلة، لكن لا يوجد فيها مفتاح مزود، فلا نموذج جاهزًا للرد. أضف مفتاح مزود مجاني في صفحة Keys داخل لوحة FreeLLMAPI، ثم أرسل «تابع».'];
const REJECTED: Failure = ['CHAT_PROVIDER_REJECTED', 502, 'رفض مزود النموذج مفتاح الاتصال أو صلاحية الحساب. حدّث الإعداد على الخادم ثم أرسل «تابع».'];
const NOT_CONFIGURED: Failure = ['CHAT_PROVIDER_NOT_CONFIGURED', 409, 'لم يُهيأ مزود نموذج للمحادثة على الخادم. راجع «الأدوات المتقدمة ← الاتصالات».'];
const MODEL: Failure = ['CHAT_MODEL_UNAVAILABLE', 502, 'النموذج المحدد غير متاح لدى المزود أو لا يدعم هذا الطلب. راجع اسم النموذج في إعداد الخادم.'];
const QUOTA: Failure = ['CHAT_PROVIDER_QUOTA', 429, 'نفدت الحصة المتاحة لدى مزود النموذج. تحتاج إلى تجدد الحصة أو تعديل إعداد المزود. حُفظت الصفحة والخطوات.'];
const BUSY: Failure = ['ASSISTANT_MODEL_BUSY', 503, 'النماذج المتاحة مشغولة الآن، وتعذرت المتابعة ضمن حدود الانتظار التلقائي. حُفظت الصفحة والخطوات.'];
const CONNECTION: Failure = ['CHAT_PROVIDER_UNREACHABLE', 502, 'انقطع الاتصال بمزود النموذج أو انتهت مهلته قبل الرد. أرسل «تابع» للمحاولة مجددًا.'];
const INVALID: Failure = ['CHAT_MODEL_INVALID', 502, 'أعاد النموذج ردًا غير صالح، ولم يُنفذ أي إجراء. أرسل «تابع» للمحاولة مجددًا.'];
const POLICY: Failure = ['CHAT_NO_ELIGIBLE_PROVIDER', 409, 'لا يوجد مزود نموذج مسموح لهذا الطلب حسب إعدادات المزودين الحالية، مثل «المجاني فقط». راجع «الأدوات المتقدمة ← الاتصالات».'];

/** In priority order: what a person must fix comes before what may pass by itself. */
const BY_CODE: readonly (readonly [readonly string[], Failure])[] = [
  [['AUTHENTICATION_FAILED', 'PERMISSION_DENIED'], REJECTED],
  [['NOT_CONFIGURED'], NOT_CONFIGURED],
  [['MODEL_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'], MODEL],
  [['GATEWAY_UNREACHABLE'], GATEWAY],
  [['GATEWAY_NO_PROVIDERS'], NO_PROVIDERS],
  [['QUOTA_EXHAUSTED'], QUOTA],
  [['RATE_LIMITED', 'COOLING_DOWN'], BUSY],
  [['ABORTED', 'NETWORK_ERROR', 'UPSTREAM_ERROR', 'STREAM_STALLED', 'STREAM_INTERRUPTED', 'TIMEOUT'], CONNECTION],
  [['INVALID_RESPONSE', 'INCOMPLETE_RESPONSE', 'MODEL_MISMATCH', 'RESPONSE_TOO_LARGE', 'REQUEST_REJECTED'], INVALID],
];

/** The provider codes behind a failure: the failure's own code, or what removed each routed candidate. */
export function failureCauses(error: ProviderError): string[] {
  if (error.code !== 'NO_ELIGIBLE_PROVIDER') return [error.code];
  const last = error.cause instanceof ProviderError ? [error.cause.code] : [];
  return [...new Set([...(error.causes ?? []), ...last])];
}

export function chatModelFailure(error: ProviderError): BrowserError {
  const causes = failureCauses(error);
  const known = BY_CODE.find(([codes]) => causes.some(cause => codes.includes(cause)));
  const [code, status, message] = known?.[1]
    // Every candidate was excluded by policy or capability, not by a failure.
    ?? (error.code === 'NO_ELIGIBLE_PROVIDER' && !causes.length ? POLICY
      : ['CHAT_PROVIDER_FAILED', 502, `تعذر الحصول على رد من النموذج (${causes[0] ?? error.code}). أرسل «تابع» وسأحاول مجددًا.`] as const);
  return new BrowserError(code, message, status);
}
