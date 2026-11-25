/**
 * Honest limits before any search. Requests that no capability of the model-free brain can perform
 * (drawing, playing media, booking, buying, calling, sending) used to become a web search: «ارسم لي صورة قطة»
 * searched for 11 s and then said it found nothing (artifacts/plan-2026-11-22/0-baseline.md §8.3).
 * Each reply names what cannot be done and the nearest thing that can.
 */
export type UnsupportedKind = 'image' | 'media' | 'act' | 'generic' | 'safety';
/** `spec`: the owner's own description of how the picture should look, when the message is only that (see imageSpecification). */
export interface UnsupportedRequest { kind: UnsupportedKind; lang: 'ar' | 'en'; spec?: string }

const fold = (text: string) => text.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').trim()
  .replace(/^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|هل (?:يمكنك|تستطيع|تقدر)|يمكنك|تقدر|please|kindly|could you|can you|would you)[،,\s]+)+/iu, '');

const IMAGE = /^(?:(?:ارسم|رسم|صمم|اصنع|انشئ|ولد|اعمل|سو|سوي|سولي|اعطني|هات)(?:\s*لي)?\s+(?:ال)?(?:صور[ةه]|صور|رسم[ةه]?|رسوم|لوجو|لوغو|شعار|بوستر|ملصق|تصميم|ايقون[ةه]|خريط[ةه] ذهني[ةه]|انفوجرافيك)|ارسم(?=\s|$))|\b(?:draw|paint|sketch|illustrate)\b|\b(?:generate|create|make|design|render|produce)\s+(?:me\s+|an?\s+|the\s+|some\s+)*(?:image|images|picture|pictures|photo|photos|logo|poster|icon|illustration|drawing|avatar|wallpaper|infographic|artwork)\b/iu;
const MEDIA = /^(?:(?:شغل|اشغل|سمعني|اسمعني|حط لي|حطلي|ابدا)(?:\s*لي)?\s+(?:ال)?(?:اغني[ةه]|اغاني|موسيقي|موسيقا|فيديو|مقطع|بودكاست|راديو|اذاع[ةه]|سور[ةه]|قران|تلاو[ةه]|نشيد|اناشيد|فيلم|مسلسل|حلق[ةه]))|\b(?:play|stream)\s+(?:me\s+|a\s+|the\s+|some\s+)*(?:song|songs|music|video|videos|playlist|podcast|radio|audio|track|movie|episode)\b|\b(?:generate|create|make|produce|compose)\s+(?:me\s+|an?\s+|the\s+|some\s+)*(?:video|song|music|audio|voice|voice ?over|animation|jingle)\b/iu;
/** Acting in the world for the owner: a booking, a purchase, a call, a message or a payment, which needs their accounts and their hand on each step. */
const ACT = /^(?:(?:احجز|احجزلي|اطلب|اطلبلي|اشتر|اشتري|ادفع|اشحن|وصلني)(?:\s*لي)?(?=\s|$)|(?:اتصل|كلم|رن|دق)(?:\s*لي)?\s+(?:ب|على|ع|مع|ل)?\s*\S|(?:راسل|ابعت|ابعث|ارسل|ارسللي)(?:\s*لي)?\s+(?:رسال[ةه]|ايميل|بريد|واتساب|واتس|اس ام اس|sms|email|رسائل|ل|الى|إلى|ع|على)\s*\S)|\b(?:book|reserve)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:flight|flights|ticket|tickets|table|room|hotel|taxi|cab|uber|car|appointment|seat|seats|trip)\b|\b(?:order|buy|purchase)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:food|pizza|dinner|lunch|groceries|ticket|tickets|flight|phone|laptop|book|gift|[a-z]+ for me)\b|\b(?:call|phone|dial|text|message|whatsapp|email)\s+(?:my\s+(?:mom|mum|dad|wife|husband|boss|doctor|bank|friend|sister|brother)|(?:him|her|them)\b|the\s+(?:doctor|bank|restaurant|hotel|office|school|clinic)|\+?\d[\d\s-]{5,})|\bsend\s+(?:an?\s+|the\s+)?(?:email|message|text|sms|whatsapp|letter|invoice|payment)\s+to\b|\b(?:pay|transfer|wire)\s+(?:\$|£|€|\d|the\s+(?:bill|invoice|rent)|money)/iu;

