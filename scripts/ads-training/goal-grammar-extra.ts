/**
 * Fourth-round additions to the goal grammar (2026-11-15), written from the v3c model's mistakes
 * on the consumed fourth test (independent-v4). Many frames here follow those test sentences
 * closely, with the values turned into slots, so independent-v4 no longer measures this model:
 * it counts as training material from this round on. Only a fresh test judges the result.
 * The kinds of mistake covered:
 *   - products named by a noun and what they are made of ("linen aprons", "أواني فخارية");
 *   - lessons, classes and workshops of a subject; equipment repairs; "firm" as a container word;
 *   - places given in an order ("first X, then Y"), goals followed by what they are for;
 *   - details promised for later, which are not values;
 *   - requests that mention ads, bookings or a city but do not ask for a new campaign.
 * Slots as in goal-grammar-en.ts. extendPacks() adds them to the packs before any sentence is made.
 */
import type { Pack } from './goal-grammar.js';

const cross = (first: string[], second: string[]) => first.flatMap(a => second.map(b => `${a} ${b}`));

// ---------------------------------------------------------------- English
const EN_MATERIALS = ['linen', 'wooden', 'leather', 'ceramic', 'glass', 'wool', 'cotton', 'silk', 'brass', 'copper', 'bamboo', 'oak', 'marble', 'paper', 'silver', 'steel', 'clay',
  'stone', 'wicker', 'handmade', 'custom', 'bespoke', 'vintage', 'organic', 'hand-painted', 'recycled', 'personalised', 'artisan', 'luxury', 'second-hand', 'wildflower', 'herbal',
  'scented', 'knitted', 'printed', 'engraved', 'reclaimed', 'heated', 'folding', 'waterproof'];
const EN_PRODUCTS = ['aprons', 'lamps', 'candles', 'seeds', 'kits', 'beds', 'sticks', 'bags', 'toys', 'cakes', 'cards', 'frames', 'mugs', 'baskets', 'blankets', 'rugs', 'benches', 'clocks',
  'knives', 'hats', 'scarves', 'soaps', 'plants', 'tents', 'kayaks', 'tools', 'chairs', 'tables', 'shelves', 'planters', 'notebooks', 'puzzles', 'wreaths', 'cushions', 'teas', 'jams',
  'bird houses', 'dog beds', 'cat trees', 'walking sticks', 'growing kits', 'gift boxes', 'picture frames', 'chopping boards', 'tote bags', 'wedding dresses', 'garden sheds', 'bike racks'];
const EN_SUBJECTS = ['accordion', 'handbell', 'embroidery', 'singing', 'pottery', 'fossil', 'kayaking', 'paper marbling', 'surfing', 'climbing', 'chess', 'coding', 'baking', 'violin',
  'drumming', 'archery', 'sailing', 'calligraphy', 'watercolour', 'woodcarving', 'beekeeping', 'fencing', 'ballet', 'salsa', 'karate', 'meditation', 'knitting', 'glassblowing',
  'falconry', 'bushcraft', 'life drawing', 'creative writing', 'public speaking', 'sign language', 'horse riding', 'rock climbing', 'fly fishing', 'stand-up paddle'];
const EN_SESSIONS = ['lessons', 'classes', 'courses', 'workshops', 'tours', 'walks', 'tuition', 'coaching', 'sessions', 'retreats', 'camps', 'club'];
const EN_GEAR = ['equipment', 'gear', 'instrument', 'machine', 'engine', 'boat', 'trailer'];
const EN_JOBS = ['repairs', 'hire', 'sales', 'servicing', 'rental', 'storage', 'restoration'];
const EN_PLACES_OF_WORK = ['laboratory', 'studio', 'clinic', 'agency', 'practice', 'workshop', 'surgery', 'gallery', 'academy', 'nursery', 'kennels', 'brewery', 'bakery', 'dairy'];
const EN_TRADES = ['dental', 'surveying', 'bookkeeping', 'architecture', 'veterinary', 'printing', 'tailoring', 'framing', 'recruitment', 'insurance', 'marketing', 'physio', 'optical',
  'legal', 'engineering', 'joinery', 'upholstery', 'cobbler', 'locksmith', 'tea', 'cheese', 'cider', 'pottery', 'dance', 'music', 'language', 'driving', 'cookery'];
