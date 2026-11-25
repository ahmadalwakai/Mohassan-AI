import { requestOperationText } from '../request-scope.js';

export function normalizeRefusalText(value: string): string {
  return requestOperationText(value.replace(/[\p{Cf}]/gu, '').replace(/[’‘]/gu, "'")
    .replace(/(?<=\p{L})[-‐‑](?=\p{L})/gu, ' '));
}

// Bound both scripts with Unicode letters rather than JavaScript's ASCII word boundary.
export const words = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'u');
export const head = (pattern: string) => new RegExp(`^(?:${pattern})(?![\\p{L}\\p{N}_])`, 'u');

export const secretTarget = words(
  'passwords?|passcodes?|passphrases?|passwd|otp(?:s)?|one[ _-]?time (?:codes?|passcodes?|passwords?)|(?:verification|security|authentication|login|2fa|mfa|backup|recovery) codes?|(?:credit|debit|bank|payment) card(?: numbers?| details?| data)?|card (?:numbers?|details?|data)|cv[cv]|pins?|api[ _]?keys?|(?:access|refresh|auth) tokens?|client secrets?|private keys?|login credentials|كلم(?:ه|ات) (?:ال)?(?:مرور|سر)(?:ي|ك|ه|ها)?|باسورد(?:ي|ك|ه|ها)?|رم(?:ز|وز) (?:التحقق|الدخول|الامان|المصادقه|التاكيد)|(?:كود|رمز) (?:التحقق|التاكيد|المرور|الدخول|الامان|لمره واحده|مره واحده)|(?:رقم|ارقام|بيانات|تفاصيل) (?:بطاق(?:ه|تي|تك|ته|تها)|الكارت|كارت|البطاقه|الفيزا|فيزا)(?: الائتمان(?:يه)?| المصرفيه)?|الرقم السري|رقم التعريف الشخصي|مفتاح api',
);

export const paymentTarget = words(
  'payments?|purchases?|orders?|checkout|check out|wire transfer|bank transfer|money|funds|bills?|invoices?|subscriptions?|rent|cash|deposit|withdrawal|دفع|الدفع|شراء|الشراء|الطلب|طلب الشراء|عمليه الشراء|مدفوعات|فاتوره|الفاتوره|الفواتير|الاشتراك|ايجار|الايجار|مبلغ|المبلغ|اموال|الاموال|فلوس|الفلوس|حواله|الحواله|رصيد|الرصيد|(?:حسابي|حسابنا) (?:البنكي|المصرفي)',
);

export const humanVerificationTarget = words(
  'captchas?|recaptcha|human (?:check|verification)|robot (?:check|verification)|i am not a robot|owner(?:\'s)? (?:permission|approval|verification)(?: card)?|(?:permission|approval|consent|confirmation|review) (?:card|prompt|step|check|dialog|gate)|(?:device|phone) (?:check|approval|verification)|(?:identity|age) (?:check|verification)|(?:ال)?(?:كابتشا|كابشا)|تحقق بشري|التحقق البشري|اختبار الروبوت|لست روبوت|بطاقه (?:الموافقه|الاذن|التاكيد)|موافقه (?:المالك|صاحب الحساب)|التحقق (?:من (?:الهويه|هويتي|هويتنا)|من المالك|المطلوب من المالك)|اثبات الهويه|اثبات العمر|اذن المالك|تاكيد الهويه',
);

export const accountTarget = words(
  'accounts?|profiles?|dashboards?|workspaces?|inbox(?:es)?|browsers?|tabs?|desktops?|computers?|devices?|files?|documents?|notes?|records?|messages?|emails?|data|m[eé]mory|passwords?|credentials|حساب(?:ه|ها|هم|ات|ات[ه]م|ي|نا)?|الحساب(?:ات)?|بيانات(?:ه|ها|هم)?|البيانات|ملفات(?:ه|ها|هم)?|الملفات|وثائق(?:ه|ها|هم)?|الوثائق|مستندات(?:ه|ها|هم)?|المستندات|ملاحظات(?:ه|ها|هم)?|الملاحظات|ذاكر(?:ه|ته|تها|تهم)|الذاكره|تبويبات|التبويبات|الجهاز|جهاز(?:ه|ها|هم)?|بريد(?:ه|ها|هم)?|(?:ال)?ايميل(?:ه|ها|هم)?|البريد|الرسائل|كلمه السر|رمز التحقق',
);