/**
 * A message that only says how a picture should look: its colours and its background. «أزرق على خلفية رمادية», «بخلفية
 * شفافة» and "white on a black background" describe an image; they are not questions to look up. Real request rq091
 * (2026-11-22): «لون أسود على خلفية بيضاء» after "bmw logo" (after "can you create image" in production) was searched on
 * its own words, and the reply quoted a sentence about mirrors from the ar Wikipedia article «لون».
 *
 * A colour set against a background, a colour on a colour, or «بدون خلفية» describes a picture with nothing before it. A
 * bare colour («باللون الأخضر», "make it blue"), a resolution, a file type or a style describes one only right after the
 * owner asked for an image or named one (a logo, a picture, an icon), possibly through earlier descriptions. After a PDF,
 * a website, a page or a letter the description belongs to that work, so it is not taken as an image here. Every form is
 * a whole message: a question word, a verb with its own object or a second clause leaves it to the other routes. The forms
 * are general; the tests use their own wording, not the set's.
 */
const HUE_AR = '(?:اسود|سوداء|سودا|ابيض|بيضاء|بيضا|احمر|حمراء|حمرا|ازرق|زرقاء|زرقا|اخضر|خضراء|خضرا|اصفر|صفراء|صفرا|(?:رمادي|بني|برتقالي|بنفسجي|وردي|زهري|ذهبي|فضي|كحلي|سماوي|فيروزي|شفاف|ملون)ه?|بيج)';
const SHADE_AR = '(?:(?:فاتح|داكن|غامق)ه?)';
/** «أسود», «الأسود», «لون أسود», «باللون الأسود», «لونها زرقاء», «أزرق فاتح», «داكنة». Folded text. */
const COLOUR_AR = `(?:(?:ب|بال|ال)?لون(?:ه|ها)? )?(?:ال)?(?:${HUE_AR}(?: (?:ال)?${SHADE_AR})?|${SHADE_AR})`;
/** «على خلفية», «بخلفية», «مع خلفية», «والخلفية», «خلفيتها», «أرضية». */
const GROUND_AR = '(?:(?:و ?)?(?:على|علي|فوق|مع|في) |و)?(?:ب|بال|ال)?(?:خلفي|ارضي)(?:ه|ته|تها)';
const NO_GROUND_AR = '(?:بدون|بلا|لا|من غير|من دون|دون) (?:ال)?(?:خلفي|ارضي)ه';
/** «شعار», «شعارًا», «صورة القطة», «لوجو bmw»: a picture named first, with at most three words of its own (letters only). */
const OBJECT_AR = '(?:ال)?(?:(?:شعار|لوجو|لوغو|لوقو|بوستر|ملصق|بانر)ا?|صوره|ايقونه|رسمه)(?: [\\p{L}&]+){0,3}';
const COLOUR_EN = '(?:(?:(?:light|dark|bright|pale|deep) )?(?:black|white|red|blue|green|yellow|gr[ae]y|brown|orange|purple|violet|pink|gold(?:en)?|silver|navy|cyan|magenta|beige|maroon|teal|turquoise|transparent|colou?red|colou?rful|plain)|light|dark)';
const OBJECT_EN = '(?:(?:a|an|the|my|our) )?(?:[\\p{L}&]+ ){0,3}?(?:logo|image|picture|photo|icon|drawing|illustration|poster|banner|sticker|wallpaper|avatar|emblem)s?';
const GROUND_EN = '(?:background|backdrop|bg)';
const A = '(?:(?:a|an|the) )?';
const SPEC_STRONG: readonly RegExp[] = [
  new RegExp(`^(?:${OBJECT_AR} )?(?:${COLOUR_AR} )?${GROUND_AR} ${COLOUR_AR}$`, 'u'),
  new RegExp(`^(?:${OBJECT_AR} )?${COLOUR_AR} (?:على|علي|فوق) ${COLOUR_AR}$`, 'u'),
  new RegExp(`^(?:${OBJECT_AR} )?(?:${COLOUR_AR} )?${NO_GROUND_AR}$`, 'u'),
  new RegExp(`^(?:${OBJECT_EN} )?(?:in )?${A}${COLOUR_EN}(?: ${OBJECT_EN})? (?:on|over|against) ${A}${COLOUR_EN}(?: ${GROUND_EN})?$`, 'u'),
  new RegExp(`^(?:${OBJECT_EN} )?(?:(?:in )?${A}${COLOUR_EN} )?(?:(?:with|on|over|against|and|in front of) )?${A}${COLOUR_EN} ${GROUND_EN}$`, 'u'),
  new RegExp(`^(?:${OBJECT_EN} )?${A}${GROUND_EN} (?:(?:is|should be|in|to) )?${A}${COLOUR_EN}$`, 'u'),
  new RegExp(`^(?:${OBJECT_EN} )?(?:(?:with|and) )?(?:no|without(?: (?:a|the|any))?) ${GROUND_EN}$`, 'u'),
];
const SPEC_WEAK: readonly RegExp[] = [
  new RegExp(`^(?:(?:الي|الى|ل) )?${COLOUR_AR}$`, 'u'),
  new RegExp(`^(?:(?:in|to) )?${A}${COLOUR_EN}(?: (?:colou?r|colou?red|one|version|tone|instead))?$|^colou?r(?:ed)? ${COLOUR_EN}$`, 'u'),
  /^(?:(?:ب|بال)?(?:دقه|جوده) (?:عاليه|عالي|اعلي|ممتازه)|(?:ب|بال)?(?:صيغه|امتداد|نوع) (?:png|svg|jpe?g|webp)|(?:ب ?شكل |بستايل |بطريقه )?(?:ثلاثي الابعاد|ثنائي الابعاد|كرتوني|واقعي|بسيط|مسطح))$/u,
  /^(?:(?:in|as) )?(?:(?:a|an) )?(?:png|svg|jpe?g|webp|hd|full hd|4k|8k|3d|high(?:er)? (?:res|resolution|quality|definition)|cartoon|realistic|minimalist|minimal|flat|vector|watercolou?r)(?: (?:format|file|version|style|image|one))?$/u,
];
/** «طيب», «لا،», «بس», «أريد», «اجعلها», «خليه», "make it", "I want": a lead that only hands the description over. «لا خلفية» and "no background" keep their «no». */
const SPEC_LEAD = /^(?:(?:طيب|بس|اوك|اوكي|حسنا|تمام|لا(?! (?:ال)?(?:خلفي|ارضي)ه(?: |$))|نعم|ايوه|و|ok|okay|and|but|just|no(?! (?:background|backdrop|bg)(?: |$))|yes|yeah|so|now)\s+)*(?:(?:اريد(?:ه|ها)?|ابي(?:ه|ها)?|ابغي|ابغا(?:ه|ها)?|بدي(?:اه|ه|ها)?|عايز|اعطني|هات|اجعل(?:ه|ها)|خلي(?:ه|ها)|خل(?:ه|ها)|سوي(?:ه|ها)|اعمل(?:ه|ها)|حول(?:ه|ها)|غير(?:ه|ها)|ليكن|لتكن|يكون|تكون)\s+|(?:i want it|id like it|i would like it|i want|i need|id like|i would like|give me|make it|make them|do it|turn it|change it(?: to)?|have it|keep it|it should be|should be)\s+)?/u;
const SPEC_TAIL = /\s+(?:من فضلك|لو سمحت|لو سمحتي|رجاء|please|pls|plz|thanks|thank you|يا موحسن|mohassan)$/u;
/** The same lead words and courtesy tail on the owner's unfolded text, so the description is named back without them. */
const SHOWN_LEAD = /^(?:(?:طيب|بس|اوك|اوكي|حسنا|تمام|نعم|ايوه|ok|okay|and|but|just|yes|yeah|so|now)[،,\s]+)+/iu;
const SHOWN_TAIL = /[،,\s]+(?:من فضلك|لو سمحت|لو سمحتي|رجاء|please|pls|plz|thanks|thank you|يا موحسن|mohassan)$/iu;
const specText = (request: string): string => fold(request).toLowerCase().replace(/['’‘`]/gu, '')
  .replace(/[«»"“”.!?؟،,؛;:()[\]{}…*_~|\\/+=-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  .replace(SPEC_LEAD, '').replace(SPEC_TAIL, '').trim();

function visualSpec(text: string): 'strong' | 'weak' | null {
  if (!text || text.length > 120 || text.split(' ').length > 12) return null;
  if (SPEC_STRONG.some(pattern => pattern.test(text))) return 'strong';
  if (SPEC_WEAK.some(pattern => pattern.test(text))) return 'weak';
  return null;
}

/** A picture named or asked for: «شعارًا», «شعاري», «صورتي», «ارسم», "logo", "draw". Folded text. */
const IMAGE_NAMED = /(?<![\p{L}\p{N}])(?:ال|لل|ب|بال|و|ل)?(?:(?:شعار|لوجو|لوغو|لوقو|بوستر|ملصق|بانر)(?:ات)?(?:ا|ي|ك|نا|ه|ها)?|صور(?:ه|ت(?:ي|ك|ه|ها|نا))?|ايقون(?:ه|ات|ت(?:ي|ك|ه|ها))|رسم(?:ه|ات|ت(?:ي|ك|ه|ها))?|رسومات|ارسم(?:ي|لي)?)(?![\p{L}\p{N}])|\b(?:images?|pictures?|photos?|logos?|icons?|drawings?|draw|illustrations?|posters?|banners?|stickers?|wallpapers?|avatars?)\b/u;
/** A PDF, a website, a page, a document, a slide or a letter: work whose look has its own path. */
const OTHER_WORK = /(?<![\p{L}\p{N}])(?:ال)?(?:pdf|بي ?دي ?اف|موقع|موقعا|مواقع|صفحه|مستند|ملف|عرض تقديمي|شريحه|شرائح|رساله|خطاب|بريد|ايميل)(?![\p{L}\p{N}])|\b(?:pdf|websites?|web ?sites?|sites?|web ?pages?|pages?|landing|documents?|files?|presentations?|slides?|letters?|emails?)\b/u;

/** The last request asked for or named a picture, possibly before a run of descriptions of it. */
function imageContext(earlier: readonly string[]): boolean {
  for (let index = earlier.length - 1, looked = 0; index >= 0 && looked < 3; index--, looked++) {
    const turn = specText(earlier[index] ?? '');
    if (!turn || OTHER_WORK.test(turn)) return false;
    if (IMAGE_NAMED.test(turn) && turn.split(' ').length <= 12) return true;
    if (!visualSpec(turn)) return false;
  }
  return false;
}

/**
 * The owner's description as written, when the whole message says how a picture should look; null otherwise.
 * `earlier` holds the owner's previous messages in this conversation, oldest first.
 */
export function imageSpecification(request: string, earlier: readonly string[] = []): string | null {
  if (typeof request !== 'string' || request.length > 200) return null;
  const strength = visualSpec(specText(request));
  if (!strength) return null;
  const last = earlier.length ? specText(earlier[earlier.length - 1] ?? '') : '';
  if (last && OTHER_WORK.test(last)) return null;
  if (strength === 'weak' && !imageContext(earlier)) return null;
  const shown = request.normalize('NFC').replace(/\s+/gu, ' ').replace(/^[\s«"“]+|[\s.!?؟،,»"”]+$/gu, '').trim()
    .replace(SHOWN_LEAD, '').replace(SHOWN_TAIL, '').replace(/[\s.!?؟،,]+$/u, '').trim();
  return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
}

/**
 * Which unsupported action the request asks for, or null when it is not one. Private, computing, writing and browser
 * requests are decided elsewhere first. `earlier`: the owner's previous messages, oldest first, for a description that
 * follows a request for a picture.
 */
export function unsupportedRequest(request: string, earlier: readonly string[] = []): UnsupportedRequest | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 600) return null;
  const text = fold(request);
  const lang: UnsupportedRequest['lang'] = /[؀-ۿ]/u.test(request) ? 'ar' : 'en';
  if (IMAGE.test(text)) return { kind: 'image', lang };
  if (MEDIA.test(text)) return { kind: 'media', lang };
  if (ACT.test(text)) return { kind: 'act', lang };
  const spec = imageSpecification(request, earlier);
  if (spec) return { kind: 'image', lang, spec };
  return null;
}

const IMAGE_ALTERNATIVE = {
  ar: 'ما أستطيعه: البحث في الويب عن الموضوع وعرض مصادره، مثل «ابحث عن صور القطط» أو «افتح google وابحث عن صور قطط».',
  en: 'What I can do: search the web for the subject and show its sources, for example “search for cat pictures” or “open google and search for cat images”.',
};
const REPLY: Record<UnsupportedKind, Record<'ar' | 'en', string>> = {
  safety: {
    ar: 'لا أستطيع المساعدة في هذا الطلب كما صيغ. يمكنك طلب معلومات عامة أو مساعدة بطريقة آمنة.',
    en: 'I can’t help with this request as phrased. You can ask for general information or help with a safe alternative.',
  },
  image: {
    ar: `لا أرسم الصور ولا أولّدها؛ هذه القدرة غير مفعّلة في موحسن الآن.\n\n${IMAGE_ALTERNATIVE.ar}`,
    en: `I cannot draw or generate images; that capability is not enabled in Mohassan yet.\n\n${IMAGE_ALTERNATIVE.en}`,
  },
  media: {
    ar: 'لا أشغّل الأغاني أو الفيديو ولا أولّدها.\n\nما أستطيعه: أن أفتح يوتيوب وأبحث فيه إن قلت مثلًا «افتح يوتيوب وابحث عن أغنية لفيروز»، وتشغّل أنت المقطع من لوحة المتصفح.',
    en: 'I cannot play or generate songs or videos.\n\nWhat I can do: open YouTube and search there if you say, for example, “open youtube and search for Fairuz songs”, and you play the clip from the browser panel.',
  },
  act: {
    ar: 'لا أحجز ولا أشتري ولا أتصل ولا أرسل بنفسي؛ هذه أفعال تحتاج حساباتك وموافقتك عند كل خطوة، وليست من قدراتي الحالية.\n\nما أستطيعه: أن أفتح موقع الخدمة وأبحث فيه إن أعطيتني اسمه أو رابطه، وتكمل أنت الخطوة الحساسة من لوحة المتصفح. وإن أردت نص رسالة فقل «اكتب رسالة …» وأجهّز لك مسودة.',
    en: 'I do not book, buy, call or send on my own; those actions need your accounts and your approval at each step, and they are outside my current capabilities.\n\nWhat I can do: open the service’s website and search there if you give me its name or link, and you complete the sensitive step from the browser panel. For a message text, say “write a message …” and I will prepare a draft.',
  },
  generic: {
    ar: 'لا أستطيع تنفيذ هذا الطلب بقدراتي الحالية: الحساب، وذاكرتك، والبحث في الويب وقراءة المصادر، وأوامر المتصفح، والرسائل من قالب، وتخطيط الأسبوع.\n\nإن كان طلبك يقع ضمن إحداها فأعد صياغته، مثل «ابحث عن …» أو «افتح …».',
    en: 'I cannot perform this request with my current capabilities: calculation, your memory, web search and reading sources, browser commands, template letters and week planning.\n\nIf it fits one of those, rephrase it, for example “search for …” or “open …”.',
  },
};

export function unsupportedReply(found: UnsupportedRequest): string {
  // A description of the picture is named back, so the owner sees what was understood before the limit.
  if (found.kind === 'image' && found.spec) return found.lang === 'ar'
    ? `فهمت «${found.spec}» وصفًا لشكل الصورة، لكني لا أرسم الصور ولا أولّدها؛ هذه القدرة غير مفعّلة في موحسن الآن.\n\n${IMAGE_ALTERNATIVE.ar}`
    : `I took “${found.spec}” as how the image should look, but I cannot draw or generate images; that capability is not enabled in Mohassan yet.\n\n${IMAGE_ALTERNATIVE.en}`;
  return REPLY[found.kind][found.lang];
}

/**
 * The source guard refused to turn the request into a public search. Before, the run ended as «تعذّر»
 * with the guard's message and no reply at all (8 of 107 real requests on 2026-11-22). This is the reply instead.
 */
export function searchRefusedReply(request: string, query: string, code: string, message: string): string {
  const ar = /[؀-ۿ]/u.test(request);
  const shown = query.trim().slice(0, 80);
  if (code === 'ASSISTANT_SEARCH_SOURCE') {
    return ar
      ? `لم أبحث في الويب عن «${shown}»: يبدو الطلب متعلقًا بمعلومات خاصة، أو بمرجع غير محدد، أو بفعل لا أنفّذه بنفسي، ولا أحوّل مثل هذا إلى بحث عام.\n\nإن كان سؤالًا عامًا فاكتبه سؤالًا كاملًا مثل «ما هو …؟»، أو أرسل رابط الموقع المقصود وأقرأه لك.`
      : `I did not search the web for “${shown}”: the request looks tied to private information, an unspecified reference, or an action I do not perform myself, and I do not turn such requests into a public search.\n\nIf it is a general question, write it in full, such as “what is …?”, or send the website’s link and I will read it for you.`;
  }
  return message;
}
