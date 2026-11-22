import type { SiteKind, SiteLang, SitePartialBrief, SiteWant } from '@mohassan/contracts';
import { detectLang, findEmail, findNumbers, findUrl, normalize, requestedLang } from './text.ts';
import { colourFromWord } from './theme.ts';

/**
 * Does the sentence ask for a website to be made? Arabic and English, with a guard against browser
 * verbs ("افتح موقع X", "search the site") and against editing an existing site.
 * Matching runs on normalised text (no diacritics, unified alef/ya/ta marbuta, ASCII digits).
 */
const WANT = '(?:اريد|ابغي|ابغا|بدي|بغيت|عايز|عاوز|احتاج|محتاج|نريد|نحتاج|ممكن|هل يمكن|هل تستطيع|لو سمحت|من فضلك|رجاء|ارجو|اتمني|حاب|حابب|ودي|نفسي|i want|i need|we want|we need|i would like|i\'d like|can you|could you|please|help me)';
const VERB = '(?:ابن|ابني|ابنيلي|اعمل|اعملي|اعمللي|انشئ|انشي|انشا|صمم|صممي|صمملي|سوي|سويلي|اكتب|اكتبلي|جهز|جهزلي|اصنع|ركب|طور|طورلي|انجز|كود|برمج|build|make|create|design|set up|setup|develop|code|put together|generate|launch)';
const OBJECT = '(?:موقع(?:ا|ي|نا)?(?:\\s+(?:الكتروني|ويب|انترنت|تعريفي|شخصي|تجاري|احترافي|بسيط|كامل))?|صفحه\\s+(?:هبوط|تعريفيه|ويب|انترنت|شخصيه|لنشاطي)|ويب\\s*سايت|ويبسايت|لاندينج|لاندنج|متجر(?:ا)?\\s+الكتروني|بورتفوليو|website|web\\s*site|site|landing\\s*page|home\\s*page|homepage|web\\s*page|online\\s+(?:store|shop|catalog(?:ue)?)|portfolio\\s+(?:site|website|page))';
const BROWSER_VERB = /(?:^|\s)(?:افتح|ادخل|اذهب|روح|تصفح|ابحث|دور|شوف|اقرا|لخص|ترجم|قيم|حلل|راجع|افحص|صور|حدث|open|visit|go to|browse|search|read|summari[sz]e|translate|check|review|analy[sz]e|look at|screenshot|scrape|fetch|login|log in|sign in)(?=\s)/u;
const EXISTING_SITE = /(?:موقعي|موقعنا|الموقع الحالي|موقع (?:قديم|موجود)|my (?:current |existing |old )?(?:web)?site|our (?:current |existing )?(?:web)?site|the (?:current |existing )(?:web)?site)/u;
const EDIT_VERB = /(?:^|\s)(?:عدل|غير|حدث|اصلح|حسن|اضف|احذف|edit|update|fix|improve|change|redesign)(?=\s)/u;
const REQUEST_WITH_VERB = new RegExp(`(?:^|\\s)(?:${WANT}\\s+)?(?:ان\\s+|ان تبني\\s+|ان تعمل\\s+)?${VERB}(?:\\s+(?:لي|لنا|معي|لنفسي|me|us|for me|for us))?(?:\\s+(?:a|an|the|new|my|our)?\\s*)?(?:(?!${OBJECT})[\\p{L}\\p{N}'’-]+\\s+){0,3}${OBJECT}(?!\\p{L})`, 'u');
const REQUEST_WANT_ONLY = new RegExp(`(?:^|\\s)${WANT}\\s+(?:a|an|the|new|my|our)?\\s*${OBJECT}(?!\\p{L})`, 'u');
const REQUEST_OBJECT_FIRST = new RegExp(`^(?:${OBJECT})\\s+(?:ل|لـ|for|about|عن|لمطعم|لشركه|لعياده|لمتجر|لمكتب|لمحل|لصالون|لمركز|لنشاط|لعمل|لمشروع)`, 'u');

