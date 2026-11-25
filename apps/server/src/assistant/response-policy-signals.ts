import type { MannersDialect } from './manners/detect.js';

const boundary = String.raw`(?![\p{L}\p{N}])`;
const clauseEnd = String.raw`(?=\s*(?:$|[.,،;؛!?؟\n]|\band\b|و\s+))`;
const lead = String.raw`^(?:(?:please|kindly|can you|could you|would you|i (?:want|need) you to|من فضلك|لو سمحت|ممكن|اريدك ان)\s+)*`;
const start = (pattern: string) => new RegExp(lead + '(?:' + pattern + ')' + boundary, 'iu');

const lengthWords = String.raw`in (?:more |full |great )?detail|(?:a )?(?:detailed|in-depth) (?:answer|explanation|reply|overview)|بالتفصيل|بشكل مفصل|شرح مفصل|تفاصيل اكثر|briefly|concisely|باختصار|بايجاز|بشكل مختصر`;
const replyLength = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${lengthWords})${clauseEnd}|${lead}(?:${lengthWords})${boundary}`, 'giu');
const briefWords = /briefly|concisely|باختصار|بايجاز|مختصر/u;
const numberOnly = /(?:^|[\s,،.])(?:(?:just|only) (?:the )?(?:answer|result|value|number)|(?:the )?(?:answer|result|value|number) only|(?:النتيجه|الناتج|الجواب|الاجابه|الرقم|القيمه) (?:فقط|بس))\s*[.!?؟]*$/u;
const oneSentence = /(?:^|\s)(?:in (?:just )?(?:one|a single|1) (?:line|sentence)|(?:في |ب)(?:سطر|جمله) (?:واحد[ه]?|فقط))\s*[.!?؟]*$/u;

export function explicitLength(text: string): 'short' | 'long' | null {
  const matches = [...text.matchAll(replyLength)];
  const last = matches.at(-1)?.[0];
  if (numberOnly.test(text) || oneSentence.test(text)) return 'short';
  if (last) {
    // The surrounding clause must ask for this format, rather than forbid it.
    const at = matches.at(-1)!.index;
    if (/(?:\bnot|\bwithout|\bdon't answer|لا تجب|بدون|دون)\s*$/u.test(text.slice(0, at))) return null;
    return briefWords.test(last) ? 'short' : 'long';
  }
  return null;
}

const NO_STRUCTURE = /\b(?:no|without(?: any)?)\s+(?:bullet points|bullets|lists|headings|steps)\b|\b(?:plain text|one paragraph|continuous prose)\b|(?:بدون|بلا|من دون|دون) (?:نقاط|قوائم|عناوين|خطوات)|(?:في |ب)فقره واحده/u;
const REQUESTED_FORMAT = /\b(?:as|in|use|make|format(?: it)? as) (?:an? )?(?:table|json|csv|yaml|diagram|code block)\b|(?:علي شكل|في|بصيغه|ك)(?:\s*)(?:جدول|مخطط|كتله شيفره|json|csv|yaml)(?!\p{L})/u;
const HEADINGS = /\b(?:use|with|into|in) (?:(?:one|two|three|four|five|[1-9]) )?(?:separate |named |clear )?(?:sections|headings)\b|(?:قسمه الي|قسمها الي|استخدم|مع|في) (?:اقسام|عناوين)/u;
const EXPLICIT_STEPS = /\bstep[ -]by[ -]step\b|\b(?:give(?: me)?|list|show(?: me)?|what are|include|in) (?:the |numbered )?(?:steps|instructions)\b|خطوه بخطوه|(?:اعطني|اذكر|اشرح|ما هي|في|ضمن|وضح) (?:ال)?خطوات/u;
const PROCEDURE = start(String.raw`(?:how (?:do|can|should) (?:i|we|you)|how to) (?:set up|install|replace|assemble|connect|configure|make|reset|write|prepare|cook|clean|fix|build)|(?:كيف|ازاي|شلون|كيفاش) (?:اضبط|اثبت|اركب|اوصل|اعد|اصلح|اصنع|اطبخ|اكتب|ابني)|walk me through|خذني خطوه بخطوه`);
const LIST = start(String.raw`list|enumerate|name (?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\b|(?:give|show) (?:me )?(?:an? )?list|(?:what|which) are (?:the |some )?(?:types|kinds|options|examples|ingredients|advantages|risks)|(?:اعرض|اكتب|اعطني) (?:لي )?قائمه|اعدد|(?:اذكر|عدد) (?:[2-9]|اثنين|ثلاث(?:ه)?|اربع(?:ه)?|خمس(?:ه)?|ست(?:ه)?|سبع(?:ه)?|ثمان(?:يه)?|تسع(?:ه)?|عشر(?:ه)?)|ما (?:هي )?(?:انواع|امثله|خيارات|مكونات)`);
const LIST_FORMAT = /\b(?:as|in|use|with) (?:a )?(?:bulleted list|bullet points|bullets)\b|(?:علي شكل|في) (?:قائمه|نقاط)|بنقاط/u;
const MULTI_SECTION = /\b(?:compare|contrast)\b[^.?؟\n]{0,250}\b(?:dimensions|criteria|trade[ -]offs|pros and cons|costs? and benefits?)\b|(?:قارن|مقارنه)[^.?؟\n]{0,250}(?:المزايا والعيوب|معايير|التكاليف والفوائد)/u;

export function requestedStructure(text: string) {
  if (REQUESTED_FORMAT.test(text)) return 'requested';
  if (NO_STRUCTURE.test(text)) return 'prose';
  if (HEADINGS.test(text)) return 'sections';
  if (LIST_FORMAT.test(text)) return 'list';
  if (EXPLICIT_STEPS.test(text)) return 'steps';
  return null;
}

export function suggestedStructure(text: string) {
  if (PROCEDURE.test(text)) return 'steps';
  if (LIST.test(text)) return 'list';
  if (MULTI_SECTION.test(text)) return 'sections';
  return 'prose';
}

export const expectsExplanation = start(String.raw`why|explain|describe|discuss|compare|contrast|what (?:is|are) (?:the )?(?:difference|reason|cause|effect|impact)|how (?:does|did|is|are)|لماذا|ليش|ليه|علاش|اشرح|وضح|صف|ناقش|قارن|كيف (?:يعمل|تعمل|يحدث|تحدث)|ما (?:هو |هي )?(?:الفرق|السبب|الاثر)`);
export const asksForScalar = start(String.raw`who|whom|whose|when|where|which|how (?:many|much|far|old|tall|long|heavy|high)|what (?:is|was) (?:the )?(?:capital|name|age|price|height|weight|population|date|time|address|unit|symbol|currency|value|score|result|number)|متي|امتي|وقتاش|متيش|اين|وين|فين|كم|كام|قديش|شكد|مين|شكون|من (?:هو|هي|كتب|الف|اخترع)|ما (?:هو |هي )?(?:عاصمه|اسم|عمر|سعر|ارتفاع|طول|عدد|مساحه|عنوان|التاريخ|الوقت|العمله)`);
export const asksForCoverage = /\b(?:all|each|every|both|including|explain|why|cite|citations?|sources?|warnings?|risks?|exceptions?|limitations?|justify|examples?|references?)\b|(?<!\p{L})(?:كل|جميع|بما في ذلك|اذكر السبب|ولماذا|مع ذكر|المصادر|مصادر|تحذير|مخاطر|استثناءات|امثله|مراجع)(?!\p{L})/u;
export const multipleQuestions = /[?؟]\s*\p{L}|\b(?:and|then) (?:who|when|where|why|how|what|which|explain|describe|show|compare)\b|(?<!\p{L})(?:واين|ومتي|وكم|وكيف|ولماذا|واذكر|واشرح|ثم اشرح)(?!\p{L})/u;

export const avoidFollowUp = /\b(?:no follow[ -]?ups?|(?:do not|don't|never) ask (?:me )?(?:any )?(?:follow[ -]?up |clarifying )?questions?|(?:do not|don't|never) suggest (?:any )?(?:next steps?|anything else)|answer only)\b|(?:لا (?:تسالني|تسال|تقترح|تطرح اسئله)|بدون (?:اسئله|متابعه|اقتراحات|توضيح))(?!\p{L})/u;
const nextStep = /\b(?:next (?:action|step|move)|what (?:should|can) i do next|where (?:should|do) i go from here)\b|(?:الخطوه (?:التاليه|القادمه|الجايه)|ماذا افعل بعد|شو اعمل بعدها|اعمل ايه بعد كده)(?!\p{L})/u;

const offeredAction = /\b(?:give(?: me)?|suggest|recommend|propose|end with)\b[^.!?؟]{0,28}\b(?:one|a single|1)\s+(?:concrete |practical |simple )?(?:thing|action|check|test|priority|step|move)\b|(?:اقترح|اقتراح|اعطني|اذكر)[^.!?؟]{0,26}(?:خطوه|اولويه|اختبار|اجراء|شيء)(?: عمليه| عملي| ملموسه?| محدده?)? (?:واحد[ه]?)(?!\p{L})/u;
export const requestedNextStep = (text: string) => nextStep.test(text) || offeredAction.test(text);

export const noHistory = /\b(?:(?:do not|don't|never) (?:use|include|read|look at|refer to)|ignore) (?:the |any |our )?(?:conversation history|(?:earlier|previous|past|prior) (?:turns|messages|context|conversation|chat))\b|\b(?:use|read|consider) (?:only|just) (?:the |this )?(?:current|latest|last) (?:message|turn|request)\b|(?:لا (?:تستخدم|تقرا|ترجع الي|تراجع)|تجاهل) (?:سجل المحادثه|السياق السابق|الرسائل السابقه|الردود السابقه|ما سبق)|(?:استخدم|اعتمد علي) (?:الرساله الحاليه|هذا الطلب) فقط/u;
export const externalHistory = /\b(?:a(?:n)? |the |my |our )?(?:another|other|different|separate) (?:conversation|chat|thread)\b|(?:محادثه|دردشه|نقاش) (?:اخري|اخر|ثانيه|ثاني|مختلفه|مختلف|منفصله|منفصل)(?!\p{L})/u;
const recap = /\b(?:summari[sz]e|recap|review|outline) (?:for me )?(?:(?:this|our|the|entire|whole|full|all|of|we|have|what|everything|we've)\s+){0,5}(?:conversation|chat|thread|discussion|messages|decided|agreed|discussed|covered)\b(?!\s+(?:between|of|among|about)\b)|\b(?:what have we|what did we) (?:discuss|agree|decide|cover)(?: on| so far)?[.!?\s]*$|(?:لخص|اختصر|راجع|اعطني ملخصا?|اعطيني ملخص|ذكرني ب|استعرض) (?:لي )?(?:هذه |هذي |كل |كامل |جميع )?(?:المحادثه|نقاشنا|محادثتنا|حديثنا|كلامنا|ما (?:ناقشنا|اتفقنا عليه|قررناه|قلناه)|ما دار بيننا)/u;
const older = /\b(?:earliest|first|initial|original) (?:messages?|turns?|repl(?:y|ies)|questions?|requests?|instructions?|(?:thing|version|plan) (?:i|we|you) (?:said|shared|mentioned|discussed|gave|asked))\b(?!\s+(?:from|by|of|to)\b)|\b(?:at|from|near) the (?:very )?(?:start|beginning|top) of (?:this|the|our) (?:conversation|chat|thread|discussion)\b|\b(?:many|several|[7-9]|\d{2,}) (?:messages?|turns?|replies) (?:back|ago|earlier)\b|\b(?:much|way) earlier(?: in (?:this|the|our) (?:conversation|chat|thread))?|(?:اول|اولي) (?:رساله|سؤال|طلب|رد|تعليمات)|(?:من|في) بدايه (?:هذه |هذي )?(?:المحادثه|محادثتنا|النقاش)|قبل (?:عده|كم|كثير من|[7-9]|\d{2,}) (?:رسائل|رساله|ردود|ادوار)|من زمان في (?:هذه )?المحادثه/u;
const conflict = /\b(?:reconcile|resolve|check|compare|explain)\b[^.!?؟\n]{0,200}\b(?:conflict(?:ing)?|contradict(?:ion|ory|ing)?|inconsisten(?:t|cy)|discrepancy)\b[^.!?؟\n]{0,100}\b(?:messages|turns|instructions|replies|earlier|above|here|conversation|chat)\b|\b(?:earlier|previous) (?:messages|turns|instructions|replies)\b[^.!?؟\n]{0,100}\b(?:conflict|contradict|disagree)\b|(?:راجع|حل|وضح|وفق بين)[^.!?؟\n]{0,160}(?:تناقض|تعارض|اختلاف)[^.!?؟\n]{0,100}(?:الرسائل|الردود|المحادثه|السابقه|تعليماتنا)/u;
const directResume = start(String.raw`(?:resume|continue|pick up|restart) (?:the |my |our |this )?(?:previous |paused |long[ -]running |background |ongoing |incomplete )?(?:run|task|project|research|monitoring|build|job)\b(?:[^.!?؟\n]{0,100}\b(?:paused|left off|last time|earlier|previous|yesterday|had started|from (?:the )?(?:checkpoint|last step))\b)?|(?:resume|continue|pick up) (?:where we left off|from (?:the |your )?(?:last )?checkpoint)|(?:استكمل|اكمل|استانف|تابع|كمل) (?:العمل|المهمه|المشروع|البحث|المراقبه|المتابعه|التنفيذ)(?: (?:السابق|السابقه|المتوقف|المتوقفه|المعلق|المعلقه))?|(?:استكمل|اكمل|استانف|تابع|كمل) من (?:حيث توقفنا|اخر نقطه|اخر خطوه|نقطه التوقف)`);

const currentChat = /\b(?:this|our|the current) (?:(?:entire|whole|full) )?(?:conversation|chat|thread|discussion)\b|(?<!\p{L})(?:هذه المحادثه|هذي المحادثه|هالمحادثه|هالدردشه|محادثتنا|نقاشنا|كلامنا في الدردشه|في (?:الدردشه|المحادثه))(?!\p{L})/u;
const recapRequest = start(String.raw`recap|summari[sz]e|look back (?:over|through|at)|review|(?:give|provide) (?:me )?(?:a |the )?summary|لخص|(?:اعمل|سوي|اكتب|اعطني|اعطيني) (?:لي )?ملخص|ارجع ل(?:كل )?(?:كلامنا|نقاشنا)|استعرض`);
const recapTarget = /\b(?:all|entire|whole|everything|throughout|decisions?|discussion|open questions?)\b|(?<!\p{L})(?:كل|جميع|كامل|القرارات|الملخص|المعلق[هة]|بدايتها)(?!\p{L})/u;
export const recapConversation = (text: string) => recap.test(text)
  || currentChat.test(text) && recapRequest.test(text) && recapTarget.test(text);
const priorMention = /\b(?:i|we|you) (?:first |previously )?(?:said|mentioned|shared|gave|asked)\b|(?<!\p{L})(?:ذكرت(?:ه[ا]?|ها)?|حكيت لك|قلت لك|ذكرناه|قلناه)(?!\p{L})/u;
const oldPosition = /\b(?:very first|first|earliest|original|at the beginning)\b|(?<!\p{L})(?:باول|اول|اولي|بالبدايه|بدايه)(?!\p{L})/u;
export const olderReference = (text: string) => older.test(text) || oldPosition.test(text) && priorMention.test(text)
  && (currentChat.test(text) || /\b(?:here|above)\b/u.test(text));
const earlierMaterial = /\b(?:our |my |your )?(?:earlier|previous|prior) (?:(?:conflicting|contradictory|inconsistent) )?(?:facts|requirements|instructions|details|messages|replies|notes)\b|(?:المتطلبات|التعليمات|المعلومات|الردود|الرسائل) (?:السابقه|القديمه)(?!\p{L})/u;
const contradictory = /\b(?:conflicting|contradictory|inconsistent|two different|two incompatible|different versions)\b|(?<!\p{L})(?:متعارض(?:ه|ين|تان|تين)?|متناقض(?:ه|ين|تان|تين)?|مختلف(?:ان|ين|تين|تان))(?!\p{L})/u;
const provenance = /\b(?:i|we|you) (?:said|gave|confirmed|wrote)\b|\bfrom (?:me|you|us)\b|(?<!\p{L})(?:قلت لك|قلت لي|كتبنا|اعتمدته|اكدته)(?!\p{L})/u;
export const conflictingHistory = (text: string) => conflict.test(text) || contradictory.test(text)
  && (earlierMaterial.test(text) || currentChat.test(text) && provenance.test(text));
const continuation = start(String.raw`resume|continue|restart|pick up|finish|استانف|استكمل|اكمل|كمل|تابع`);
const checkpoint = /\b(?:we|i|you) (?:had )?(?:paused|stopped|left off|started)\b|\b(?:where (?:we|i|you) left off|from (?:the |your )?(?:last )?checkpoint)\b|(?<!\p{L})(?:وقفناها|وقفناه|اوقفناه|اوقفناها|توقفنا|اخر نقطه|اخر خطوه)(?!\p{L})/u;
const unfinishedProject = /\b(?:unfinished|paused|background|long[ -]running|ongoing) (?:\p{L}+[ -]){0,4}(?:audit|study|research|build|project|job|task|run|report|analysis)\b|(?:العمل|المهمه|المشروع|البحث|المراقبه) (?:السابق|السابقه|المتوقف|المتوقفه|المعلق|المعلقه)(?!\p{L})/u;
export const resumeWork = (text: string) => continuation.test(text)
  && (checkpoint.test(text) || unfinishedProject.test(text) || currentChat.test(text) && directResume.test(text));
export const interactiveOnly = /\b(?:(?:no|without) background (?:work|runs?)|(?:do not|don't|never) (?:run|continue|work) in the background|(?:stay|keep (?:this|it)) interactive|(?:answer|explain|reply) (?:here and now|right now)|quick (?:question|answer))\b|(?:لا (?:تعمل|تكمل|تتابع|تشغل) في الخلفيه|بدون (?:عمل|تنفيذ|تشغيل) في الخلفيه|(?:اجب|رد|جاوب) (?:هنا والان|الان)|سؤال سريع)(?!\p{L})/u;
const autonomousLead = start(String.raw`(?:run|work|continue|keep working|start (?:a )?(?:run|job|task)) (?:on (?:this|it) )?(?:in the background|autonomously|without stopping|until (?:it is|it's|you are|you're) (?:done|complete|finished))|(?:ابد[اأ]|اعمل|اشتغل|نفذ|تابع|واصل|اكمل|كمل) (?:المهمه |العمل |عليها )?(?:في الخلفيه|بشكل مستقل|بدون توقف|حتي (?:تنتهي|يكتمل))`);

const autonomousTail = /(?:^|[.!?,;]\s*|\b(?:then|and)\s+)(?:work|keep working|continue|run) (?:on (?:it|this) )?(?:while (?:i am|i'm) (?:away|offline)|in the background)\b|(?:خل|خلي|دع) (?:العمل|الشغل|التنفيذ) (?:يكمل|يستمر|يتابع)[^.!?؟]{0,40}(?:غايب|غائب|مو موجود|غير متصل|في الخلفيه)(?!\p{L})/u;
export const backgroundWork = (text: string) => autonomousLead.test(text) || autonomousTail.test(text);
const monitor = start(String.raw`monitor|watch|keep (?:watching|checking|tracking|an eye on)|track|check|راقب|تابع|افحص|تحقق من|استمر في (?:مراقبه|متابعه|فحص)|خل(?:ك|يك) (?:تراقب|تتابع)`);
const frequency = /\b(?:every|until|next|hourly|daily|overnight|periodically|continuously|repeatedly|notify me (?:if|when)|for \d+ (?:minutes?|hours?|days?|weeks?))\b|(?:كل|حتي|الي ان|لمده|خلال|يوميا|دوريا|باستمرار|نبهني (?:اذا|عند)|بلغني (?:اذا|عند))(?!\p{L})/u;
const temporalLead = /^(?:for the next|over the next|for) [^,،]{1,48}(?:minutes?|hours?|days?|weeks?)[,،]\s+|^(?:لمده|خلال) [^,،]{1,48}[,،]\s+/u;
const cadence = /\b(?:repeatedly|periodically|continuously|hourly|daily|overnight|until|notify (?:me|us) (?:when|if)|every (?:\p{N}+ |\p{L}+ )?(?:minutes?|hours?|days?|weeks?))\b|(?:لمده|كل (?:\S+ ){0,2}(?:دقيقه|دقائق|ساعه|ساعات|ايام)|نبهني (?:اذا|عند)|اخبرني (?:عندما|اذا)|بلغني (?:اذا|عند))(?!\p{L})/u;
const sustainedMonitor = start(String.raw`monitor|watch|keep (?:watching|checking|tracking|an eye on)|track|راقب|تابع|استمر في (?:مراقبه|متابعه|فحص)`);
const monitoringDuration = /\b(?:for (?:the next )?|over the next )(?:a|an|one|two|\d+) (?:minutes?|hours?)\b|(?:لمده|خلال) (?:[0-9٠-٩]+ )?(?:دقيقه|دقائق|ساعه|ساعتين|ساعات)(?!\p{L})/u;
export const monitoringRequest = (text: string) => {
  const command = text.replace(temporalLead, '');
  return monitor.test(command) && (frequency.test(text) && cadence.test(text)
    || sustainedMonitor.test(command) && monitoringDuration.test(text));
};
const research = start(String.raw`research|investigate|synthesi[sz]e|(?:give|provide|prepare|produce|write) (?:me )?(?:an? )?(?:deep|comprehensive|in[ -]depth|systematic) (?:research|study|review)|(?:conduct|do|carry out|run) (?:an? )?(?:deep|thorough|systematic|comprehensive) (?:research|investigation|review|study)|ابحث|حقق|ادرِ?س|استقص|اجمع|(?:اعمل|سو|سوي|جهز) (?:بحثا?|دراسه)|اجري (?:بحثا?|دراسه)`);
const researchDepth = /\b(?:deep|comprehensive|systematic|thorough(?:ly)?|in[ -]depth|multiple sources|across sources|literature review|audit trail|primary sources)\b|(?:بعمق|معمق(?:ا|ه)?|بحث شامل|دراسه شامله|مراجعه شامله|متعمق|مصادر متعدده|عده مصادر|مصادر اوليه|مصادر مختلفه)/u;
export const deepResearch = (text: string) => research.test(text) && researchDepth.test(text);
const build = start(String.raw`build|implement|develop|create|migrate|refactor|set up|construct|finish|ابن|ابني|نفذ|طور|انشئ|صمم|برمج|جهز|انقل|اعد هيكله|اكمل بناء`);
const artifact = /\b(?:app(?:lication)?|site|website|dashboard|prototype|integration|service|repo(?:sitory)?|codebase|project|pipeline|backend|frontend|automation|feature|dataset|interactive tool)\b|(?:تطبيق|موقع|لوحه تحكم|نظام|مشروع|مستودع|خدمه|نموذج اولي|واجهه|ادات|اداه|قواعد البيانات|قاعده بيانات|عمليه تلقائيه)/u;
const execution = /\b(?:run (?:the )?tests|test (?:it|the)|deploy|verify|deliver|commit|migrate|refactor|end[ -]to[ -]end|from scratch)\b|(?:شغل الاختبارات|اختبر|انشر|تحقق|سلم|من الصفر)/u;
export const substantialBuild = (text: string, implementationRoute: boolean) => build.test(text) && (artifact.test(text) || implementationRoute && execution.test(text));

const DIALECTS: Readonly<Record<string, MannersDialect>> = {
  egyptian: 'egyptian', 'مصري': 'egyptian', 'مصريه': 'egyptian',
  gulf: 'gulf', 'خليجي': 'gulf', 'خليجيه': 'gulf',
  levantine: 'levantine', 'شامي': 'levantine', 'شاميه': 'levantine',
  iraqi: 'iraqi', 'عراقي': 'iraqi', 'عراقيه': 'iraqi',
  maghrebi: 'maghrebi', 'مغاربي': 'maghrebi', 'مغاربيه': 'maghrebi', 'دارجه': 'maghrebi',
  sudanese: 'sudanese', 'سوداني': 'sudanese', 'سودانيه': 'sudanese',
  yemeni: 'yemeni', 'يمني': 'yemeni', 'يمنيه': 'yemeni',
  msa: 'msa', 'modern standard arabic': 'msa', 'فصحي': 'msa', 'العربيه الفصحي': 'msa',
};
const LANGUAGE = /\b(?:(?:answer|reply|respond|write) (?:to me )?(?:in|using)|in) (arabic|english)(?: only)?(?=\s*(?:$|[.,،;؛!?؟\n]))|(?<!\p{L})(?:اجب|رد|جاوب|اكتب)(?: لي| علي)? (بالعربي(?:ه)?|بالانجليزي(?:ه)?)(?!\p{L})/gu;
const DIALECT = /\b(?:in|using) (egyptian|gulf|levantine|iraqi|maghrebi|sudanese|yemeni|msa|modern standard arabic)(?: arabic| dialect)?(?=\s*(?:$|[.,،;؛!?؟\n]))|(?<!\p{L})(?:باللهجه (?:ال)?|بال)(مصريه?|خليجيه?|شاميه?|عراقيه?|مغاربيه?|دارجه|سودانيه?|يمنيه?|فصحي|عربيه الفصحي)(?!\p{L})/gu;
const DIALECT_LEADS: ReadonlyArray<readonly [MannersDialect, RegExp]> = [
  ['egyptian', /^(?:ازاي|ازيك|عايز|عاوز|كام|امتي|فين)(?!\p{L})/u],
  ['gulf', /^(?:وش|ابغي|ابغا|ابي)(?!\p{L})/u],
  ['levantine', /^(?:شو|بدي|قديش)(?!\p{L})/u],
  ['iraqi', /^(?:شنو|شكد|هسه)(?!\p{L})/u],
  ['maghrebi', /^(?:كيفاش|وقتاش|علاش|شكون|بغيت)(?!\p{L})/u],
  ['yemeni', /^اشتي(?!\p{L})/u],
];

export function explicitReplyLocale(text: string): { language: 'ar' | 'en'; dialect?: MannersDialect } | null {
  const language = [...text.matchAll(LANGUAGE)].at(-1);
  const dialect = [...text.matchAll(DIALECT)].at(-1);
  if (dialect && (!language || dialect.index >= language.index)) {
    const value = DIALECTS[dialect[1] ?? dialect[2] ?? ''];
    if (value) return { language: 'ar', dialect: value };
  }
  if (!language) return null;
  return { language: /arabic|بالعربي/u.test(language[1] ?? language[2] ?? '') ? 'ar' : 'en' };
}

export function requestDialect(text: string): MannersDialect {
  return DIALECT_LEADS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'msa';
}
