import { compileQuery, searchTokens } from '@mohassan/browser';
import { asksToRemember, directRoute, sensitiveAction } from '../brain.js';
import { requestedSites } from '../goal-integrity.js';
import { memoryRecallFormat } from '../memory-recall.js';
import { requestsPausedCampaign } from '../tools.js';
import type { AnswerType, Frame, Intent } from './contract.js';
import { isTemperatureQuestion } from './compute.js';
import { matchText, normalizeRequest, stripCourtesyTail } from './normalize.js';

const ADDRESS = /https?:\/\/[^\s<>«»"'`]+|(?<![\p{L}\p{N}_@/.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>«»"'`]*)?(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}])/giu;
const EXPLICIT_ADDRESS = /https?:\/\/[^\s<>«»"'`]+/giu;
const SOURCE_LEAD = /^(?:(?:at|from|on|according to|via)|(?:من|في|علي|حسب)(?: (?:الرابط|الموقع|الصفحه))?)\s*[:,،؛–—-]+\s*/iu;
const COMMON_DOMAIN_END = /\.(?:com|org|net|edu|gov|int|mil|io|ai|info|biz|test|example|invalid|local|co|uk|us|ca|fr|de|es|it|au|nz|eu|ae|sa|qa|kw|om|eg|jo|lb|sy|tr|in|cn|jp|nl)$/iu;
const EXPLICIT_DOMAIN = /(?:\b(?:site|website|page|url|link|domain|open|visit|browse)(?:\s+(?:at|on))?|(?:موقع|صفحه|رابط|نطاق|افتح))\s*:?\s*$/iu;
const FOCUS_SCAFFOLDING = new Set(['who', 'whom', 'whose', 'which', 'when', 'where', 'did', 'does', 'can', 'could', 'was', 'were', 'at', 'with', 'me', 'my', 'our', 'tell', 'show', 'give', 'only', 'just', 'please', 'من', 'وين', 'اين', 'متى', 'متي', 'هل', 'اي', 'كم', 'لك', 'فقط', 'موقع', 'صفحه', 'صفحة', 'رابط', 'ذاكرتي', 'اخبرني']);

function addressesIn(request: string) {
  const explicitOrigins = new Set(requestedSites(request.replace(/[؟،؛]/gu, ' ')));
  const candidates: Array<{ written: string; href: string }> = [];
  for (const match of request.matchAll(ADDRESS)) {
    const written = match[0].replace(/[.,،؛:!?؟)\]}]+$/gu, '');
    const explicitScheme = /^https?:\/\//i.test(written);
    try {
      const url = new URL(explicitScheme ? written : `https://${written}`);
      if (url.username || url.password) continue;
      const prefix = request.slice(0, match.index);
      if (!explicitScheme && /(?:[a-z][a-z\d+.-]*:\/\/|@)$/i.test(prefix)) continue;
      if (!explicitScheme && !COMMON_DOMAIN_END.test(url.hostname) && !EXPLICIT_DOMAIN.test(matchText(prefix))
        && url.pathname === '/' && !url.search) continue;
      if (explicitScheme && !explicitOrigins.has(url.origin) && !requestedSites(written).includes(url.origin)) continue;
      candidates.push({ written, href: url.href });
    } catch {
      // A malformed address never opens a different address by way of repair.
    }
  }
  return candidates;
}