export function isSiteRequest(text: string): boolean {
  const norm = normalize(text);
  if (!norm) return false;
  if (BROWSER_VERB.test(norm) && !REQUEST_WITH_VERB.test(norm)) return false;
  if (EXISTING_SITE.test(norm) && EDIT_VERB.test(norm)) return false;
  if (REQUEST_WITH_VERB.test(norm) || REQUEST_WANT_ONLY.test(norm) || REQUEST_OBJECT_FIRST.test(norm)) {
    // "open the website of X" and friends never pass: the browser verb check above already excluded them.
    return !/(?:^|\s)(?:افتح|open)\s/.test(norm);
  }
  return false;
}
/** Exported for hands.ts: one test on the raw text. */
export const SITE_REQUEST = { test: isSiteRequest };

interface KindEntry { kind: SiteKind; words: readonly string[] }
/** Order matters: more specific kinds first; "services" is the default when nothing else matches. */
const KINDS: readonly KindEntry[] = [
  { kind: 'restaurant', words: ['مطعم', 'مطعمي', 'مطاعم', 'كافيه', 'كافي', 'كوفي', 'مقهي', 'قهوه', 'حلويات', 'حلواني', 'مخبز', 'فرن', 'بيتزا', 'برجر', 'برغر', 'شاورما', 'مشاوي', 'مشويات', 'وجبات', 'ماكولات', 'اكل', 'مطبخ', 'بوفيه', 'كيك', 'عصائر', 'عصير', 'restaurant', 'cafe', 'café', 'coffee', 'coffee shop', 'bakery', 'pizza', 'pizzeria', 'burger', 'grill', 'sweets', 'dessert', 'patisserie', 'bistro', 'diner', 'eatery', 'food truck', 'catering', 'kitchen', 'juice bar', 'shisha'] },
  { kind: 'clinic', words: ['عياده', 'عيادتي', 'عيادات', 'طبيب', 'طبيبه', 'دكتور', 'دكتوره', 'اسنان', 'تجميل', 'جلديه', 'صيدليه', 'مستوصف', 'مركز طبي', 'مركز صحي', 'علاج', 'علاج طبيعي', 'نفسي', 'بصريات', 'نظارات', 'تغذيه', 'مخبر', 'مختبر', 'اشعه', 'بيطري', 'clinic', 'dentist', 'dental', 'doctor', 'medical', 'physio', 'physiotherapy', 'pharmacy', 'dermatology', 'optician', 'optometrist', 'therapy', 'therapist', 'nutrition', 'nutritionist', 'lab', 'laboratory', 'veterinary', 'vet', 'health centre', 'health center', 'surgery'] },
  { kind: 'catalogue', words: ['متجر', 'متجري', 'محل', 'محلي', 'بوتيك', 'منتجات', 'منتجاتي', 'بضاعه', 'ملابس', 'عطور', 'اكسسوارات', 'احذيه', 'شنط', 'حقائب', 'مجوهرات', 'ذهب', 'الكترونيات', 'جوالات', 'موبايلات', 'اثاث', 'مفروشات', 'كتالوج', 'كتالوغ', 'تسوق', 'بيع', 'store', 'shop', 'boutique', 'products', 'catalog', 'catalogue', 'clothing', 'fashion', 'perfume', 'perfumes', 'accessories', 'shoes', 'bags', 'jewellery', 'jewelry', 'electronics', 'phones', 'furniture', 'gifts', 'retail', 'merch', 'merchandise'] },
  { kind: 'portfolio', words: ['اعمالي', 'بورتفوليو', 'معرض اعمال', 'معرض اعمالي', 'مصور', 'مصوره', 'فوتوغرافي', 'مصمم', 'مصممه', 'جرافيك', 'فنان', 'فنانه', 'رسام', 'رسامه', 'معماري', 'معماريه', 'مهندس', 'مهندسه', 'كاتب', 'كاتبه', 'مطور', 'مطوره', 'مبرمج', 'مستقل', 'فريلانسر', 'سيره', 'سيرتي', 'شخصي', 'portfolio', 'photographer', 'photography', 'designer', 'graphic', 'illustrator', 'artist', 'architect', 'engineer', 'writer', 'developer', 'freelancer', 'freelance', 'my work', 'personal site', 'personal website', 'resume', 'cv', 'creative'] },
  { kind: 'landing', words: ['صفحه هبوط', 'لاندينج', 'لاندنج', 'عرض خاص', 'عرض', 'حمله', 'منتج واحد', 'اطلاق', 'كورس', 'دوره', 'ورشه', 'فعاليه', 'مؤتمر', 'تسجيل', 'اشتراك', 'landing', 'landing page', 'offer', 'promotion', 'promo', 'campaign', 'launch', 'single product', 'one product', 'course', 'workshop', 'event', 'conference', 'webinar', 'sign-up', 'signup', 'waitlist', 'app'] },
  { kind: 'services', words: ['خدمات', 'خدماتي', 'خدمه', 'سباك', 'سباكه', 'كهربائي', 'كهرباء', 'تنظيف', 'نظافه', 'نقل', 'نقل عفش', 'نقل اثاث', 'شحن', 'صيانه', 'تصليح', 'محامي', 'محاميه', 'محاماه', 'مكتب', 'مكتبي', 'شركه', 'شركتي', 'مقاولات', 'مقاول', 'بناء', 'تكييف', 'تبريد', 'دهان', 'نجار', 'حداد', 'حدائق', 'تنسيق حدائق', 'تعليم', 'دروس', 'مدرس', 'مدرسه خاصه', 'ترجمه', 'محاسبه', 'محاسب', 'استشارات', 'تسويق', 'عقارات', 'عقاري', 'تاجير', 'سيارات', 'ميكانيكي', 'ورشه سيارات', 'غسيل', 'مغسله', 'خياطه', 'خياط', 'صالون', 'حلاق', 'تجميل منزلي', 'تصوير', 'طباعه', 'تصميم داخلي', 'ديكور', 'امن', 'حراسه', 'توصيل', 'سفر', 'سياحه', 'حج', 'عمره', 'تاشيرات', 'services', 'service', 'plumber', 'plumbing', 'electrician', 'electrical', 'cleaning', 'cleaner', 'moving', 'movers', 'removals', 'man and van', 'courier', 'delivery', 'repair', 'repairs', 'maintenance', 'handyman', 'lawyer', 'law firm', 'solicitor', 'accountant', 'accounting', 'consulting', 'consultant', 'marketing', 'agency', 'real estate', 'estate agent', 'letting', 'rental', 'car', 'garage', 'mechanic', 'mot', 'laundry', 'dry cleaning', 'tailor', 'salon', 'barber', 'hairdresser', 'beauty', 'nails', 'tutor', 'tutoring', 'lessons', 'driving school', 'translation', 'printing', 'interior', 'decor', 'builder', 'construction', 'contractor', 'roofing', 'painter', 'decorator', 'carpenter', 'gardener', 'landscaping', 'security', 'locksmith', 'travel', 'tourism', 'visa', 'company', 'business', 'office', 'firm', 'studio', 'gym', 'fitness', 'trainer', 'yoga', 'school', 'nursery', 'daycare'] },
];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (word: string) => new RegExp(`(?:^|[^\\p{L}])(?:ال|لل|ل|بال|ب|و|ولل|ول|وب|the |a |an |my |our )?${escapeRegExp(word)}(?:ي|نا|ك|كم|s|es)?(?![\\p{L}])`, 'u');
export function detectKind(text: string): { kind: SiteKind; word: string } | null {
  const norm = normalize(text);
  for (const entry of KINDS) {
    for (const word of entry.words) if (wordPattern(word).test(norm)) return { kind: entry.kind, word };
  }
  return null;
}
export const KIND_WORDS = KINDS;

