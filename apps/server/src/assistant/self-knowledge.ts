import { evaluateLocalConversation } from './local-conversation.js';
import { fixedReply, type LocalReply } from './mind/limits.js';
import { normalizeRequest, stripCourtesyTail } from './mind/normalize.js';

/**
 * Questions about Mohassan itself, answered without a model: step 2 of the task cycle («فهم الطلب وتجميع السياق»).
 * Who made it, which model it runs on, what it can do, whether it can do one named thing, how it compares with another
 * assistant, and what would improve it. Every answer is built from the host's facts for this conversation (what is
 * configured and reachable for this account) and the application's fixed texts; nothing is looked up on the web.
 *
 * Measured on the frozen set of 107 real requests (artifacts/plan-2026-11-22/real-questions-v1.jsonl, run 14:11 UTC on
 * 2026-11-22): «ما هي قدراتك» was answered with a book title from a web page, and the other questions about the
 * assistant ended in «لم أنفّذ هذا الطلب» or «لم يتحقق مسار البحث». The patterns below are written as general forms;
 * the unit tests use their own wording, not the set's.
 *
 * Only a whole message that is one such question is taken. A message that also carries a link, a number, or a task
 * with its own object («can you build a website for my bakery», «what can you tell me about Paris») goes on to the
 * other routes, so a capability the host has is still used as a task and never answered with «yes, I can».
 */

export interface SelfFacts {
  /** A chat-generation model is configured for this conversation. */
  chatModel: boolean;
  /** Public web search and reading pages over HTTP. */
  web: boolean;
  /** Opening a site, searching inside it and reading its pages. */
  browser: boolean;
  computation: boolean;
  memory: boolean;
  /** The owner's local documents. */
  knowledge: boolean;
  /** Creating and editing PDF files. */
  documents: boolean;
  sites: boolean;
  skills: boolean;
  /** Google Ads campaigns, for an account that may reach them. */
  ads: boolean;
  imageReading: boolean;
  /** Computer control, for an account that may reach it. */
  pc: boolean;
  planner: boolean;
  letters: boolean;
}

export type SelfTopic = 'creator' | 'model' | 'compare' | 'improve' | 'capabilities' | 'can_do';
export type SelfAbility = 'image_generation' | 'media_generation' | 'free_writing' | 'translation' | 'website' | 'pdf' | 'image_reading' | 'web' | 'ads';
/** `brief`: the answer was asked for in one or two sentences («اذكر في جملتين …», «tell me briefly …»). */
export interface SelfQuestion { topic: SelfTopic; lang: 'ar' | 'en'; ability?: SelfAbility; asked?: 'ai' | 'human' | 'product' | 'which'; brief?: 1 | 2 }

const MAX_REQUEST = 600;
const MAX_WORDS = 40;

/** Assistant products and providers, as people type them (lower case; Arabic folded by matchText). */
const PRODUCT = '(?:chat ?gpt|gpt(?: ?-? ?\\d+(?:\\.\\d+)?[a-z]*)?|open ?ai|groq|grok|gemini|bard|claude|anthropic|llama|meta ai|qwen|deep ?seek|mistral|copilot|perplexity|siri|alexa|تشات ?جي ?بي ?تي|شات ?جي ?بي ?تي|جي ?بي ?تي|اوبن ?اي ?اي|جروك|غروك|جيميني|جيمناي|بارد|كلود|لاما|كوين|ديب ?سيك|ميسترال|كوبايلوت|سيري|اليكسا)';
const B = '(?:^| )';
const E = '(?= |$)';
const YOU = '(?:you|u|mohassan)';

const COMPARATIVE_EN = '(?:smarter|better|stronger|faster|cleverer|more (?:intelligent|capable|accurate|powerful|useful|advanced|clever)|smartest|best)';
const COMPARATIVE_AR = '(?:اذكي|افضل|اقوي|اسرع|ادق|احسن|اشطر)';
const COMPARE: RegExp[] = [
  new RegExp(`\\b(?:are|r) (?:you|u) ${COMPARATIVE_EN} than\\b`, 'u'),
  new RegExp(`\\b(?:who|whos|which(?: one)?|what)(?: is)? ${COMPARATIVE_EN}\\b.*\\b${YOU}\\b`, 'u'),
  new RegExp(`\\b(?:is|are) ${PRODUCT} ${COMPARATIVE_EN} than ${YOU}\\b`, 'u'),
  new RegExp(`\\b${YOU} (?:vs|versus) ${PRODUCT}\\b|\\b${PRODUCT} (?:vs|versus) ${YOU}\\b`, 'u'),
  new RegExp(`\\bcompare (?:yourself|you) (?:to|with) `, 'u'),
  new RegExp(`${B}(?:هل )?(?:انت|انتا|انتي) ${COMPARATIVE_AR} (?:من|ولا|او|ام)${E}`, 'u'),
  new RegExp(`${B}(?:مين|من|منو|ايهما|ايكما|اي واحد)(?: هو| اللي)? ${COMPARATIVE_AR}${E}.*${B}(?:انت|انتا|انتي|منك|موحسن)${E}`, 'u'),
  new RegExp(`${B}${COMPARATIVE_AR} (?:منك|من موحسن)${E}`, 'u'),
  new RegExp(`${B}قارن (?:نفسك|بينك وبين)${E}`, 'u'),
];

