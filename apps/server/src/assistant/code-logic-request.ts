import { assessRequestScope, requestOperationText, requestScopeActionText } from './request-scope.js';
import { reviewWorkRequestScope } from './work-request-scope.js';

const ARABIC = [
  /^(?:اجعل|خلي)\s+(?:(?:ال)?(?:داله|وظيفه|طريقه|كود|برنامج|تطبيق|مشروع|واجهه|مكون|خادم)\s+\S|.+?\s+(?:تضرب|يضرب|تجمع|يجمع|تعمل|يعمل|تعيد|يعيد|ترجع|يرجع|تدعم|يدعم|تقبل|يقبل|تعرض|يعرض|بدل ان)(?!\p{L}))/u,
  /^(?:غير|بدل)\s+(?:ال)?(?:سلوك|منطق)\s+\S/u,
  /^(?:اضف|احذف|ازل)\s+(?:ال)?(?:داله|وظيفه|خاصيه|ميزه|طريقه|مكون|نقطه نهايه)(?!\p{L})/u,
];
const ENGLISH = [
  /^make\s+(?:(?:the\s+)?(?:function|method|code|app|project|component|api|cli)\s+\S|.+?\s+(?:do|act|behave|return|multiply|add|subtract|divide|support|accept|display|show|use|run|exit|handle)\b)/u,
  /^change\s+(?:(?:the|its)\s+)?(?:behaviou?r|logic)\s+\S/u,
  /^(?:add|remove|delete)\s+(?:(?:a|an|the|a new)\s+)?(?:function|method|feature|component|endpoint)\b/u,
];

type LogicLanguage = 'ar' | 'en';

/** Recognize a direct behavior change independently of the normal coding route's repair vocabulary. */
export function recognizeCodeLogicRequest(request: string): LogicLanguage | null {
  const text = requestOperationText(requestScopeActionText(request));
  const language = ARABIC.some(pattern => pattern.test(text)) ? 'ar' : ENGLISH.some(pattern => pattern.test(text)) ? 'en' : null;
  if (!language || assessRequestScope(request).destination === 'writing') return null;
  return reviewWorkRequestScope(request, 'code_prepare').allowed ? language : null;
}

export function codeLogicReply(request: string, project: string, language: LogicLanguage, sandboxAvailable: boolean) {
  const goal = request.trim();
  const text = language === 'ar'
    ? `فهمت أنك تريد تغيير سلوك «${project}»، وطلبك هو «${goal}». تغيير المنطق يحتاج إلى نموذج لا يعمل الآن. لم أشغّل شيئًا.\n\n`
      + 'أستطيع الآن البحث في ملفات المشروع وقراءة علاقات الاستيراد. '
      + (sandboxAvailable ? 'أستطيع أيضًا ' : 'عند توفر بيئة العزل، أستطيع ')
      + 'تشغيل الفحوص وشرح نتائجها، وتطبيق الإصلاحات المثبتة بعد موافقتك.'
    : `I understood that you want to change the behaviour of “${project}”. Your request was “${goal}”. A logic change needs a model, which is not running now. I ran nothing.\n\n`
      + 'I can search the project files and inspect imports now. '
      + (sandboxAvailable ? 'I can also ' : 'When the sandbox is available, I can ')
      + 'run the checks and explain the results, and apply proven fixes with your approval.';
  return { kind: 'reply', text, status: 'blocked', direct: true } as const;
}