const CITIES: readonly { ar: string; en: string }[] = [
  { ar: 'دمشق', en: 'Damascus' }, { ar: 'حلب', en: 'Aleppo' }, { ar: 'حمص', en: 'Homs' }, { ar: 'حماه', en: 'Hama' }, { ar: 'اللاذقيه', en: 'Latakia' }, { ar: 'طرطوس', en: 'Tartus' }, { ar: 'دير الزور', en: 'Deir ez-Zor' }, { ar: 'الرقه', en: 'Raqqa' }, { ar: 'درعا', en: 'Daraa' }, { ar: 'السويداء', en: 'Sweida' }, { ar: 'ادلب', en: 'Idlib' }, { ar: 'القامشلي', en: 'Qamishli' },
  { ar: 'الرياض', en: 'Riyadh' }, { ar: 'جده', en: 'Jeddah' }, { ar: 'مكه', en: 'Mecca' }, { ar: 'المدينه', en: 'Medina' }, { ar: 'الدمام', en: 'Dammam' }, { ar: 'الخبر', en: 'Khobar' }, { ar: 'الطائف', en: 'Taif' }, { ar: 'ابها', en: 'Abha' }, { ar: 'تبوك', en: 'Tabuk' }, { ar: 'القصيم', en: 'Qassim' },
  { ar: 'دبي', en: 'Dubai' }, { ar: 'ابوظبي', en: 'Abu Dhabi' }, { ar: 'الشارقه', en: 'Sharjah' }, { ar: 'عجمان', en: 'Ajman' }, { ar: 'العين', en: 'Al Ain' }, { ar: 'الدوحه', en: 'Doha' }, { ar: 'الكويت', en: 'Kuwait' }, { ar: 'المنامه', en: 'Manama' }, { ar: 'مسقط', en: 'Muscat' }, { ar: 'صلاله', en: 'Salalah' },
  { ar: 'عمان', en: 'Amman' }, { ar: 'اربد', en: 'Irbid' }, { ar: 'الزرقاء', en: 'Zarqa' }, { ar: 'العقبه', en: 'Aqaba' }, { ar: 'بيروت', en: 'Beirut' }, { ar: 'طرابلس', en: 'Tripoli' }, { ar: 'صيدا', en: 'Sidon' }, { ar: 'بغداد', en: 'Baghdad' }, { ar: 'البصره', en: 'Basra' }, { ar: 'الموصل', en: 'Mosul' }, { ar: 'اربيل', en: 'Erbil' }, { ar: 'النجف', en: 'Najaf' }, { ar: 'كربلاء', en: 'Karbala' },
  { ar: 'القاهره', en: 'Cairo' }, { ar: 'الاسكندريه', en: 'Alexandria' }, { ar: 'الجيزه', en: 'Giza' }, { ar: 'المنصوره', en: 'Mansoura' }, { ar: 'طنطا', en: 'Tanta' }, { ar: 'اسوان', en: 'Aswan' }, { ar: 'الاقصر', en: 'Luxor' }, { ar: 'الخرطوم', en: 'Khartoum' }, { ar: 'صنعاء', en: "Sana'a" }, { ar: 'عدن', en: 'Aden' }, { ar: 'تعز', en: 'Taiz' },
  { ar: 'الدار البيضاء', en: 'Casablanca' }, { ar: 'الرباط', en: 'Rabat' }, { ar: 'مراكش', en: 'Marrakech' }, { ar: 'فاس', en: 'Fez' }, { ar: 'طنجه', en: 'Tangier' }, { ar: 'تونس', en: 'Tunis' }, { ar: 'صفاقس', en: 'Sfax' }, { ar: 'الجزائر', en: 'Algiers' }, { ar: 'وهران', en: 'Oran' }, { ar: 'بنغازي', en: 'Benghazi' }, { ar: 'مصراته', en: 'Misrata' },
  { ar: 'اسطنبول', en: 'Istanbul' }, { ar: 'انقره', en: 'Ankara' }, { ar: 'ازمير', en: 'Izmir' }, { ar: 'غازي عنتاب', en: 'Gaziantep' }, { ar: 'بورصه', en: 'Bursa' }, { ar: 'مرسين', en: 'Mersin' },
  { ar: 'لندن', en: 'London' }, { ar: 'مانشستر', en: 'Manchester' }, { ar: 'برمنغهام', en: 'Birmingham' }, { ar: 'ليدز', en: 'Leeds' }, { ar: 'ليفربول', en: 'Liverpool' }, { ar: 'غلاسكو', en: 'Glasgow' }, { ar: 'ادنبره', en: 'Edinburgh' }, { ar: 'بريستول', en: 'Bristol' }, { ar: 'شيفيلد', en: 'Sheffield' }, { ar: 'كارديف', en: 'Cardiff' }, { ar: 'بلفاست', en: 'Belfast' }, { ar: 'نوتنغهام', en: 'Nottingham' }, { ar: 'ليستر', en: 'Leicester' }, { ar: 'كوفنتري', en: 'Coventry' }, { ar: 'برادفورد', en: 'Bradford' }, { ar: 'نيوكاسل', en: 'Newcastle' }, { ar: 'لوتون', en: 'Luton' }, { ar: 'ريدينغ', en: 'Reading' }, { ar: 'اكسفورد', en: 'Oxford' }, { ar: 'كامبريدج', en: 'Cambridge' }, { ar: 'دبلن', en: 'Dublin' },
  { ar: 'برلين', en: 'Berlin' }, { ar: 'هامبورغ', en: 'Hamburg' }, { ar: 'ميونخ', en: 'Munich' }, { ar: 'كولونيا', en: 'Cologne' }, { ar: 'فرانكفورت', en: 'Frankfurt' }, { ar: 'شتوتغارت', en: 'Stuttgart' }, { ar: 'دوسلدورف', en: 'Düsseldorf' }, { ar: 'باريس', en: 'Paris' }, { ar: 'مارسيليا', en: 'Marseille' }, { ar: 'ليون', en: 'Lyon' }, { ar: 'بروكسل', en: 'Brussels' }, { ar: 'امستردام', en: 'Amsterdam' }, { ar: 'روتردام', en: 'Rotterdam' }, { ar: 'ستوكهولم', en: 'Stockholm' }, { ar: 'غوتنبرغ', en: 'Gothenburg' }, { ar: 'مالمو', en: 'Malmö' }, { ar: 'اوسلو', en: 'Oslo' }, { ar: 'كوبنهاغن', en: 'Copenhagen' }, { ar: 'هلسنكي', en: 'Helsinki' }, { ar: 'فيينا', en: 'Vienna' }, { ar: 'زيورخ', en: 'Zurich' }, { ar: 'جنيف', en: 'Geneva' }, { ar: 'مدريد', en: 'Madrid' }, { ar: 'برشلونه', en: 'Barcelona' }, { ar: 'روما', en: 'Rome' }, { ar: 'ميلانو', en: 'Milan' }, { ar: 'اثينا', en: 'Athens' }, { ar: 'وارسو', en: 'Warsaw' }, { ar: 'براغ', en: 'Prague' }, { ar: 'بودابست', en: 'Budapest' }, { ar: 'لشبونه', en: 'Lisbon' },
  { ar: 'نيويورك', en: 'New York' }, { ar: 'لوس انجلوس', en: 'Los Angeles' }, { ar: 'شيكاغو', en: 'Chicago' }, { ar: 'هيوستن', en: 'Houston' }, { ar: 'ديترويت', en: 'Detroit' }, { ar: 'ديربورن', en: 'Dearborn' }, { ar: 'تورونتو', en: 'Toronto' }, { ar: 'مونتريال', en: 'Montreal' }, { ar: 'فانكوفر', en: 'Vancouver' }, { ar: 'اوتاوا', en: 'Ottawa' }, { ar: 'كالغاري', en: 'Calgary' }, { ar: 'سيدني', en: 'Sydney' }, { ar: 'ملبورن', en: 'Melbourne' }, { ar: 'كوالالمبور', en: 'Kuala Lumpur' }, { ar: 'جاكرتا', en: 'Jakarta' }, { ar: 'اسلام اباد', en: 'Islamabad' }, { ar: 'كراتشي', en: 'Karachi' }, { ar: 'لاهور', en: 'Lahore' },
];
/** The city as the user wrote it when it is a known city, otherwise what follows "في"/"in" when it looks like a place. */
export function detectCity(text: string, lang: SiteLang): string | null {
  const norm = normalize(text);
  for (const city of CITIES) {
    const arabic = normalize(city.ar);
    if (new RegExp(`(?:^|\\s)(?:في|ب|بمدينه|مدينه|من|الي|الى)\\s*(?:مدينه\\s+)?(?:ال)?${escapeRegExp(arabic.replace(/^ال/, ''))}(?![\\p{L}])`, 'u').test(norm) || new RegExp(`(?:^|\\s)${escapeRegExp(arabic)}(?![\\p{L}])`, 'u').test(norm) && /(?:في|ب|مدينه)\s/.test(norm)) {
      const original = text.match(new RegExp(`(ال)?${escapeRegExp(city.ar)}`, 'u'));
      return lang === 'ar' ? (original ? original[0] : city.ar) : city.en;
    }
    if (new RegExp(`(?:^|\\s)(?:in|at|from|near|around|based in)\\s+${escapeRegExp(city.en.toLocaleLowerCase())}(?![a-z])`, 'u').test(norm) || new RegExp(`(?:^|\\s)${escapeRegExp(city.en.toLocaleLowerCase())}(?![a-z])`, 'u').test(norm) && /\b(?:in|based)\b/.test(norm)) return lang === 'en' ? city.en : city.ar;
  }
  const explicit = text.match(/(?:بمدينة|مدينة|city of|in the city of)\s+([\p{L}][\p{L}\s'-]{1,30}?)(?=[\s,،.؟!]|$)/u);
  return explicit ? explicit[1]!.trim() : null;
}

const NAME_STOP = '(?:في|بـ|ب|رقم|رقمي|رقمنا|هاتف|هاتفي|جوال|جوالي|موبايل|واتساب|واتس|البريد|ايميل|الموقع|وعنوان|عنوان|والرقم|والهاتف|,|،|\\.|؟|\\?|!|$)';
const NAME_PATTERNS: readonly RegExp[] = [
  /[«"“”„]([^»"“”„]{2,60})[»"“”„]/u,
  /(?:^|\s)[‘'’]([^‘'’]{2,60})[‘'’](?=[\s,،.؟!]|$)/u,
  new RegExp(`(?:اسمه|اسمها|اسمهم|باسم|يسمي|تسمي|يدعي|تدعي|اسم (?:المطعم|الشركه|العياده|المتجر|المكتب|المحل|الصالون|المركز|النشاط|المشروع|الموقع)|الاسم)\\s*[:：]?\\s*((?:(?!${NAME_STOP}\\s)[^\\s,،.؟?!]+\\s*){1,4})`, 'u'),
  /(?:called|named|name is|name:|titled|under the name|brand(?:ed)? as)\s+((?:(?!(?:in|at|phone|whatsapp|number|email|located|based|,|\.|$)\s)[^\s,.!?]+\s*){1,4})/iu,
];
const KIND_NOUN_NAME = new RegExp(`(?:^|\\s)(?:ل|لـ)(?:مطعم|كافيه|مقهي|عياده|شركه|متجر|مكتب|محل|صالون|مركز|مخبز|مدرسه|معهد|بوتيك|مغسله|ورشه|مؤسسه|معرض|عمل|نشاط|مشروع|علامه)\\s+((?:(?!${NAME_STOP}\\s)[^\\s,،.؟?!]+\\s*){1,4})`, 'u');
const EN_CAP = "[A-Z][\\w'’-]*";
/** "for my plumbing business Swift Plumbing in Manchester", "for Bright Dental clinic", "for Harbour Accounting in Bristol". */
const EN_KIND_NOUN_NAME = new RegExp(`\\b(?:for|of)\\s+(?:(?:my|our|a|an|the|new)\\s+)?(?:[a-z][\\w-]*\\s+){0,3}(${EN_CAP}(?:\\s+(?:${EN_CAP}|&|and|of|the))*)`, 'u');
const NAME_REJECT = /^(?:موقع|موقعا|موقعاً|صفحه|صفحة|جديد|جديدا|جديداً|الكتروني|إلكتروني|احترافي|بسيط|كامل|website|site|page|new|a|an|the|my|our)$/iu;

/** The business name only when the sentence states it; never guessed from the kind. */
export function detectName(text: string, kindWord?: string | null): string | null {
  const cleanup = (value: string) => value.trim().replace(/^[\s:：\-–—]+|[\s,،.؟?!:：\-–—]+$/gu, '').replace(/\s+/g, ' ');
  const candidates: string[] = [];
  for (const pattern of NAME_PATTERNS) { const match = text.match(pattern); if (match?.[1]) candidates.push(match[1]); }
  const kinded = text.match(KIND_NOUN_NAME); if (kinded?.[1]) candidates.push(kinded[1]);
  const english = text.match(EN_KIND_NOUN_NAME); if (english?.[1]) candidates.push(english[1]);
  for (const candidate of candidates) {
    const name = cleanup(candidate).replace(/\s+(?:and|of|the|&)$/iu, '');
    if (name.length < 2 || name.length > 80 || NAME_REJECT.test(name)) continue;
    if (kindWord && normalize(name) === normalize(kindWord)) continue;
    if (detectKind(name) && name.split(' ').length === 1) continue;
    if (/^(?:في|in|at)\s/u.test(name)) continue;
    // A capitalised city after "for" is a place, not a name ("a website for Manchester").
    if (CITIES.some(city => normalize(city.en) === normalize(name) || normalize(city.ar) === normalize(name))) continue;
    return name;
  }
  return null;
}

/** Sections and pages the sentence asks for by name; each one is content the planner must collect, never invent. */
const REQUEST_WORDS: readonly { want: SiteWant; words: readonly string[] }[] = [
  { want: 'team', words: ['فريق', 'فريقنا', 'فريق العمل', 'الطاقم', 'اطباء', 'الاطباء', 'موظفين', 'الموظفين', 'الكادر', 'team', 'our team', 'staff', 'doctors', 'our people', 'members'] },
  { want: 'faq', words: ['اسئله شائعه', 'اسئله متكرره', 'الاسئله الشائعه', 'الاسئله', 'اسئله واجوبه', 'faq', 'faqs', 'frequently asked', 'questions and answers', 'q&a'] },
  { want: 'pricing', words: ['اسعار', 'الاسعار', 'باقات', 'الباقات', 'اشتراكات', 'الاشتراكات', 'خطط', 'الخطط', 'عروض الاسعار', 'قائمه اسعار', 'pricing', 'prices', 'price list', 'plans', 'packages', 'subscriptions', 'rates'] },
  { want: 'projects', words: ['مشاريع', 'مشاريعنا', 'المشاريع', 'سابقه اعمال', 'سابقة اعمال', 'اعمالنا السابقه', 'دراسات حاله', 'projects', 'our projects', 'case studies', 'past work', 'previous work'] },
  { want: 'about', words: ['من نحن', 'عنا', 'عننا', 'قصتنا', 'نبذه', 'نبذه عنا', 'تعريف', 'about us', 'about page', 'our story', 'who we are'] },
  { want: 'features', words: ['مميزات', 'المميزات', 'ميزات', 'لماذا نحن', 'لماذا تختارنا', 'ما يميزنا', 'نقاط القوه', 'features', 'why us', 'why choose us', 'benefits', 'advantages', 'what makes us'] },
  { want: 'steps', words: ['كيف نعمل', 'خطوات', 'الخطوات', 'طريقه العمل', 'اليه العمل', 'مراحل', 'how it works', 'our process', 'steps', 'how we work', 'the process'] },
  { want: 'facts', words: ['ارقام', 'الارقام', 'انجازات', 'الانجازات', 'احصائيات', 'الاحصائيات', 'stats', 'statistics', 'numbers', 'achievements', 'milestones', 'figures'] },
  { want: 'testimonials', words: ['اراء', 'الاراء', 'اراء العملاء', 'تقييمات', 'التقييمات', 'شهادات', 'الشهادات', 'توصيات', 'reviews', 'testimonials', 'feedback', 'what clients say'] },
  { want: 'posts', words: ['مدونه', 'المدونه', 'اخبار', 'الاخبار', 'مقالات', 'المقالات', 'نصائح', 'blog', 'news', 'articles', 'posts', 'tips', 'updates'] },
  { want: 'hours', words: ['ساعات العمل', 'اوقات العمل', 'الدوام', 'مواعيد العمل', 'opening hours', 'opening times', 'working hours', 'business hours'] },
];
const FORM_WORDS = /(?:نموذج|استماره|استمارة|فورم|form|contact form|booking form|enquiry form|inquiry form)/u;
const MAP_WORDS = /(?:خريطه|خرائط|موقعنا علي الخريطه|map|maps|location map|directions)/u;
const GALLERY_WORDS = /(?:معرض صور|معرض الصور|البوم|صور|الصور|gallery|photos|photo gallery|pictures|images)/u;
const SINGLE_PAGE = /(?:صفحه واحده|صفحة واحدة|بصفحه واحده|one page|one-page|single page|single-page|onepage)/u;
const BILINGUAL = /(?:لغتين|بلغتين|عربي وانجليزي|عربي و انجليزي|انجليزي وعربي|العربيه والانجليزيه|bilingual|two languages|arabic and english|english and arabic)/u;
export interface SiteRequests { wants: SiteWant[]; form: boolean; map: boolean; gallery: boolean; singlePage: boolean; bilingual: boolean }
export function detectRequests(text: string): SiteRequests {
  const norm = normalize(text);
  const wants: SiteWant[] = [];
  for (const entry of REQUEST_WORDS) if (entry.words.some(word => wordPattern(word).test(norm))) wants.push(entry.want);
  return { wants, form: FORM_WORDS.test(norm), map: MAP_WORDS.test(norm), gallery: GALLERY_WORDS.test(norm), singlePage: SINGLE_PAGE.test(norm), bilingual: BILINGUAL.test(norm) };
}

/** Everything the sentence itself states. Nothing is inferred beyond kind, language and the detected words. */
export function siteSentence(text: string): SitePartialBrief | null {
  if (!isSiteRequest(text)) return null;
  const lang: SiteLang = requestedLang(text) ?? detectLang(text);
  const kind = detectKind(text);
  const name = detectName(text, kind?.word);
  const city = detectCity(text, lang) ?? undefined;
  const numbers = findNumbers(text);
  const whatsapp = numbers.find(number => number.whatsapp)?.digits;
  const phone = numbers.find(number => !number.whatsapp)?.digits;
  const email = findEmail(text) ?? undefined;
  const url = findUrl(text) ?? undefined;
  const colour = colourFromWord(text);
  const requests = detectRequests(text);
  const kindReason = kind ? (lang === 'ar' ? `ذكرتَ كلمة «${kind.word}»` : `you mentioned "${kind.word}"`) : undefined;
  return {
    lang,
    ...(kind ? { kind: kind.kind, kindReason } : {}),
    ...(name ? { name } : {}),
    ...(city ? { city } : {}),
    ...(phone ? { phone } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    ...(email ? { email } : {}),
    ...(url ? { url } : {}),
    ...(colour ? { primary: colour.hex, colourWord: colour.word } : {}),
    requested: requests.wants,
    skipped: [],
    ...(requests.singlePage ? { singlePage: true } : {}),
    rounds: 0,
  };
}