const MODEL_WORDS_EN = '(?:ai|an ai|a ?i|artificial intelligence|(?:a )?bot|(?:a )?chat ?bot|(?:a )?robot|(?:a )?human|(?:a )?real person|(?:a )?person|(?:a )?(?:large )?language model|(?:an? )?llm|(?:an? )?(?:ai )?model)';
// «نموذج», «النموذج اللغوي», «نموذج الذكاء الاصطناعي»: the noun with the qualifier people add to it. Without the qualifier
// «على أي نموذج لغوي تعمل؟» was not recognised and an instruction skill about machine learning answered it (2026-11-22).
const MODEL_NOUN_AR = '(?:ال)?(?:نموذج|موديل)(?: (?:ال)?لغوي(?: (?:ال)?كبير)?| (?:ال)?لغه| (?:ال)?ذكاء (?:ال)?(?:اصطناعي|صناعي))?';
/** Which model the assistant runs on: answered directly, with no «نعم» or «لا» in front. */
const MODEL_WHICH: RegExp[] = [
  /\b(?:what|which) (?:ai|model|llm|language model|engine|brain|ai model)(?: are you| do you use| do you run on| are you using| are you based on| are you built on| powers you| runs you| is behind you)\b/u,
  new RegExp(`${B}(?:اي|ايش|شو|ما|ما هو|ماهو|وش) ${MODEL_NOUN_AR}(?: الذي| اللي)? (?:تستخدمه|تستخدم|تعمل عليه|تعمل به|تشتغل عليه|تشتغل به|يشغلك|وراك|خلفك|انت)${E}`, 'u'),
  new RegExp(`${B}(?:على|علي|ب) ?(?:اي|ايش|شو|وش) ${MODEL_NOUN_AR} (?:تعمل|تشتغل|مبني|انت)${E}`, 'u'),
];
const MODEL: RegExp[] = [
  new RegExp(`\\b(?:are|r) (?:you|u) (?:an? |the |actually |really )?(?:${PRODUCT}|${MODEL_WORDS_EN})\\b`, 'u'),
  ...MODEL_WHICH,
  new RegExp(`\\bdo (?:you|u) (?:use|run on|work with) ${PRODUCT}\\b`, 'u'),
  new RegExp(`\\b(?:are|r) (?:you|u) (?:based|built|running|made|powered|trained) (?:on|by|with) ${PRODUCT}\\b`, 'u'),
  new RegExp(`\\bis this ${PRODUCT}\\b`, 'u'),
  new RegExp(`${B}(?:هل )?(?:انت|انتا|انتي) (?:${PRODUCT}|ذكاء (?:اصطناعي|صناعي)|بوت|روبوت|انسان|بشر|شخص حقيقي|نموذج لغوي|نموذج)${E}`, 'u'),
  new RegExp(`${B}هل (?:تستخدم|تعمل (?:على|علي|ب)|مبني (?:على|علي)) ${PRODUCT}${E}`, 'u'),
];

const MADE_EN = '(?:made|make|makes|created|create|creates|built|build|builds|developed|develop|develops|designed|design|trained|train|programmed|program|coded|code|owns|own|invented|invent)';
const MADE_AR = '(?:صنعك|انشاك|طورك|برمجك|صممك|بناك|دربك|اخترعك|ابتكرك|يملكك|سواك|عملك|كتبك|وراك|خلفك|صاحبك|مالكك|صانعك|مطورك|مبرمجك|مصممك|منشئك)';
const MADE_BY_ME_AR = '(?:صنعتك|صنعناك|انشاتك|انشاناك|طورتك|طورناك|برمجتك|برمجناك|صممتك|صممناك|بنيتك|بنيناك|سويتك|سويناك|عملتك|عملناك|دربتك|دربناك)';
const CREATOR: RegExp[] = [
  new RegExp(`\\b(?:who|whos)(?: is| has| had| did)? ${MADE_EN} ${YOU}\\b`, 'u'),
  /\bwho(?: is|s)? (?:your|ur) (?:creators?|makers?|developers?|owners?|author|father|dad|boss|inventor|programmers?)\b/u,
  new RegExp(`\\bwho(?: is|s)? behind ${YOU}\\b`, 'u'),
  // «but I created you»: a correction names the maker. «How could we make you better» is a question about improving it.
  /\b(?:i|we) (?:made|created|create|built|build|developed|develop|programmed|program|coded|code|trained|train|designed|design|invented|invent) (?:you|u)\b(?! (?:better|smarter|stronger|faster|more|less))/u,
  /\b(?:were|are|was) (?:you|u) (?:made|created|built|developed|trained|designed|programmed) by\b/u,
  new RegExp(`${B}(?:من|مين|منو|من الذي|من اللي|مين اللي)(?: هو)? ${MADE_AR}${E}`, 'u'),
  new RegExp(`${B}(?:انا|احنا|نحن)(?: اللي| الذي| من)? ${MADE_BY_ME_AR}${E}`, 'u'),
];