export const EN_SERVICES_EXTRA = [...cross(EN_MATERIALS, EN_PRODUCTS), ...cross(EN_SUBJECTS, EN_SESSIONS), ...cross(cross(EN_SUBJECTS.slice(0, 20), EN_GEAR), EN_JOBS),
  ...cross(EN_TRADES, EN_PLACES_OF_WORK), ...cross(['residential', 'commercial', 'emergency', 'mobile', 'domestic'], ['locksmith work', 'electrical work', 'plumbing work', 'roofing work',
    'building work', 'tree work', 'glazing work', 'drainage work']), ...cross(['guided', 'private', 'family', 'evening', 'weekend'], cross(EN_SUBJECTS.slice(0, 16), ['walks', 'tours', 'lessons', 'classes']))];
/** One-word trades that read naturally before "firm", "business" or "company". */
export const EN_TRADE_WORDS = ['bookkeeping', 'surveying', 'accountancy', 'plumbing', 'roofing', 'landscaping', 'catering', 'cleaning', 'printing', 'tailoring', 'joinery', 'glazing',
  'recruitment', 'removals', 'scaffolding', 'plastering', 'tiling', 'fencing', 'paving', 'haulage', 'security', 'engineering', 'architecture', 'conveyancing', 'upholstery', 'welding'];

export const EN_EXTRA = [
  'Set up new advertising for {S}; {G2} are excluded from our objectives.',
  'Build a search campaign in {L}. Do not optimize it for {G2}.',
  'Create a campaign using {U}. We have ruled out {G2}, and will choose an objective later.',
  'For the new campaign, advertise {S} in {L}. Getting {G2} is not our goal.',
  'Start ads for {U}; no {G2} please, the objective can remain undecided.',
  'Prepare a campaign for {S}. We are not looking for {G2}.',
  'Launch ads for our family {S} in {L}; our objective is {G}.',
  'I need a search campaign for my {S} firm. Target {L} and get {G}.',
  'Make search ads for {S}. Target {L}; I would like {G}.',
  'Use {U} for a new campaign selling {S}, with {M} {P} available.',
  'My {S} needs its first campaign. Use {L} and get {G} via {U}.',
  'Could you create ads around {S} in {L} with a limit of {M} {P}?',
  'Run a new campaign for {S} at {U}, targeting {L}.',
  'Please advertise the family {S} in {L}; we want {G} and can spend {M} {P}.',
  'Could we start a campaign for {S}? Promote them in {L} and seek {G}.',
  'Please start a campaign for {S}, targeting {L} with {G} in mind.',
  'Please launch ads that bring {G}. I will tell you what we sell shortly.',
  'Advertise my {S}; do not target {L2}, use {L}.',
  'Could you arrange a new campaign for my family\'s small {S} in {L}? I want {G} and can spare {M} {P}.',
  'A Google campaign for the {S} would help; include {L}, using {U}.',
  'Make ads for {S} at {U}, reaching {L} with {M} {P}.',
  'Please create a new campaign for my {S} firm in {L}; set a budget of {M} {P} and seek {G}.',
  'Launch a campaign for {S} in {L}; I have got {M} but have not decided the period.',
  'I want new ads for {S}; either {M1} or {M} {P} might work, but I am undecided.',
  'New ads please, for a shop selling {S}. People should end up on {U}.',
  'We make {S} and sell them through {U}. A campaign aimed at {L} is what we are after.',
  'Our {S} company wants to try Google ads. Keep it to {L} and try to win {G}.',
  'Start a campaign that sells {S} to people living near {L}. We hope for {G}.',
  'Could you prepare ads for the {S} we run every weekend in {L}?',
  'There is a {S} I run from home. Please advertise it across {L} for {M} {P}.',
  'I teach {S} and want more pupils from {L}. Please build a campaign; {G} would be ideal.',
  'We repair things: {S} is our trade. Launch ads for {L}, please.',
  'Kindly put a campaign together for {S}; the landing page is {U} and the cap is {M} {P}.',
  'My sister and I run a {S} in {L}. Could you launch Google ads for us before the summer?',
  'Create ads for {S}. Then, once they are live, we will talk about the budget.',
  'I would like a campaign for {S}, shown in {L} and nowhere else, to gain {G}.',
  'Please launch Google ads. What we sell and where will follow tomorrow morning.',
  'Start a new campaign and I will email the website tonight.',
  'A new campaign, please; the goal is {G} and everything else can wait until Monday.',
  'Get a campaign going in {L} for {G}; the link will come later today.',
  'Begin a search campaign for {U}. I will let you know the area after lunch.',
  'We would love {G} from a new campaign. Which service to promote is still under discussion.',
  'Set ads running for {S}; my partner will send you the address of the site this evening.',
  'I need ads for {S} around {L}. Ignore {L2}, we stopped working there.',
  'Run a campaign for {S} with {G} as the target rather than {G2}, in {L}.',
  'Advertise {S} from {U}. The spend was going to be {M1}, but please use {M} {P}.',
  'Could you sort out ads for my {S} business? We are in {L} and happy with {M} {P}.',
  'Ads for {S} would be great. Our customers come from {L}, mostly at weekends.',
  'Please promote our {S}. Bring us {G}, and keep the ads inside {L}.',
  'I have opened a {S} near the station in {L}. Please create a campaign to bring {G}.',
  'Let us advertise {S} to tourists visiting {L}; we can stretch to {M} {P}.',
];
const EN_OTHER_EXTRA = [
  'I would like you to proofread this sentence about {S}', 'please list the search terms from our {M} weekly campaign in {L}',
  'I want a summary of yesterday\'s appointments, not a new advertising campaign', 'I would like a weather forecast for {L} before the weekend',
  'give me a summary of this week\'s calls, not a campaign', 'show the bookings we received in {L} last month', 'which of my campaigns brought the most enquiries?',
  'I need a list of yesterday\'s leads from {L}', 'tell me how many appointments were booked on Monday', 'export the keywords of my {S} campaign',
  'I am not after a new campaign; just compare my two existing ones', 'no campaign needed, only a report on calls from {L}', 'proofread my advert text for {S}',
  'check the spelling of this headline about {S}', 'summarise the reviews of my {S} business', 'what are people in {L} searching for?', 'draft a letter to my customers in {L}',
  'plan my week: meetings in {L} and calls on Friday', 'find the phone number of a {S} in {L}', 'how do I cancel a booking?', 'move my appointment in {L} to Tuesday',
  'in my existing {L} campaign, switch the goal from calls to bookings without creating another', 'duplicate nothing; just tell me why my {S} ads were disapproved',
  'I would like a forecast of next month\'s spend for the {L} campaign', 'rather than a new campaign, send me last week\'s invoice', 'compare the cost of leads in {L} and nearby towns',
  'write three headline ideas about {S} for me to read', 'I only want advice on whether {M} a month is enough', 'what would a campaign for {S} in {L} cost? I am not ordering one',
  'please explain the difference between my two campaigns', 'look up the opening hours of a {S} near {L}', 'I need directions to {L}', 'translate my {S} leaflet into Arabic',
];