export const accountAction = head(
  'open|read|view|access|inspect|show|give|list|copy|export|download|forward|send|publish|post|reset|change|edit|update|delete|remove|log ?in(?:to)?|sign ?in(?:to)?|connect|select|use|switch to|find|fetch|get|pull|recover|reveal|print|display|retrieve|tell|take|launch|run|impersonate|enter|افتح|ادخل|اقرا|اعرض|شوف|وريني|استعرض|استرجع|جيب|هات|طلع|استخرج|انقل|انسخ|صدر|حمل|نزل|ارسل|ابعت|ابعث|انشر|احذف|امسح|غير|عدل|استعمل|استخدم|دخل|سجل(?:لي)?|شغل|نفذ|اطبع|اكشف',
);

export const otherOwner = words(
  "another (?:account|user|member|person|employee|customer|owner|tenant)(?:'s)?|(?:someone|anyone|everybody|everyone|somebody) else's|(?:other|different) (?:users?|members?|people|persons?|accounts?|customers?|tenants?|employees?|people's|users'|members'|persons'|accounts'|customers'|employees')(?:'s)?|(?:the )?(?:workspace )?owner's|(?:my |our |the )(?:coworker|colleague|boss|manager|ex|friend|partner|neighbor|neighbour|sister|brother|spouse|husband|wife|mother|father|client|customer|teammate)(?:'s|s')|their (?:private|personal|saved|stored|login)|(?:his|her|their) (?:account|profile|mailbox|inbox|dashboard|device)|(?:isn't|is not|aren't|are not) (?:mine|ours|my account|our account)|i (?:don't|do not) own|without (?:their|the owner's) (?:knowledge|permission|consent)|(?:عضو|العضو|شخص|الشخص|حد|مستخدم|المستخدم|عميل|العميل|الحساب|حساب|صاحب الحساب) (?:اخر|الآخر|الاخر|الاخري|اخري|الثاني|الثانيه|تاني|التاني|التانيه|ثاني|غيري)|(?:صاحبي|زميلي|اخوي|اختي|اخي|جارنا|جاري|ابوي|ابي|امي|مديري|موظف|موظفي|عميلي)|(?:حساب|ايميل|بريد|صندوق بريد) (?:المدير|المشرف|الزميل|الزميله)|(?:غير|مش|مو|ليس) (?:حسابي|حسابنا|ملكي)|المالك|صاحب الحساب الثاني",
);

export const publicMaterial = words(
  'public (?:profile|bio|page|website|post|article|report|record|information|documents?|company profile)|published (?:bio|article|report)|official (?:website|page)|(?:الملف|الحساب|الموقع|صفحه|الصفحه) (?:العام|العامه|الرسمي|الرسميه)|(?:تقرير|منشور|خبر) منشور',
);

export const privateMaterial = words(
  'private (?:workspace|account|browser|notes?|docs?|documents?|files?|records?|memory|emails?|messages?|data|saved notes?)|(?:internal|confidential|restricted) (?:workspace|notes?|docs?|documents?|files?|records?|memory|emails?|messages?|data)|(?:owned|saved|stored|personal) (?:notes?|memory|records?|data)|owner memory|الذاكره الخاصه|ذاكره خاصه|الذاكره المحفوظه|البيانات الخاصه|بيانات خاصه|الملاحظات الخاصه|الملفات الخاصه|الوثائق الخاصه|ملفات خاصه|مستندات خاصه|محتوي الذاكره(?: الخاصه)?',
);

export const externalDisclosure = words(
  'public (?:page|website|site|channel|chat|forum|link|post|service|system)|publicly|online|on the (?:open |public )?web|open (?:channel|forum)|everyone|anyone|outside (?:the )?(?:company|workspace|organization)|external (?:channel|address|site|system|service)|my (?:email|inbox)|[لب]?(?:صفحه عامه|موقع عام|قناه عامه|خدمه عامه|نظام عام|منتدي عام)|للعلن|للجميع|للكل|برا الشركه|بريدي|حساب خارجي',
);

export const disclosureAction = head('share|publish|post|email|forward|send|upload|broadcast|expose|transfer|export|ارسل|ابعت|ابعث|انشر|شارك|ارفع|وزع|سرب|انقل|صدر');

