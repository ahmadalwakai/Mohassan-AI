/**
 * Honest limits before any search. Requests that no capability of the model-free brain can perform
 * (drawing, playing media, booking, buying, calling, sending) used to become a web search: «ارسم لي صورة قطة»
 * searched for 11 s and then said it found nothing (artifacts/plan-2026-11-22/0-baseline.md §8.3).
 * Each reply names what cannot be done and the nearest thing that can.
 */
export type UnsupportedKind = 'image' | 'media' | 'act' | 'generic';
export interface UnsupportedRequest { kind: UnsupportedKind; lang: 'ar' | 'en' }

const fold = (text: string) => text.normalize('NFKC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').trim()
  .replace(/^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|هل (?:يمكنك|تستطيع|تقدر)|يمكنك|تقدر|please|kindly|could you|can you|would you)[،,\s]+)+/iu, '');

const IMAGE = /^(?:(?:ارسم|رسم|صمم|اصنع|انشئ|ولد|اعمل|سو|سوي|سولي|اعطني|هات)(?:\s*لي)?\s+(?:ال)?(?:صور[ةه]|صور|رسم[ةه]?|رسوم|لوجو|لوغو|شعار|بوستر|ملصق|تصميم|ايقون[ةه]|خريط[ةه] ذهني[ةه]|انفوجرافيك)|ارسم(?=\s|$))|\b(?:draw|paint|sketch|illustrate)\b|\b(?:generate|create|make|design|render|produce)\s+(?:me\s+|an?\s+|the\s+|some\s+)*(?:image|images|picture|pictures|photo|photos|logo|poster|icon|illustration|drawing|avatar|wallpaper|infographic|artwork)\b/iu;
const MEDIA = /^(?:(?:شغل|اشغل|سمعني|اسمعني|حط لي|حطلي|ابدا)(?:\s*لي)?\s+(?:ال)?(?:اغني[ةه]|اغاني|موسيقي|موسيقا|فيديو|مقطع|بودكاست|راديو|اذاع[ةه]|سور[ةه]|قران|تلاو[ةه]|نشيد|اناشيد|فيلم|مسلسل|حلق[ةه]))|\b(?:play|stream)\s+(?:me\s+|a\s+|the\s+|some\s+)*(?:song|songs|music|video|videos|playlist|podcast|radio|audio|track|movie|episode)\b|\b(?:generate|create|make|produce|compose)\s+(?:me\s+|an?\s+|the\s+|some\s+)*(?:video|song|music|audio|voice|voice ?over|animation|jingle)\b/iu;
/** Acting in the world for the owner: a booking, a purchase, a call, a message or a payment, which needs their accounts and their hand on each step. */
const ACT = /^(?:(?:احجز|احجزلي|اطلب|اطلبلي|اشتر|اشتري|ادفع|اشحن|وصلني)(?:\s*لي)?(?=\s|$)|(?:اتصل|كلم|رن|دق)(?:\s*لي)?\s+(?:ب|على|ع|مع|ل)?\s*\S|(?:راسل|ابعت|ابعث|ارسل|ارسللي)(?:\s*لي)?\s+(?:رسال[ةه]|ايميل|بريد|واتساب|واتس|اس ام اس|sms|email|رسائل|ل|الى|إلى|ع|على)\s*\S)|\b(?:book|reserve)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:flight|flights|ticket|tickets|table|room|hotel|taxi|cab|uber|car|appointment|seat|seats|trip)\b|\b(?:order|buy|purchase)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:food|pizza|dinner|lunch|groceries|ticket|tickets|flight|phone|laptop|book|gift|[a-z]+ for me)\b|\b(?:call|phone|dial|text|message|whatsapp|email)\s+(?:my\s+(?:mom|mum|dad|wife|husband|boss|doctor|bank|friend|sister|brother)|(?:him|her|them)\b|the\s+(?:doctor|bank|restaurant|hotel|office|school|clinic)|\+?\d[\d\s-]{5,})|\bsend\s+(?:an?\s+|the\s+)?(?:email|message|text|sms|whatsapp|letter|invoice|payment)\s+to\b|\b(?:pay|transfer|wire)\s+(?:\$|£|€|\d|the\s+(?:bill|invoice|rent)|money)/iu;

/** Which unsupported action the request asks for, or null when it is not one. Private, computing, writing and browser requests are decided elsewhere first. */
export function unsupportedRequest(request: string): UnsupportedRequest | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 600) return null;
  const text = fold(request);
  const lang: UnsupportedRequest['lang'] = /[؀-ۿ]/u.test(request) ? 'ar' : 'en';
  if (IMAGE.test(text)) return { kind: 'image', lang };
  if (MEDIA.test(text)) return { kind: 'media', lang };
  if (ACT.test(text)) return { kind: 'act', lang };
  return null;
}

const REPLY: Record<UnsupportedKind, Record<'ar' | 'en', string>> = {
  image: {
    ar: 'لا أرسم الصور ولا أولّدها؛ هذه القدرة غير مفعّلة في موحسن الآن.\n\nما أستطيعه: البحث في الويب عن الموضوع وعرض مصادره، مثل «ابحث عن صور القطط» أو «افتح google وابحث عن صور قطط».',
    en: 'I cannot draw or generate images; that capability is not enabled in Mohassan yet.\n\nWhat I can do: search the web for the subject and show its sources, for example “search for cat pictures” or “open google and search for cat images”.',
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