// ---------------------------------------------------------------- Arabic
const AR_PRODUCT_NOUNS = ['أواني', 'دفاتر', 'زيوت', 'منتجات', 'حقائب', 'شموع', 'صابون', 'سلال', 'ألعاب', 'مفارش', 'أكواب', 'لوحات', 'كراسي', 'طاولات', 'مصابيح', 'سجاد', 'عباءات', 'إكسسوارات',
  'مجوهرات', 'أحذية', 'قبعات', 'وسائد', 'بطانيات', 'هدايا', 'عطور', 'حلويات', 'مخبوزات', 'معجنات', 'توابل', 'نباتات', 'تحف', 'أثاث', 'ملابس', 'أقمشة', 'مناديل', 'صناديق', 'أساور', 'مرايا',
  'ستائر', 'أغطية'];
const AR_PRODUCT_KINDS = ['فخارية', 'يدوية', 'عطرية', 'جلدية', 'خشبية', 'زجاجية', 'نحاسية', 'قطنية', 'صوفية', 'حريرية', 'طبيعية', 'عضوية', 'منزلية', 'تراثية', 'مطرزة', 'مخصصة', 'فاخرة', 'مستعملة',
  'شرقية', 'شامية', 'مغربية', 'ملونة', 'مزخرفة', 'مستوردة', 'شعبية', 'صحية'];