export const secretAction = head(
  'read|see|view|show|tell|give|fetch|get|find|retrieve|recover|look up|reveal|disclose|dump|expose|extract|export|copy|save|store|remember|record|send|forward|share|use|type|enter|paste|submit|fill (?:in|out)|repeat|keep|print|display|upload|insert|input|text|email|take note of|where (?:is|are) (?:my|our|the stored|the saved)|what (?:is|are) (?:my|our|the stored|the saved)|اقرا|شوف|اعرض|وريني|ارني|قل لي|قلي|هات|جيب|طلع|استرجع|استخرج|ابحث عن|دور علي|اكشف|افش|اطبع|انسخ|خزن|سجل|تذكر|احفظ|ارسل|ابعث|ابعت|شارك|استخدم|استعمل|اكتب|ادخل|دخل|الصق|املا|عب|كرر|احط|حط|وين|ما (?:هي|هو)|وش',
);

export const paymentAction = head(
  'pay|purchase|buy|check ?out|place (?:a|an|the|my|our|this|that) (?:new )?order|(?:confirm|complete|finali[sz]e|submit) (?:a|an|the|my|our|this|that) (?:order|payment|purchase|checkout)|subscribe (?:me |us )?to|renew (?:my|our|the|this) (?:paid |premium )?subscription|اشتر(?:ي|يلي|لي|يه|يها|يهم)?|ادفع(?:لي)?|سدد|سددي|اشتري|اكد (?:الطلب|الدفع|الشراء|الاشتراك)|اتمم (?:الطلب|الدفع|الشراء)|كمل (?:الطلب|الدفع|الشراء)|اطلب(?:لي)?|اشتريلي|اشترك',
);

export const transferAction = head(
  'transfer|wire|send|move|withdraw|deposit|remit|donate|حول(?:لي|ها|ه)?|حوّل|ارسل|ابعث|ابعت|اسحب|اودع|تبرع',
);

export const moneyAmount = /(?:[$€£]\s*\d|\b\d+(?:[.,]\d+)?\s*(?:usd|gbp|eur|sar|aed|dollars?|pounds?|cents?|euros?)\b|\d+(?:[.,]\d+)?\s*(?:ريال|جنيه|دولار|درهم|يورو|دينار))/u;
export const paymentQualifier = words('checkout|payment|purchase|wire transfer|money transfer|place order|buy now|pay now|confirm order|confirm payment|complete purchase|renew subscription|الدفع|ادفع الان|اشتر الان|تاكيد الدفع|تاكيد الشراء|تاكيد الطلب|اتمام الدفع|اتمام الشراء');
export const genericAction = head('click|press|tap|select|confirm|approve|submit|complete|run|perform|do|نفذ|اضغط|انقر|دوس|اختار|اكد|اتمم|وافق|اعتمد|اكمل|كمل|اعمل');

export const riskyInstruction = head(
  "how to|how (?:do|can|could|would|should) (?:i|we|you)|tell (?:me|us) how to|(?:find|search for|look up) (?:steps|instructions|a guide|a tutorial) (?:to|for)|show (?:me|us) how to|explain how to|teach (?:me|us) how to|give (?:me|us) (?:steps|instructions|a guide|a tutorial) (?:to|for)|(?:steps|instructions|guide|tutorial) (?:to|for)|(?:كيف|ازاي|شلون|ازاى)(?: اقدر| استطيع)?|علمني (?:كيف|ازاي|شلون)|(?:اشرح|وضح) (?:لي )?(?:كيف|ازاي|شلون)|(?:اعطني|عطني|اديني) (?:خطوات|طريقه)(?: ل)?|طريقه",
);

