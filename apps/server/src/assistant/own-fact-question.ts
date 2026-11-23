/**
 * A question about a fact of the owner's own life or business, in Arabic («ما هي لغتي المفضلة؟», «ما هو رقم جوالي؟»,
 * «ما هي أسعار منتجاتي؟»): step 2 of the task cycle («فهم الطلب وتجميع السياق»). Its answer is in the owner's memory or
 * documents or nowhere, so the chat reads memory for it and never turns it into a public web query.
 *
 * Why this exists (measured 2026-11-22, artifacts/agent-gaps-2026-11-22/audit-head-3959084): ownership was recognised
 * through two closed noun lists (mind/frame.ts PERSONAL, request-context.ts PRIVATE). «لغتي» and «جوالي» are in neither,
 * so «ما هي لغتي المفضلة؟», asked right after the language was saved, went to the public search providers and came back
 * «لم أجد في المصادر المتاحة لي».
 *
 * The Arabic first-person ending «ـي» is also the last letter of adjectives («ذكي», «اصطناعي»), names («ميسي», «علي»),
 * places («جيبوتي», «سيدني») and plurals in the construct state («موظفي الشركة»), so the ending alone decides nothing.
 * A question is recognised only by its whole shape:
 *   a question word, then nothing but attribute nouns («اسم», «رقم», «تاريخ»…), then one owned noun from the list below
 *   carrying «ـي» or «ـنا», then at most two adjectives from a short list («المفضلة», «الجديد», «الإلكتروني»).
 * «كم عمر ميسي؟», «ما هي عاصمة جيبوتي؟», «ما هو تسويق رقمي؟» and «كم عدد موظفي الشركة؟» do not have that shape. English is
 * not handled here: `buildFrame(request).personal` already recognises «my …» there.
 *
 * Pure: no I/O, no model. The word lists are a proposal measured on the sets named in the tests, and easy to extend.
 */
import { matchText } from './mind/normalize.js';

export interface OwnFactQuestion {
  /** The asked noun phrase without the question word («لغتي المفضلة», «رقم جوالي»). */
  topic: string;
  /** The owned noun that made the question personal, folded («لغتي», «جوالي»). */
  owned: string;
}

const MAX_REQUEST = 200;

/** Words that open a question about a value. «كيف» and «لماذا» ask for a method or a reason, never for a stored fact. */
const QUESTION = '(?:ما هو|ما هي|ماهو|ماهي|ما|كم(?: هو| هي| يبلغ| تبلغ)?|اين(?: هو| هي| يقع| تقع)?|وين|متي(?: هو| هي)?|من هو|من هي|من|مين|شو(?: هو| هي)?|ايش(?: هو| هي)?|وش(?: هو| هي)?)';
/** Polite ways of asking for the same value. «ذكّرني» is left to the reminder route. */
const TELL = '(?:(?:اخبرني|خبرني|اعطني|هات|اذكر لي|قل لي|قلي)(?: (?:عن|ما هو|ما هي|ما))?|هل (?:تعرف|تتذكر|تذكر))';

/** Attribute nouns: the property asked of the owned thing («اسم شركتي», «رقم لوحة سيارتي»). Bare, never with «ال». */
const ATTRIBUTE = ['اسم', 'اسماء', 'لقب', 'رقم', 'ارقام', 'عنوان', 'عناوين', 'تاريخ', 'يوم', 'عمر', 'لون', 'مقاس', 'وزن', 'طول', 'موعد', 'مواعيد', 'مكان', 'موقع', 'سعر', 'اسعار', 'نوع',
  'رصيد', 'عدد', 'قيمه', 'حاله', 'رابط', 'كلمه', 'فصيله', 'ماركه', 'موديل', 'لوحه', 'هاتف', 'جوال', 'موبايل', 'تلفون', 'بريد', 'ايميل', 'حساب', 'ميزانيه', 'مدير', 'صاحب', 'مالك'];

/**
 * Nouns that take the owner's «ـي». Stems as they stand before the ending (a final «ة» is written «ت»). Each was checked
 * against its twin: the adjective («رقمي», «عملي», «بريدي») never follows a question word or an attribute noun directly, and
 * a noun whose bare form already ends in «ي» or names a thing people ask to have defined («محامي», «حساب جاري») is left out.
 */