const AR_PAIRS = ['بيوت طيور', 'أسرّة قطط', 'ألعاب أطفال', 'ملابس مواليد', 'أدوات مطبخ', 'معدات التسلق', 'معدات الغوص', 'لوازم الرحلات', 'قطع الدراجات', 'أدوات الرسم', 'مستلزمات الخياطة',
  'أحواض السمك', 'أقفاص العصافير', 'خيام التخييم', 'أجهزة الرياضة', 'كتب الأطفال', 'ورق الهدايا', 'علب الحلوى', 'باقات الورد', 'عربات الأطفال'];
const AR_SESSIONS = ['دروس', 'تعليم', 'ورش', 'جلسات', 'دورات', 'حصص', 'تدريب'];
const AR_SUBJECTS = ['الرسم الرقمي', 'التزلج', 'التطريز', 'صناعة الجبن', 'الفخار', 'الخط العربي', 'العزف على العود', 'الطبخ', 'التصوير', 'اليوغا', 'السباحة', 'الرسم على الزجاج', 'الخياطة',
  'البرمجة', 'الروبوت', 'الشطرنج', 'ركوب الخيل', 'الغوص', 'التجويد', 'الحياكة', 'صناعة الشموع', 'صناعة الصابون', 'تنسيق الزهور', 'النحت', 'الكاراتيه', 'الباليه', 'الجيتار', 'اللغة الفرنسية',
  'الإسعافات الأولية', 'تربية النحل', 'الزراعة المنزلية', 'تصميم الأزياء', 'المكياج', 'الإلقاء', 'الحساب الذهني'];
const AR_PLACES_OF_WORK = ['مركز يوغا', 'مركز لياقة', 'مركز تدريب', 'محل حلويات', 'محل خياطة', 'محل زهور', 'معمل ألبان', 'مختبر أسنان', 'استوديو تسجيل', 'مرسم أطفال', 'مشغل تطريز', 'مكتب مساحة',
  'مكتب هندسي', 'عيادة تغذية', 'عيادة علاج طبيعي', 'نادي فروسية', 'أكاديمية كرة', 'مطبعة', 'محمصة قهوة', 'معصرة زيتون', 'مصبغة', 'مخبز حلويات', 'مطعم مأكولات بحرية', 'مقهى كتب'];
export const AR_SERVICES_EXTRA = [...cross(AR_PRODUCT_NOUNS, AR_PRODUCT_KINDS), ...cross(AR_PAIRS, ['خشبية', 'يدوية', 'مستعملة', 'ملونة', 'فاخرة']), ...AR_PAIRS, ...cross(AR_SESSIONS, AR_SUBJECTS),
  ...AR_PLACES_OF_WORK, ...cross(['مخبوزات', 'حلويات', 'معجنات', 'وجبات', 'عصائر'], ['خالية من الجلوتين', 'خالية من السكر', 'قليلة الدسم', 'بدون مواد حافظة'])];