const IMPROVE: RegExp[] = [
  new RegExp(`\\b(?:if|when) (?:we|i|you|someone) (?:want(?:ed)?|wish(?:ed)?|were|was|could|had|decided?|plan(?:ned)?|need(?:ed)?) (?:to )?(?:upgrade|improve|develop|enhance|train|update|better) (?:you|u|yourself|mohassan)\\b`, 'u'),
  /\bhow (?:can|could|should|do|would) (?:we|i|one|someone) (?:upgrade|improve|enhance|develop|train|better|make) (?:you|u|mohassan)\b/u,
  /\bwhat (?:would|could|should|will) (?:make (?:you|u) (?:better|smarter|stronger|more useful)|you (?:improve|change|upgrade|add) (?:in|about|to) yourself)\b/u,
  /\bwhat (?:do (?:you|u) (?:lack|miss|need to improve)|are (?:you|u) missing|is missing (?:in|from) (?:you|u))\b/u,
  /\b(?:your|ur) (?:weaknesses|weak points|weak spots|shortcomings)\b/u,
  /\b(?:upgrade|improve|enhance) (?:yourself|mohassan)\b/u,
  new RegExp(`${B}(?:لو|اذا|ان|لما) (?:اردنا|اردت|بدنا|بدي|ودنا|ودي|نبي|ابي|نبغي|ابغي|حبينا|حبيت|كان بامكاننا|كان بامكاني|كان بامكانك|كان باستطاعتك|كان باستطاعتنا|استطعت|قدرت|قدرنا)(?: ان)? (?:نطورك|اطورك|نحسنك|احسنك|نرقيك|ارقيك|نحدثك|احدثك|تطور نفسك|تحسن نفسك|تطوير نفسك)${E}`, 'u'),
  // «لو كان بإمكانك تطوير شيء واحد في نموذج الذكاء الاصطناعي الذي تبنيه»: the change is about the assistant being built.
  new RegExp(`${B}(?:لو|اذا) كان (?:بامكانك|باستطاعتك|بمقدورك) (?:ان )?(?:تطور|تطوير|تحسن|تحسين|تغير|تغيير)${E}.*${B}(?:نفسك|فيك|قدراتك|نموذجك|موحسن|(?:نموذج|الذكاء الاصطناعي|النظام|المساعد)(?: \\S+){0,3} (?:الذي|اللي) (?:تبنيه|تبنونه|نبنيه|ابنيه|يبنيه|تطوره|نطوره|نبنيه))${E}`, 'u'),
  new RegExp(`${B}كيف (?:نطورك|اطورك|نحسنك|احسنك|نرقيك|ارقيك|تتطور|تتحسن|اخليك افضل|نخليك افضل)${E}`, 'u'),
  new RegExp(`${B}(?:ما|ماذا|ايش|شو|وش)(?: الذي| اللي)? (?:ينقصك|تحتاجه لتتحسن|تحتاج لتتطور|تحتاج لتتحسن|يحسنك|يطورك)${E}`, 'u'),
  new RegExp(`${B}(?:ما|ماذا|ايش|شو|وش)(?: هي)? (?:نقاط ضعفك|عيوبك|نواقصك)${E}`, 'u'),
  new RegExp(`${B}(?:ماذا|ما|ايش|شو) (?:تقترح|تنصح)(?: علينا| علي)? (?:لتطويرك|لتحسينك|لترقيتك|لتطوير نفسك)${E}`, 'u'),
];

const CAPABILITIES: RegExp[] = [
  /^(?:(?:so|and|ok|okay|well|hey|hi|hello) )?(?:what (?:can|could) (?:you|u) (?:do|offer)(?: for me| to help| exactly| now)?|what do (?:you|u) do|what are (?:you|u) (?:capable of|able to do|good at|for)|what (?:are|r|is) (?:your|ur) (?:capabilities|abilities|features|skills|functions|powers|limits|limitations|capability|ability|purpose|job)|(?:show me |list )?(?:your|ur) (?:capabilities|abilities|features|skills)|what you can do|how (?:can|could|do|will) (?:you|u) help(?: me| us)?|what (?:kind of |sort of )?(?:things|tasks|stuff|jobs) (?:can|do|could) (?:you|u) (?:do|handle|help with|help me with))$/u,
  /^(?:(?:طيب|اوك|يعني|سؤال) )?(?:(?:ما|ماهي|ما هي|وش|ايش|شو)(?: هي)? (?:قدراتك|مميزاتك|امكانياتك|امكاناتك|مهاراتك|وظائفك|مهامك|خدماتك|حدودك|ميزاتك|وظيفتك|مهمتك)(?: الحاليه| حاليا| الان)?|(?:ماذا|ما الذي|ما اللي|شو|ايش|وش|ويش|ما) (?:تستطيع|تقدر|يمكنك|بتقدر|بامكانك|تعرف|بتعرف|تقدري|تقدرين)(?: ان)?(?: (?:تفعل|تعمل|تسوي|تساعد|تقدم|تفعله|تعمله|تسويه|تقدمه|تساعدني فيه|تساعدني به|تفيدني به|تفعل لي|تعمل لي|تسوي لي))?(?: لي| من اجلي)?|(?:كيف|بماذا|بشو|بايش|في ماذا|في شو|فيم) (?:تستطيع|يمكنك|بتقدر|تقدر|ممكن)(?: ان)? (?:تساعدني|تفيدني|تخدمني|تساعدنا)|(?:عرفني|اخبرني|قل لي|قلي|احكي لي) (?:ب|عن) ?(?:قدراتك|امكانياتك|مميزاتك|مهاراتك)|ماذا تفعل|شو بتعمل|ايش تسوي|وش تسوي|ما عملك)$/u,
];

/**
 * «ما الأدوات التي تستطيع استخدامها الآن؟», "what tools can you use?": a question about the tools of this assistant. It
 * must name the assistant (your tools, tools you can use, tools available to you), and nothing may follow but «now» and
 * the like: «ما الأدوات التي أحتاجها لتركيب رف» or "what tools can you use to edit video" are other requests.
 */
const NOW_AR = '(?: (?:الان|حاليا|فعليا|فعلا|بالفعل|في هذه المحادثه|هنا))*';
const NOW_EN = '(?: (?:now|right now|currently|today|actually|really|in this conversation|here))*';
const TOOLS: RegExp[] = [
  new RegExp(`^(?:(?:ما|ماهي|ما هي|وش|ايش|شو|ماذا)(?: هي)? )?(?:ادواتك(?: (?:الحاليه|المتاحه))?|(?:ال)?ادوات (?:(?:التي|اللي|الذي) )?(?:(?:تستطيع|تقدر|يمكنك|بامكانك|بتقدر)(?: ان)? (?:استخدامها|استعمالها|تستخدمها|تستعملها)|(?:المتاحه|المتوفره) لك|لديك|عندك))${NOW_AR}$`, 'u'),
  new RegExp(`^(?:(?:what|which) |the )?tools? (?:(?:can|could|do) (?:you|u)(?: actually| really| currently)? (?:use|access|have(?: access to)?)|(?:are|r) available to (?:you|u)|(?:that )?(?:you|u) (?:can|could) (?:actually |really )?(?:use|access))${NOW_EN}$`, 'u'),
  new RegExp(`^(?:what (?:are|r) )?(?:your|ur) (?:available )?tools${NOW_EN}$`, 'u'),
];

