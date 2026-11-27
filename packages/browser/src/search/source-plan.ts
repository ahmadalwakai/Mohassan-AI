import type { DocumentedProvider } from './providers.js';
import { compileQuery, webFreshnessText } from './ranking.js';

export type SourceDomain = 'news' | 'health' | 'official_statistics' | 'government' | 'programming' | 'scholarly' | 'religion' | 'language' | 'travel' | 'encyclopedia' | 'general_web';

export interface SourcePlan {
  explicitSites: string[];
  excludedSites: string[];
  domains: SourceDomain[];
  language: 'ar' | 'en';
  fresh: boolean;
  reasons: { ar: string; en: string }[];
}

export interface PlannedProviderInfo {
  domains: SourceDomain[];
  languages: ('ar' | 'en')[];
  access: 'documented_api' | 'feed' | 'opensearch' | 'sitemap';
  contract: { url: string; checked: string };
  hosts: string[];
}

export type PlannedProvider = DocumentedProvider & { planned: PlannedProviderInfo };

type Language = SourcePlan['language'];
type Reason = SourcePlan['reasons'][number];
type Site = { aliases: readonly string[]; official: string | Record<Language, string>; checked: string; news?: true };

// Official public destinations verified live. A registry match identifies the
// requested host. The provider's access contract separately governs search.
const sites: readonly Site[] = [
  { aliases: ['wikipedia', 'ويكيبيديا', 'ويكبيديا'], official: 'https://www.wikipedia.org/', checked: '2026-11-27' },
  { aliases: ['al jazeera', 'aljazeera', 'الجزيرة', 'الجزيره'], official: { ar: 'https://www.aljazeera.net/', en: 'https://www.aljazeera.com/' }, checked: '2026-11-27', news: true },
  { aliases: ['al jazeera english', 'الجزيرة الانجليزية'], official: 'https://www.aljazeera.com/', checked: '2026-11-27', news: true },
  { aliases: ['youtube', 'يوتيوب', 'اليوتيوب'], official: 'https://www.youtube.com/howyoutubeworks/', checked: '2026-11-27' },
  { aliases: ['who', 'world health organization', 'world health organisation', 'منظمة الصحة العالمية'], official: 'https://www.who.int/', checked: '2026-11-27' },
  { aliases: ['bbc', 'bbc news', 'بي بي سي'], official: { ar: 'https://www.bbc.com/arabic', en: 'https://www.bbc.co.uk/news' }, checked: '2026-11-27', news: true },
  { aliases: ['bbc arabic', 'bbc news arabic'], official: 'https://www.bbc.com/arabic', checked: '2026-11-27', news: true },
  { aliases: ['the guardian', 'guardian', 'الغارديان', 'الجارديان'], official: 'https://www.theguardian.com/international', checked: '2026-11-27', news: true },
  { aliases: ['sky news arabia', 'سكاي نيوز عربية', 'سكاي نيوز العربية', 'سكاي نيوز'], official: 'https://www.skynewsarabia.com/', checked: '2026-11-27', news: true },
  { aliases: ['stack overflow', 'stackoverflow', 'stack exchange', 'ستاك اوفر فلو', 'ستاك اكستشينج'], official: 'https://stackoverflow.com/questions', checked: '2026-11-27' },
  { aliases: ['hacker news', 'هاكر نيوز'], official: 'https://news.ycombinator.com/', checked: '2026-11-27' },
  { aliases: ['arxiv', 'اركسايف'], official: 'https://arxiv.org/', checked: '2026-11-27' },
  {
    aliases: ['saudi ministry of health', 'saudi arabian ministry of health', 'وزارة الصحة السعودية', 'وزارة الصحة السعوديه', 'وزارة الصحة في السعودية', 'وزارة الصحة', 'وزاره الصحه', 'ministry of health'],
    official: 'https://www.moh.gov.sa/pages/default.aspx',
    checked: '2026-11-27',
  },
];