export const AR_EXTRA = [
  'جهز إعلانات جديدة عن {S}؛ نستبعد {G2} من أهدافنا.',
  'أنشئ حملة بحث في {L}. لا تجعل هدفها {G2}.',
  'ابدأ حملة تستخدم {U}. استبعدنا {G2} وسنختار الهدف لاحقاً.',
  'أطلق حملة عن {S} في {L}؛ الحصول على {G2} ليس هدفنا.',
  'جهز حملة للموقع {U}؛ بدون {G2}، ونترك الهدف غير محدد.',
  'نحتاج إعلاناً جديداً عن {S}. لسنا بحاجة إلى {G2}.',
  'الموقع {U} جاهز؛ أنشئ حملة عن {S} بميزانية {M} {P}.',
  'اعمل لي حملة على {U} لبيع {S}؛ خلينا نركز على {G}.',
  'ابدأ حملة عن {S}، وخلي الناس تدخل على {U}.',
  'أريد حملة ل{S} في {L}؛ الهدف {G}.',
  'أرغب بحملة عن {S} على {U}؛ أريد {G} من مدينة {L}.',
  'ممكن نبدأ حملة ل{S} في {L} بمصاريف {M} {P}؟',
  'ابدأ إعلانات ل{S}؛ رابطها {U} والميزانية {M} {P}.',
  'هل ممكن تنشئ إعلانات عن {S} في {L}، بهدف {G}؟',
  'ابدأ حملة ل{S} في {L}، وأريد {G}.',
  'حابب حملة عن {S} في {L}، وتكون ل{G}.',
  'اعمل إعلانات عن {S} في {L}، عشان تجيب {G}.',
  'لو سمحت أطلق حملة عن {S} في {L}؛ نسعى ل{G}.',
  'اعمل حملة عن {S} في {L}، والهدف {G}.',
  'أريد حملة إعلانية جديدة، والتفاصيل أرسلها لك في المساء.',
  'عايز حملة تجيب {G}، ونوع النشاط هقولك عليه بكرة.',
  'لو سمحت أنشئ حملة يكون هدفها {G}، والباقي نناقشه لاحقاً.',
  'ممكن تبدأ إعلانات في {L} بهدف {G}؟ الرابط سأرسله فيما بعد.',
  'بدي حملة عن {S}، تستهدف {L} وموقعها {U}.',
  'عايز حملة لخدمة {S} في {L}، تودي الناس على {U}.',
  'بدي إعلانات عن {S} في {L}، مع استخدام {U}.',
  'بدي حملة عن {S} على {U}، تستهدف {L} بميزانية {M} {P}.',
  'أطلق حملة لمتجر {S} في {L}، هدفها {G} وليس {G2}.',
  'ممكن تسوي حملة عن {S} في {L}، بميزانية {M} {P}؟',
  'أنشئ حملة عن {S} صغيرة في {L} بمبلغ {M} {P}.',
  'نصنع {S} ونبيعها عبر {U}. نبغى حملة موجهة إلى {L}.',
  'أنا أدرّس {S} وأبحث عن طلاب من {L}. جهز حملة، ويا ليت تجيب {G}.',
  'عندنا {S} في {L} قرب السوق القديم. اعمل حملة تجيب لنا {G}.',
  'أبغى إعلانات ل{S} حول {L}. اترك {L2} لأننا توقفنا عن العمل هناك.',
  'شغّل حملة عن {S} يكون هدفها {G} بدل {G2}، في {L}.',
  'أعلن عن {S} من {U}. كان المبلغ {M1} لكن خله {M} {P}.',
  'ابدأ حملة جديدة والموقع أرسله لك الليلة.',
  'حملة جديدة لو سمحت؛ الهدف {G} وكل شيء ثاني ننتظر فيه ليوم الأحد.',
  'جهز حملة في {L} عشان {G}؛ والرابط يوصلك بعد شوي.',
  'ابدأ حملة بحث لموقع {U}. المنطقة أخبرك بها بعد الظهر.',
  'نتمنى {G} من حملة جديدة. الخدمة التي نروّج لها ما زالت قيد النقاش.',
  'شغّل إعلانات عن {S}؛ شريكي يرسل لك عنوان الموقع مساءً.',
  'أختي وأنا ندير {S} في {L}. ممكن تطلق لنا إعلانات جوجل قبل الصيف؟',
  'نبي حملة ل{S} تظهر في {L} وبس، عشان نحصل {G}.',
  'عايزين نعلن عن {S} للسياح اللي بيزوروا {L}؛ نقدر ندفع {M} {P}.',
  'لدينا {S} ونرغب بتجربة إعلانات جوجل. خلها على {L} وحاول تجيب {G}.',
  'سوّ حملة تبيع {S} للناس القريبين من {L}. نطمح إلى {G}.',
  'أنشئ إعلانات عن {S}. وبعد ما تشتغل نتكلم عن الميزانية.',
  'محتاج حملة ل{S}، والصفحة المقصودة {U} والحد {M} {P}.',
  'افتتحت {S} جنب المحطة في {L}. أنشئ حملة تجيب {G} لو سمحت.',
];
const AR_OTHER_EXTRA = [
  'أحتاج ملخصاً لمواعيد أمس، وليس إنشاء حملة إعلانية', 'في حملة {L} الحالية، حوّل الهدف من اتصالات إلى حجوزات من غير إنشاء حملة أخرى', 'أعطني ملخص مكالمات هذا الأسبوع، مو حملة',
  'ورني الحجوزات اللي جتنا من {L} الشهر الماضي', 'أي حملة من حملاتي جابت استفسارات أكثر؟', 'أحتاج قائمة باستفسارات أمس من {L}', 'كم موعد انحجز يوم الاثنين؟',
  'صدّر الكلمات المفتاحية لحملة {S}', 'ما أبغى حملة جديدة؛ بس قارن بين حملتيني الحاليتين', 'ما في داعي لحملة، فقط تقرير عن الاتصالات من {L}', 'دقق لي نص إعلان عن {S}',
  'راجع إملاء هذا العنوان عن {S}', 'لخص تقييمات نشاطي في {S}', 'عن ماذا يبحث الناس في {L}؟', 'اكتب رسالة لعملائي في {L}', 'رتب أسبوعي: اجتماعات في {L} ومكالمات يوم الجمعة',
  'هات لي رقم {S} في {L}', 'كيف ألغي حجز؟', 'انقل موعدي في {L} إلى يوم الثلاثاء', 'لا تكرر شيء؛ فقط قل لي لماذا رُفضت إعلانات {S}', 'أبغى توقع لصرف الشهر الجاي لحملة {L}',
  'بدل حملة جديدة، أرسل لي فاتورة الأسبوع الماضي', 'قارن تكلفة الاستفسارات في {L} والمدن القريبة', 'اكتب لي ثلاث أفكار عناوين عن {S} أقرأها', 'أريد فقط نصيحة: هل {M} شهرياً تكفي؟',
  'كم تكلف حملة ل{S} في {L}؟ أنا لا أطلب حملة الآن', 'اشرح لي الفرق بين حملتيّ', 'شوف لي مواعيد دوام {S} قريب من {L}', 'أحتاج توقعات الطقس في {L} قبل نهاية الأسبوع',
  'ترجم منشور {S} إلى الإنجليزية', 'عايز ملخص لحجوزات امبارح مش حملة جديدة', 'بدي تقرير عن اتصالات {L} مش إعلان جديد',
];

