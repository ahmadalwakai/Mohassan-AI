import { detectManners } from '../manners/detect.js';
import { fixedReply, type LocalReply } from '../mind/limits.js';
import { requestLanguage, splitReplyDirective, type ReplyLanguage } from '../reply-directive.js';
import { maskRequestLiteralData } from '../request-constraints.js';
import { normalizeRefusalText } from './patterns.js';
import type { RefusalAlternative, RefusalCode, RefusalDecision } from './types.js';

const EN_REASON: Record<RefusalCode, string> = {
  unsafe: "I can't help with an action that could harm someone or compromise their security.",
  secrets: "I can't retrieve, share, or use passwords, card numbers, or one-time codes in chat.",
  other_account: "I can't access or act on someone else's account.",
  payment: "I can't make payments, purchases, or money transfers.",
  no_capability: "I can't perform that action from this chat.",
  no_access: "I can't access that private source from this chat.",
  future: "I can't run a task later or keep monitoring after this chat.",
  role: "I can't use owner-only tools from a member account.",
  human_step: "I can't complete a step that requires you to act in person or on your account.",
};

const EN_ALTERNATIVE: Record<RefusalAlternative, string> = {
  protect: 'I can help with steps to protect yourself or others.',
  private_output: 'I can help prepare a version with private details removed.',
  secure_entry: 'Enter the details directly on the official site yourself.',
  sign_in: 'Sign in to your own account, then I can help with the next step.',
  own_account: 'I can help with your own account.',
  compare: 'I can help you compare options before you buy.',
  review_payment: 'I can help you review the details before you confirm the payment.',
  draft: 'I can draft it for you to send.',
  manual_step: 'I can explain the steps so you can finish it yourself.',
  public_info: 'I can help you look up public information about it.',
  plan: 'I can help you make a plan or write a reminder you can set yourself.',
  forecast_sources: 'I can help you find forecasts and explain what information they use.',
  ask_owner: 'Ask the account owner to run the task.',
  describe_image: 'I can help write a description you can use to make the image.',
  find_media: 'I can help find where you can play it yourself.',
  share_material: 'Share an excerpt you have permission to share and I can help with it.',
  device_control: 'I can help you find the controls for your device.',
  place_order: 'I can help you compare options before you order.',
  make_booking: 'I can help you find options and booking information.',
  place_call: 'I can help you prepare what to say.',
  publish_content: 'I can help prepare the content so you can publish it.',
};

const AR_REASON: Record<RefusalCode, string> = {
  unsafe: 'لا أستطيع المساعدة في إجراء قد يؤذي أحدًا أو يعرّض أمانه للخطر.',
  secrets: 'لا أستطيع جلب كلمات المرور أو أرقام البطاقات أو رموز التحقق أو مشاركتها أو استخدامها في المحادثة.',
  other_account: 'لا أستطيع الدخول إلى حساب شخص آخر أو إجراء تغييرات فيه.',
  payment: 'لا أستطيع الدفع أو الشراء أو تحويل المال.',
  no_capability: 'لا أستطيع تنفيذ هذا الإجراء من المحادثة.',
  no_access: 'لا أستطيع الوصول إلى هذا المصدر الخاص من المحادثة.',
  future: 'لا أستطيع تنفيذ مهمة لاحقًا أو مواصلة المتابعة بعد المحادثة.',
  role: 'لا أستطيع استخدام أدوات مخصّصة للمالك من حساب عضو.',
  human_step: 'لا أستطيع تنفيذ خطوة تتطلب حضورك أو تدخّلك الشخصي في الحساب.',
};

type ArabicVoice = { can: string; youCan: string; then: string };

const AR_VOICES: readonly [RegExp, ArabicVoice][] = [
  [/(?<!\p{L})(?:هسه|تگدر|اگدر|مالتي|هوايه)(?!\p{L})/u, { can: 'أگدر', youCan: 'تگدر', then: 'وبعدها' }],
  [/(?<!\p{L})(?:عا(?:يز|وز)(?:ه|ك|ني)?|ازاي|دلوقتي|النهارده|تقدرش)(?!\p{L})/u, { can: 'أقدر', youCan: 'تقدر', then: 'وبعد كده' }],
  [/(?<!\p{L})(?:بدي|هلق|هيك|بتقدر)(?!\p{L})/u, { can: 'بقدر', youCan: 'فيك', then: 'وبعدها' }],
  [/(?<!\p{L})(?:ابغي|ابغاك|ابيك|وش|وشلون|الحين)(?!\p{L})/u, { can: 'أقدر', youCan: 'تقدر', then: 'وبعدها' }],
];
const STANDARD_AR: ArabicVoice = { can: 'يمكنني أن', youCan: 'يمكنك أن', then: 'ثم' };

function arabicVoice(source: string): ArabicVoice {
  const folded = source.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');
  return AR_VOICES.find(([marker]) => marker.test(folded))?.[1] ?? STANDARD_AR;
}