const OWNED = [
  // Identity and contact.
  'اسم', 'لقب', 'عمر', 'ميلاد', 'مولد', 'جنسيت', 'لغت', 'لهجت', 'ديانت', 'بلد', 'دولت', 'مدينت', 'قريت', 'عنوان', 'بيت', 'منزل', 'شقت', 'سكن', 'رقم', 'جوال', 'هاتف', 'موبايل', 'تلفون',
  'بريد', 'ايميل', 'حساب', 'حسابات', 'سر', 'هويت', 'جواز', 'رخصت', 'بطاقت', 'توقيع',
  // Family and people.
  'زوجت', 'زوج', 'ابن', 'ابنت', 'بنت', 'ولد', 'اولاد', 'اطفال', 'ابنا', 'والد', 'والدت', 'ام', 'اب', 'اخ', 'اخت', 'اخوت', 'اخوان', 'عائلت', 'اهل', 'جد', 'جدت', 'عم', 'عمت', 'خالت',
  'صديق', 'صديقت', 'اصدقا', 'خطيبت', 'خطيب', 'طبيب', 'محاسب',
  // Work and business.
  'شركت', 'وظيفت', 'عمل', 'مهنت', 'تخصص', 'راتب', 'دخل', 'مدير', 'مديرت', 'مكتب', 'مشروع', 'مشاريع', 'متجر', 'محل', 'مطعم', 'مصنع', 'منتج', 'منتجات', 'خدمت', 'خدمات', 'عملا', 'زبائن', 'موظف',
  'فريق', 'حملت', 'حملات', 'ميزانيت', 'اعلانات', 'اعلان', 'موقع', 'نطاق', 'دومين', 'علامت', 'فواتير', 'فاتورت', 'طلب', 'طلبات', 'طلبيت', 'حجز', 'حجوزات', 'موعد', 'مواعيد', 'اشتراك', 'اشتراكات',
  'خطت', 'هدف', 'اهداف', 'مهام', 'مهمت', 'جدول', 'ملف', 'ملفات', 'ملاحظت', 'ملاحظات', 'مستند', 'مستندات', 'وثائق', 'عقد', 'عقود', 'مبيعات', 'ارباح', 'ايرادات', 'مصاريف', 'ديون', 'قرض', 'رصيد',
  'استثمارات', 'اسهم', 'ضريبت', 'ضرائب',
  // Belongings, body, study, tastes.
  'سيارت', 'دراجت', 'جهاز', 'حاسوب', 'كمبيوتر', 'لابتوب', 'قطت', 'كلب', 'لون', 'طول', 'وزن', 'مقاس', 'دم', 'هوايت', 'هوايات', 'جامعت', 'مدرست', 'كليت', 'معدل', 'درجات', 'شهادت',
  'كتاب', 'كتب', 'صور', 'صورت', 'اكلت', 'طعام', 'مشروب', 'فيلم', 'رياضت', 'برج',
];

/** Adjectives that follow an owned noun and agree with it. A closed list: «موظفي الشركة» is a plural before its genitive. */
const ADJECTIVE = ['المفضل', 'الجديد', 'القديم', 'الحالي', 'السابق', 'الشخصي', 'الخاص', 'الالكتروني', 'الرئيسي', 'الاول', 'الثاني', 'الاصلي', 'الكامل', 'الرسمي', 'التجاري', 'الاخير',
  'المسجل', 'المحفوظ', 'الصحيح', 'الحقيقي', 'الشهري', 'السنوي', 'اليومي', 'الاساسي', 'البريدي', 'الوطني', 'الضريبي', 'البنكي', 'المصرفي', 'الجامعي', 'الدراسي', 'الصغير', 'الكبير', 'الاكبر', 'الاصغر'];

const stems = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length).join('|');
/** «عملائي», «أبنائي», «أصدقائي»: the hamza of a broken plural sits on a seat before the ending. */
const OWNED_WORD = `(?:${stems(OWNED)})(?:ئ|ء)?(?:ي|نا)`;
const ATTRIBUTE_WORD = `(?:${stems(ATTRIBUTE)})`;
/** The agreeing adjectives («المفضلة», «الأولى»), then at most one word of place or time. */
const TAIL = `(?: (?:${stems(ADJECTIVE)})(?:ه|ي)?){0,2}(?: (?:الان|حاليا|اليوم|عندك|عندي|لديك|في ذاكرتك|في ذاكرتي))?`;
const LEAD = `^(?:و|ف)?(?:${QUESTION}|${TELL}) ب?`;
const OWN_FACT = new RegExp(`${LEAD}((?:${ATTRIBUTE_WORD} ){0,3}(${OWNED_WORD})${TAIL})$`, 'u');
/** «لاعبي المفضل», «أكلتي المفضلة»: «المفضل» right after a noun with «ـي» is the owner's favourite, whatever the noun. */
const FAVOURITE = new RegExp(`${LEAD}((?!ال)([\\p{L}]{2,}ي) المفضل(?:ه)?(?: (?:الان|حاليا|عندي|لدي))?)$`, 'u');

function folded(request: string): string | null {
  if (typeof request !== 'string' || !request.trim() || request.length > MAX_REQUEST || /[\r\n]/u.test(request.trim())) return null;
  if (!/\p{Script=Arabic}/u.test(request) || /https?:\/\/|\bwww\.|[\d٠-٩۰-۹]/iu.test(request)) return null;
  return matchText(request).replace(/['’‘`]/gu, '').replace(/[؟?!.,،؛;:«»"“”()[\]{}…*_~|\\/<>-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Null unless the whole message is one question about one fact of the owner's own. */
export function ownFactQuestion(request: string): OwnFactQuestion | null {
  const text = folded(request);
  if (!text) return null;
  const found = OWN_FACT.exec(text) ?? FAVOURITE.exec(text);
  if (!found) return null;
  // The topic keeps the owner's spelling where the words line up: the same count of words from the end of the message.
  const words = request.trim().replace(/[\s؟?!.،,؛;:]+$/gu, '').split(/\s+/u);
  const asked = found[1]!.split(' ');
  const written = words.slice(-asked.length);
  const aligned = written.length === asked.length && matchText(written[0]!).replace(/^[«"“(]+/u, '') === asked[0];
  return { topic: aligned ? written.join(' ') : found[1]!, owned: found[2]! };
}
