import { foldText } from '../../../../../packages/skills/src/stems.js';
import { figureKind, hasFigureOf, isMetaLine, isReasonQuestion, isUiText, questionLanguage, type FigureKind } from '../answer-check.js';

export type AnswerType = 'person' | 'organization' | 'place' | 'date' | 'quantity' | 'reason' | 'method' | 'definition' | 'comparison' | 'unknown';

export interface QuestionIntent {
  type: AnswerType;
  language: 'ar' | 'en';
  question: string;
  figure: FigureKind;
}

export interface AnswerTypeCandidate {
  text: string;
  title?: string;
  heading?: string;
  kind?: 'title' | 'lead' | 'sentence' | 'list' | 'table';
  cells?: readonly string[];
}

export interface AnswerTypeEvidence {
  /** Original quote or field carrying the cue. The ranker still returns the complete candidate quote. */
  value: string;
  strength: 1 | 2 | 3;
  cue: string;
}

const REQUEST_PREFIX = /^(?:(?:please )?(?:explain|describe|tell me|find out|show me)\s+(?:to me\s+)?|(?:من فضلك )?(?:اشرح|وضح|فسر|اخبرني|قل لي|بين)\s+(?:لي\s+)?)/u;
const COMPARISON_QUESTION = /(?:^|\s)(?:قارن|مقارنه|مقابل|ايهما|الفرق بين)(?=\s|$)|\b(?:compar(?:e|ison)|versus|vs\.?|differences? between|which (?:one )?is (?:larger|smaller|higher|lower|older|younger|taller|longer|faster|slower|better|worse|more|less))\b/u;
const COMPARISON_OPTIONS = /^which\b[^?]{0,170}\b(?:deeper|shallower|larger|smaller|higher|lower|older|younger|earlier|later|taller|longer|shorter|faster|slower|hotter|colder|heavier|lighter|better|worse|more|less)\b[^?]{0,170}\bor\s+\S/u;
const COMPARATIVE = /\b(?:deeper|shallower|larger|smaller|higher|lower|older|younger|earlier|later|taller|longer|shorter|faster|slower|hotter|colder|heavier|lighter|better|worse|more(?: [a-z]+){0,2}|less(?: [a-z]+){0,2}) than\s+(?![\d-]|(?:a|one) (?:hundred|thousand|million|billion)\b)|(?:^|\s)(?:اعمق|اضحل|اكبر|اصغر|اعلي|ادني|اطول|اقصر|اسرع|ابطا|اقدم|احدث|افضل|اسوا|اثقل|اخف|اكثر(?: [\p{L}]+){0,2}|اقل(?: [\p{L}]+){0,2}) من\s+(?![\d-])|(?:^|\s)(?:[وف])?(?:تزيد|يزيد|تقل|يقل) [\p{L}]+ عن\s+(?![\d-])/u;
const COMPARATIVE_ORDINAL = /\bsecond-(?:largest|smallest|highest|lowest|longest|shortest|most|least)\b[^.;!?]{1,70}\bafter\s+\p{Lu}/u;
const DATE_QUESTION = /^(?:when\b|(?:in )?(?:which|what) (?:year|month|day|date)\b|what (?:is|was) (?:the )?date\b|متي(?=\s|$)|في اي (?:عام|سنه|شهر|يوم|تاريخ)(?=\s|$)|ما تاريخ(?=\s|$))/u;
const QUANTITY_QUESTION = /^(?:how (?:many|much|old|long|far|high|tall|heavy|fast|deep|wide|big)\b|what (?:is|was)\b.*\b(?:population|size|length|width|height|weight|age|depth|distance|speed|area|price|cost|duration|percentage|number)\b|(?:كم|اديش|قديش)(?=\s|$)|(?:ما|ماهو|ماهي)\s+(?:(?:هو|هي) )?(?:عدد|مساحه|طول|عرض|ارتفاع|عمق|وزن|عمر|سرعه|تكلفه|سعر|مسافه|مده|نسبه|تعداد|حجم)(?=\s|$))/u;
const METHOD_QUESTION = /^(?:how\b|(?:what|which) (?:method|steps?|procedure|process|way)\b|(?:كيف|كيفيه)(?=\s|$)|(?:ما|ماهي)\s+(?:هي\s+)?(?:طريقه|خطوات|كيفيه)(?=\s|$))/u;
const PLACE_QUESTION = /^(?:where\b|(?:in )?(?:what|which) (?:city|country|continent|region|place|state|province|town)\b|what (?:is|was) (?:the )?(?:capital|location|birthplace)\b|(?:اين|وين|من وين)(?=\s|$)|في اي (?:مدينه|دوله|بلد|قاره|منطقه|مكان|ولايه)(?=\s|$)|(?:ما|ماهي)\s+(?:هي\s+)?(?:عاصمه|موقع|مكان)(?=\s|$))/u;
const ORGANIZATION_QUESTION = /^(?:(?:what|which) (?:(?:is|was) the )?(?:organi[sz]ation|agency|company|corporation|firm|institution|university|team|group)\b|(?:اي\s+(?:ال)?|(?:ما|ماهي)\s+(?:هي\s+)?ال)(?:شركه|منظمه|هيئه|جامعه|م[وؤ]سسه|وكاله|فريق|جهه)(?=\s|$))/u;
const PERSON_QUESTION = /^(?:who(?:m|se)?\b|(?:which|what) person\b|(?:من|لمن|مين)(?=\s|$))/u;
const DEFINITION_QUESTION = /^(?:define\b|what (?:is|are|was|were|does .+ mean)\b|meaning of\b|(?:عرف|ماهو|ماهي|ما المقصود|ما معني|ما مفهوم|ما تعريف|ماذا يعني|ماذا تعني)(?=\s|$)|ما(?=\s|$))/u;