const PERSONAL = /\b(?:my|our)\s+(?!(?:question|request|message|answer)\b)\p{L}[\p{L}\p{M}'’-]*|(?<!\p{L})(?:[وبفل])?(?:ذاكرت|شركت|حملت|ميزانيت|حساب|موقع|ملاحظات|ملاحظت|وثائق|ملفات|ملف|مشروع|متجر|منتج|فريق|طلبات|طلب|موعد|مواعيد|عنوان|بريد|اسم|رقم|هاتف|عائلت|عمل|وظيفت|مكتب|راتب|بطاقت|سيارت|رئيس|كتاب|سياس[ته]|مستندات|مستند|قسيمت|حجوزات|حجز)(?:ي|نا)(?!\p{L})/iu;
const MEMORY = /\b(?:my|our) (?:saved )?memor(?:y|ies)\b|\b(?:recall|look up|find|check|read|search)\b[^.!?]*\b(?:saved|personal|my|our) (?:notes?|records?|documents?|files?)\b|(?<!\p{L})(?:ذاكرت(?:ي|نا)|ذاكره موحسن|الذاكره المحفوظه|ملاحظات(?:ي|نا) المحفوظه)(?!\p{L})/iu;
const IDENTITY = /^(?:who (?:are you|made you|created you)|what (?:are you|is your name|can you do)|what(?:'|’)s your name|introduce yourself|tell me (?:your name|about yourself)|مين انت|انت مين|من انت|ما اسمك|وش اسمك|ايش اسمك|من صنعك|ماذا تستطيع|ما قدراتك|عرف بنفسك|عرف نفسك|قدم نفسك|ما هويتك)(?:[\s,.!?؟،]+|$)/iu;
const SMALLTALK = /^(?:(?:hi|hello|hey|good (?:morning|afternoon|evening)|how are you(?: doing)?(?: today)?|thank(?:s| you)(?: very much| so much| for (?:helping(?: me| us)?|(?:your|the) (?:help|time|reply|information|advice)))?|much appreciated|nice to meet you|bye|goodbye|سلام|السلام عليكم|وعليكم السلام|مرحبا(?: بك)?|هلا(?: بك)?|اهلا(?: وسهلا)?|صباح (?:الخير|النور)|مساء (?:الخير|النور)|كيف حالك(?: اليوم)?|شلونك|كيفك|شكرا(?: لك| جزيلا)?|تسلم|يعطيك العافيه|جزاك الله خيرا|مع السلامه)[\s.!?؟،,]*)+$/iu;
const SALUTATION_END = /[،,\s]+(?:يا\s+(?:(?:صديق|صاحب)(?:ي)?|موحسن|مساعد|استاذ)|(?:my )?(?:friend|assistant|pal|mate|mohassan)|there|على المساعده|بارك الله فيك)[\s.!?؟،,]*$/iu;
const QUESTION = /^(?:who|what|when|where|why|how|which|is|are|was|were|does|do|did|can|could|has|have|whom)\b|^(?:من|ماذا|ما|متي|اين|وين|كيف|لماذا|ليه|ليش|كم|هل|اي|ايهما|وش|شنو|ايش|امتي)(?!\p{L})|[?؟]\s*$/iu;
const ASK_FACT = /^(?:find|research|look up|identify|check|verify|confirm|cross-check|tell me|show me|give me|retrieve|read|consult|ابحث|جد|اعثر|اخبرني|قل لي|اعطني|هات|اذكر|تحقق|اقرا)(?!\p{L})/iu;
const PRESENT_VERB = /^(?:list|state|report|provide|return|display|present|show|give|quote|extract|اعرض|اذكر|اورد|بين|قدم|اعد|ارجع|اظهر|هات|اقتبس|استخرج|انقل)(?!\p{L})(?:\s+(?:me|لي)(?!\p{L}))?[\s,:،-]*/iu;
const FACT_OBJECT = /\b(?:facts?|findings?|values?|figures?|statistics|evidence|sources?|results?|quotes?|quotations?|claims?|information|details|estimates?|terms?|records?|deadlines?|requirements?)\b|(?<!\p{L})(?:ال)?(?:حقائق|معلومات|نتائج|ارقام|بيانات|ادله|مصادر|اقتباسات|شواهد|قيم|سجلات|تفاصيل|تقديرات|شروط|متطلبات)(?!\p{L})/iu;
const VALUE_NOUN = 'value|answer|number|result|date|year|month|day|name|code|amount|price|fee|cost|figure|count|duration|percentage';
const ONLY_VALUE = new RegExp(`\\b(?:only|just) (?:(?:give|return|show|state|provide) )?(?:the )?(?:(?:numeric|numerical|opening|closing|founding|publication|release) )?(?:${VALUE_NOUN})\\b|\\b(?:${VALUE_NOUN}) only\\b|\\b(?:nothing else|without (?:any )?(?:explanation|steps|working)|no (?:explanation|steps|working)|just answer)\\b|(?:فقط|لا غير|وحده[ا]?|(?:بلا|دون|بدون|من غير) (?:شرح|خطوات))\\s*[.!?؟]*$|(?<!\\p{L})(?:بس (?:الرقم|القيمه|الناتج|الجواب)|(?:الرقم|القيمه|الناتج|الجواب) بس)(?!\\p{L})`, 'iu');
const CLOCK = /\b(?:time zone|timezone|utc|gmt|dst)\b|(?:التوقيت|المنطقه الزمنيه)|\bwhat(?:'s| is) the (?:current )?(?:local )?time\b|^what time (?:is it|would it be)\b|(?:كم الساعه|ما الوقت|ما التوقيت)|\b(?:time difference|what day of the week|which weekday)\b|(?:فرق التوقيت|اي يوم من الاسبوع|ما يوم الاسبوع)/iu;
const DATE_MATH = /\bhow many (?:days|weeks|months|years) (?:until|since|between|from|to)\b|\b(?:days|weeks|months|years) (?:after|before)\b|\b(?:add|subtract)\s+\d+.*\b(?:days|weeks|months|years)\b|(?:كم\s+(?:يوما|يوم|اسبوعا|اسبوع|شهرا|شهر|سنه|سنوات)\s+(?:حتي|منذ|بين|باقيه|متبقيه|تبقي)|فرق (?:الايام|التاريخين)|(?:اي|ما)\s+يوم\s+(?:كان|يصادف|يوافق)|(?:اي|ما|كم)\s+تاريخ\s+(?:بعد|قبل)|(?:بعد|قبل|زود|اضف|اطرح)\s+\d+\s*(?:ايام|يوم|اسبوع|اسابيع|شهر|سنه))/iu;
const MATH_VERB = /^(?:calculate|compute|evaluate|solve|convert|multiply|divide|add|subtract|احسب|احسبي|حول|حولي|اوجد|اضرب|اقسم|اجمع|اطرح|حل)(?!\p{L})/iu;
const MATH_FORMAT = /\d\s*(?:[+*×÷−/−^=]|-(?!\d{2}-\d))\s*[-+]?\d|\d\s*[%٪]\s*(?:of|من)|\b(?:percentage|percent|per cent|power of|square root)\b|(?:نسبه مئويه|بالمئه|في المئه|جذر تربيعي|الاس )/iu;
const SPOKEN_MATH = /[\d)]\s*(?:\b(?:plus|minus|times|multiplied by|divided by|over|raised to)\b|(?:زائد|زايد|ناقص|مضروب(?:ه)? في|ضرب(?: في)?|في|مقسوم(?:ه)? علي|قسمه(?: علي)?|تقسيم|علي|ع|اس)(?!\p{L}))\s*\(*\s*[+−-]?\s*\d|\d\s*(?:بالمائه|بالمئه|بالميه|بلميه|pct)(?!\p{L})/iu;
const QUANTITY = /\d\s*(?:km\/h|m\/s|kg|mg|gb|mb|kb|tb|mph|kms?|cms?|mms?|°\s*[cfk]|g|m|mi|ft|in|lb|oz|gal|l|ml|km2|m2|cm2|m3|cm3|lit(?:re|er)s?|met(?:re|er)s?|kilomet(?:re|er)s?|miles?|yards?|feet|foot|pounds?|ounces?|kilos?|grams?|celsius|fahrenheit|kelvin|bytes?|كم|كغ|كجم|(?:كيلو(?:متر|غرام|جرام)?|متر|ملم|سم|جرام|غرام|ميل|لتر|رطل|اونصه|قدم|درجه|كيلوبايت|ميغابايت|جيجابايت)ا?)(?!\p{L})/iu;
const UNIT_EXPRESSION = /\b(?:in|into|to|as|equal(?:s)?|how many)\b|(?<!\p{L})(?:الي|كم|تساوي|يساوي|يعادل|يعني)(?!\p{L})/iu;
const CURRENCY = /[$€£¥₹]|\b(?:usd|eur|gbp|jpy|cad|aud|aed|sar|egp|inr|chf|cny|krw|try|brl|mxn|pln|dollars?|euros?|yen|dirhams?|riyals?|rupees?|sterling|pounds? sterling|british pounds?|francs?|pesos?|kron(?:a|or)|rubles?|roubles?|yuan|renminbi)\b|(?<!\p{L})(?:[وب])?(?:ال)?(?:دولار(?:ا|ات)?|يورو|ريال(?:ا|ات)?|درهم(?:ا|ات)?|جنيه(?:ا|ات)?|ليره|ين|روبيه|فرنك(?:ات)?|روبل|يوان)(?!\p{L})/giu;
const EXCHANGE = /\b(?:exchange rates?|fx rates?|currency (?:exchange|conversion|converter))\b|(?:سعر الصرف|اسعار الصرف|صرف العملات?|تحويل العملات?)/iu;
const CURRENCY_PAIR = /\b(?:against|versus|vs\.?|per)\b|(?<!\p{L})(?:مقابل|لقاء)(?!\p{L})|\/|→/iu;
const COMPARISON = /\b(?:compare|versus|vs\.?|which (?:one |of them )?(?:is|has|costs))\b|\b(?:cheaper|costlier|higher|lower|larger|smaller|lighter|heavier|faster|slower|better|older|earlier|newer) than\b|(?<!\p{L})(?:قارن|مقارنه بين|ايهما|ايهم|افضل من|اكبر من|اصغر من|ارخص من|اغلي من|اثقل من|اخف من)(?!\p{L})/iu;
const DISAGREEMENT = /^(?:contrast|differentiate between|وازن بين|قابل بين|ميز بين)(?!\p{L})|\b(?:differences?|discrepanc(?:y|ies)|conflict|disagreement) (?:between|among|in|across)\b|(?<!\p{L})(?:(?:ال)?(?:فرق|فروق|اختلاف|تعارض|تضارب)\s+(?:بين|في|عبر)|(?:اختلفت?|تعارضت|تضاربت)\s+(?:فيه?|حول))(?!\p{L})/iu;
const CONFLICTING_REPORT = /\b(?:conflicting|differing|competing)\s+(?=\p{L})|(?<!\p{L})(?:ال)?(?:قيم|ارقام|تقديرات|بيانات|تواريخ|نتائج|روايات)\s+(?:ال)?(?:المختلفه|المتعارضه|متعارضه|متضاربه|مختلفه)(?!\p{L})/iu;
const SITE_CHECK = /\b(?:audit|inspect|test|check|analyze) (?:the |this |that |a )?(?:website|site|webpage|page|url|link)\b|\b(?:is|does) (?:the |this |that )?(?:website|site|page|url|link) (?:up|down|working|reachable|available|load|use https)\b|\b(?:redirects?|http status|status code|responding|reachable|load successfully)\b|(?<!\p{L})(?:افحص|اختبر|حلل|راجع)\s+(?:(?:هذا|هذه)\s+)?(?:ال)?(?:موقع|رابط|صفحه)|(?:يعمل الموقع|الموقع يعمل|الموقع متوقف|حاله الموقع|رمز الاستجابه|تحويلات الموقع|يعمل هذا الرابط)/iu;
const ADDRESS_HEALTH = /^(?:(?:check|inspect|audit|test|افحص|اختبر|راجع)\s*[?؟.!]*$|(?:is (?:it )?(?:up|down|available|working|reachable)|does (?:it )?(?:work|load|respond|use https)|هل (?:يعمل|تعمل|يفتح|تفتح|يستجيب|تستجيب))(?!\p{L}))/iu;
const ADDRESS_STATUS = /^(?:(?:the )?(?:(?:http|website|site|page|link|server|response|service|endpoint) )?(?:status|uptime|reachability|health|availability|response code)(?: of (?:the )?(?:site|website|page|link|url|service|endpoint))?|(?:حاله|جهوزيه|توفر|توافر)(?: (?:الموقع|الرابط|الصفحه|الخادم|الخدمه|نقطه النهايه|http))?|رمز (?:الحاله|الاستجابه))(?: (?:at|for|of|on|للرابط|للموقع|في|علي))?[\s.!?؟،,:]*$/iu;
const ADDRESS_REDIRECT = /(?<!\p{L})(?:(?:وجهه|هدف|عنوان|مسار|رابط|رمز|كود|حاله)\s+(?:اعاده التوجيه|(?:ال)?تحويل)|(?:الي اين|وين)\s+(?:يحول|تحول|يعيد توجيه|تعيد توجيه))(?!\p{L})/iu;
const OPEN_REQUEST = /^(?:open|go to|visit|browse|navigate to|افتح|ادخل|اذهب الي|روح (?:علي|الي))(?!\p{L})/iu;
const ADDRESS_OPEN = /^(?:open|go to|visit|browse|navigate to|افتح|ادخل(?: الي| علي)?|اذهب الي|روح (?:علي|الي))(?: (?:the |this |that )?(?:site|website|page|link|url|الموقع|موقع|الرابط|رابط|الصفحه|صفحه))?[\s.!?؟،,]*$/iu;
const ADS = /^(?:create|build|launch|draft|prepare|make|write|انشئ|ابني|جهز|اعد|اعمل|صمم)\s+.*(?:\bad campaign\b|\bads? campaign\b|\bgoogle ads\b|حمله اعلانيه|اعلانات جوجل|جوجل ادز)/iu;
const CODING = /^(?:(?:write|implement|generate|edit|modify|patch|fix|debug|refactor|add|remove)\s+.*(?:\bcode\b|\bfunction\b|\bclass\b|\bscript\b|\bbug\b|\btest\b|\bendpoint\b|\bsource file\b)|(?:اكتب|اصلح|عدل|صحح|نفذ|برمج|انشئ|اضف)\s+.*(?:كود|داله|برنامج|ملف مصدر|اختبار برمجي|سكريبت|واجهه api))/iu;
const COMPUTER = /^(?:(?:click|press|type|scroll|drag|close|run|open|launch)\b.*\b(?:screen|mouse|keyboard|computer|terminal|window|button|application|settings|file)\b|(?:انقر|اضغط|اكتب|مرر|اسحب|اغلق|شغل|افتح)\s+.*(?:الشاشه|الفاره|الماوس|لوحه المفاتيح|الحاسوب|الكمبيوتر|النافذه|الطرفيه|الزر|التطبيق|الاعدادات))/iu;
const EXPLAIN = /^(?:explain|teach me|walk me through|summari[sz]e|اشرح|علمني|وضح|لخص|فسر|بسط)(?!\p{L})/iu;
const WRITE = /^(?:(?:can|could|would) you(?: please)? )?(?:(?:freely|creatively|formally|professionally|briefly) )?(?:write|draft|compose|translate|rewrite|paraphrase|brainstorm|tell me a|make up|اكتب|الف|صغ|ترجم|اعد صياغه|حرر|ابتكر|احك لي)(?!\p{L})/iu;
const PRODUCE_TEXT = /^(?:(?:can|could|would) you(?: please)? )?(?:create|generate|produce|make|انشئ|اصنع|ولد|انتج)\s+.*(?:\b(?:story|poem|dialogue|dialog|narrative|script|article|letter|email|essay|slogan|lyrics)\b|(?:قصه|قصيده|حوار|روايه|سيناريو|مقال|رساله|شعار))/iu;
const VAGUE_QUESTION = /^(?:who|what|when|where|why|how|which|who is (?:it|that)|which one|how (?:much|many) (?:is it|are there)|what (?:is|was) (?:it|that|this)|how do i do (?:it|this|that)|ما|ماذا|متي|اين|كيف|لماذا|كم|ما هذا|من هذا|كم (?:ذلك|هذا)|كيف افعل (?:هذا|ذلك)|اي واحد)\s*[?؟.!]*$/iu;
const MEASURE = 'distance|length|height|width|weight|size|speed|cost|price|age|count|depth|area|volume';
const AR_MEASURE = 'المسافه|الطول|الارتفاع|العرض|الوزن|الحجم|السرعه|التكلفه|السعر|العمر|العدد|العمق|المساحه|السعه';
const MEASURE_WITHOUT_SUBJECT = new RegExp(`^(?:(?:what(?:'s|’s| is| was) )?(?:the |its |their )?(?:${MEASURE})(?: (?:of|for|to) (?:it|this|that|there|them))?|how (?:far|much|long|wide|heavy|tall|high|fast|old|big|deep|shallow) (?:is|are|was|were) (?:it|this|that|there|they)|(?:(?:ما|كم) (?:تبلغ |يبلغ )?)?(?:${AR_MEASURE})(?: (?:الي|عن|لهذا|لهذه|له|لها) ?(?:هناك|هنا|ذلك|تلك|هذا|هذه)?)?|كم (?:تبلغ |يبلغ )?(?:مسافت|طول|ارتفاع|عرض|وزن|حجم|سرعت|تكلفت|سعر|عمر|عدد|عمق|مساحت|سعت)(?:ه|ها|هم))\\s*[?؟.!]*$`, 'iu');
const VAGUE_ACTION = /^(?:do (?:it|this|that|the usual)|go ahead|proceed|افعل (?:هذا|ذلك)|نفذها?|اعمل (?:هذا|ذلك|كده)|سوها?)\s*[.!?؟]*$/iu;
const CHECK_REFERENCE = /^(?:(?:check|inspect|verify|review|test|look (?:at|up)|read)(?: (?:it|them|this|that|these|those|(?:this|that|the previous) (?:one|item|page|link)))?|(?:افحص|اختبر|راجع|تحقق(?: من)?|اقرا)(?: (?:هذا|هذه|ذلك|تلك|هنا|هناك))?|(?:افحص|اختبر|راجع|اقرا)(?:ه|ها))\s*[.!?؟،,:]*$/iu;
const NOMINAL_SCAFFOLDING = new Set(['the', 'it', 'its', 'they', 'their', 'this', 'that', 'these', 'those', 'there', 'here', 'another', 'one', 'me', 'please', 'kindly', 'only', 'just', 'actual', 'official', 'estimated', 'average', 'current', 'latest', 'هذا', 'هذه', 'ذلك', 'تلك', 'هناك', 'هنا', 'فقط', 'بس', 'رجاء', 'سمحت', 'فضلك', 'سكان']);
const ACTION_ONLY = /^(?:please|calculate|compute|solve|evaluate|convert|احسب|حول|حل)\s*[?؟.!]*$/iu;
const HISTORY = /^(?:when|what (?:date|year)|متي|في اي (?:عام|سنه))\b|\b(?:in|during|as of|on|from)\s+(?:1\d{3}|20\d{2})\b|(?:عام|سنه)\s+\d{4}/iu;
const EXPLICIT_FRESHNESS = /\b(?:right now|current(?:ly)?|today|latest|at present|this (?:week|month|year))\b|(?:الان|حاليا|اليوم|احدث|هذا (?:الاسبوع|الشهر|العام))/iu;
const TRANSPORT = /\b(?:trains?|flights?|rail(?:way|road)?s?|airlines?|tram(?:way)?s?|bus(?:es)?|ferr(?:y|ies))\b|(?<!\p{L})(?:[وف])?(?:[بك]?ال|لل|[بكل])?(?:قطار(?:ات)?|طيران|رحل(?:ه|ات) (?:جويه|بحريه)|سكه حديد|حافل(?:ه|ات)|ترام|عبار(?:ه|ات))(?!\p{L})/iu;
const TRANSIT_SERVICE = /\b(?:schedules?|timetables?|status|delays?|delayed|cancellations?|cancelled|canceled|disruptions?|departures?|arrivals?|tickets?|fares?|available|availability|next|tomorrow)\b|\b(?:when|what time)\b.*\b(?:departs?|departure|leaves?|arrives?|lands?)\b|(?<!\p{L})(?:ال)?(?:جدول|مواعيد|موعد|تاخير|الغاء|تذاكر|تذكره|التالي|القادم|القادمه|غدا|حاله الخدمه|حاله الرحله)(?!\p{L})|(?:متي|اي ساعه|ما وقت)\s+.*(?:يغادر|يصل|ينطلق|تغادر|تصل|تنطلق)/iu;
const TRANSIT_HISTORY = /\b(?:historic(?:al)?|archived|formerly|used to|when did)\b|\b(?:in|during|as of|on|from)\s+(?:1\d{3}|20\d{2})\b|(?:متي (?:كان|كانت)|في (?:الماضي|عام|سنه)|تاريخي(?:ا)?|سابقا)(?!\p{L})/iu;
const OTHER_TIME_VARYING = /\b(?:weather|forecast|prices?)\b|(?<!\p{L})(?:ال)?(?:طقس|سعر|اسعار)(?!\p{L})/iu;

const TYPES: ReadonlyArray<readonly [AnswerType, RegExp]> = [
  ['money', /\b(?:what(?:'s| is) (?:the|its|their) (?:price|cost|fee|rent)|how much (?:is|does|did|will)\b.*\b(?:cost|price|rent|pay|charge)|cheaper|costlier|exchange rates?)\b|(?:سعر|تكلفه|كم بلغ سعر|ثمن|كم (?:يكلف|تكلف)|ارخص|اغلي|سعر الصرف)/iu],
  ['date', /^(?:when|what (?:date|year|day)|which (?:year|day))\b|^(?:متي|في اي (?:عام|سنه)|ما التاريخ|(?:ما|اي) يوم)(?!\p{L})/iu],
  ['name', /^(?:who|whose|which person|what is the name)\b|^(?:من (?:هو|هي|اسس|كتب|صنع|اخترع|اسس|تولي|قاد)|ما اسم|مين)(?!\p{L})/iu],
  ['place', /^(?:where|which (?:place|city|country|region|continent)|what is the capital|what is the address)\b|^(?:اين|وين|في اي (?:مدينه|بلد|دوله)|ما (?:هي )?عاصمه|ما العنوان)(?!\p{L})/iu],
  ['number', /^(?:how (?:many|much|high|tall|long|wide|far|large|big|heavy|fast|old|deep|shallow)|what (?:is|was) the (?:number|population|height|length|distance|size|weight|age|area|speed|depth|volume))\b|^(?:كم|ما (?:عدد|حجم|وزن|ارتفاع|طول|مساحه|سرعه|عمر|قيمه|عمق))(?!\p{L})/iu],
  ['yes_no', /^(?:is|are|was|were|does|do|did|can|could|has|have)\b|^(?:هل)(?!\p{L})/iu],
  ['definition', /^(?:what(?:'s| is) (?:a |an |the )?|define)\b|^(?:ما هو|ما هي|ماذا يعني|ما معني|عرف)(?!\p{L})/iu],
  ['steps', /^(?:how (?:can|do|would|to)|steps to)\b|^(?:كيف|ما (?:الخطوات|طريقه))(?!\p{L})/iu],
  ['list', /^(?:list|name the|what are)\b|^(?:اذكر|عدد|ما هي قائمه)(?!\p{L})/iu],
];

const FIELD_TYPES: ReadonlyArray<readonly [AnswerType, RegExp]> = [
  ['money', /^(?:(?:admission|entry|enrollment|registration|subscription|ticket|tuition|shipping|delivery|monthly) )?(?:prices?|fees?|costs?|charges?|rent)\b|^(?:ال)?(?:سعر|اسعار|رسوم|تكلفه|ثمن|تعرفه|اجره)(?!\p{L})/iu],
  ['date', /^(?:(?:founding|establishment|publication|release|opening|closing|enrollment|registration|launch|start|end|expiry|expiration|issue|effective|delivery) )?(?:dates?|years?|deadlines?)\b|^(?:ال)?(?:تاريخ|موعد|سنه|عام|مهله)(?!\p{L})/iu],
  ['place', /^(?:postal address|street address|addresses?|locations?|capital(?: city)?|headquarters)\b|^(?:ال)?(?:عنوان|موقع|عاصمه|مقر)(?!\p{L})/iu],
  ['name', /^(?:name\b|author\b|founder\b|director\b)|^(?:ال)?(?:اسم|مؤلف|موسس|مدير)(?!\p{L})/iu],
  ['number', /^(?:length|height|width|thickness|diameter|circumference|wingspan|distance|weight|size|speed|age|count|depth|area|volumes?|capacity|duration|temperature|numbers?|(?:population|attendance)(?: figures?)?)\b|^(?:ال)?(?:طول|ارتفاع|عرض|سماكه|محيط|مسافه|وزن|حجم|سرعه|عمر|عدد|عمق|مساحه|سعه|مده|درجه الحراره)(?!\p{L})/iu],
  ['text', /^(?:(?:opening|closing|office|visiting|business|working|support|service) hours|hours|schedules?|timetable|title|availability|contact (?:details|information)|cancellation (?:terms|policy)|terms|requirements|policy)\b|^(?:(?:ساعات|اوقات)\s+(?:ال)?(?:العمل|الدوام|الزياره|الدعم|الفتح|الاغلاق)|(?:ال)?(?:جدول|توافر|مواعيد|شروط|متطلبات|سياسه)|بيانات الاتصال)(?!\p{L})/iu],
];

function namedField(text: string): AnswerType | undefined {
  const subject = text.replace(/^(?:(?:the|only|just|both|all|each|كلا|كلتا|جميع|كل)[\s,:]+)*/iu, '')
    .replace(/^(?:(?:official|actual|declared|published|estimated|average|total|maximum|minimum|conflicting|differing)\s+)*/iu, '');
  return FIELD_TYPES.find(([, pattern]) => pattern.test(subject))?.[0];
}

const ATTRIBUTION = /\s+(?:(?:listed|specified|stated|indicated|shown|printed|documented|reported|published)\s+(?:at|on|in|by)|according to|(?:كما\s+(?:ورد|ذكر|نشر)|(?:الوارد|المذكور|المدون|المنشور)(?:ه)?\s+(?:في|علي)|حسب))(?=\s|[\p{P}]|$)/iu;
const EMBEDDED_FIELDS = FIELD_TYPES.map(([type, pattern]) => [
  type,
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern.source.replace(/(^|\|)\^/gu, '$1')})`, pattern.flags),
] as const);

function reportedField(object: string) {
  let first: { index: number; end: number; type: AnswerType } | undefined;
  for (const [type, pattern] of EMBEDDED_FIELDS) {
    const field = pattern.exec(object);
    if (field && (!first || field.index < first.index)) first = { index: field.index, end: field.index + field[0].length, type };
  }
  return first;
}

function nominalTopic(object: string, field: NonNullable<ReturnType<typeof reportedField>>) {
  const remainder = `${object.slice(0, field.index)} ${object.slice(field.end)}`;
  return searchTokens(remainder).some(word => /\p{L}/u.test(word) && !NOMINAL_SCAFFOLDING.has(word) && !namedField(word));
}

type RuleInput = {
  text: string;
  match: string;
  hasUrls: boolean;
  personal: boolean;
  exchange: boolean;
  direct: ReturnType<typeof directRoute>;
  recallFormat: ReturnType<typeof memoryRecallFormat>;
  report: boolean;
  comparison: boolean;
  nominal: boolean;
  field: AnswerType | undefined;
};
type Rule = { intent: Intent; rule: string; applies(input: RuleInput): boolean };

const RULES: readonly Rule[] = [
  { intent: 'memory_save', rule: 'explicit-memory-write', applies: input => asksToRemember(input.text) },
  { intent: 'memory_recall', rule: 'memory-lookup', applies: input => Boolean(input.recallFormat) || MEMORY.test(input.match) },
  { intent: 'identity', rule: 'assistant-identity', applies: input => IDENTITY.test(input.match) },
  { intent: 'smalltalk', rule: 'greeting-or-thanks', applies: input => SMALLTALK.test(input.match.replace(SALUTATION_END, '')) },
  { intent: 'memory_recall', rule: 'owner-data', applies: input => input.personal && (QUESTION.test(input.match) || ASK_FACT.test(input.match) || input.report || Boolean(input.field)) },
  { intent: 'ads', rule: 'campaign-request', applies: input => requestsPausedCampaign(input.text) || ADS.test(input.match) },
  { intent: 'coding', rule: 'code-change', applies: input => CODING.test(input.match) },
  { intent: 'computer', rule: 'computer-control', applies: input => COMPUTER.test(input.match) },
  { intent: 'fact_question', rule: 'live-currency-exchange', applies: input => input.exchange },
  { intent: 'site_check', rule: 'site-inspection', applies: input => SITE_CHECK.test(input.match) || input.hasUrls && (ADDRESS_HEALTH.test(input.match) || ADDRESS_STATUS.test(input.match) || ADDRESS_REDIRECT.test(input.match) || CHECK_REFERENCE.test(input.match)) },
  { intent: 'open_site', rule: 'direct-open', applies: input => Boolean(input.direct?.finishes) || ADDRESS_OPEN.test(input.match) || OPEN_REQUEST.test(input.match) && !input.hasUrls },
  { intent: 'site_question', rule: 'question-with-address', applies: input => input.hasUrls && (QUESTION.test(input.match) || ASK_FACT.test(input.match) || Boolean(input.direct)) },
  { intent: 'site_question', rule: 'field-with-address', applies: input => input.hasUrls && (input.report || Boolean(input.field)) },
  { intent: 'compute', rule: 'local-calculation', applies: input => !input.exchange && (MATH_VERB.test(input.match) || CLOCK.test(input.match) || DATE_MATH.test(input.match) || MATH_FORMAT.test(input.match) || SPOKEN_MATH.test(input.match) || QUANTITY.test(input.match) && UNIT_EXPRESSION.test(input.match) || isTemperatureQuestion(input.match.replace(/[\s,.!?؟،؛;:]+$/u, ''))) },
  { intent: 'compare', rule: 'comparison', applies: input => input.comparison },
  { intent: 'explain', rule: 'free-explanation', applies: input => EXPLAIN.test(input.match) },
  { intent: 'write', rule: 'free-writing', applies: input => WRITE.test(input.match) || PRODUCE_TEXT.test(input.match) },
  { intent: 'unknown', rule: 'ambiguous-action', applies: input => VAGUE_ACTION.test(input.match) || !input.hasUrls && CHECK_REFERENCE.test(input.match) },
  { intent: 'fact_question', rule: 'factual-report', applies: input => input.report },
  { intent: 'fact_question', rule: 'question-shape', applies: input => QUESTION.test(input.match) || ASK_FACT.test(input.match) },
  { intent: 'fact_question', rule: 'property-and-topic', applies: input => input.nominal },
  { intent: 'open_site', rule: 'address-only', applies: input => input.hasUrls && input.match === '' },
];

export function buildFrame(request: string): Frame {
  const normalized = normalizeRequest(request);
  const addresses = addressesIn(request);
  const urls = [...new Set(addresses.map(address => address.href))];
  const purpose = addresses.reduce((text, address) => text.replaceAll(address.written, ' '), normalized.text).replace(EXPLICIT_ADDRESS, ' ').replace(/\s+/gu, ' ').trim();
  const folded = stripCourtesyTail(matchText(purpose));
  const match = urls.length ? folded.replace(SOURCE_LEAD, '').replace(/^[:,،؛–—-]+\s*/u, '') : folded;
  const personal = PERSONAL.test(match);
  const exchange = EXCHANGE.test(match) || (UNIT_EXPRESSION.test(match) || CURRENCY_PAIR.test(match)) && [...match.matchAll(CURRENCY)].length > 1;
  const direct = directRoute(normalized.text);
  const recallFormat = memoryRecallFormat(normalized.text);
  const hasPresentationVerb = PRESENT_VERB.test(match);
  const subject = match.replace(PRESENT_VERB, '');
  const compares = COMPARISON.test(match) || DISAGREEMENT.test(subject);
  const named = namedField(subject);
  const object = subject.split(ATTRIBUTION, 1)[0];
  const mentioned = reportedField(object);
  const nominal = Boolean(mentioned && !OPEN_REQUEST.test(match) && nominalTopic(object, mentioned) && (named || !sensitiveAction(match)));
  const field = named ?? (hasPresentationVerb || compares || nominal ? mentioned?.type : undefined);
  const hasFactObject = FACT_OBJECT.test(subject);
  const comparison = compares || hasPresentationVerb && CONFLICTING_REPORT.test(subject) && (Boolean(field) || hasFactObject);
  const report = hasPresentationVerb && subject.length > 0 && (Boolean(field) || comparison || QUESTION.test(subject) || hasFactObject);
  const input = { text: normalized.text, match, hasUrls: urls.length > 0, personal, exchange, direct, recallFormat, report, comparison, nominal, field };
  const matched = RULES.filter(rule => rule.applies(input)).map(({ intent, rule }) => ({ intent, rule }));
  const intent: Intent = matched[0]?.intent ?? 'unknown';
  const missing: string[] = [];
  if (intent === 'unknown' || !urls.length && (VAGUE_QUESTION.test(subject) || MEASURE_WITHOUT_SUBJECT.test(subject))) missing.push('question');
  if ((intent === 'open_site' && !direct || intent === 'site_check') && !urls.length) missing.push('website');
  if (intent === 'compute' && ACTION_ONLY.test(match)) missing.push('expression');
  if (intent === 'memory_save' && !match.replace(/^(?:تذكر|احفظ|لا تنس|remember|don['’]?t forget|save (?:this|that|it)|keep in mind)[\s,:،]*/iu, '').replace(/[.!?؟]/gu, '').trim()) missing.push('memory_content');

  let query: ReturnType<typeof compileQuery> | undefined;
  try { query = compileQuery(purpose); } catch { /* empty or malformed filters have no compiled query */ }
  const answerType = exchange ? 'money' : field ?? TYPES.find(([, pattern]) => pattern.test(match))?.[0]
    ?? (hasPresentationVerb ? TYPES.find(([, pattern]) => pattern.test(subject))?.[0] : undefined)
    ?? (intent === 'compute' ? 'number' : intent === 'compare' ? 'number' : intent === 'unknown' ? null : 'text');
  const transport = TRANSPORT.test(match);
  const pendingService = transport && TRANSIT_SERVICE.test(match) && !TRANSIT_HISTORY.test(match);
  // Search ranking accepts bare transport nouns as freshness cues. The frame
  // requires a service detail or a separate freshness cue for those subjects.
  const searchFreshness = query?.timeSensitive && !HISTORY.test(match) && (!transport || OTHER_TIME_VARYING.test(match));
  const timeSensitive = exchange || EXPLICIT_FRESHNESS.test(match) || pendingService || Boolean(searchFreshness);
  const requestWords = report ? new Set(searchTokens(match.slice(0, match.length - subject.length))) : undefined;
  return {
    lang: normalized.lang, intent, matched, text: normalized.text, urls,
    focus: [...new Set(query?.tokens ?? searchTokens(purpose))].filter(term => !FOCUS_SCAFFOLDING.has(term) && !requestWords?.has(term)), answerType, timeSensitive,
    personal, valueOnly: ONLY_VALUE.test(match) || recallFormat?.kind === 'value', missing,
  };
}