/** A rejected objective does not imply a different positive objective. */
export const GOAL_ABSENT = {
  en: ['no {G2} please', 'we do not want {G2}', 'do not optimize for {G2}',
    '{G2} are not our objective', 'we have ruled out {G2}', 'we are not seeking {G2}',
    'exclude {G2} from the objectives', 'we are avoiding {G2}; the objective is still undecided'],
  ar: ['لا نحتاج {G2}', 'لا أريد {G2}', 'ما نبي {G2}', 'مش عايزين {G2}',
    'لا تجعل الهدف {G2}', 'نستبعد {G2} من الأهداف', 'لسنا بحاجة إلى {G2}',
    'بدون {G2}، والهدف لم يتحدد'],
};

/** Adds the fourth-round wording to the packs. Called once, before any sentence is made. */
export function extendPacks(en: Pack, ar: Pack): void {
  en.other.push(...EN_OTHER_EXTRA);
  ar.other.push(...AR_OTHER_EXTRA);
  en.listJoin.push([', then ', ', then '], [' first, then ', ' and then ']);
  ar.listJoin.push([' ثم ', ' ثم '], ['، ثم ', '، ثم ']);
  en.goalNouns.calls.push('calls from local customers', 'calls about our prices');
  en.goalNouns.bookings.push('bookings for our classes', 'reservations for the weekend', 'appointments for new clients');
  en.goalNouns.leads.push('enquiries about prices', 'enquiries from new customers');
  ar.goalNouns.calls.push('اتصالات من الزبائن', 'مكالمات عن الأسعار');
  ar.goalNouns.bookings.push('حجوزات جلسات', 'مواعيد للحصص', 'مواعيد للدورات', 'حجوزات للورش');
  ar.goalNouns.leads.push('استفسارات عن الأسعار', 'استفسارات من عملاء جدد');
  en.inline.service.push('for my {S} firm', 'for our {S} firm', 'selling {S}', 'around {S}', 'for the family {S}', "for my family's small {S}");
  en.clause.service.push('I run a {S} firm', 'we are a {S} firm', 'my {S} firm needs customers', 'we make {S}', 'I teach {S}', 'our family runs a {S}');
  ar.inline.service.push('لبيع {S}', 'عن {S}');
  ar.clause.service.push('نصنع {S}', 'أدرّس {S}', 'نبيع {S} من البيت', 'عندنا {S} صغير');
}