export function classifyQuestion(question: string): QuestionIntent {
  const language = questionLanguage(question);
  const query = foldText(question).trim().replace(REQUEST_PREFIX, '').replace(/[؟?!]+$/u, '').trim();
  const figure = figureKind(query);
  let type: AnswerType = 'unknown';
  if (isReasonQuestion(query) || /^(?:what (?:made|led to|caused)\b|(?:ما|اي)\s+(?:العوامل|الاسباب) التي ادت)/u.test(query)) type = 'reason';
  else if (COMPARISON_QUESTION.test(query) || COMPARISON_OPTIONS.test(query) || COMPARATIVE.test(query)) type = 'comparison';
  else if (DATE_QUESTION.test(query)) type = 'date';
  else if (QUANTITY_QUESTION.test(query)) type = 'quantity';
  else if (PLACE_QUESTION.test(query)) type = 'place';
  else if (ORGANIZATION_QUESTION.test(query)) type = 'organization';
  else if (PERSON_QUESTION.test(query)) type = 'person';
  else if (METHOD_QUESTION.test(query)) type = 'method';
  else if (DEFINITION_QUESTION.test(query)) type = 'definition';
  return { type, language, question: query, figure };
}

const MAKER_RELATIONS = [
  /\b(?:invent(?:s|ed|ing|or|ion)?|patent(?:s|ed)?|devis(?:e|ed|es|ing))\b|(?:^|\s)(?:اخترع[ته]?|اختراع(?:ه|ها)?|مخترع|ابتكر[ته]?|ابتكار|براءه اختراع)(?=\s|$)/u,
  /\b(?:writ(?:e|es|ing|ten)|wrote|author(?:s|ed)?|(?:novel|book|play|paper|poem) by)\b|(?:^|\s)(?:كتب[ته]?|كتابه|كاتب|الكاتب|الف[ته]?|(?:ال)?م[وؤ]لف|تاليف)(?=\s|$)/u,
  /\b(?:found(?:s|ed|ers?)|establish(?:es|ed|ing)?|co-found(?:s|ed|ers?))\b|(?:^|\s)(?:اسس[ته]?|تاسيس|م[وؤ]سس[هه]?|اسسها|انشا[ته]?|انشئ[ت]?|انشاء)(?=\s|$)/u,
  /\b(?:discover(?:y|s|ed|er)?|identif(?:ied|ies|y))\b|(?:^|\s)(?:اكتشف[ته]?|اكتشاف|مكتشف)(?=\s|$)/u,
  /\b(?:direct(?:or|ed|s)?|design(?:er|ed|s)?|paint(?:er|ed|s)?|compos(?:er|ed|es|ition))\b|(?:^|\s)(?:اخرج[ته]?|اخراج|مخرج|صمم[ته]?|تصميم|مصمم|رسم[ته]?|رسام|لحن[ته]?|ملحن)(?=\s|$)/u,
  /\b(?:built|build(?:s|er|ing)?|creat(?:e|es|ed|or))\b|(?:^|\s)(?:بني[ته]?|بناه|بناها|بناء|صنع[ته]?|صانع)(?=\s|$)/u,
  /\b(?:won|wins?|winner|awarded|received)\b|(?:^|\s)(?:فاز[ته]?|فائز|حصل[ته]?|نال[ته]?|منح[ته]?)(?=\s|$)/u,
  /\b(?:president|minister|mayor|governor|leader|chief executive|ceo|monarch|king|queen)\b|(?:^|\s)(?:ال)?(?:رئيس|وزير|حاكم|عمده|ملك|ملكه|قائد|مدير)(?=\s|$)/u,
] as const;