/**
 * «اذكر …», «قل لي باختصار …», "tell me in two sentences …": a lead that asks for the answer and, at most, how short it
 * should be. It comes off before the forms above are matched; the length it names shapes the answer (real request rq039,
 * 2026-11-22: «… ثم اذكر في جملتين ما الأدوات التي تستطيع استخدامها الآن فعلياً»).
 */
const LENGTH_AR = '(?:باختصار|بايجاز|(?:في|ب) (?:جمله(?: واحده)?|جملتين|سطر(?: واحد)?|سطرين|كلمات قليله))';
const LENGTH_EN = '(?:briefly|in short|in (?:one|a single|two|a couple of|a few) (?:sentences?|lines?))';
const ANSWER_LEAD = new RegExp(`^(?:(?:اذكر|عدد|قل|قول|اخبرني|خبرني|وضح|بين)(?: لي| لنا)?|tell (?:me|us)|list|name)(?: ${LENGTH_AR}| ${LENGTH_EN})? `, 'u');
const LENGTH_TAIL = new RegExp(` (?:${LENGTH_AR}|${LENGTH_EN})(?: فقط| only)?$`, 'u');
function lengthAsked(words: string): 1 | 2 | undefined {
  if (/(?:جمله|سطر)(?: واحده| واحد)?(?= |$)|\b(?:one|a single) (?:sentence|line)\b/u.test(words)) return 1;
  if (/جملتين|سطرين|باختصار|بايجاز|كلمات قليله|\b(?:two|a couple of|a few) (?:sentences|lines)\b|\b(?:briefly|in short)\b/u.test(words)) return 2;
  return undefined;
}

/** «Can you …» and «هل تستطيع …»: what follows must name one ability and nothing more. */
const CAN_PREFIX: RegExp[] = [
  /^(?:(?:so|and|ok|okay|hey) )?(?:can|could|will|would) (?:you|u)(?: also| even| actually| really| please)? /u,
  /^(?:are|r) (?:you|u) (?:able|capable) (?:to|of) /u,
  /^do (?:you|u) (?:know how to|support|offer|provide|do) /u,
  /^is it possible (?:for (?:you|u) )?to /u,
  /^(?:هل )?(?:انت |انتا )?(?:تستطيع|تقدر|يمكنك|بامكانك|باستطاعتك|بتقدر|تعرف|بتعرف|تقدري|ممكن|يمكن)(?: ان)? /u,
  /^(?:هل )?(?:لديك|عندك) (?:القدره|امكانيه) (?:على|علي) /u,
];
/** Words that leave a capability question a question: «a full project», «لي», «احترافي». */
const GENERIC = '(?:a|an|the|some|any|full|complete|whole|entire|simple|professional|new|my|me|for me|for us|great|good|nice|real|also|too|from scratch|project|projects|لي|لنا|كامل|كامله|متكامل|متكامله|احترافي|احترافيه|جديد|جديده|بسيط|بسيطه|اي|بعض|مشروع|مشاريع|ايضا|كمان|من الصفر)';
const G = `(?:${GENERIC} )*`;
const ABILITY_FORMS: Record<SelfAbility, string[]> = {
  image_generation: [
    `(?:create|make|generate|draw|design|produce|paint|do) ${G}(?:images?|pictures?|photos?|drawings?|art|artwork|logos?|illustrations?|icons?)`,
    '(?:image|picture|photo|art) (?:generation|creation)',
    `(?:ال)?(?:انشاء|انشئ|تنشئ|صنع|تصنع|توليد|تولد|رسم|ترسم|تصميم|تصمم|عمل|تعمل|تسوي|سوي|انتاج|تنتج) ${G}(?:ال)?(?:صور|صوره|رسومات|رسوم|رسمه|لوحات|لوحه|شعارات|شعار|لوجو|ايقونات)`,
    '(?:توليد|انشاء) (?:ال)?صور',
  ],
  media_generation: [
    `(?:create|make|generate|produce|edit|compose) ${G}(?:videos?|songs?|music|audio|voices?|voiceovers?|podcasts?|animations?|movies?|films?)`,
    `(?:ال)?(?:انشاء|صنع|توليد|عمل|تعمل|تسوي|تصنع|تنشئ|مونتاج|تعديل|تعدل|انتاج|تنتج|تاليف|تؤلف) ${G}(?:ال)?(?:فيديو|فيديوهات|مقاطع|مقطع|اغاني|اغنيه|موسيقي|صوت|اصوات|بودكاست|افلام|فيلم)`,
  ],
  free_writing: [
    `(?:write|compose|create|generate) ${G}(?:stor(?:y|ies)|essays?|articles?|poems?|poetry|novels?|blog(?: posts?)?|posts?|lyrics|scripts?|books?|captions?|content)`,
    `(?:ال)?(?:كتابه|تكتب|اكتب|تاليف|تالف|تؤلف|انشاء|تنشئ) ${G}(?:ال)?(?:قصص|قصه|مقال|مقالات|شعر|قصيده|قصائد|روايه|روايات|منشور|منشورات|كتاب|كتب|سيناريو|محتوي)`,
  ],
  translation: [
    `translat(?:e|ion)(?: ${G}(?:texts?|documents?|languages?|between languages))?`,
    `(?:(?:ال)?ترجمه|تترجم|ترجم)(?: ${G}(?:ال)?(?:نصوص|نص|مستندات|لغات))?`,
  ],
  website: [
    `(?:build|create|make|design|develop|code) ${G}(?:websites?|web ?sites?|web ?pages?|landing pages?|sites?|online stores?)`,
    `(?:ال)?(?:انشاء|بناء|عمل|تصميم|صنع|برمجه|تبني|تنشئ|تعمل|تسوي|تصمم|تصنع|سوي) ${G}(?:ال)?(?:مواقع|موقع|صفحات|صفحه هبوط|متجر)(?: (?:الكتروني|الكترونيه|ويب|انترنت))?`,
  ],
  pdf: [
    `(?:create|make|edit|generate|design) ${G}(?:pdfs?|pdf (?:files?|documents?))`,
    `(?:ال)?(?:انشاء|عمل|تعديل|تنشئ|تعدل|تسوي|تصميم|تصمم) ${G}(?:(?:ال)?(?:ملفات|ملف|مستندات|مستند) )?pdf`,
  ],
  image_reading: [
    `(?:read|extract|recogni[sz]e) ${G}(?:text (?:from|in|on) )?${G}(?:images?|pictures?|photos?|screenshots?|scans?)`,
    'ocr',
    `(?:ال)?(?:قراءه|تقرا|استخراج|تستخرج) ${G}(?:(?:ال)?(?:نص|نصوص|كلام) )?(?:(?:من|في) )?(?:ال)?(?:صور|صوره|لقطات الشاشه|لقطه شاشه)`,
  ],
  web: [
    '(?:search|browse|surf) (?:on )?(?:the )?(?:web|internet|net|online)',
    '(?:access|use|go on|get on) (?:the )?(?:internet|web)',
    `(?:read|open|visit) ${G}(?:websites?|web ?pages?|links?|urls?)`,
    '(?:البحث|تبحث|بحث|ابحث|تصفح|تتصفح|الوصول|تدخل|الدخول) (?:(?:في|على|علي|الي|عن) )?(?:ال)?(?:انترنت|نت|ويب)',
    `(?:فتح|تفتح|قراءه|تقرا|زياره|تزور) ${G}(?:ال)?(?:مواقع|روابط|صفحات)`,
  ],
  ads: [
    `(?:create|make|run|set ?up|manage|build|prepare) ${G}(?:google )?(?:ads? )?(?:campaigns?|ads?|adverts?|advertisements?)`,
    `(?:ال)?(?:انشاء|عمل|اداره|تدير|تعمل|تسوي|تنشئ|تجهيز|تجهز) ${G}(?:ال)?(?:حملات|حمله|اعلانات|اعلان)(?: (?:اعلانيه|جوجل|google|google ads))*`,
  ],
};
const ABILITIES = Object.entries(ABILITY_FORMS).map(([ability, forms]) =>
  [ability as SelfAbility, new RegExp(`^${G}(?:${forms.join('|')})(?: ${GENERIC})*$`, 'u')] as const);