export const harmfulAction = head(
  'hack(?:ing)? (?:into\\b|[a-z]+\\s+(?:account|website|server|network)|(?:the|my|our|someone|anyone|their|an?|another|this|that)\\b)|break into|(?:run|trigger|launch|use) (?:an? |the )?exploit (?:against|on)|steal(?:ing)?|doxx?(?:ing)?|blackmail(?:ing)?|stalk(?:ing)?|scam(?:ming)?|impersonat(?:e|ing)|phish(?:ing)?\\s+(?:my|our|a|the|their|your|users|customers|employees)|(?:deploy|install|spread|write|create|build|code|run|generate)\\s+(?:an? |the |some )?(?:malware|ransomware|keylogger|spyware|credential stealer|phishing page|phishing kit|phishing email|exploit to (?:break|hack|gain access))|(?:make|build|assemble|construct|manufacture|put together)\\s+(?:(?:me|us) )?(?:an? |the |some )?(?:homemade )?(?:bombs?|explosives?|poison|weapon for an attack)|kill(?:ing)?|murder(?:ing)?|(?:hurt|harm|injure|poison|attack)\\s+(?:my|our|someone|people|anyone|another|a person|the person)|(?:plan|carry out)\\s+(?:an? |the )?(?:violent attack|armed attack|shooting|robbery)|forge\\s+(?:a |an |the |my |someone\'s )?(?:signature|passport|document|identification|identity)|(?:اهكر|هكر|اخترق|اختراق)\\s+(?:ال)?(?:حساب|موقع|جهاز|شبكه|سيرفر|بريد|الواي فاي)|(?:اسرق|سرقه|ابتز|ابتزاز|انصب علي|احتال علي|اقتل|قتل|اذي|اوذي|اؤذي|(?:اسمم|سمم) (?:كلب|قط|حيوان|طعام|شراب|اكل|شخص)|اغتال|اغتيال)|(?:اصنع|اعمل|اسوي|صنع|تصنيع|جهز|تركيب|اعمل لي)\\s+(?:لي )?(?:قنبله|متفجرات|عبوه ناسفه|سلاح للهجوم)|(?:انشر|اكتب|اصنع|اعمل|سوي|صمم)\\s+(?:برنامج (?:خبيث|تجسس)|فيروس (?:كمبيوتر|للسرقه)|رساله تصيد|صفحه تصيد)|زور\\s+(?:توقيع|جواز|هويه)',
);

export const harmlessTechnicalObject = head('kill (?:a|the|this|that|my) (?:(?:running|background|unresponsive|stuck|hung|local|node|python) )?(?:process|job|thread|task|server)');

export const unsafeCircumvention = head(
  'bypass|skip|ignore|disable|evade|circumvent|defeat|remove|turn off|work around|fake|اعبر|تجاوز|تخط(?:ي)?|عدي|تجاهل|الغ|الغي|عطل|تحايل علي|لف علي',
);

export const ownershipControls = words(
  'ownership controls?|(?:account|role|access|permission|tenant|authorization|security) (?:controls?|restrictions?|checks?|boundaries)|(?:approval|verification|security|permission|consent) (?:requirement|step|check|gate|prompt)|permission checks?|approval|consent|authorization|صلاحيات المالك|الملكيه|الموافقه|الاذن|شرط التحقق|شرط الموافقه|قيود الصلاحيه|حدود الحساب',
);

export const loginAction = head('(?:log|sign) ?in(?:to)?|authenticate|sso into|enter (?:my|our) account|سجل(?:لي)? (?:دخول|الدخول)|ادخل (?:في|علي|الي)?\\s*(?:حسابي|حسابنا)|افتح جلس(?:ه|تي)|سو(?:ي)? تسجيل دخول');
export const personalLogin = words('my|our|as me|as us|on my behalf|on our behalf|for me|for us|with my|using my|حسابي|حسابنا|عني|نيابه عني|بدالي|باسمي|لي|دخولي');
export const humanStepAction = head('solve|complete|pass|approve|accept|check|confirm|certify|verify|perform|do|click|press|tap|sign|tick|submit|حل|اكمل|كمل|اجتز|ادخل|اعبر|وافق|اقبل|اكد|اثبت|تحقق|نفذ|اعمل|اضغط|انقر|دوس|وقع|اعتمد');
export const humanCommitment = words('(?:legal|binding|lease|employment|consent) (?:agreement|form|contract|document)|(?:terms and conditions|terms of service|privacy consent)|(?:contract|agreement|lease|waiver) (?:on my behalf|for me|as me)|(?:my|the) (?:legal )?signature|(?:عقد|العقد|اتفاقيه|الاتفاقيه|اقرار|الاقرار|موافقه) (?:نيابه عني|بدالي|باسمي)|الشروط والاحكام|شروط الاستخدام|توقيعي|توقيع العقد|عقد (?:الايجار|العمل)');

export const sendAction = head(
  'send|forward|deliver|email|mail|text|whatsapp|dm|message|ارسل(?:ه|ها|هم|لي)?|ابعث(?:ه|ها|هم)?|ابعت(?:ه|ها|هم)?|راسل|ابعتلي',
);
export const outreach = words(
  'emails?|e mail|messages?|texts?|sms|whatsapp|letters?|dm|to [a-z0-9_.+-]+@[a-z0-9.-]+|رساله|الرساله|رسائل|ايميل|الايميل|البريد|بريد(?:ي)?|واتساب|واتس|اس ام اس|خطاب|الخطاب',
);
export const draftReference = head('(?:send|forward|deliver|email|mail|text) (?:it|them|this)\\b|(?:ارسل|ابعث|ابعت)(?:ه|ها|هم)');