const fold = (text: string) => text.replace(/[أإآٱ]/gu, 'ا').replace(/[\p{M}\p{Cf}ـ]/gu, '').toLowerCase();
const aliases = new Map(sites.flatMap(site => site.aliases.map(alias => [fold(alias), site] as const)));
const aliasPattern = (values: string[]) => values.sort((a, b) => b.length - a.length).map(alias => alias.replaceAll(' ', '\\s+')).join('|');
const hostLabel = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
const hostname = String.raw`(?:${hostLabel}\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})`;
const start = String.raw`(?<![\p{L}\p{N}@._-])`;
const hostEnd = String.raw`(?=$|[\s/?:!؟،,;؛)\]»”"'#]|\.(?![a-z0-9.-]))`;
const nameEnd = String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`;
const url = String.raw`(?:https?://)?${hostname}${hostEnd}(?:/[^\s"»”<>؟،;؛]*)?`;
const named = String.raw`(?:${aliasPattern([...aliases.keys()])})${nameEnd}`;
const outlet = String.raw`(?:${aliasPattern([...aliases].filter(([, site]) => site.news).map(([alias]) => alias))})${nameEnd}`;
const headlines = String.raw`(?:news|headlines|اخبار|انباء|عناوين)`;
const operand = String.raw`(?:"(?:${url}|${named})"|«(?:${url}|${named})»|“(?:${url}|${named})”|${url}|${named})`;
const negative = String.raw`(?:not(?:\s+(?:from|on|using))?|without|excluding|exclude|except|avoid|don['’]t\s+use|do\s+not\s+use|من\s+غير|بدون|باستثناء|عدا|تجنب|غير|لا\s+(?:تستخدم|تستعمل|تعتمد\s+على|تبحث\s+(?:في|على)))`;
const positive = String.raw`(?:according\s+to|from|on|via|in|within|search(?:\s+(?:on|in))?|(?:في|على|عبر|داخل|من|حسب|بحسب|وفقا\s+ل|ابحث|فتش))`;
const siteWord = String.raw`(?:(?:the\s+)?(?:website|site|platform|channel)(?:\s+of)?|(?:موقع|منصة|منصه|قناة|قناه|موسوعة|موسوعه))\s+`;
const quote = String.raw`"[^"]*"|«[^»]*»|“[^”]*”`;
const genericMinistry = /^(?:وزارة الصحة|وزاره الصحه|ministry of health)$/u;
const ministryQualifier = /^\s+(?!(?:عن|حول|for|about|and|or|او|و)(?!\p{L}))\p{L}/u;
// These filename suffixes are outside the DNS root list:
// https://data.iana.org/TLD/tlds-alpha-by-domain.txt (checked 2026-11-27).
const fileSuffix = /\.(?:js|mjs|cjs|jsx|ts|tsx|json)$/u;

interface SiteMention { host: string; excluded: boolean; inferred: boolean; start: number; end: number }

function siteMentions(text: string, language: Language): SiteMention[] {
  // Map the folded scan back to the original text, preserving spelling and
  // vowel marks in the actual search terms.
  const positions: number[] = [];
  const scanned = text.replace(/[\s\S]/gu, (character, at: number) => {
    const value = fold(character);
    for (let offset = 0; offset < value.length; offset++) positions.push(at);
    return value;
  });
  positions.push(text.length);
  const mentions: SiteMention[] = [];
  const scan = new RegExp(String.raw`${start}(?:
    (?<minus>-)?site:(?<scoped>${hostname})${hostEnd}|
    (?:(?<negative>${negative})|${positive})\s+(?:${siteWord}|the\s+)?(?<operand>${operand})|
    (?<label>${named})(?=\s*[:：])\s*[:：]|
    (?<headlinePrefix>${headlines}\s+)(?<leadingOutlet>${outlet})|
    (?<trailingOutlet>${outlet})(?=\s+${headlines}${nameEnd})|
    (?<bare>${url})
  )|${quote}`.replaceAll(/\n\s*/gu, ''), 'gu');
  const continuation = new RegExp(String.raw`\s*(?:[,،](?:\s*(?:and|or|و|او)\s+)?|\s+(?:and|or|او)\s+|\s+و\s*)\s*(?:${siteWord})?(?<operand>${operand})`, 'uy');
  const add = (value: string, result: RegExpExecArray, excluded: boolean, scoped = false, keep = 0): boolean => {
    const name = value.replace(/^["«“]|["»”]$/gu, '').replace(/\s+/g, ' ');
    const site = aliases.get(name);
    const inferred = Boolean(site && genericMinistry.test(name));
    const end = result.index + result[0].length;
    if (inferred && ministryQualifier.test(scanned.slice(end))) return false;
    if (name === 'who' && /^search\s+who$/u.test(result[0]) && !/WHO$/u.test(text.slice(positions[result.index], positions[end]))) return false;
    const host = site ? new URL(typeof site.official === 'string' ? site.official : site.official[language]).hostname
      : name.replace(/^https?:\/\//u, '').split('/')[0]!;
    // Ordinary unqualified filenames and technology names (such as Node.js)
    // are search subjects. An explicit site scope or URL remains authoritative.
    if (!scoped && fileSuffix.test(host) && !/^https?:\/\//u.test(name)) return false;
    mentions.push({ host: site ? host.replace(/^www\./u, '') : host, excluded, inferred, start: positions[result.index + keep]!, end: positions[end]! });
    return true;
  };
  for (let result = scan.exec(scanned); result; result = scan.exec(scanned)) {
    const { minus, scoped, negative: exclusion, operand: value, label, headlinePrefix, leadingOutlet, trailingOutlet, bare } = result.groups!;
    const target = scoped ?? value ?? label ?? leadingOutlet ?? trailingOutlet ?? bare;
    if (target === undefined || !add(target, result, Boolean(minus || exclusion), Boolean(scoped), headlinePrefix?.length)) continue;
    // A source list shares the first source cue: “from WHO and Wikipedia”.
    if (bare) continue;
    continuation.lastIndex = scan.lastIndex;
    for (let next = continuation.exec(scanned); next; next = continuation.exec(scanned)) {
      if (!add(next.groups!.operand!, next, Boolean(minus || exclusion))) break;
      scan.lastIndex = continuation.lastIndex;
    }
  }
  return mentions;
}

function inspect(question: string) {
  const text = question.normalize('NFKC');
  const language: Language = /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';
  const mentions = siteMentions(text, language);
  let topic = '', end = 0;
  for (const mention of mentions) {
    topic += text.slice(end, mention.start) + ' ';
    end = mention.end;
  }
  topic += text.slice(end);
  if (mentions.length) {
    topic = topic.trim()
      .replace(/^(?:please\s+|من فضلك\s+)?(?:search|find(?:\s+out)?|ابحث|أبحث|فتش)(?=\s|$)\s*/iu, '')
      .replace(/^(?:for|about|عن|حول)(?=\s|$)\s*/iu, '')
      .replace(/(?:^|\s)(?:and|or|و|او|أو)(?=[\s,،;؛:!?؟.]*$)/iu, '')
      .replace(/[\s,،;؛:]+(?=[!?؟.]?$)/u, '')
      .replace(/"[^"]*"|«[^»]*»|“[^”]*”|\s+/gu, match => /^["«“]/u.test(match) ? match : ' ')
      .replace(/\s+([!?؟.])$/u, '$1');
    if (!/[\p{L}\p{N}]/u.test(topic)) topic = '';
  }
  return { language, mentions, topic };
}

/** Keep the subject and quoted phrases separate from the plan's site constraints. */
export function sourceSearchText(question: string): string {
  return inspect(question).topic;
}

const domainRules: readonly { domain: SourceDomain; clue: RegExp; reason: Reason }[] = [
  {
    domain: 'news',
    clue: /\b(?:news|headlines|breaking|live\s+updates?|press\s+coverage)\b|(?<!\p{L})و?(?:ال)?(?:اخبار|انباء|مستجدات|عاجل|عناوين الصحف|تغطية اخبارية)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب أخبارًا أو مستجدات', en: 'the question asks for news or updates' },
  },
  {
    domain: 'health',
    clue: /\b(?:health|medical|medicine|symptoms?|diagnos(?:is|e|tic)|treatments?|therap(?:y|ies)|diseases?|vaccin\w*|surgery|medications?|side effects?|diabetes|cancer|cataracts?|flu|influenza|fever)\b|(?<!\p{L})و?(?:ال)?(?:صحة|صحي|صحية|طبي|طبية|مرض|امراض|اعراض|تشخيص|علاج|دواء|ادوية|لقاح(?:ات)?|تطعيم(?:ات)?|جراحة|سكري|سرطان|حمى|انفلونزا|المياه البيضاء|(?:تاثيرات|اثار) جانبية)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب معلومات صحية', en: 'the question asks for health information' },
  },
  {
    domain: 'official_statistics',
    clue: /\b(?:official (?:figures|data|statistics)|statistics|census|gdp|population|unemployment|inflation|poverty rate|how many people live)\b|(?<!\p{L})و?(?:ال)?(?:احصا(?:ء|ءات|ئي|ئية)|تعداد|ناتج محلي|بطالة|تضخم|عدد (?:ال)?سكان(?:ها|ه)?|ارقام رسمية|بيانات رسمية|معدل (?:ال)?فقر)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب أرقامًا أو إحصاءات', en: 'the question asks for figures or statistics' },
  },
  {
    domain: 'government',
    clue: /\b(?:government|ministry|passport|tax(?:es|ation)?|regulations?|embass(?:y|ies)|benefit application|visa requirements?|visa fees?)\b|(?<!\p{L})و?(?:ال)?(?:حكومة|حكومي|حكومية|وزارة|سفارة|قنصلية|جواز(?: السفر)?|ضرائب|ضريبة|لوائح|تشريع|تاشيرة)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب معلومات أو خدمات حكومية', en: 'the question asks about government information or services' },
  },
  {
    domain: 'programming',
    clue: /\b(?:programming|software (?:development|docs)|documentation|java(?:script)?|typescript|node(?:\.js)?|react|python|postgresql|api|css|sql|stack trace|source code|code examples?|compiler)\b|(?<!\p{L})و?(?:ال)?(?:برمجة|برمجي|برمجية|برمجيات|كود|شفرة مصدرية|توثيق تقني|جافاسكريبت|بايثون)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب معلومات برمجية', en: 'the question asks about programming' },
  },
  {
    domain: 'scholarly',
    clue: /\b(?:research(?: papers?| studies)?|peer.reviewed|doi|systematic review|(?:academic|scholarly) (?:articles?|journals?|papers?|sources?)|journal articles?|(?:papers?|studies) (?:about|on|of))\b|(?<!\p{L})و?(?:ال)?(?:بحث علمي|ابحاث|دراسة علمية|دراسات|دراسة (?:عن|حول)|اوراق علمية|ورقة علمية|مجلة علمية|محكمة)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب دراسات أو منشورات علمية', en: 'the question asks for research or scholarly publications' },
  },
  {
    domain: 'religion',
    clue: /\b(?:qur['’]?an|koran|hadith|fatwa|tafsir|bible|torah|religious ruling|prayer times?)\b|(?<!\p{L})و?(?:ال)?(?:قران|حديث نبوي|احاديث نبوية|فتوى|فتاوى|فقه|تفسير اية|سورة|حكم شرعي|حكم (?:ال)?(?:صيام|صلاة|زكاة)|مواقيت الصلاة|انجيل)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب نصًا أو مرجعًا دينيًا', en: 'the question asks for a religious text or reference' },
  },
  {
    domain: 'language',
    clue: /\b(?:dictionary|pronunciation|pronounce|etymology|synonyms?|antonyms?|grammar|spell(?:ing)?|meaning of (?:the )?(?:word|phrase)|translate|translation)\b|(?<!\p{L})و?(?:ال)?(?:قاموس|معجم|مرادف|مرادفات|معنى (?:كلمة|كلمه|عبارة)|اصل كلمة|نطق كلمة|ترجمة|قواعد (?:ال)?لغة|اعراب|املاء)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب معنى لغويًا أو استعمال كلمة', en: 'the question asks about language or word usage' },
  },
  {
    domain: 'travel',
    clue: /\b(?:travel|flights?|trains?|ferr(?:y|ies)|hotels?|tourism|tourist|visa|(?:best|time) to visit|(?:bus|rail) tickets?)\b|(?<!\p{L})و?(?:ال)?(?:سفر|سياحة|سياحي|سياحية|طيران|رحلات|رحلة|قطار|قطارات|فندق|فنادق|تاشيرة|زيارة سياحية|افضل وقت لزيارة)(?!\p{L})/u,
    reason: { ar: 'السؤال يطلب معلومات عن السفر أو التنقل', en: 'the question asks about travel or transport' },
  },
];

const encyclopedic = /^(?:definition of|what (?:is|are|was|were)|what['’]s|who (?:is|are|was|were|wrote|invented|founded|discovered)|when (?:did|was|were)|where (?:is|are|was|were)|why|history of|ما|ماهو|ماهي|ماذا|من (?:هو|هي|كتب|الف|اسس|اخترع|اكتشف)|متى|اين|وين|لماذا|ليش|ليه|تاريخ)(?=\s|$)|\b(?:capital(?: city)? of|biograph\w*|height of|geography)\b|(?<!\p{L})(?:ال)?(?:عاصمة|ارتفاع|مساحة|سيرة ذاتية|جغرافيا)(?!\p{L})/u;
const generalWeb = /\b(?:(?:general|public) web|online|internet|reviews?|official (?:site|website)|compare|where to buy|how to|weather|forecast)\b|(?<!\p{L})(?:مراجعات|مقارنة|طقس|كيف|(?:ال)?ويب|(?:ال)?انترنت|موقع رسمي)(?!\p{L})/u;
const recent = /\b(?:tomorrow|tonight|recent(?:ly)?|this (?:week|month|year)|breaking|live updates?|forecast|as of now)\b|(?<!\p{L})(?:غدا|بكرة|الليلة|مؤخرا|عاجل|هذا (?:الاسبوع|الشهر|العام)|مستجدات)(?!\p{L})/u;
const followUp = /^(?:(?:what about|how about|and|also|tell me more|more details|ماذا عن|مزيد من التفاصيل|ايضا|طيب|طب)(?=\s|[؟?]|$)|و(?=ماذا|متى|اين|كيف|كم|هل|ما|في|غدا|اليوم|بكرة))|\b(?:its|their|his|her)\s+\p{L}|^(?:ما|كم|كيف|هل)\s+\p{L}{2,}(?:ها|ه)(?:\s|[؟?]|$)/u;
const domainReasons: Partial<Record<SourceDomain, Reason>> = {
  encyclopedia: { ar: 'السؤال يطلب حقيقة عامة أو شرحًا موسوعيًا', en: 'the question asks for a general fact or explanation' },
  general_web: { ar: 'السؤال يحتاج إلى صفحات الويب ذات الصلة', en: 'the question calls for relevant web pages' },
};

function topicPlan(topic: string): { domains: SourceDomain[]; fresh: boolean; reasons: Reason[] } {
  const text = fold(webFreshnessText(topic)).trim();
  let timeSensitive = false;
  try { timeSensitive = compileQuery(topic).timeSensitive; } catch { /* A source-only turn can still be planned. */ }
  const fresh = timeSensitive || recent.test(text);
  const rules = domainRules.filter(rule => rule.clue.test(text));
  if (rules.length) return { domains: rules.map(rule => rule.domain), fresh, reasons: rules.map(rule => rule.reason) };
  const domain = fresh || generalWeb.test(text) ? 'general_web' : encyclopedic.test(text) ? 'encyclopedia' : undefined;
  return domain ? { domains: [domain], fresh, reasons: [domainReasons[domain]!] } : { domains: [], fresh, reasons: [] };
}

/** Choose public source families from the owner's wording and bounded user-turn context. */
export function planSources(question: string, recentTurns: readonly string[] = []): SourcePlan {
  const own = inspect(question);
  const contextual = followUp.test(fold(own.topic.trim())) || own.mentions.length > 0 && !/[\p{L}\p{N}]/u.test(own.topic);
  const previous = contextual && recentTurns.length ? inspect(recentTurns[recentTurns.length - 1]!) : undefined;
  const explicit = own.mentions.filter(site => !site.excluded);
  const inherited = previous?.mentions.filter(site => site.excluded || !explicit.length) ?? [];
  const mentions = [...own.mentions, ...inherited];
  const explicitSites = [...new Set(mentions.filter(site => !site.excluded).map(site => site.host))];
  const excludedSites = [...new Set(mentions.filter(site => site.excluded).map(site => site.host))];
  const current = topicPlan(own.topic);
  const topic = previous && !current.domains.length ? topicPlan(previous.topic) : current;
  const reasons: Reason[] = [
    ...explicitSites.map(host => mentions.some(item => item.host === host && item.inferred) ? {
      ar: `فُهم اسم وزارة الصحة دون تحديد الدولة على أنه الوزارة السعودية (${host})`,
      en: `the unqualified Ministry of Health was interpreted as the Saudi ministry (${host})`,
    } : { ar: `طلبت البحث في ${host}`, en: `you requested ${host}` }),
    ...excludedSites.map(host => ({ ar: `طلبت استبعاد ${host}`, en: `you excluded ${host}` })),
    ...topic.reasons,
  ];
  if (!reasons.length) reasons.push({ ar: 'لم يحدد السؤال فئة مصادر بعينها', en: 'the question did not specify a source family' });
  return { explicitSites, excludedSites, domains: topic.domains, language: own.language, fresh: current.fresh || topic.fresh, reasons };
}