const PROPER_NAME = /\p{Lu}[\p{L}\p{M}’'-]+(?:\s+(?:(?:de|del|van|von|al|bin|ibn)\s+)?(?:\p{Lu}[\p{L}\p{M}’'-]+|\p{Lu}\.))+/u;
const NAMED_ACTOR = new RegExp(String.raw`^(?<name>${PROPER_NAME.source}|\p{Lu}\p{Ll}+)(?:\s*\([^)]*\))?\s+(?:first |co-)?(?:invented|wrote|founded|discovered|directed|designed|painted|composed|built|created|won|received|patented|was (?:awarded|credited)|is (?:credited|considered))\b`, 'u');
const CREDITED_ACTORS = /^(?<names>[^.!?;]{3,180}?)\s+(?:ha(?:ve|s) (?:(?:all|both) )?been|were|are) (?:(?:all|both) )?credited with\b/u;
const NAMED_RECIPIENT = new RegExp(String.raw`\b(?:by|(?:credited|awarded|granted) to)\s+(?:\p{Ll}[\p{L}-]*\s+){0,4}(?<name>${PROPER_NAME.source})`, 'u');
const NAMED_OFFICIAL = new RegExp(String.raw`\b(?:is|was)\s+(?<name>${PROPER_NAME.source})`, 'u');
const ARABIC_PERSON_ROLE = /(?:^|\s)(?:المخترع|العالم|الم[وؤ]لف|الكاتب|الرئيس|القائد|الطبيب|المهندس|الفنان|اللاعب|الممثل|الشاعر|الروائي|السياسي|الم[وؤ]سس)(?=\s|$)/u;
const ARABIC_AGENT_LINK = /(?:^|\s)(?:من (?:طرف|قبل|تاليف)|علي يد|بقياده|علي راس)(?=\s|$)/u;
const IDENTITY_EN = /\b(?:is|was|are|were) (?:an? |the )(?:[\p{L}’'-]+ ){0,5}[\p{L}’'-]+\b|\b(?:known as|refers to|is (?:defined as|called)|means|consists of)\b/u;
const IDENTITY_AR = /(?:^|\s)(?:هو|هي|هما|كان|كانت|يعرف بانه|تعرف بانها|يعرف علي انه|تعرف علي انها|يقصد به|يقصد بها|يعني|تعني|عباره عن|يشير الي|تشير الي)\s+(?!(?:في|منذ|عند|خلال|علي|احدي سنه)\s)\S/u;
const ORGANIZATION_LABEL = /\b(?:company|corporation|organi[sz]ation|agency|firm|institution|university|developer|producer|publisher|manufacturer|team|operator|group)\b|(?:^|\s)(?:ال)?(?:شركه|منظمه|هيئه|جامعه|م[وؤ]سسه|وكاله|فريق|جهه|ناشر|مطور|منتج)(?=\s|$)/u;
const ORGANIZATION_NAME = /\b(?:university|institute|association|foundation|corporation|inc\.?|ltd\.?|llc|plc|ministry|organi[sz]ation|agency|commission|society|administration|company|council|platforms|systems|laboratories)\b|(?:^|\s)(?:ال)?(?:شركه|منظمه|هيئه|جامعه|م[وؤ]سسه|وكاله|وزاره|مجلس|جمعيه|معهد|اداره)(?=\s|$)/u;
const ORGANIZATION_RELATION = /\b(?:(?:operated|run|owned|managed|developed|maintained|published|manufactured|produced|built|funded|formed|created) by|founded|owns?|manages?|operates?|developers?|publishers?|manufacturer)\b|(?:^|\s)(?:تدير|يدير|تمتلك|تملك|يتبع|تابع ل|انشات|طورت|تنتج|صنعت|اطلقت|نشرت|انتاج|اشراف|تمويل)(?=\s|$)/u;
const ORGANIZATION_ROLES = [
  [/\b(?:runs?|operat(?:es?|or)|manag(?:es?|er)|in charge of)\b|(?:^|\s)(?:يدير|تدير|يشغل|تشغل|يشرف|تشرف)(?=\s|$)/u, /\b(?:(?:run|operated|managed) by|(?:runs?|operates?|manages?) (?:the|an?)|operator)\b|(?:^|\s)(?:تدير[هه]ا?|يدير[هه]ا?|يشغل[هه]ا?|تشغل[هه]ا?|يدار|تدار|تشرف|يشرف|باشراف)(?=\s|$)/u],
  [/\b(?:funds?|funded|funding|sponsors?|sponsored)\b|(?:^|\s)(?:يمول|تمول|مول|مولت|تمويل)(?=\s|$)/u, /\b(?:(?:funded|sponsored) by|(?:funds?|sponsors?) (?:the|an?)|funding)\b|(?:^|\s)(?:يمول|تمول|مول[ت]?|تمويل|بتمويل)(?=\s|$)/u],
  [/\b(?:makes?|manufactur(?:es?|ed)|produc(?:es?|ed))\b|(?:^|\s)(?:يصنع|تصنع|صنع|صنعت|ينتج|تنتج|انتجت)(?=\s|$)/u, /\b(?:(?:made|manufactured|produced) by|(?:makes?|manufactures?|produces?) (?:the|an?)|manufacturer|producer)\b|(?:^|\s)(?:يصنع|تصنع|صنع[ت]?|ينتج|تنتج|انتج[ت]?|انتاج)(?=\s|$)/u],
  [/\b(?:develop(?:s|ed|er)?|creat(?:es?|ed|or))\b|(?:^|\s)(?:يطور|تطور|طور|طورت|ينشي|تنشي|انشا|انشات)(?=\s|$)/u, /\b(?:(?:developed|created) by|(?:develops?|creates?) (?:the|an?)|developer|creator)\b|(?:^|\s)(?:يطور|تطور|طور[ت]?|ينشي|تنشي|انشا[ت]?|مطور)(?=\s|$)/u],
  [/\b(?:owns?|owned|owner)\b|(?:^|\s)(?:يملك|تملك|يتمتع بملكيه|تمتلك|يمتلك)(?=\s|$)/u, /\b(?:owned by|owns? (?:the|an?)|owner)\b|(?:^|\s)(?:تملك|يملك|تمتلك|يمتلك|تابع ل|مالك)(?=\s|$)/u],
] as const;
const LOCATION_LABEL = /\b(?:capital|location|birth(?:place| place)|headquarters|place of (?:birth|death)|country|continent|city|state|region|province|town)\b|(?:^|\s)(?:ال)?(?:عاصمه|موقع|مقر|مكان الميلاد|مكان الولاده|مكان الوفاه|مكان|مدينه|دوله|بلد|قاره|منطقه|ولايه)(?=\s|$)/u;
const EVENT_CUES = [
  /\b(?:born|birth(?:place)?)\b|(?:^|\s)(?:[وف])?(?:ولد[ت]?|(?:ال)?ميلاد(?:ه|ها)?|ولاده|مولد|مسقط راسه)(?=\s|$|[:|])/u,
  /\b(?:died|die|death|passed away)\b|(?:^|\s)(?:[وف])?(?:توفي[ت]?|مات[ت]?|وفاه|وفات(?:ه|ها))(?=\s|$)/u,
  /\b(?:capital|headquarters)\b|(?:^|\s)(?:عاصمه|عاصمت[هه]ا?|مقر(?:ه|ها)?)(?=\s|$)/u,
  /\b(?:held|takes? place|took place|occurr?(?:ed|s)?)\b|(?:^|\s)(?:[وف])?(?:اقيم[ت]?|عقد[ت]?|حدث[ت]?)(?=\s|$)/u,
  /\b(?:found(?:s|ed)?|establish(?:ed|ment)?|originat(?:e|ed|es))\b|(?:^|\s)(?:[وف])?(?:انشئ[ت]?|تاسس[ت]?|تاسيس(?:ه|ها)?|اصل|نشا[ت]?)(?=\s|$)/u,
  /\b(?:independen(?:t|ce)|became sovereign)\b|(?:^|\s)(?:[وف])?(?:استقل[ت]?|استقلال(?:ها|ه)?|مستقل(?:ه)?)(?=\s|$)/u,
  /\b(?:publish(?:ed|es)?|releas(?:e|ed)|premier(?:e|ed))\b|(?:^|\s)(?:[وف])?(?:نشر[ت]?|صدر[ت]?|صدور|اطلق[ت]?|اطلاق)(?=\s|$)/u,
  /\b(?:fall|fell|fallen|collapse[ds]?|collapsed|came down)\b|(?:^|\s)(?:[وف])?(?:سقط[ت]?|سقوط|انهار[ت]?|انهيار)(?=\s|$)/u,
  /\b(?:open(?:ed|ing)?|inaugurat(?:e|ed|ion))\b|(?:^|\s)(?:[وف])?(?:افتتح[ت]?|افتتاح)(?=\s|$)/u,
] as const;
const LOCATION_EN = /\b(?:located|situated|based|born|died|held|established|founded|occurs?|takes? place|lies|stands) (?:in|at|near|on)\s+(?!the (?:year|early|late)\b)|\b(?:capital|birthplace|headquarters) (?:city )?(?:is|was|of)\b/u;
const GEOGRAPHIC_IDENTITY = /\b(?:is|was) (?:an? |the )?(?:[a-z-]+ ){0,4}(?:country|island|city|town|region|province|state|continent|district|mountain|village) (?:in|of|on|near) (?:(?:the|northern|southern|western|eastern) )?\p{Lu}/u;
const LOCATION_AR = /(?:^|\s)(?:[وف])?(?:يقع|تقع|يوجد|توجد|تقعان|يمتد|تمتد|ولد|ولدت|توفي|توفيت|مات|ماتت|اقيم|اقيمت|تاسس|تاسست|انشئ|انشئت)\s+(?:في|ب|داخل|بالقرب من|علي)\s*\S|(?:^|\s)(?:ال)?(?:عاصمه|عاصمت[هه]ا?|مقرها|مقره|مقر|مسقط راسه)(?=\s|$)/u;
const AR_EVENT_LOCATION = /(?:^|\s)(?:[وف])?(?:ولد[ت]?|توفي[ت]?|مات[ت]?|اقيم[ت]?|تاسس[ت]?)(?:\s+\p{L}+){1,6}\s+(?:في|بمدينه|بمحافظه)\s+\p{L}/u;

const REASON_MARKER = /\b(?:because(?: of)?|due to(?! (?:be|start|arrive|begin|end|leave|open|close)\b)|caused by|as a result of|owing to|result(?:s|ed|ing)? from|stems? from|influenced by|attribut(?:ed|able) to|is why)\s+\S|(?:^|[\s،(])(?:و|ف)?لان(?:ه|ها|هم|هما|نا|ك)?\s+\S|(?:^|[\s،(])(?:و|ف)?(?:بسبب|كنتيجه|نتيجه(?: ل| عن)?|جراء|بفعل|علي اثر|يعود ذلك الي|يعود الي|تعود الي|يرجع الي|ترجع الي|يعزي الي|تعزي الي)\s+\S/u;
const CAUSAL_PREDICATE = /\b(?:causes?|caused|leads? to|led to|results? in|resulted in|trigger(?:s|ed)|responsible for)\s+\S|\b(?:falls?|pulled|driven) (?:by|under (?:the influence of )?) ?gravity\b|(?:^|\s)(?:يسبب|تسبب|تسببت|سبب|ادت الي|ادي الي|يودي الي|تودي الي|ينجم عن|ينتج عن|تنتج عن|ناتج عن)\s+\S/u;
const REASON_HEADING = /^(?:(?:main |primary )?(?:causes?|reasons?|factors))(?: of| for|$)|^(?:اهم\s+)?(?:ال)?(?:سبب|اسباب|عوامل|مسببات)(?=\s|$)/u;
const REASON_POINTER = /(?:\b(?:for the following reasons|(?:several|many|various|different|multiple) (?:reasons|factors)(?:,? (?:including|such as|as follows))?)|(?:^|\s)(?:(?:لاسباب|لعوامل|اسباب|عوامل) (?:عده|كثيره|مختلفه|متعدده)|(?:عده|عديد من) (?:ال)?(?:اسباب|عوامل))(?:[،,]?\s+(?:اهمها|منها|مثل|تشمل))?)[.:：…]?$/u;
const EXPLICIT_REASON = /\b(?:(?:the )?reason (?:is|was)(?: that)?|(?:primary |main )?(?:purpose|intention) for [^.!?;]{1,80} (?:is|was) to)\s+\S|(?:^|\s)(?:السبب (?:ان|هو|يكمن في)|نظرا (?:الي|ل)|الهدف من [^.!?؛]{1,70} (?:هو|كان))\s+\S/u;
const NAMING_QUESTION = /\b(?:named|called|nicknamed|known as)\b|(?:^|\s)(?:سمي[ت]?|تسميه|يدعي|اسم)(?=\s|$)/u;
const NAMING_REASON = /\b(?:named after|(?:named|called|titled|nicknamed) [^.!?;]{1,90} for (?:its|their|the))\s+\S|(?:^|\s)(?:سمي[ت]?|تسميه) [^.!?;]{1,85} (?:نسبه الي|نظرا ل|تيمنا ب)\s*\S/u;
const METHOD_MARKER = /\b(?:by [a-z]+ing|by means of|using|via|works? by|consists? of|carried out (?:by|through))\s+\S|(?:^|[\s،(])(?:عن طريق|من خلال|باستخدام|بواسطه|عن طريقه|عبر|تتم ب|يتم ب)\s*\S/u;
const METHOD_MECHANISM = /\b(?:occurs?|happens?|forms?|grows?|works?) when\s+\S|\b(?:depends? on|in a process called|measured through)\s+\S|(?:^|\s)(?:يحدث|تحدث|يتشكل|تتشكل|يتكون|تتكون|ينمو|تنمو)[^.؛]{0,60}\sعندما\s+\S/u;
const METHOD_HEADING = /^(?:methods?|procedure|instructions?|steps?|process|preparation)(?:\s|$)|^(?:ال)?(?:خطوات|طريقه|طرق|كيفيه|تحضير|اجراءات|اعداد)(?=\s|$)/u;

const DATE_LABEL = /\b(?:date|year|founded|established|born|died|released|published|opened|started|established)\b|(?:^|\s)(?:ال)?(?:تاريخ|عام|سنه|مولد|ميلاد|وفاه|تاسيس|انشاء|اطلاق|افتتاح|نشر|استقلال)(?=\s|$)/u;
const DATE_CONTEXT = /\b\d{1,4}\s*(?:b\.?c\.?(?:e\.?)?|a\.?d\.?|c\.?e\.?)\b|\b(?:in (?:the year )?|year )\d{3}\b|(?:^|\s)(?:سنه|عام) \d{3,4}(?!\d)|\d{1,4}\s*(?:قبل الميلاد|ميلادي(?:ه)?|هجري(?:ه)?)(?=\s|$|[.،,])/u;
const DATE_CLAUSE_BREAK = /[;؛]|[,،]\s*(?:which|who|while|whereas|although|but|الذي|التي|حيث|بينما|لكن)(?=\s|$)/u;
const QUANTITY_LABEL = /\b(?:age|height|area|population|distance|price|length|width|duration|mass|weight|counts?|total|number|speed|depth)\b|(?:^|\s)(?:ال)?(?:عمر|طول|عرض|ارتفاع|مساحه|سكان|مسافه|سعر|وزن|مده|عدد|عمق|سرعه)(?=\s|$)/u;
const AGE_QUESTION = /\b(?:how old|age)\b|(?:^|\s)(?:ال)?عمر(?:ه|ها)?(?=\s|$)/u;
const AGE_EVIDENCE = /\b(?:aged?\s*(?::|was|is|of)?\s*\d|\d+\s+years? old|at (?:the )?age of)\b|(?:^|[\s(])(?:(?:[وف])?(?:(?:ي|ت)?بلغ|البالغ[هه]?) (?:من )?(?:ال)?عمر(?:ه|ها)?|(?:ال)?عمر(?:ه|ها)?\s*(?::|هو|هي)?\s*\d|ناهز(?:ت)?)(?=\s|\d|[)]|$)/u;
const CURRENT_AGE = /\b(?:is \d+ years? old|(?:current )?age (?:is|:)\s*\d|now aged? \d)|\(\s*age \d|(?:^|[\s(])(?:(?:[وف])?(?:يبلغ|تبلغ) (?:من )?(?:ال)?عمر(?:ه|ها)?\s+\d|(?:ال)?عمر(?:ه|ها)?\s*(?::|هو|هي)?\s*\d)/u;
const HISTORICAL_AGE_QUESTION = /\b(?:how old (?:was|were)|age (?:at|when|in)|when|at the time of)\b|(?:^|\s)(?:كان عمر|كان عمره|كانت عمرها|عند|عندما|حين)(?=\s|$)/u;
const POPULATION_FORECAST = /\b(?:project(?:s|ed|ion|ions)?|forecast(?:s|ed)?|expects?|expected|will (?:reach|rise to|be))\b|(?:^|\s)(?:يتوقع|متوقع|متوقعه|توقعات|سيبلغ|ستبلغ|سيصل|ستصل)(?=\s|$)/u;
const MEASURES = [
  [/\b(?:how (?:far|high|tall|deep|wide|long)|height|length|width|depth|distance)\b|(?:^|\s)(?:مسافه|ارتفاع|طول|عرض|عمق)(?=\s|$)/u, /\b(?:kilomet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|miles?|feet|ft|cm|km|m)\b|(?:^|\s)(?:كيلومتر(?:ا|ات)?|كم|م|متر(?:ا|ات)?|سم|سنتيمتر(?:ا|ات)?|قدم(?:ا)?|كيلومترات|اميال|ميل(?:ا)?|امتار)(?=\s|$|[.،,])/u],
  [/\b(?:weight|how heavy)\b|(?:^|\s)وزن(?=\s|$)/u, /\b(?:kilograms?|grams?|kg|pounds?|lb|tons?|tonnes?)\b|(?:^|\s)(?:كيلوغرام(?:ا|ات)?|كيلوجرام(?:ا|ات)?|كغ|غرام(?:ا|ات)?|غم|طن(?:ا)?|اطنان|رطل(?:ا)?)(?=\s|$|[.،,])/u],
  [/\barea\b|(?:^|\s)مساحه(?=\s|$)/u, /\b(?:square (?:kilomet(?:er|re)s?|met(?:er|re)s?|miles?)|sq\.? (?:km|mi)|hectares?|acres?|km2|m2)\b|(?:^|\s)(?:كيلومتر|كم|متر|ميل)\s*(?:مربع|مربعه|2)|(?:^|\s)هكتار(?:ا|ات)?(?=\s|$|[.،,])/u],
  [/\b(?:speed|how fast)\b|(?:^|\s)سرعه(?=\s|$)/u, /\b(?:mph|kph|km\/h|m\/s|(?:kilomet(?:er|re)s?|miles?|met(?:er|re)s?) per (?:hour|second))\b|(?:^|\s)(?:كيلومتر|كم|متر|ميل)\s*(?:\/\s*س|\/\s*ث|في (?:الساعه|الثانيه)|لكل (?:ساعه|ثانيه))/u],
] as const;

const evidence = (value: string, strength: AnswerTypeEvidence['strength'], cue: string): AnswerTypeEvidence => ({ value, strength, cue });

function field(candidate: AnswerTypeCandidate, label: RegExp, accept: (value: string) => boolean = value => /\p{L}/u.test(value)): string | undefined {
  if (candidate.kind !== 'table' && candidate.kind !== 'list') return undefined;
  const fields = candidate.cells?.length ? candidate.cells : candidate.text.split(/\s*(?:[:：|]|\t)\s*/u);
  for (let index = 0; index + 1 < fields.length; index++) {
    const name = foldText(fields[index]).trim();
    const value = fields[index + 1].trim();
    if (name.split(/\s+/u).length <= 6 && label.test(name) && accept(value)) return value;
  }
  if (candidate.heading && label.test(foldText(candidate.heading)) && fields.length === 1 && accept(fields[0])) return fields[0].trim();
  return undefined;
}

function person(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  const relation = MAKER_RELATIONS.find(pattern => pattern.test(intent.question));
  const role = relation ?? ARABIC_PERSON_ROLE;
  const namedField = field(candidate, role);
  if (namedField) return evidence(namedField, 3, 'person-field');
  const lineRole = relation?.exec(line);
  if (relation && !lineRole) return null;
  if (intent.language === 'en') {
    if (relation) {
      const official = relation === MAKER_RELATIONS.at(-1) ? NAMED_OFFICIAL.exec(candidate.text) : null;
      const name = (NAMED_ACTOR.exec(candidate.text) ?? NAMED_RECIPIENT.exec(candidate.text) ?? official)?.groups?.name;
      if (name) return evidence(name, 3, 'person-role');
      const credited = CREDITED_ACTORS.exec(candidate.text)?.groups?.names;
      return credited && PROPER_NAME.test(credited) ? evidence(credited, 3, 'credited-people') : null;
    }
    const name = PROPER_NAME.exec(candidate.text)?.[0];
    if (!name) return null;
    if (IDENTITY_EN.test(line)) return evidence(name, 2, 'named-identity');
    return candidate.kind === 'title' ? evidence(name, 1, 'person-title') : null;
  }
  const markedPerson = ARABIC_PERSON_ROLE.test(line) || ARABIC_AGENT_LINK.test(line);
  if (lineRole && !markedPerson) {
    const askedRole = relation?.exec(intent.question);
    const work = askedRole && intent.question.slice(askedRole.index + askedRole[0].length).trim();
    const afterRole = line.slice(lineRole.index + lineRole[0].length).trim();
    if (work && `${afterRole} `.startsWith(`${work} `)) return null;
  }
  if ((lineRole || markedPerson) && line.split(' ').filter(word => /\p{L}/u.test(word)).length >= 4) return evidence(candidate.text, 3, 'person-role');
  return IDENTITY_AR.test(line) && (candidate.kind === 'lead' || PROPER_NAME.test(candidate.text)) ? evidence(candidate.text, 2, 'named-identity') : null;
}

function organization(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  const role = ORGANIZATION_ROLES.find(([question]) => question.test(intent.question))?.[1];
  const namedField = field(candidate, role ?? ORGANIZATION_LABEL);
  if (namedField) return evidence(namedField, 3, 'organization-field');
  const named = (ORGANIZATION_NAME.test(line) && /\p{L}{2,}\s+\p{L}{2,}/u.test(line)) || /\b[A-Z]{2,}\b/u.test(candidate.text);
  if (named && (role ?? ORGANIZATION_RELATION).test(line)) return evidence(candidate.text, 3, 'organization-role');
  if (role) return null;
  return named && ORGANIZATION_NAME.test(line) && ['lead', 'title'].includes(candidate.kind ?? '') ? evidence(candidate.text, 2, 'organization-name') : null;
}

function place(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  const event = EVENT_CUES.find(pattern => pattern.test(intent.question));
  const eventMatches = !event || event.test(line) || event.test(foldText(candidate.heading ?? ''));
  const namedField = field(candidate, LOCATION_LABEL);
  if (namedField && eventMatches) return evidence(namedField, 3, 'place-field');
  if (!eventMatches) return null;
  const located = intent.language === 'ar' ? LOCATION_AR.test(line) || Boolean(event && AR_EVENT_LOCATION.test(line)) : LOCATION_EN.test(line) || !event && GEOGRAPHIC_IDENTITY.test(candidate.text);
  if (located && !/\b(?:born|died|founded) (?:in|on) \d|(?:^|\s)(?:ولد[ت]?|توفي[ت]?|تاسس[ت]?) في \d/u.test(line)) return evidence(candidate.text, 3, 'location-predicate');
  return null;
}

function figure(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  // This is presence evidence for a sentence score. Value parsing, dates, units, normalization and
  // source conflicts belong to the structured evidence module in PR #18.
  if (!/\d/u.test(line)) return null;
  if (intent.type === 'date') {
    const dateMention = (clause: string) => /\d/u.test(clause) && (hasFigureOf('date', clause) || DATE_CONTEXT.test(clause));
    if (!dateMention(line)) return null;
    const event = EVENT_CUES.find(pattern => pattern.test(intent.question));
    if (event && !line.split(DATE_CLAUSE_BREAK).some(clause => event.test(clause) && dateMention(clause)) && !event.test(foldText(candidate.heading ?? ''))) return null;
    const observed = field(candidate, DATE_LABEL, value => /\d/u.test(foldText(value)));
    return observed ? evidence(observed, 3, 'date-field') : evidence(candidate.text, event ? 3 : 2, 'date-mention');
  }
  const observed = field(candidate, QUANTITY_LABEL, value => /\d/u.test(foldText(value)));
  if (AGE_QUESTION.test(intent.question)) {
    const labelledAge = field(candidate, AGE_QUESTION, value => /\d/u.test(foldText(value)));
    const ageCue = HISTORICAL_AGE_QUESTION.test(intent.question) ? AGE_EVIDENCE : CURRENT_AGE;
    if (ageCue.test(line) || labelledAge) return evidence(labelledAge ?? candidate.text, 3, 'age-mention');
    return null;
  }
  if (intent.figure === 'people' && POPULATION_FORECAST.test(line) && !POPULATION_FORECAST.test(intent.question)) return null;
  const lengthQuestion = /^how long (?:is|was|are|were)\b/u.test(intent.question);
  const figure = lengthQuestion ? 'any' : intent.figure;
  if (!hasFigureOf(figure, line)) return null;
  const measure = figure === 'duration' ? undefined : MEASURES.find(([question]) => question.test(intent.question));
  if (measure && !measure[1].test(line)) return null;
  if (observed) return evidence(observed, 3, 'quantity-field');
  if (measure || figure !== 'any' || QUANTITY_LABEL.test(line)) return evidence(candidate.text, 2, 'quantity-with-cue');
  return evidence(candidate.text, 1, 'number-mention');
}

function reason(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  if (REASON_POINTER.test(line)) return null;
  const marker = REASON_MARKER.exec(line);
  // In a preference construction, «تميل لأن تتشكل» says what tends to happen.
  const purpose = marker && /(?:^|\s)(?:يميل|تميل|تحتاج|تسعي|يسعي|يهدف|تهدف)(?:\s+\p{L}+){0,5}\s*$/u.test(line.slice(0, marker.index)) && /^\s*لان\s/u.test(marker[0]);
  if (marker && !purpose) return evidence(candidate.text, 3, 'causal-connective');
  if (EXPLICIT_REASON.test(line) || NAMING_QUESTION.test(intent.question) && NAMING_REASON.test(line)) return evidence(candidate.text, 3, 'explicit-reason');
  if (CAUSAL_PREDICATE.test(line)) return evidence(candidate.text, 2, 'causal-predicate');
  if (candidate.kind === 'list' || candidate.kind === 'table') {
    const observed = field(candidate, REASON_HEADING);
    if (observed && foldText(observed).trim().split(/\s+/u).length >= 2) return evidence(observed, 2, 'cause-field');
  }
  return null;
}

function method(candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  if (METHOD_MARKER.test(line)) return evidence(candidate.text, 3, 'method-connective');
  if (METHOD_MECHANISM.test(line)) return evidence(candidate.text, 3, 'method-mechanism');
  if (candidate.kind === 'list' || candidate.kind === 'table') {
    const observed = field(candidate, METHOD_HEADING);
    if (observed && foldText(observed).trim().split(/\s+/u).length >= 2) return evidence(observed, 2, 'method-step');
  }
  return null;
}

function definition(intent: QuestionIntent, candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  const explicit = intent.language === 'ar' ? IDENTITY_AR.test(line) : IDENTITY_EN.test(line);
  const observed = field(candidate, /^(?:definition|meaning|description|(?:ال)?(?:معني|تعريف|وصف))$/u);
  if (observed) return evidence(observed, 3, 'definition-field');
  if (explicit) return evidence(candidate.text, candidate.kind === 'lead' ? 3 : 2, 'defining-predicate');
  return null;
}

function comparison(candidate: AnswerTypeCandidate, line: string): AnswerTypeEvidence | null {
  if (COMPARATIVE.test(line) || COMPARATIVE_ORDINAL.test(candidate.text)) return evidence(candidate.text, 3, 'directional-comparison');
  const sides = line.split(/\b(?:whereas|while|in contrast to)\b|(?:^|\s)(?:بينما|في حين ان|في المقابل)(?=\s|$)/u);
  if (sides.length === 2 && sides.every(side => /\d/u.test(side) || /\b(?:has|have|uses?|contains?|is|are|weighs?|measures?|requires?|supports?)\b|(?:^|\s)(?:يبلغ|تبلغ|يحتوي|تحتوي|يستخدم|تستخدم|يتميز|تتميز|يوجد|توجد|هو|هي)(?=\s|$)/u.test(side))) {
    return evidence(candidate.text, 2, 'paired-contrast');
  }
  return null;
}

export function extractAnswerType(intent: QuestionIntent, candidate: AnswerTypeCandidate): AnswerTypeEvidence | null {
  if (!candidate.text.trim() || isMetaLine(candidate.text) || isUiText(candidate.text)) return null;
  const source = candidate.kind === 'table' && candidate.cells?.length ? candidate.cells.join(' ') : candidate.text;
  const line = foldText(source).replace(/\s+/gu, ' ').trim();
  switch (intent.type) {
    case 'person': return person(intent, candidate, line);
    case 'organization': return organization(intent, candidate, line);
    case 'place': return place(intent, candidate, line);
    case 'date': case 'quantity': return figure(intent, candidate, line);
    case 'reason': return reason(intent, candidate, line);
    case 'method': return method(candidate, line);
    case 'definition': return definition(intent, candidate, line);
    case 'comparison': return comparison(candidate, line);
    case 'unknown': return null;
  }
}