export const ownerCapabilityTarget = words(
  'owner tools?|owner console|workspace admin(?:istration)?|admin (?:tools?|console|settings)|workspace settings|member management|membership settings|(?:owner|workspace) invites?|invite (?:a |an )?(?:new )?(?:member|user)|member (?:quota|limits?)|owner(?:\'s)? (?:computer|desktop|browser|tabs?|projects?|skills?)|(?:my |the |this )?(?:pc|computer|desktop) (?:screen|window|session|files?|browser)|(?:my|the|this) (?:computer|desktop|pc)|skills? engine|(?:system|workspace|owner) providers?|(?:active|enabled) providers|local filesystem|local files?|local paths?|local projects?|workspace computer|pair (?:my |the |this )?(?:windows computer|windows device)|studio tasks?|website publishing|ادوات المالك|لوحه المالك|ادوات المشرف|اعدادات (?:المالك|مساحه العمل|الاداره|المستخدمين)|اداره الاعضاء|دعوات (?:المالك|الاعضاء)|دعوه (?:عضو|مستخدم)|(?:كمبيوتر|حاسوب|جهاز|متصفح|مشاريع|مهارات) المالك|جهازي|كمبيوتري|حاسوبي|سطح (?:المكتب|مكتبي)|مسار محلي|الملفات المحليه|(?:مشاريعي|المشاريع) المحليه|كمبيوتر مساحه العمل|اربط جهاز ويندوز|محرك المهارات|اداره المزودين|مزودي مساحه العمل',
);
export const ownerCapabilityAction = head(
  'open|launch|run|use|configure|manage|change|enable|disable|access|view|read|show|list|give|install|inspect|update|edit|repair|fix|refactor|invite|grant|promote|restart|enter|publish|pair|look at|what (?:is|are|can you see|do you see|does)|افتح|شغل|نفذ|استخدم|ادخل|اعرض|اقرا|شوف|وريني|ارني|اظهر|ماذا|ما عنوان|اعد|ادع|ادعو|غير|عدل|ثبت|افحص|اصلح|انشر|ارفع|اربط|اداره',
);
export const sitePublish = words('publish (?:my |our |the |this )?(?:generated )?(?:website|site)\\b|post (?:my |our |the |this )?site live|انشر (?:الموقع|موقعي|موقعنا|هذا الموقع)');
export const workspaceRoleChange = words('(?:invite|revoke|remove|disable|promote|add) (?:a |an |the |another |new )?(?:workspace )?(?:member|user)\\b|(?:دعوه|ادع|ادعو|اضف|ازل|احذف|رق) (?:عضو|مستخدم)');

export const delayedScheduling = head(
  "remind (?:me|us)(?! of\\b)|set (?:an? |the |my |our )?(?:alarm|reminder|timer)\\b|schedule (?:a |an |the |my |our |this |that )?(?:task|reminder|notification|call|appointment|message|email|post|meeting)\\b|wake (?:me|us) (?:up )?(?:at|in|tomorrow)|ذكرني(?: بكرا| بكره| غدا| بعد| الساعه| يوم| بموع[دظ])|نبهني|فكرني|اضبط (?:تنبيها?|المنبه|منبها?)|حط (?:منبه|تذكير)|جدول (?:رساله|مهمه|تنبيه|تذكير)",
);