function arabicAlternatives({ can, youCan, then }: ArabicVoice): Record<RefusalAlternative, string> {
  return {
    protect: `${can} أساعدك بخطوات تحميك وتحمي غيرك.`,
    private_output: `${can} أساعدك في إعداد نسخة من دون البيانات الخاصة.`,
    secure_entry: `${youCan} تدخل البيانات بنفسك في الموقع الرسمي.`,
    sign_in: `سجّل الدخول إلى حسابك بنفسك، ${then} ${can} أساعدك في الخطوة التالية.`,
    own_account: `${can} أساعدك في حسابك أنت.`,
    compare: `${can} أساعدك في مقارنة الخيارات قبل الشراء.`,
    review_payment: `${can} أساعدك في مراجعة التفاصيل قبل تأكيد الدفع.`,
    draft: `${can} أكتب لك مسودة ترسلها بنفسك.`,
    manual_step: `${can} أشرح لك الخطوات لتكملها بنفسك.`,
    public_info: `${can} أساعدك في البحث عن المعلومات المتاحة للجميع.`,
    plan: `${can} أساعدك في وضع خطة أو كتابة تذكير تضبطه بنفسك.`,
    forecast_sources: `${can} أساعدك في العثور على التوقعات ومعرفة مصادرها.`,
    ask_owner: 'اطلب من مالك الحساب تنفيذ المهمة.',
    describe_image: `${can} أكتب لك وصفًا تستخدمه لإنشاء الصورة.`,
    find_media: `${can} أساعدك في العثور على مكان تشغّل فيه المقطع بنفسك.`,
    share_material: `شارك مقتطفًا لديك إذن بمشاركته، ${then} ${can} أساعدك فيه.`,
    device_control: `${can} أساعدك في العثور على أدوات التحكم في جهازك.`,
    place_order: `${can} أساعدك في مقارنة الخيارات قبل الطلب.`,
    make_booking: `${can} أساعدك في العثور على الخيارات ومعلومات الحجز.`,
    place_call: `${can} أساعدك في التحضير لما تريد قوله.`,
    publish_content: `${can} أساعدك في تجهيز المحتوى لتنشره بنفسك.`,
  };
}

const SPECIFIC_REASON: Partial<Record<RefusalAlternative, { code: RefusalCode; en: string; ar: string }>> = {
  private_output: { code: 'unsafe', en: "I can't share private information outside your workspace.", ar: 'لا أستطيع مشاركة معلومات خاصة خارج مساحة العمل.' },
  sign_in: { code: 'human_step', en: "I can't sign in on your behalf.", ar: 'لا أستطيع تسجيل الدخول نيابةً عنك.' },
  draft: { code: 'human_step', en: "I can't send the message from this chat.", ar: 'لا أستطيع إرسال الرسالة من المحادثة.' },
  forecast_sources: { code: 'future', en: "I can't know that future result for certain.", ar: 'لا أستطيع معرفة النتيجة المستقبلية على وجه اليقين.' },
  describe_image: { code: 'no_capability', en: "I can't create images from this chat.", ar: 'لا أستطيع إنشاء الصور من المحادثة.' },
  find_media: { code: 'no_capability', en: "I can't create or play audio or video from this chat.", ar: 'لا أستطيع تشغيل الصوت أو الفيديو أو إنشاءهما من المحادثة.' },
  device_control: { code: 'no_capability', en: "I can't control your device from this chat.", ar: 'لا أستطيع التحكم في جهازك من المحادثة.' },
  place_order: { code: 'payment', en: "I can't place an order for you.", ar: 'لا أستطيع تقديم طلب شراء نيابةً عنك.' },
  make_booking: { code: 'human_step', en: "I can't make a booking for you.", ar: 'لا أستطيع إجراء الحجز نيابةً عنك.' },
  place_call: { code: 'human_step', en: "I can't make a phone call for you.", ar: 'لا أستطيع إجراء مكالمة نيابةً عنك.' },
  publish_content: { code: 'human_step', en: "I can't publish content to an external service for you.", ar: 'لا أستطيع نشر المحتوى على خدمة خارجية نيابةً عنك.' },
};

/** Use the instruction's opening language so names and content in its operands do not switch the reply. */
function refusalLanguage(source: string): ReplyLanguage {
  const prose = source.replace(/(?:https?:\/\/|www\.)[^\s<>"'،«»]+|[\w.+-]+@[\w.-]+\.[a-z]+/giu, ' ');
  const action = normalizeRefusalText(detectManners(prose)?.request ?? prose);
  const initialLetter = /(?=\p{L})[\p{Script=Arabic}\p{Script=Latin}]/u.exec(action)?.[0];
  return requestLanguage(initialLetter ?? '');
}

/** Uses the request to pick language and dialect. The reply itself contains only fixed copy. */
export function refusalReply({ code, alternative }: RefusalDecision, request: string): LocalReply {
  const framing = splitReplyDirective(request);
  const source = maskRequestLiteralData(framing.body);
  const lang = framing.directive?.lang ?? refusalLanguage(source);
  const specific = SPECIFIC_REASON[alternative];
  if (lang === 'ar') {
    const reason = specific?.code === code ? specific.ar : AR_REASON[code];
    return fixedReply(`${reason} ${arabicAlternatives(arabicVoice(source))[alternative]}`, 'blocked');
  }
  const reason = specific?.code === code ? specific.en : EN_REASON[code];
  return fixedReply(`${reason} ${EN_ALTERNATIVE[alternative]}`, 'blocked');
}