/** The folded message, or null when it carries what a question about the assistant never does. */
function folded(request: string): string | null {
  if (typeof request !== 'string' || !request.trim() || request.length > MAX_REQUEST || /\n\s*\S[\s\S]*\n/u.test(request.trim())) return null;
  if (/https?:\/\/|\bwww\./iu.test(request)) return null;
  const { match } = normalizeRequest(request);
  let text = stripCourtesyTail(match)
    .replace(/['’‘`]/gu, '')
    .replace(/[؟?!.,،؛;:«»"“”()[\]{}…*_~|\\/<>]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  // A name or a filler at either end addresses the assistant and asks nothing.
  text = text.replace(/^(?:(?:يا )?(?:موحسن|محسن)|(?:hey |hi |dear )?mohassan|but|so|and|well|ok|okay|hey|hi|hello|طيب|اوك|بس|لكن|مرحبا|اهلا) /u, '')
    .replace(/ (?:يا )?(?:موحسن|محسن|mohassan)$/u, '').trim();
  if (!text || text.split(' ').length > MAX_WORDS) return null;
  if (/\b[a-z0-9-]+\.(?:com|net|org|co|uk|io|ai|app|dev|sa|ae|eg|info|biz|me)\b/u.test(text)) return null;
  // Figures belong to calculations and tasks; a model's own number («gpt-4») is the only one kept.
  if (/\d/u.test(text.replace(new RegExp(PRODUCT, 'gu'), ' '))) return null;
  return text;
}

export function recognizeSelfQuestion(request: string): SelfQuestion | null {
  let text = folded(request);
  if (!text) return null;
  const lang: 'ar' | 'en' = /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
  let brief: 1 | 2 | undefined;
  const lead = ANSWER_LEAD.exec(text);
  if (lead) { brief = lengthAsked(lead[0]); text = text.slice(lead[0].length); }
  const length = LENGTH_TAIL.exec(text);
  if (length) { brief ??= lengthAsked(length[0]); text = text.slice(0, length.index); }
  if (!text) return null;
  const question = (topic: SelfTopic, extra: Partial<SelfQuestion> = {}): SelfQuestion => Object.freeze({ topic, lang, ...(brief ? { brief } : {}), ...extra });
  if (COMPARE.some(pattern => pattern.test(text))) return question('compare');
  if (CREATOR.some(pattern => pattern.test(text))) return question('creator');
  if (MODEL.some(pattern => pattern.test(text))) {
    const asked = new RegExp(PRODUCT, 'u').test(text) ? 'product'
      : /\b(?:human|person)\b|(?:^| )(?:انسان|بشر|شخص حقيقي)(?= |$)/u.test(text) ? 'human'
        : MODEL_WHICH.some(pattern => pattern.test(text)) ? 'which' : 'ai';
    return question('model', { asked });
  }
  if (IMPROVE.some(pattern => pattern.test(text))) return question('improve');
  if (CAPABILITIES.some(pattern => pattern.test(text)) || TOOLS.some(pattern => pattern.test(text))) return question('capabilities');
  for (const prefix of CAN_PREFIX) {
    const found = prefix.exec(text);
    if (!found) continue;
    const rest = text.slice(found[0].length).trim();
    for (const [ability, pattern] of ABILITIES) if (pattern.test(rest)) return question('can_do', { ability });
    return null;
  }
  return null;
}

type Lang = 'ar' | 'en';
type Configurable = 'memory' | 'knowledge' | 'documents' | 'sites' | 'skills' | 'ads' | 'imageReading' | 'pc';
const ABLE: Record<Lang, Record<Exclude<keyof SelfFacts, 'chatModel'>, string>> = {
  ar: {
    web: 'أجيب عن الأسئلة العامة من صفحات أقرؤها على الويب، وأذكر المصدر.',
    browser: 'أفتح المواقع وأبحث داخلها وأقرأ صفحاتها.',
    computation: 'أحسب العمليات والنسب، وأحوّل الوحدات والتواريخ.',
    memory: 'أحفظ ملاحظاتك وأسترجعها من ذاكرتك.',
    knowledge: 'أبحث في مستنداتك المحلية.',
    documents: 'أنشئ ملفات PDF وأعدّلها.',
    sites: 'أبني موقعًا إلكترونيًا من كلماتك.',
    planner: 'أرتّب خطة أسبوعك من مهامك ومواعيدك.',
    letters: 'أرتّب رسالة أو بريدًا رسميًا من قالب بكلماتك.',
    skills: 'أعرض أدلة عمل من مكتبة المهارات: الخطوات وشكل الجواب.',
    ads: 'أجهّز حملات Google Ads.',
    imageReading: 'أقرأ النص من الصور التي ترفقها.',
    pc: 'أنفّذ أوامر محددة على حاسوبك عند طلبك.',
  },
  en: {
    web: 'Answer general questions from pages I read on the web, naming the source.',
    browser: 'Open websites, search inside them and read their pages.',
    computation: 'Calculate arithmetic and percentages, and convert units and dates.',
    memory: 'Save your notes and recall them from your memory.',
    knowledge: 'Search your local documents.',
    documents: 'Create and edit PDF files.',
    sites: 'Build a website from your own words.',
    planner: 'Lay out your week from your tasks and appointments.',
    letters: 'Arrange a formal letter or email from a template in your words.',
    skills: 'Show how-to guides from the skills library: the steps and the answer shape.',
    ads: 'Prepare Google Ads campaigns.',
    imageReading: 'Read the text in images you attach.',
    pc: 'Carry out specific commands on your computer when you ask.',
  },
};
const UNCONFIGURED: Record<Lang, Record<Configurable, string>> = {
  ar: { memory: 'الذاكرة', knowledge: 'البحث في المستندات المحلية', documents: 'ملفات PDF', sites: 'بناء المواقع', skills: 'مكتبة المهارات',
    ads: 'حملات Google Ads', imageReading: 'قراءة النص من الصور', pc: 'التحكم بالحاسوب' },
  en: { memory: 'memory', knowledge: 'local document search', documents: 'PDF files', sites: 'website building', skills: 'the skills library',
    ads: 'Google Ads campaigns', imageReading: 'reading text from images', pc: 'computer control' },
};
/** The same abilities as short names, for an answer asked in one or two sentences. */
const ABLE_SHORT: Record<Lang, Record<Exclude<keyof SelfFacts, 'chatModel'>, string>> = {
  ar: {
    web: 'البحث في الويب وقراءة الصفحات مع ذكر المصدر', browser: 'فتح المواقع والبحث داخلها', computation: 'الحساب وتحويل الوحدات والتواريخ',
    memory: 'الحفظ في ذاكرتك والاسترجاع منها', knowledge: 'البحث في مستنداتك المحلية', documents: 'إنشاء ملفات PDF وتعديلها', sites: 'بناء المواقع',
    planner: 'ترتيب خطة الأسبوع', letters: 'ترتيب الرسائل الرسمية من قوالب', skills: 'أدلة العمل من مكتبة المهارات', ads: 'تجهيز حملات Google Ads',
    imageReading: 'قراءة النص من الصور', pc: 'تنفيذ أوامر محددة على حاسوبك',
  },
  en: {
    web: 'web search and page reading with sources', browser: 'opening websites and searching inside them', computation: 'calculations and unit and date conversions',
    memory: 'saving to and recalling from your memory', knowledge: 'searching your local documents', documents: 'creating and editing PDF files', sites: 'building websites',
    planner: 'week plans', letters: 'formal letters from templates', skills: 'how-to guides from the skills library', ads: 'preparing Google Ads campaigns',
    imageReading: 'reading text from images', pc: 'specific commands on your computer',
  },
};
const ORDER: (Exclude<keyof SelfFacts, 'chatModel'>)[] = ['web', 'browser', 'computation', 'memory', 'knowledge', 'documents', 'sites', 'planner', 'letters', 'skills', 'ads', 'imageReading', 'pc'];
const CONFIGURABLE: Configurable[] = ['memory', 'knowledge', 'documents', 'sites', 'skills', 'ads', 'imageReading', 'pc'];

const NO_MODEL = {
  ar: 'لا يوجد نموذج توليد محادثة مهيأ في هذه النسخة، فلا أكتب نصًا حرًا ولا أشرح بأسلوبي.',
  en: 'No chat-generation model is configured in this build, so I do not write free text or explain in my own words.',
};
const WITH_MODEL = {
  ar: 'في هذه النسخة نموذج توليد محادثة مهيأ من المضيف، ولا أسمّي نموذجًا نشطًا دون فحص من المضيف.',
  en: 'A chat-generation model is configured by the host in this build; I do not name an active model without a host check.',
};

function creatorLine(lang: Lang): string {
  return evaluateLocalConversation(lang === 'ar' ? 'من صنعك؟' : 'Who created you?')?.text
    ?? (lang === 'ar' ? 'أنا موحسن.' : 'I’m Mohassan.');
}

function missingLines(facts: SelfFacts, lang: Lang): string[] {
  const lines: string[] = [];
  if (!facts.chatModel) lines.push(lang === 'ar'
    ? 'نموذج لغوي يفهم الطلبات الحرة ويخطط لها ويكتب: غير مهيأ الآن، فأفهم الصيغ التي تعرفها قواعدي فقط، ولا أكتب قصصًا أو مقالات ولا أترجم.'
    : 'A language model that understands free requests, plans them and writes: not configured now, so I understand only the forms my rules know, and I do not write stories or articles or translate.');
  lines.push(lang === 'ar' ? 'إنشاء الصور والفيديو والصوت: غير متاح.' : 'Creating images, video or audio: not available.');
  const off = CONFIGURABLE.filter(key => !facts[key]).map(key => UNCONFIGURED[lang][key]);
  if (off.length) lines.push(lang === 'ar' ? `غير مهيأ في هذه المحادثة: ${off.join('، ')}.` : `Not configured in this conversation: ${off.join(', ')}.`);
  return lines;
}

const listed = (items: readonly string[], lang: Lang): string => lang === 'ar' ? items.join('، و')
  : items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;

/** What can be used and what cannot, in the one or two sentences the question allowed. The same host facts as the full answer. */
function briefCapabilities(facts: SelfFacts, lang: Lang, sentences: 1 | 2): string {
  const ar = lang === 'ar';
  const able = ORDER.filter(key => facts[key]).map(key => ABLE_SHORT[lang][key]);
  const missing = [
    ...(facts.chatModel ? [] : [ar ? 'نموذج لغوي يفهم الطلبات الحرة ويكتب' : 'a language model that understands free requests and writes']),
    ar ? 'إنشاء الصور والفيديو والصوت' : 'media generation (images, video and audio)',
    ...CONFIGURABLE.filter(key => !facts[key]).map(key => UNCONFIGURED[lang][key]),
  ];
  const can = ar ? `الأدوات التي أستطيع استخدامها الآن في هذه المحادثة: ${listed(able, lang)}` : `The tools I can use now in this conversation: ${listed(able, lang)}`;
  const cannot = ar ? `ولا يتوفر لي الآن: ${listed(missing, lang)}` : `not available to me now: ${listed(missing, lang)}`;
  if (sentences === 1) return `${can}${ar ? '؛ ' : '; '}${cannot}.`;
  return `${can}. ${ar ? cannot : cannot.charAt(0).toUpperCase() + cannot.slice(1)}.`;
}

function canDo(ability: SelfAbility, facts: SelfFacts, lang: Lang): string | null {
  const ar = lang === 'ar';
  switch (ability) {
    case 'image_generation':
      return ar ? `لا. إنشاء الصور غير متاح عندي الآن: لا يوجد نموذج لتوليد الصور.${facts.imageReading ? ' ما أستطيعه مع الصور: قراءة النص منها إذا أرفقتها.' : ''}`
        : `No. I cannot create images now: there is no image-generation model.${facts.imageReading ? ' What I can do with images: read the text in them when you attach them.' : ''}`;
    case 'media_generation':
      return ar ? 'لا. إنشاء الفيديو والصوت والموسيقى غير متاح عندي الآن.' : 'No. Creating video, audio or music is not available to me now.';
    case 'free_writing': {
      if (facts.chatModel) return null;
      const alternatives = [facts.letters ? (ar ? 'ترتيب رسالة أو بريد رسمي من قالب بكلماتك' : 'arrange a formal letter or email from a template in your words') : null,
        facts.skills ? (ar ? 'عرض خطوات الكتابة وشكلها من مكتبة المهارات' : 'show the steps and shape of a piece of writing from the skills library') : null].filter(Boolean);
      return ar ? `لا أستطيع الآن كتابة قصص أو مقالات أو شعر بأسلوبي: لا يوجد نموذج كتابة مهيأ.${alternatives.length ? ` ما أستطيعه: ${alternatives.join('، و')}.` : ''}`
        : `I cannot write stories, articles or poems in my own words now: no writing model is configured.${alternatives.length ? ` What I can do: ${alternatives.join(', and ')}.` : ''}`;
    }
    case 'translation':
      if (facts.chatModel) return null;
      return ar ? 'لا. الترجمة غير متاحة الآن: تحتاج نموذج كتابة غير مهيأ في هذه النسخة.' : 'No. Translation is not available now: it needs a writing model, which is not configured in this build.';
    case 'website':
      return facts.sites
        ? ar ? 'نعم. أبني موقعًا إلكترونيًا من كلماتك: قل مثلًا «اصنع لي موقعًا لمطعمي»، وأسألك عما يحتاجه الموقع ثم أبنيه.'
          : 'Yes. I build a website from your own words: say, for example, “build me a website for my bakery”, and I will ask what the site needs, then build it.'
        : ar ? 'بناء المواقع غير مهيأ في هذه المحادثة الآن.' : 'Website building is not configured in this conversation now.';
    case 'pdf':
      return facts.documents
        ? ar ? 'نعم. أنشئ ملفات PDF وأعدّلها: قل مثلًا «أنشئ ملف PDF بعنوان خطة العمل»، ثم اكتب ما تريده فيه.'
          : 'Yes. I create and edit PDF files: say, for example, “create a PDF titled Business plan”, then write what you want in it.'
        : ar ? 'ملفات PDF غير مهيأة في هذه المحادثة الآن.' : 'PDF files are not configured in this conversation now.';
    case 'image_reading':
      return facts.imageReading
        ? ar ? 'نعم. أرفق صورة مع رسالتك وأقرأ النص الذي فيها.' : 'Yes. Attach an image to your message and I will read the text in it.'
        : ar ? 'قراءة النص من الصور غير مهيأة في هذه المحادثة الآن.' : 'Reading text from images is not configured in this conversation now.';
    case 'web':
      return facts.web
        ? ar ? 'نعم. أبحث في الويب وأقرأ الصفحات وأذكر المصدر: اسألني سؤالك مباشرة، أو قل «افتح bbc.com».'
          : 'Yes. I search the web, read the pages and name the source: ask your question directly, or say “open bbc.com”.'
        : ar ? 'البحث في الويب غير مهيأ في هذه المحادثة الآن.' : 'Web search is not configured in this conversation now.';
    case 'ads':
      return facts.ads
        ? ar ? 'نعم. أجهّز حملات Google Ads: اذكر نشاطك وموقعه الإلكتروني والمدينة والميزانية في رسالة واحدة.'
          : 'Yes. I prepare Google Ads campaigns: name your business, its website, the city and the budget in one message.'
        : ar ? 'حملات Google Ads غير متاحة في هذه المحادثة الآن.' : 'Google Ads campaigns are not available in this conversation now.';
  }
}

export function answerSelfQuestion(question: SelfQuestion, facts: SelfFacts): LocalReply | null {
  const { lang } = question, ar = lang === 'ar';
  switch (question.topic) {
    case 'creator':
      return fixedReply(creatorLine(lang));
    case 'model': {
      const model = facts.chatModel ? WITH_MODEL[lang] : NO_MODEL[lang];
      const lead = question.asked === 'human'
        ? ar ? 'لا، أنا موحسن، مساعد برمجي يعمل بقواعد التطبيق وأدواته.' : 'No, I’m Mohassan, a software assistant that works with the application’s rules and tools.'
        : question.asked === 'ai'
          ? ar ? 'نعم، أنا موحسن، مساعد برمجي يعمل بقواعد التطبيق وأدواته.' : 'Yes, I’m Mohassan, a software assistant that works with the application’s rules and tools.'
          : facts.chatModel
            ? ar ? 'أنا موحسن.' : 'I’m Mohassan.'
            : question.asked === 'which'
              ? ar ? 'أنا موحسن، ولا أعمل على أي منصة ذكاء اصطناعي خارجية.' : 'I’m Mohassan, and I do not run on any external AI platform.'
              : ar ? 'لا. أنا موحسن، ولا أعمل على أي منصة ذكاء اصطناعي خارجية.' : 'No. I’m Mohassan, and I do not run on any external AI platform.';
      return fixedReply(`${lead} ${model}\n\n${creatorLine(lang)}`);
    }
    case 'compare':
      return fixedReply(ar
        ? `لا أستطيع أن أقارن نفسي بمساعد آخر مقارنة منصفة، ولا أحكم على قدرات غيري. ما أعرفه عن نفسي من المضيف: ${facts.chatModel ? WITH_MODEL.ar : NO_MODEL.ar} أجيب من الصفحات التي أقرؤها ومن الحساب الذي أتحقق منه، وأقول حين لا أجد جوابًا مؤكدًا.`
        : `I cannot compare myself fairly with another assistant, and I do not judge what others can do. What I know about myself from the host: ${facts.chatModel ? WITH_MODEL.en : NO_MODEL.en} I answer from the pages I read and the calculations I can check, and I say so when I find no confirmed answer.`);
    case 'improve':
      return fixedReply(`${ar ? 'بحسب ما يبلّغ به المضيف الآن، هذه أكبر النواقص عندي:' : 'From what the host reports now, these are my largest gaps:'}\n${missingLines(facts, lang).map(line => `- ${line}`).join('\n')}\n\n${ar ? 'ترتيب العمل عليها يقرره المالك.' : 'Which of them comes first is the owner’s decision.'}`);
    case 'capabilities': {
      if (question.brief) return fixedReply(briefCapabilities(facts, lang, question.brief));
      const able = ORDER.filter(key => facts[key]).map(key => `- ${ABLE[lang][key]}`);
      const missing = missingLines(facts, lang).map(line => `- ${line}`);
      return fixedReply(`${ar ? 'هذا ما أستطيعه الآن في هذه المحادثة، بحسب ما يبلّغ به المضيف:' : 'This is what I can do now in this conversation, as the host reports it:'}\n${able.join('\n')}\n\n**${ar ? 'غير متاح الآن:' : 'Not available now:'}**\n${missing.join('\n')}`);
    }
    case 'can_do': {
      const text = question.ability ? canDo(question.ability, facts, lang) : null;
      return text ? fixedReply(text) : null;
    }
  }
}

/** The whole local answer to a question about the assistant, or null when the message is something else. */
export function evaluateSelfQuestion(request: string, facts: SelfFacts): LocalReply | null {
  const question = recognizeSelfQuestion(request);
  return question ? answerSelfQuestion(question, facts) : null;
}