export const futureAction = head(
  "wait (?:until|for)|(?:come|get|check) back|run|repeat|retry|call|send|email|message|notify|check|keep checking|monitor|watch|open|download|publish|post|ابحث|انتظر|استني|استنا|ارجع|شغل|كرر|اتصل|ارسل|ابعت|ابعث|افتح|راقب|تابع|انشر|دور",
);
export const futureTime = words(
  'tomorrow|overnight|later today|(?:at|in) (?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|an?) (?:hours?|minutes?|days?|weeks?)|in the future|next (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|every (?:day|week|month|hour|morning|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|when i (?:leave|come back|get back|go offline)|after i (?:leave|go offline)|غدا|بكرا|بكره|باجر|باكر|بعد (?:ساعه|ساعتين|دقيقه|دقائق|\\d+|يوم|يومين|اسبوع|شهر)|(?:الاسبوع|الشهر|العام) (?:القادم|الجاي)|كل (?:ساعه|يوم|اسبوع|شهر|صباح|ليله)|طول الليل|اذا (?:طلعت|رجعت)',
);
export const immediateOperand = words('for (?:tomorrow|next (?:week|month|year))|about (?:tomorrow|next (?:week|month|year))|(?:tomorrow|next (?:week|month|year))(?:\'s) (?:weather|forecast|agenda|schedule)|بخصوص|عن (?:الطقس|الجو|بكره|بكرا|غدا)|(?:طقس|الطقس|جو|الجو|حاله الطقس) (?:بكره|بكرا|غدا)|ل(?:بكره|بكرا|غدا)');
export const guaranteedForecast = words(
  'winning lottery numbers?|(?:exact|guaranteed|certain) (?:future |next |tomorrow\'s )?(?:stock price|closing price|exchange rate|bitcoin price|match score|score|result|outcome|forecast)|(?:exactly|with certainty) (?:what will|who will|how much).+\\b(?:tomorrow|next week|next month|next year)\\b|(?:الارقام|ارقام) (?:اليانصيب|اللوتو) (?:الفائزه|الرابحه)|(?:السعر|النتيجه|الفائز) (?:المضمون|المضمونه) (?:غدا|بكرا|بكره|مسبقا)|(?:نتيجه|سعر) .{1,50} (?:غدا|بكرا|بكره) (?:بالضبط|بالتاكيد)|(?:توقع|تنبأ|تنبا) .{1,60} (?:بشكل اكيد|من دون اي خطا|بدون اي خطا)',
);

export const physicalAction = head(
  'print (?:.{1,60} )?on paper|turn (?:on|off) (?:my |the |our )?(?:kitchen |living room |bedroom |office )?(?:lights?|stove|oven|heater|air conditioner)|(?:lock|unlock) (?:my|our|the) (?:door|car|house)|water (?:my|our|the) (?:plant|plants|garden)|feed (?:my|our|the) (?:cat|dog|pet)|deliver (?:a|the|my) (?:parcel|package|groceries)|(?:go|come|drive|walk) to (?:my|our|the) (?:house|door|office|shop|store)|(?:lift|pick up|carry|move) (?:my|our|the) (?:sofa|desk|chair|furniture)|(?:make|bring|brew) (?:me |us )?(?:a |some )?(?:coffee|tea|dinner)|(?:open|close) (?:my|our|the) (?:front door|garage door)|اطبع (?:.{1,60} )?علي الورق|(?:طف|طفي|اطف|اطفي|شغل) (?:النور|الانوار|ان(?:وار|اره) (?:المطبخ|البيت|الغرفه)|الضوء|الاضاءه|الفرن|المكيف|الموقد)|(?:افتح|سكر|اقفل|اغلق) (?:باب البيت|باب المنزل|باب السياره|السياره)|(?:اسق|اسقي) (?:النباتات|الزرع|الحديقه)|(?:اطعم|اكل) (?:قطتي|كلبي)|(?:جيب|احضر|هات|اعمل|سوي) (?:لي )?(?:قهوه|شاي)|(?:انقل|شيل|احمل) (?:الكنبه|الاثاث)',
);
export const outsideAccess = words(
  'offline (?:device|computer|pc|drive)|unshared (?:document|file|drive|screen|window)|(?:device|computer|drive|screen|window|document|file) (?:that is )?not (?:connected|shared|uploaded)|(?:computer|device|drive) (?:that is )?disconnected|(?:my|our) (?:closed|unopened) apps?|(?:my|our) bank (?:balance|statement)|(?:private|closed|internal) (?:intranet|network|vault|database)|(?:جهاز|حاسوب|كمبيوتر|قرص|مجلد|ملف|مستند|موقع|شاشه|نافذه) (?:غير متصل|غير متصله|غير مشارك|غير مشاركه|لم اشاركه|لم ارفعه)|(?:رصيدي|كشف حسابي) (?:في |من )?(?:البنك|المصرف)|(?:قاعده بيانات|شبكه) (?:مغلقه|داخليه)',
);
export const genericRequestForOwnMaterial = words('my (?:gmail|private inbox|email inbox|unshared files?)|our (?:private inbox|email inbox|unshared files?)|بريدي (?:الخاص|الشخصي)|صندوق بريدي');
