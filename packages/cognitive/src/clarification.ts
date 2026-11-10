/**
 * Goal, readiness and clarification core. One deterministic engine shared by the
 * production chat (apps/server/src/command-chat.ts), the planning gate in this
 * package and the cognitive lab, which drives the production chat control.
 *
 * It decides with explicit, testable rules. A model may suggest text, but it never
 * decides readiness, permissions or whether a requirement is satisfied. Nothing
 * here grants authority: answers and evidence are data, and every external effect
 * is still gated by the server at its own action boundary.
 *
 * The question score is an explainable heuristic with documented thresholds, not a
 * calibrated probability. See DEFAULT_CLARIFICATION_CONFIG.
 */
import {
  GoalFrameSchema,
  type ChatGoalSummary, type ClarificationAnswerRecord, type ClarificationOutcome, type ClarificationQuestionSpec,
  type EvidenceKind, type EvidenceSource, type GoalDomain, type GoalEvidence, type GoalFrame, type QuestionScore,
  type ReadinessAssessment, type ReadinessReason, type ReadinessStatus, type Requirement, type SlotId, type StepKind, type StepReadiness,
} from '@mohassan/contracts';

export interface ClarificationConfig {
  /**
   * A non-mandatory question is asked only at or above this value. With the weights
   * in scoreQuestion, a high-impact (3) high-risk (3) plan-changing question scores 14
   * before interruption cost; a low-impact (1) low-risk (1) optional one scores 4.
   * 6 therefore asks about required, material gaps and assumes cheap, reversible ones.
   */
  askThreshold: number;
  /** Engine-raised questions per task. Bounds the clarification loop. */
  maxEngineQuestions: number;
  /** Slots grouped into one question when they are related and grouping saves a turn. */
  maxSlotsPerQuestion: number;
  /** Memory older than this is stale: shown as a hint, never reused as the user's current choice. */
  memoryStaleDays: number;
  /** Model `ask_user` questions withheld per run because the answer is already known or was already asked. */
  maxQuestionNudges: number;
}

export const DEFAULT_CLARIFICATION_CONFIG: Readonly<ClarificationConfig> = Object.freeze({
  askThreshold: 6, maxEngineQuestions: 2, maxSlotsPerQuestion: 3, memoryStaleDays: 90, maxQuestionNudges: 2,
});

export interface GoalCapabilities {
  models?: boolean;
  search?: boolean;
  browser?: boolean;
  coding?: boolean;
  /** Owner-only file changes go through the coding engine's approved task. */
  files?: boolean;
  computer?: boolean;
  ads?: boolean;
  adsCreate?: boolean;
  skills?: boolean;
}

export interface GoalContext {
  request: string;
  /** Earlier turns of the same conversation, oldest first. Only `user` turns can state constraints. */
  history?: readonly { role: string; text: string }[];
  /** Notes retrieved from the user's memory: untrusted, possibly stale. */
  memory?: readonly { text: string; savedAt?: string | null }[];
  /** Values read by code from trusted state or tools (for example a project list). */
  facts?: readonly { slot: SlotId; value: string; source: 'task_state' | 'tool_result' }[];
  /** Choices retrieved for a question, such as the user's coding projects. */
  choices?: Partial<Record<SlotId, readonly string[]>>;
  capabilities?: GoalCapabilities;
  /** Intent signals computed by the caller's own trusted parsers, so the rules are not duplicated here. */
  signals?: { adsCreateInAccount?: boolean };
  now?: Date;
}

// ---------------------------------------------------------------------------
// Text normalisation and slot extraction
// ---------------------------------------------------------------------------

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
export function normalizeText(text: string): string {
  return text.normalize('NFKC')
    .replace(ARABIC_DIGITS, digit => String((digit.charCodeAt(0) & 0x0f)))
    .replace(/[ـً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا');
}

export function detectLanguage(text: string): 'ar' | 'en' {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  return arabic >= latin * 0.5 && arabic > 0 ? 'ar' : 'en';
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
interface Place { id: string; names: string[]; pattern: RegExp; strip: RegExp }
/** Places named often enough in requests to recognise without a model. Matching is by alias, never by guess. */
const PLACES: Place[] = [
  ['riyadh', 'الرياض', 'riyadh'], ['jeddah', 'جدة', 'جده', 'jeddah', 'jidda'], ['makkah', 'مكة', 'مكه', 'makkah', 'mecca'], ['madinah', 'المدينة المنورة', 'medina', 'madinah'],
  ['dammam', 'الدمام', 'dammam'], ['khobar', 'الخبر', 'khobar'], ['saudi', 'السعودية', 'المملكة العربية السعودية', 'saudi arabia', 'ksa'],
  ['dubai', 'دبي', 'dubai'], ['abudhabi', 'ابوظبي', 'ابو ظبي', 'abu dhabi'], ['sharjah', 'الشارقة', 'sharjah'], ['uae', 'الامارات', 'uae', 'united arab emirates'],
  ['cairo', 'القاهرة', 'cairo'], ['alexandria', 'الاسكندرية', 'alexandria'], ['egypt', 'مصر', 'egypt'], ['kuwait', 'الكويت', 'kuwait'],
  ['doha', 'الدوحة', 'doha'], ['qatar', 'قطر', 'qatar'], ['amman', 'amman'], ['jordan', 'الاردن', 'jordan'], ['bahrain', 'البحرين', 'bahrain'],
  ['muscat', 'مسقط', 'muscat'], ['oman', 'سلطنة عمان', 'oman'], ['beirut', 'بيروت', 'beirut'], ['lebanon', 'لبنان', 'lebanon'],
  ['damascus', 'دمشق', 'damascus'], ['aleppo', 'حلب', 'aleppo'], ['syria', 'سوريا', 'syria'], ['baghdad', 'بغداد', 'baghdad'], ['iraq', 'العراق', 'iraq'],
  ['istanbul', 'اسطنبول', 'istanbul'], ['turkey', 'تركيا', 'turkey'], ['london', 'لندن', 'london'], ['glasgow', 'جلاسكو', 'غلاسكو', 'glasgow'],
  ['edinburgh', 'ادنبرة', 'edinburgh'], ['manchester', 'مانشستر', 'manchester'], ['birmingham', 'برمنغهام', 'birmingham'], ['scotland', 'اسكتلندا', 'scotland'],
  ['england', 'انجلترا', 'england'], ['uk', 'بريطانيا', 'المملكة المتحدة', 'united kingdom', 'uk'], ['usa', 'امريكا', 'الولايات المتحدة', 'united states', 'usa'],
].map(([id, ...names]) => {
  const plain = names.map(name => normalizeText(name).toLowerCase());
  // Compiled once: the gate runs before every model loop, so it must stay cheap.
  const body = `(?:^|[^\\p{L}])(?:ب|و|ل|في)?(?:${plain.map(escapeRegExp).join('|')})(?=$|[^\\p{L}])`;
  return { id: id!, names: plain, pattern: new RegExp(body, 'u'), strip: new RegExp(body, 'gu') };
});

function placeIn(text: string): Place[] {
  const plain = ` ${normalizeText(text).toLowerCase()} `;
  return PLACES.filter(place => place.pattern.test(plain));
}
export function placeId(text: string): string | null { return placeIn(text)[0]?.id ?? null; }

const CURRENCY = '£|\\$|€|gbp|usd|eur|sar|aed|egp|kwd|qar|ريال|دولار|جنيه|يورو|درهم|دينار';
const AMOUNT = '(\\d{1,7}(?:[.,]\\d{1,2})?)';
const BUDGET_PATTERNS = [
  new RegExp(`(?:budget|ميزاني[ةه]|الميزاني[ةه])[^\\d\\n]{0,30}?(?:${CURRENCY})?\\s*${AMOUNT}\\s*(${CURRENCY})?`, 'iu'),
  new RegExp(`(?:${CURRENCY})\\s*${AMOUNT}\\s*(?:a|per|/)\\s*day`, 'iu'),
  new RegExp(`${AMOUNT}\\s*(${CURRENCY})\\s*(?:يومي(?:ا)?|في اليوم|باليوم|كل يوم|per day|a day|daily|/day)`, 'iu'),
  /^budget:\s*(\d{1,7}(?:[.,]\d{1,2})?)\s*([a-z]{3})?\s*$/imu,
];
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>«»()،,]+/giu;
const DOMAIN_PATTERN = /(?<![@\w.])(?:www\.)?[a-z0-9-]{2,63}(?:\.[a-z0-9-]{2,63})*\.(?:com|net|org|co|uk|sa|ae|io|ai|app|dev|store|shop|me|info|biz|eg|qa|kw|jo|om|bh|de|fr|online|site)(?:\/[^\s"'<>«»()،,]*)?(?![\w.-])/giu;
const trimPunctuation = (value: string) => value.replace(/[.,،؛:!?؟)\]]+$/u, '');

function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) found.add(trimPunctuation(match[0]));
  const withoutUrls = text.replace(URL_PATTERN, ' ');
  for (const match of withoutUrls.matchAll(DOMAIN_PATTERN)) found.add(`https://${trimPunctuation(match[0])}`);
  return [...found].filter(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }).slice(0, 4);
}

function extractBudgets(text: string): string[] {
  const plain = normalizeText(text);
  const found = new Set<string>();
  for (const pattern of BUDGET_PATTERNS) {
    const match = pattern.exec(plain);
    if (!match) continue;
    const amount = match.slice(1).find(part => part && /^\d/.test(part));
    if (!amount) continue;
    const currency = match.slice(1).find(part => part && !/^\d/.test(part)) ?? (/£|gbp|جنيه استرليني/i.test(match[0]) ? 'GBP' : /\$|usd|دولار/i.test(match[0]) ? 'USD' : /€|eur|يورو/i.test(match[0]) ? 'EUR' : '');
    found.add(`${amount.replace(',', '.')}${currency ? ` ${currencyCode(currency)}` : ''}`);
  }
  // Two different amounts in one text with the budget word each is a real conflict.
  const all = [...plain.matchAll(new RegExp(`(?:budget|ميزاني[ةه]|الميزاني[ةه])[^\\d\\n]{0,30}?${AMOUNT}`, 'giu'))].map(match => match[1]!.replace(',', '.'));
  for (const amount of all) if (![...found].some(value => value.startsWith(`${amount}`))) found.add(amount);
  return [...found].slice(0, 4);
}

function currencyCode(raw: string): string {
  const value = normalizeText(raw).toLowerCase();
  if (/£|gbp|جنيه/.test(value)) return value.includes('جنيه') && !value.includes('استرليني') ? 'EGP' : 'GBP';
  if (/\$|usd|دولار/.test(value)) return 'USD';
  if (/€|eur|يورو/.test(value)) return 'EUR';
  if (/sar|ريال/.test(value)) return 'SAR';
  if (/aed|درهم/.test(value)) return 'AED';
  if (/kwd|دينار/.test(value)) return 'KWD';
  return value.toUpperCase().slice(0, 3);
}

function extractLanguage(text: string): string | null {
  const plain = normalizeText(text).toLowerCase();
  const line = /^language:\s*(ar|en)\b/im.exec(plain);
  if (line) return line[1]!;
  if (/\b(?:in )?arabic\b|بالعربي|باللغة العربية|عربي(?:ة)?\s*$/.test(plain)) return 'ar';
  if (/\b(?:in )?english\b|بالانجليزي|بالانكليزي|باللغة الانجليزية|انجليزي(?:ة)?\s*$/.test(plain)) return 'en';
  return null;
}

function extractObjective(text: string): string | null {
  const plain = normalizeText(text).toLowerCase();
  if (/\bcalls?\b|مكالمات|اتصالات/.test(plain)) return 'calls';
  if (/\bleads?\b|عملاء محتملين|استفسارات/.test(plain)) return 'leads';
  if (/\bsales\b|مبيعات/.test(plain)) return 'sales';
  if (/\bbookings?\b|حجوزات|حجز/.test(plain)) return 'bookings';
  if (/\btraffic\b|visits|زيارات|زوار/.test(plain)) return 'traffic';
  return null;
}

const PATH_PATTERN = /(?:[a-z]:\\[^\s"'<>|]+|(?:\.{1,2}\/|\/)[\w.\-/]+|[\w\-]+(?:\/[\w\-]+)*\.(?:ts|tsx|js|mjs|json|md|txt|csv|py|html|css|yml|yaml|xml|pdf|docx|xlsx|png|jpg|log))(?![\w.])/giu;
function extractPaths(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_PATTERN)].map(match => trimPunctuation(match[0])).filter(path => !/^https?:/i.test(path)))].slice(0, 4);
}

/** Words that carry no task content, removed before judging whether a request names its subject. */
const NOISE = new Set([
  'google', 'ads', 'adwords', 'campaign', 'campaigns', 'create', 'build', 'make', 'save', 'please', 'can', 'you', 'could', 'want', 'need', 'help', 'for', 'the', 'a', 'an', 'my', 'me', 'in', 'on', 'of', 'to', 'and', 'with', 'account', 'new', 'paused', 'search', 'ad', 'i', 'it', 'this', 'that', 'some', 'do', 'just', 'now', 'write', 'prepare', 'draft', 'suggest', 'set', 'up', 'run', 'launch', 'budget', 'daily', 'per', 'day', 'is', 'be', 'our',
  'جوجل', 'غوغل', 'قوقل', 'ادز', 'اعلانات', 'اعلان', 'اعلانية', 'اعلانيه', 'الاعلانات', 'الاعلانية', 'حملة', 'حمله', 'الحملة', 'الحمله', 'حملات', 'انشئ', 'انشاء', 'اعمل', 'سوي', 'ابني', 'ابن', 'احفظ', 'جهز', 'اكتب', 'اقترح', 'اريد', 'احتاج', 'منك', 'ان', 'لي', 'من', 'فضلك', 'لو', 'سمحت',
  'في', 'على', 'الى', 'الي', 'عن', 'مع', 'حسابي', 'الحساب', 'حساب', 'جديدة', 'جديده', 'متوقفة', 'متوقفه', 'بحث', 'ميزانية', 'ميزانيه', 'الميزانية', 'يومية', 'يوميه', 'يوميا', 'اليوم', 'هذا', 'هذه', 'ذلك', 'لنا', 'لها', 'له', 'و', 'او', 'ثم', 'الان', 'رجاء', 'تنشئ', 'تبني', 'تحفظ', 'نفسه', 'كل',
]);
function contentWords(text: string): string[] {
  const plain = normalizeText(text).toLowerCase()
    .replace(URL_PATTERN, ' ').replace(DOMAIN_PATTERN, ' ')
    .replace(new RegExp(`(?:${CURRENCY})`, 'giu'), ' ').replace(/\d+(?:[.,]\d+)?/g, ' ');
  let rest = ` ${plain} `;
  for (const place of PLACES) rest = rest.replace(place.strip, ' ');
  return rest.split(/[^\p{L}]+/u).filter(word => word.length >= 3 && !NOISE.has(word) && !NOISE.has(word.replace(/^(?:ال|و|ب|ل)/, '')));
}

// ---------------------------------------------------------------------------
// Domains, steps and requirements
// ---------------------------------------------------------------------------

const DOMAIN_RULES: [GoalDomain, RegExp][] = [
  ['google_ads', /google\s*ads|adwords|اعلانات?\s*(?:جوجل|غوغل|قوقل)|(?:جوجل|غوغل)\s*ادز|حمل[ةه]|\bcampaign/iu],
  ['coding', /\b(?:code|bug|function|repo(?:sitory)?|refactor|compile|typescript|javascript|python|endpoint|unit tests?|pull request|component)\b|كود|برمج|الدال[ةه]|خطا برمجي|اختبارات الوحد[ةه]|مشروع البرمج[ةه]|مشاريع البرمج[ةه]/iu],
  ['files', /\b(?:files?|folders?|director(?:y|ies)|rename)\b|ملف|ملفات|مجلد|المجلد/iu],
  ['computer', /(?:على|في)\s+(?:جهازي|كمبيوتري|حاسوبي|الكمبيوتر)|\bmy (?:pc|computer|desktop)\b|نافذ[ةه]/iu],
  ['skills', /مهار[ةه]|مهارات|\bskills?\b/iu],
  ['browser', /\bhttps?:\/\/|افتح|ادخل (?:على|الى)|سجل(?:ني)? (?:الدخول|دخول)|املا|عبئ|اضغط|\b(?:open|visit|go to|log ?in|sign ?in|fill (?:in|out)|click|submit)\b/iu],
  ['research', /ابحث|بحث عن|ما (?:هو|هي)|من هو|كم سعر|سعر|اسعار|احدث|اخبار|\b(?:search|look up|latest|news|price|who is|what is|how much|current)\b/iu],
];

export function detectDomains(request: string): GoalDomain[] {
  const plain = normalizeText(request);
  const domains = DOMAIN_RULES.filter(([, pattern]) => pattern.test(plain)).map(([domain]) => domain);
  return domains.length ? domains : ['conversation'];
}

// JavaScript's \b is ASCII-only, so Arabic verbs are anchored on a non-letter before them
// (allowing the joined conjunctions و/ف). Words such as "غير" (also "not") and "حدث"
// (also "event") are left out: they are too often not a request to change anything.
const IRREVERSIBLE = /\b(?:delete|remove|erase|wipe|destroy|drop table|format)\b|(?<!\p{L})(?:و|ف)?(?:احذف|حذف|امسح|مسح نهائي)/iu;
const SPEND = /\b(?:activate|enable|launch|go live|start spending|increase (?:the )?budget)\b|(?<!\p{L})(?:و|ف)?(?:فعل|تفعيل|اطلق|اطلاق|شغل الحمل|ابدا الصرف|زياد[ةه] الميزاني)/iu;
const WRITE = /\b(?:send|post|publish|submit|buy|pay|order|book|register|sign up|fix|implement|change|update|add|refactor|rename|move|overwrite)\b|(?<!\p{L})(?:و|ف)?(?:ارسل|انشر|اشتر|ادفع|احجز|سجل حساب|اصلح|نفذ|عدل|اضف|انقل|اعد تسمي[ةه]|استبدل)/iu;
const DRAFT = /\b(?:draft|suggest|write|prepare|ideas?|headlines?|keywords?|plan|preview)\b|مسود[ةه]|اقترح|اكتب|جهز|افكار|عناوين|كلمات مفتاحي[ةه]|خط[ةه]|معاين[ةه]/iu;
const READ = /\b(?:open|visit|go to|show|read|look at)\b|افتح|ادخل|اعرض|اقرا/iu;

function primaryStep(request: string, domains: GoalDomain[], signals: GoalContext['signals']): StepKind {
  const plain = normalizeText(request);
  const ads = domains.includes('google_ads');
  if (ads && SPEND.test(plain)) return 'spend';
  if (IRREVERSIBLE.test(plain) && (domains.includes('files') || domains.includes('coding') || domains.includes('browser') || ads)) return 'irreversible';
  if (ads) return signals?.adsCreateInAccount ? 'external_write' : 'draft';
  if ((domains.includes('coding') || domains.includes('files')) && WRITE.test(plain)) return 'external_write';
  if (domains.includes('browser') && WRITE.test(plain)) return 'external_write';
  if (domains.includes('browser') && READ.test(plain)) return 'read';
  if (domains.includes('research')) return 'research';
  if (DRAFT.test(plain)) return 'draft';
  return 'answer';
}

const STEPS_FOR: Record<StepKind, StepKind[]> = {
  answer: ['answer'], research: ['research', 'answer'], read: ['read', 'answer'], draft: ['draft'],
  external_write: ['external_write'], spend: ['external_write', 'spend'], irreversible: ['irreversible'],
};
/** Only a campaign has a safe, reversible draft that can be prepared while the write waits. */
function stepsFor(frame: Pick<GoalFrame, 'primaryStep' | 'domains'>): StepKind[] {
  const steps = STEPS_FOR[frame.primaryStep];
  return frame.domains.includes('google_ads') && (frame.primaryStep === 'external_write' || frame.primaryStep === 'spend') ? ['draft', ...steps] : steps;
}

interface Spec {
  slot: SlotId; domain: GoalDomain; necessity: 'required' | 'optional'; blocks: StepKind[]; authority: boolean;
  impact: 0 | 1 | 2 | 3; risk: 0 | 1 | 2 | 3;
  /** A permitted tool can find this, so the agent researches instead of asking. */
  answerable?: boolean;
  /** A safe default for optional or low-risk slots; never offered for authority slots. */
  assumption?: string | null;
}

/** Domain validators: the shared engine asks each applicable one for its requirements. */
export type RequirementValidator = (frame: { request: string; domains: GoalDomain[]; primaryStep: StepKind; language: 'ar' | 'en'; history: boolean }, context: GoalContext) => Spec[];

const PERSONAL_TARGET = /\bmy (?:bank|account|site|website|page|store|company)\b|بنكي|موقعي|متجري|شركتي|صفحتي/iu;
const PRONOUN_ONLY = /^(?:(?:كم|ما|ماذا|اين|متى|هل|what(?:'s| is| about)?|how much(?: is)?|tell me|and)\s+)?(?:سعره|سعرها|عنه|عنها|هو|هي|ذلك|هذا|it|that|this one|its price|the price|about it)\s*[?؟]?$/iu;

export const DOMAIN_VALIDATORS: Readonly<Record<GoalDomain, RequirementValidator>> = {
  google_ads: frame => {
    const consequential = frame.primaryStep === 'external_write' || frame.primaryStep === 'spend';
    const writeBlocks: StepKind[] = ['external_write', 'spend'];
    return [
      // A draft is reversible: without the business the model can write a template or ask itself.
      // Before anything is written to the account, what is advertised must come from the user.
      { slot: 'ads_service', domain: 'google_ads', necessity: consequential ? 'required' : 'optional', blocks: consequential ? writeBlocks : [], authority: false, impact: 3, risk: 3 },
      { slot: 'ads_url', domain: 'google_ads', necessity: consequential ? 'required' : 'optional', blocks: consequential ? writeBlocks : [], authority: true, impact: 3, risk: 3 },
      { slot: 'ads_location', domain: 'google_ads', necessity: consequential ? 'required' : 'optional', blocks: consequential ? writeBlocks : [], authority: true, impact: 3, risk: 3 },
      { slot: 'ads_budget', domain: 'google_ads', necessity: consequential ? 'required' : 'optional', blocks: consequential ? writeBlocks : [], authority: true, impact: 3, risk: 3 },
      { slot: 'ads_language', domain: 'google_ads', necessity: 'optional', blocks: [], authority: false, impact: 1, risk: 1, assumption: frame.language },
      { slot: 'ads_objective', domain: 'google_ads', necessity: 'optional', blocks: [], authority: false, impact: 1, risk: 1, assumption: 'leads' },
      ...(consequential ? [{ slot: 'ads_conversion' as const, domain: 'google_ads' as const, necessity: 'optional' as const, blocks: [], authority: false, impact: 1 as const, risk: 1 as const, assumption: null }] : []),
    ];
  },
  coding: (frame, context) => frame.primaryStep !== 'external_write' && frame.primaryStep !== 'irreversible' ? [] : [
    { slot: 'project', domain: 'coding', necessity: 'required', blocks: ['external_write', 'irreversible'], authority: true, impact: 3, risk: 3, answerable: !context.choices?.project },
    { slot: 'change', domain: 'coding', necessity: 'required', blocks: ['external_write', 'irreversible'], authority: false, impact: 3, risk: 2 },
  ],
  files: frame => frame.primaryStep !== 'external_write' && frame.primaryStep !== 'irreversible' ? [] : [
    { slot: 'file_path', domain: 'files', necessity: 'required', blocks: ['external_write', 'irreversible'], authority: true, impact: 3, risk: 3 },
  ],
  browser: (frame, context) => frame.primaryStep === 'read' || frame.primaryStep === 'external_write' ? [
    { slot: 'target_site', domain: 'browser', necessity: 'required', blocks: ['read', 'external_write'], authority: frame.primaryStep === 'external_write', impact: 2, risk: 2, answerable: Boolean(context.capabilities?.search) && !PERSONAL_TARGET.test(normalizeText(frame.request)) },
  ] : [],
  research: () => [{ slot: 'subject', domain: 'research', necessity: 'required', blocks: ['research', 'answer'], authority: false, impact: 2, risk: 2 }],
  conversation: () => [{ slot: 'subject', domain: 'conversation', necessity: 'required', blocks: ['answer', 'draft'], authority: false, impact: 2, risk: 2 }],
  computer: () => [],
  skills: () => [],
};

const KNOWN_SITE = /google|gmail|youtube|facebook|instagram|linkedin|github|vercel|twitter|tiktok|amazon|noon|جوجل|جيميل|يوتيوب|فيسبوك|انستقرام|انستغرام|لينكد|جيت هب|امازون|نون|تويتر|تيك توك/iu;

/** Values for a slot found in one text, by the slot's own trusted extractor. */
function valuesFor(slot: SlotId, text: string, context: GoalContext, frame: { request: string; history: boolean }, contextual: boolean): string[] {
  switch (slot) {
    case 'ads_url': return extractUrls(text);
    case 'ads_budget': {
      const budgets = extractBudgets(text);
      if (budgets.length || !contextual) return budgets;
      const bare = /^\D{0,24}?(\d{1,7}(?:[.,]\d{1,2})?)\s*([^\d\s]{0,12})\D{0,30}$/u.exec(normalizeText(text).trim());
      return bare ? [`${bare[1]!.replace(',', '.')}${bare[2] && new RegExp(`^(?:${CURRENCY})`, 'iu').test(bare[2]) ? ` ${currencyCode(bare[2])}` : ''}`] : [];
    }
    case 'ads_location': {
      const named = /^location:\s*(.+)$/gim;
      const explicit = [...text.matchAll(named)].map(match => match[1]!.trim()).filter(Boolean);
      const places = placeIn(text).map(place => place.names.find(name => normalizeText(text).toLowerCase().includes(name)) ?? place.id);
      const found = [...new Set([...explicit, ...places])];
      if (found.length || !contextual) return found.slice(0, 3);
      const rest = normalizeText(text).replace(URL_PATTERN, ' ').replace(DOMAIN_PATTERN, ' ').replace(/\d+(?:[.,]\d+)?\s*(?:[^\s\d]{0,6})?/g, ' ').replace(/[،,.؛]/g, ' ').replace(/\s+/g, ' ').trim();
      return rest.length >= 2 && rest.length <= 60 ? [rest] : [];
    }
    case 'ads_language': { const language = extractLanguage(text); return language ? [language] : []; }
    case 'ads_objective': { const objective = extractObjective(text); return objective ? [objective] : []; }
    case 'ads_service': {
      const words = contentWords(text);
      if (!words.length && !(contextual && text.trim().length >= 2) && !extractUrls(text).length) return [];
      return [text.replace(/\s+/g, ' ').trim().slice(0, 160)];
    }
    case 'file_path': return extractPaths(text);
    case 'target_site': {
      if (extractUrls(text).length) return extractUrls(text);
      const known = KNOWN_SITE.exec(normalizeText(text));
      return known ? [known[0]] : contextual && text.trim().length >= 2 ? [text.trim().slice(0, 120)] : [];
    }
    case 'project': {
      const choices = context.choices?.project ?? [];
      const plain = normalizeText(text).toLowerCase();
      const named = choices.filter(choice => plain.includes(normalizeText(choice).toLowerCase()));
      return named.length === 1 ? named : contextual && choices.length === 0 && text.trim() ? [text.trim().slice(0, 120)] : [];
    }
    case 'change': return contentWords(text).length >= 3 || (contextual && contentWords(text).length >= 1) ? [text.replace(/\s+/g, ' ').trim().slice(0, 200)] : [];
    case 'subject': {
      const plain = normalizeText(text).trim();
      if (contextual) return plain.length >= 2 ? [plain.slice(0, 160)] : [];
      return PRONOUN_ONLY.test(plain) && !frame.history ? [] : [plain.slice(0, 160)];
    }
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Frame construction
// ---------------------------------------------------------------------------

const MAX_EVIDENCE = 48;
const iso = (date: Date) => date.toISOString();
const slugPart = (value: string) => value.replace(/[^a-z0-9_]/g, '_').slice(0, 20);

const CONSTRAINTS: [RegExp, string][] = [
  [/(?:paused|متوقف[ةه])/iu, 'paused_only'],
  [/(?:لا\s+تصرف|بدون\s+صرف|no spend|don't spend|do not spend|without spending)/iu, 'no_spend'],
  [/(?:مسود[ةه] فقط|معاين[ةه] فقط|draft only|preview only)/iu, 'draft_only'],
  [/(?:لا\s+تحذف|don't delete|do not delete)/iu, 'no_delete'],
  [/(?:بنفسي|myself|manually)/iu, 'user_acts_personally'],
];

function evidenceFrom(slot: SlotId, values: string[], kind: EvidenceKind, source: EvidenceSource, at: Date, options: { trusted: boolean; stale?: boolean }, index: number): GoalEvidence[] {
  return values.map((value, position) => ({
    id: `${source.slice(0, 12)}.${slugPart(slot)}.${index}${position}`.slice(0, 64),
    slot, kind, source, value: value.slice(0, 400), observedAt: iso(at),
    trusted: options.trusted, stale: options.stale ?? false,
    needsVerification: kind === 'INFERRED_PREFERENCE' || kind === 'WORKING_ASSUMPTION' || kind === 'UNKNOWN',
  }));
}

/** Builds the goal frame for a new task. Deterministic for the same context and time. */
export function interpretGoal(context: GoalContext, config: ClarificationConfig = DEFAULT_CLARIFICATION_CONFIG): GoalFrame {
  const now = context.now ?? new Date();
  const request = context.request.trim().slice(0, 4000);
  const domains = detectDomains(request);
  const language = detectLanguage(request);
  const step = primaryStep(request, domains, context.signals);
  const history = (context.history ?? []).filter(entry => entry.role === 'user' && entry.text.trim());
  const frameInfo = { request, domains, primaryStep: step, language, history: (context.history ?? []).length > 0 };
  const specs = specsFor(frameInfo, context);
  const evidence: GoalEvidence[] = [];
  specs.forEach((spec, index) => {
    evidence.push(...evidenceFrom(spec.slot, valuesFor(spec.slot, request, context, frameInfo, false), 'USER_CONSTRAINT', 'request', now, { trusted: true }, index));
    history.slice(-4).forEach((entry, turn) => evidence.push(...evidenceFrom(spec.slot, spec.slot === 'subject' ? [] : valuesFor(spec.slot, entry.text, context, frameInfo, false), 'USER_CONSTRAINT', 'conversation', now, { trusted: true }, index * 10 + turn)));
    for (const fact of context.facts ?? []) if (fact.slot === spec.slot) evidence.push(...evidenceFrom(spec.slot, [fact.value], 'VERIFIED_FACT', fact.source, now, { trusted: true }, index));
    (context.memory ?? []).slice(0, 6).forEach((note, position) => {
      if (spec.slot === 'subject' || spec.slot === 'change' || spec.slot === 'ads_service') return;
      const saved = note.savedAt ? Date.parse(note.savedAt) : Number.NaN;
      const stale = !Number.isFinite(saved) || now.getTime() - saved > config.memoryStaleDays * 86_400_000;
      evidence.push(...evidenceFrom(spec.slot, valuesFor(spec.slot, note.text, context, frameInfo, false), 'INFERRED_PREFERENCE', 'memory', now, { trusted: false, stale }, index * 10 + position));
    });
  });
  const constraints = CONSTRAINTS.filter(([pattern]) => pattern.test(normalizeText(request))).map(([, name]) => name);
  const frame: GoalFrame = {
    version: 1, request, language, domains, primaryStep: constraints.includes('draft_only') && step === 'external_write' ? 'draft' : step,
    constraints, requirements: [], evidence: evidence.slice(0, MAX_EVIDENCE), conflicts: [], asked: [], answers: [],
  };
  return GoalFrameSchema.parse(resolve(frame, context));
}

function specsFor(frame: { request: string; domains: GoalDomain[]; primaryStep: StepKind; language: 'ar' | 'en'; history: boolean }, context: GoalContext): Spec[] {
  const seen = new Set<SlotId>();
  const specs: Spec[] = [];
  // A task with a specific domain is not also judged as plain conversation.
  const domains = frame.domains.length > 1 ? frame.domains.filter(domain => domain !== 'conversation') : frame.domains;
  const work = domains.some(domain => domain === 'google_ads' || domain === 'coding' || domain === 'files');
  for (const domain of domains) {
    if (domain === 'research' && domains.some(other => other !== 'research')) continue;
    // A word like "login" in a coding or campaign request does not make it a browser task.
    if (domain === 'browser' && work) continue;
    for (const spec of DOMAIN_VALIDATORS[domain](frame, context)) if (!seen.has(spec.slot)) { seen.add(spec.slot); specs.push(spec); }
  }
  return specs;
}

const SOURCE_RANK: Record<EvidenceSource, number> = { clarification_answer: 6, request: 5, tool_result: 4, task_state: 4, conversation: 3, memory: 1, retrieved_content: 0, default: 0 };

/** Recomputes requirement status from evidence. Answers outrank the request; the request outranks older turns. */
function resolve(frame: GoalFrame, context: GoalContext): GoalFrame {
  const info = { request: frame.request, domains: frame.domains, primaryStep: frame.primaryStep, language: frame.language, history: (context.history ?? []).length > 0 };
  const specs = specsFor(info, context);
  const conflicts: GoalFrame['conflicts'] = [];
  const requirements: Requirement[] = specs.map(spec => {
    const items = frame.evidence.filter(entry => entry.slot === spec.slot);
    const trusted = items.filter(entry => entry.trusted && (entry.kind === 'USER_CONSTRAINT' || entry.kind === 'VERIFIED_FACT'));
    const top = Math.max(-1, ...trusted.map(entry => SOURCE_RANK[entry.source]));
    // The newest answer wins outright; within the request, two different values are a conflict.
    const latestAnswer = trusted.filter(entry => entry.source === 'clarification_answer').at(-1);
    const best = latestAnswer ? [latestAnswer] : trusted.filter(entry => SOURCE_RANK[entry.source] === top);
    const distinct = [...new Set(best.map(entry => comparable(spec.slot, entry.value)))];
    const declined = frame.answers.some(answer => answer.kind === 'decline' && answer.slots.includes(spec.slot) && !answer.filled.includes(spec.slot));
    const base = { slot: spec.slot, domain: spec.domain, necessity: spec.necessity, blocks: spec.blocks, authority: spec.authority };
    if (distinct.length > 1) {
      conflicts.push({ slot: spec.slot, values: [...new Set(best.map(entry => entry.value))].slice(0, 4) });
      return { ...base, status: 'conflicting', evidenceIds: best.map(entry => entry.id).slice(0, 8), value: null };
    }
    if (best.length) return { ...base, status: 'satisfied', evidenceIds: best.map(entry => entry.id).slice(0, 8), value: best[0]!.value };
    const assumption = !spec.authority && spec.assumption !== undefined && spec.assumption !== null ? spec.assumption : null;
    if (assumption !== null && (spec.necessity === 'optional' || declined)) return { ...base, status: 'assumed', evidenceIds: [], value: assumption };
    return { ...base, status: declined ? 'declined' : 'missing', evidenceIds: items.filter(entry => !entry.stale).map(entry => entry.id).slice(0, 8), value: null };
  });
  return { ...frame, requirements, conflicts };
}

function comparable(slot: SlotId, value: string): string {
  if (slot === 'ads_budget') return String(Number.parseFloat(value));
  if (slot === 'ads_url' || slot === 'target_site') { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value.toLowerCase(); } }
  if (slot === 'ads_location') return placeId(value) ?? normalizeText(value).toLowerCase();
  return normalizeText(value).toLowerCase();
}

// ---------------------------------------------------------------------------
// Question value and readiness
// ---------------------------------------------------------------------------

export function scoreQuestion(input: { impact: number; risk: number; changesPlan: boolean; answerable: boolean; asked: number; mandatory: boolean }): QuestionScore {
  const interruptionCost = Math.min(10, input.asked * 2);
  const value = 2 * input.impact + 2 * input.risk + (input.changesPlan ? 2 : 0) - interruptionCost - (input.answerable ? 12 : 0);
  return { value: Math.max(-100, Math.min(100, value)), impact: input.impact, assumptionRisk: input.risk, changesPlan: input.changesPlan, answerableFromSources: input.answerable, interruptionCost, mandatory: input.mandatory };
}

const LABELS: Record<SlotId, { ar: string; en: string }> = {
  subject: { ar: 'المقصود بالطلب', en: 'what the request is about' }, target_site: { ar: 'الموقع المقصود', en: 'the website' },
  project: { ar: 'المشروع', en: 'the project' }, change: { ar: 'التغيير المطلوب', en: 'the change' },
  file_path: { ar: 'مسار الملف', en: 'the file path' }, file_operation: { ar: 'العملية على الملف', en: 'the file operation' },
  ads_service: { ar: 'النشاط أو الخدمة المعلن عنها', en: 'the business or service' }, ads_url: { ar: 'رابط صفحة الهبوط', en: 'the landing page URL' },
  ads_location: { ar: 'المنطقة المستهدفة', en: 'the target location' }, ads_language: { ar: 'لغة الإعلان', en: 'the ad language' },
  ads_budget: { ar: 'الميزانية اليومية', en: 'the daily budget' }, ads_objective: { ar: 'هدف الحملة', en: 'the campaign goal' },
  ads_account: { ar: 'حساب الإعلانات', en: 'the ads account' }, ads_conversion: { ar: 'تتبع التحويلات', en: 'conversion tracking' },
};
export function slotLabel(slot: SlotId, language: 'ar' | 'en'): string { return LABELS[slot][language]; }

const REASONS: Partial<Record<SlotId, { ar: string; en: string }>> = {
  ads_budget: { ar: 'الميزانية تحدد ما قد يُصرف من حسابك، فلا أفترضها.', en: 'The budget sets what your account may spend, so I will not assume it.' },
  ads_url: { ar: 'الإعلان سيوجه الزوار إلى هذا الرابط، فيجب أن يكون موقعك الحقيقي.', en: 'Ads send visitors to this page, so it must be your real site.' },
  ads_location: { ar: 'المنطقة تحدد من يرى الإعلان وأين يُصرف المال.', en: 'The location decides who sees the ad and where money is spent.' },
  ads_service: { ar: 'بدون معرفة ما تعلن عنه سيكون النص عامًا ولا يفيد.', en: 'Without knowing what you advertise, the copy would be generic.' },
  project: { ar: 'التعديل سيُطبق على مشروع محدد، ولا أختاره نيابة عنك.', en: 'The change applies to one specific project; I will not pick it for you.' },
  change: { ar: 'وصف التغيير ومعيار نجاحه يحددان ما سيُعدّل ويُختبر.', en: 'The change and how to check it decide what is edited and tested.' },
  file_path: { ar: 'العملية تمس ملفًا محددًا، والخطأ فيه قد لا يُسترجع.', en: 'The operation touches one file; a wrong target may not be recoverable.' },
  target_site: { ar: 'أحتاج الموقع الصحيح قبل فتحه أو إرسال أي شيء إليه.', en: 'I need the right site before opening it or sending anything.' },
  subject: { ar: 'لم يتضح من الطلب ما الذي تقصده.', en: 'The request does not say what it refers to.' },
};

const PROMPTS: Partial<Record<SlotId, { ar: string; en: string }>> = {
  ads_budget: { ar: 'ما الميزانية اليومية (المبلغ والعملة)؟', en: 'What daily budget (amount and currency)?' },
  ads_url: { ar: 'ما رابط صفحة الهبوط؟', en: 'What is the landing page URL?' },
  ads_location: { ar: 'ما المدينة أو الدولة المستهدفة؟', en: 'Which city or country should it target?' },
  ads_service: { ar: 'ما النشاط أو الخدمة التي تريد الإعلان عنها؟', en: 'What business or service should the campaign promote?' },
  project: { ar: 'على أي مشروع أطبّق التعديل؟', en: 'Which project should I change?' },
  change: { ar: 'ما التغيير المطلوب بالضبط، وكيف نعرف أنه تم؟', en: 'What exactly should change, and how will we know it is done?' },
  file_path: { ar: 'ما مسار الملف المقصود؟', en: 'Which file path?' },
  target_site: { ar: 'ما رابط الموقع المقصود؟', en: 'Which website (address)?' },
  subject: { ar: 'ما الذي تقصده بالضبط؟', en: 'What exactly do you mean?' },
};

const MUTATING: ReadonlySet<StepKind> = new Set(['external_write', 'spend', 'irreversible']);
/** Ties are broken by consequence: money first, then where it goes, then who sees it. */
const SLOT_PRIORITY: SlotId[] = ['ads_budget', 'ads_url', 'ads_location', 'ads_service', 'project', 'file_path', 'change', 'target_site', 'subject'];

function capabilityFor(step: StepKind, frame: GoalFrame, caps: GoalCapabilities | undefined): ReadinessReason | null {
  if (!caps) return null;
  const message = (ar: string, en: string) => frame.language === 'ar' ? ar : en;
  if (caps.models === false && step !== 'read') return { code: 'MODEL_UNAVAILABLE', message: message('نموذج موحسن غير متاح لحسابك أو على هذا الخادم. ميزات النموذج متاحة لمالك موحسن فقط حاليًا، على كمبيوتره.', "Mohassan's model is not available to your account or on this server. Model features are the owner's only for now, on the owner's computer."), slot: null };
  if (step === 'spend') return { code: 'SPEND_NOT_IN_CHAT', message: message('تشغيل الحملة أو صرف الميزانية لا يتم من المحادثة؛ يحتاج موافقتك المنفصلة في قسم Google Ads.', 'Launching or spending is not done from the chat; it needs your separate approval in the Google Ads section.'), slot: null };
  if (step === 'external_write' && frame.domains.includes('google_ads') && !caps.adsCreate) return { code: 'ADS_CREATE_UNAVAILABLE', message: message('إنشاء الحملات في الحساب غير متاح هنا؛ يمكن إعداد المسودة فقط.', 'Creating campaigns in the account is not available here; only a draft can be prepared.'), slot: null };
  if ((step === 'external_write' || step === 'irreversible') && frame.domains.includes('coding') && !caps.coding) return { code: 'CODING_UNAVAILABLE', message: message('تعديل المشاريع غير متاح لحسابك.', 'Project changes are not available to your account.'), slot: null };
  if ((step === 'external_write' || step === 'irreversible') && frame.domains.includes('files') && !frame.domains.includes('coding') && !caps.files) return { code: 'FILES_UNAVAILABLE', message: message('عمليات الملفات غير متاحة لحسابك.', 'File operations are not available to your account.'), slot: null };
  if ((step === 'read' || step === 'external_write') && frame.domains.includes('browser') && caps.browser === false) return { code: 'BROWSER_UNAVAILABLE', message: message('المتصفح غير متاح.', 'The browser is not available.'), slot: null };
  if (frame.domains.includes('computer') && step !== 'answer' && caps.computer === false) return { code: 'COMPUTER_UNAVAILABLE', message: message('التحكم بالكمبيوتر غير متاح لحسابك.', 'Computer control is not available to your account.'), slot: null };
  return null;
}

/**
 * Evaluates readiness per step and selects one outcome. A missing hard requirement
 * or a policy block always wins over everything else; there is no score to override it.
 */
export function assessReadiness(frame: GoalFrame, context: Pick<GoalContext, 'capabilities' | 'choices' | 'memory'> = {}, config: ClarificationConfig = DEFAULT_CLARIFICATION_CONFIG): ReadinessAssessment {
  const steps = stepsFor(frame);
  const budgetLeft = frame.asked.length < config.maxEngineQuestions;
  const say = (ar: string, en: string) => frame.language === 'ar' ? ar : en;
  const stepReadiness: StepReadiness[] = steps.map(step => {
    const reasons: ReadinessReason[] = [];
    const capability = capabilityFor(step, frame, context.capabilities);
    if (capability) return { step, status: 'BLOCKED', reasons: [capability] };
    const open = frame.requirements.filter(requirement => requirement.necessity === 'required' && requirement.blocks.includes(step) && requirement.status !== 'satisfied' && requirement.status !== 'assumed');
    for (const requirement of open) {
      const label = slotLabel(requirement.slot, frame.language);
      reasons.push(requirement.status === 'conflicting'
        ? { code: 'REQUIREMENT_CONFLICT', message: say(`قيم متعارضة لـ${label}.`, `Conflicting values for ${label}.`), slot: requirement.slot }
        : requirement.status === 'declined'
          ? { code: 'REQUIREMENT_DECLINED', message: say(`لم يُحدد ${label}.`, `${label} was not provided.`), slot: requirement.slot }
          : { code: 'REQUIREMENT_MISSING', message: say(`يلزم ${label}.`, `${label} is required.`), slot: requirement.slot });
    }
    if (open.length) {
      const askable = open.some(requirement => requirement.status !== 'declined') && budgetLeft;
      const researchable = open.every(requirement => requirement.status === 'missing' && specOf(frame, context, requirement.slot)?.answerable);
      return { step, status: researchable ? 'NEEDS_RESEARCH' : askable ? 'NEEDS_CLARIFICATION' : 'BLOCKED', reasons };
    }
    if (MUTATING.has(step)) return { step, status: 'NEEDS_APPROVAL', reasons: [{ code: 'APPROVAL_AT_BOUNDARY', message: say('سأطلب موافقتك على الإجراء نفسه قبل تنفيذه.', 'I will ask you to approve the exact action before it runs.'), slot: null }] };
    if (step === 'research') return { step, status: 'NEEDS_RESEARCH', reasons: [] };
    return { step, status: 'READY', reasons };
  });

  const primary = stepReadiness.find(entry => entry.step === frame.primaryStep) ?? stepReadiness.at(-1)!;
  const draft = stepReadiness.find(entry => entry.step === 'draft');
  const reasons = stepReadiness.flatMap(entry => entry.reasons).filter((reason, index, all) => all.findIndex(other => other.code === reason.code && other.slot === reason.slot) === index).slice(0, 16);
  let outcome: ClarificationOutcome;
  let question: ClarificationQuestionSpec | null = null;
  // Clarify the primary step first; when it is blocked, a needed answer for the safe draft still comes first.
  const target = primary.status === 'NEEDS_CLARIFICATION' ? primary : primary.status === 'BLOCKED' && draft?.status === 'NEEDS_CLARIFICATION' ? draft : null;
  if (target) {
    question = buildQuestion(frame, context, target, config);
    if (question) outcome = 'ASK_USER';
    else if (target !== primary) outcome = 'BLOCKED';
    else outcome = primary.reasons.some(reason => isAuthoritySlot(frame, reason.slot)) ? (draft && draft.status === 'READY' ? 'PREPARE_DRAFT' : 'BLOCKED') : 'PROCEED';
  } else if (primary.status === 'BLOCKED') outcome = draft && (draft.status === 'READY' || draft.status === 'NEEDS_APPROVAL') ? 'PREPARE_DRAFT' : 'BLOCKED';
  else if (primary.status === 'NEEDS_RESEARCH') outcome = 'RESEARCH';
  else if (primary.status === 'NEEDS_APPROVAL') outcome = 'REQUEST_APPROVAL';
  else outcome = 'PROCEED';
  const status: ReadinessStatus = outcome === 'ASK_USER' ? 'NEEDS_CLARIFICATION' : outcome === 'PREPARE_DRAFT' ? 'BLOCKED' : outcome === 'PROCEED' ? 'READY' : primary.status;
  return { status, outcome, primaryStep: frame.primaryStep, steps: stepReadiness, reasons, question };
}

function isAuthoritySlot(frame: GoalFrame, slot: SlotId | null): boolean {
  return Boolean(slot && frame.requirements.find(requirement => requirement.slot === slot)?.authority);
}

function specOf(frame: GoalFrame, context: Pick<GoalContext, 'capabilities' | 'choices'>, slot: SlotId): Spec | undefined {
  return specsFor({ request: frame.request, domains: frame.domains, primaryStep: frame.primaryStep, language: frame.language, history: false }, { request: frame.request, ...context }).find(spec => spec.slot === slot);
}

function buildQuestion(frame: GoalFrame, context: Pick<GoalContext, 'capabilities' | 'choices' | 'memory'>, step: StepReadiness, config: ClarificationConfig): ClarificationQuestionSpec | null {
  const candidates = step.reasons.flatMap(reason => {
    if (!reason.slot) return [];
    const requirement = frame.requirements.find(entry => entry.slot === reason.slot);
    if (!requirement || requirement.status === 'declined') return [];
    const spec = specOf(frame, context, reason.slot);
    const mandatory = requirement.authority && requirement.blocks.some(kind => MUTATING.has(kind));
    const score = scoreQuestion({ impact: spec?.impact ?? 2, risk: spec?.risk ?? 2, changesPlan: requirement.blocks.includes(frame.primaryStep) || requirement.blocks.includes(step.step), answerable: Boolean(spec?.answerable) && requirement.status === 'missing', asked: frame.asked.length, mandatory });
    return [{ requirement, score }];
  }).filter(candidate => !candidate.score.answerableFromSources && (candidate.score.mandatory || candidate.score.value >= config.askThreshold))
    .sort((a, b) => Number(b.score.mandatory) - Number(a.score.mandatory) || b.score.value - a.score.value || SLOT_PRIORITY.indexOf(a.requirement.slot) - SLOT_PRIORITY.indexOf(b.requirement.slot));
  if (!candidates.length) return null;
  // One decisive question; related slots of the same domain are grouped when that saves a turn.
  const lead = candidates[0]!;
  const group = lead.requirement.status === 'conflicting' ? [lead] : candidates.filter(candidate => candidate.requirement.domain === lead.requirement.domain && candidate.requirement.status !== 'conflicting').slice(0, config.maxSlotsPerQuestion);
  const slots = group.map(candidate => candidate.requirement.slot);
  const language = frame.language;
  const options: ClarificationQuestionSpec['options'] = [];
  const optionValues: Record<string, Partial<Record<SlotId, string>>> = {};
  let recommendedOptionId: string | null = null;
  let prompt: string;
  if (lead.requirement.status === 'conflicting') {
    const conflict = frame.conflicts.find(entry => entry.slot === lead.requirement.slot);
    const label = slotLabel(lead.requirement.slot, language);
    prompt = language === 'ar' ? `ذكرتَ أكثر من قيمة لـ${label}. أيها المقصودة؟` : `You gave more than one value for ${label}. Which one?`;
    (conflict?.values ?? []).slice(0, 3).forEach((value, index) => { const id = `v${index + 1}`; options.push({ id, label: value.slice(0, 160) }); optionValues[id] = { [lead.requirement.slot]: value }; });
  } else {
    prompt = slots.length === 1 ? (PROMPTS[slots[0]!]?.[language] ?? (language === 'ar' ? `ما ${slotLabel(slots[0]!, language)}؟` : `What is ${slotLabel(slots[0]!, language)}?`))
      : language === 'ar' ? `أحتاج قبل المتابعة: ${slots.map(slot => slotLabel(slot, language)).join('، و')}.` : `Before I continue I need: ${slots.map(slot => slotLabel(slot, language)).join(', ')}.`;
    if (slots.length === 1 && slots[0] === 'project') {
      for (const [index, name] of (context.choices?.project ?? []).slice(0, 4).entries()) { const id = `p${index + 1}`; options.push({ id, label: name.slice(0, 160) }); optionValues[id] = { project: name }; }
    }
    // A recommendation comes only from the user's own fresh memory, and only for one value.
    if (slots.length === 1) {
      const remembered = frame.evidence.find(entry => entry.slot === slots[0] && entry.source === 'memory' && !entry.stale);
      if (remembered && options.length < 3) { const id = 'r1'; options.unshift({ id, label: (language === 'ar' ? `كما في المرة السابقة: ${remembered.value}` : `As last time: ${remembered.value}`).slice(0, 160) }); optionValues[id] = { [slots[0]!]: remembered.value }; recommendedOptionId = id; }
    }
  }
  if (frame.domains.includes('google_ads') && MUTATING.has(frame.primaryStep) && slots.some(slot => isAuthoritySlot(frame, slot))) options.push({ id: 'draft_only', label: language === 'ar' ? 'جهّز مسودة فقط دون إنشاء' : 'Prepare a draft only' });
  options.push({ id: 'stop', label: language === 'ar' ? 'توقف هنا' : 'Stop here' });
  const reason = slots.map(slot => REASONS[slot]?.[language]).filter(Boolean).slice(0, 2).join(' ') || (language === 'ar' ? 'الإجابة تغيّر طريقة التنفيذ.' : 'The answer changes how the task is done.');
  const score = group.reduce((best, candidate) => candidate.score.value > best.value ? candidate.score : best, lead.score);
  return {
    id: `q${frame.asked.length + 1}.${slugPart(slots.join('_'))}`.slice(0, 64),
    slots, prompt: prompt.slice(0, 1000), reason: reason.slice(0, 300), options: options.slice(0, 5), recommendedOptionId,
    allowText: true, score, optionValues,
  };
}

// ---------------------------------------------------------------------------
// Answers and replies
// ---------------------------------------------------------------------------

const CANCEL_REPLY = /^(?:توقف|الغ|الغاء|كفى|لا تكمل|stop|cancel|abort)(?![\p{L}\p{N}])/iu;
const DECLINE_REPLY = /(?:لا اعرف|لا ادري|مش عارف|ما ادري|تجاهل|تخط|قرر انت|اختر انت|كما تشاء|اي شيء|على راحتك|\bskip\b|you decide|whatever|\bany\b|i don'?t know|not sure)/iu;
const NEW_GOAL_REPLY = /(?:انس(?:ى)? (?:ذلك|هذا|الموضوع|الامر)|بدلا من ذلك|طلب جديد|موضوع (?:اخر|ثاني)|دعك من|forget (?:that|it|about it)|never ?mind|instead,|new task|something else)/iu;
const TASK_VERB = /^(?:افتح|ابحث|اكتب|لخص|ترجم|اشرح|احسب|ارسل|احذف|open|search|write|summari[sz]e|translate|explain|calculate|send|delete)(?![\p{L}\p{N}])/iu;

export type ReplyKind = ClarificationAnswerRecord['kind'];

/** Whether a free-text reply answers the pending question, declines it, stops, or starts something else. */
export function classifyReply(text: string, frame: GoalFrame, slots: readonly SlotId[], context: Pick<GoalContext, 'choices'> = {}): ReplyKind {
  const plain = normalizeText(text).trim();
  if (CANCEL_REPLY.test(plain)) return 'cancel';
  if (NEW_GOAL_REPLY.test(plain)) return 'new_goal';
  const info = { request: frame.request, history: true };
  const fills = slots.some(slot => valuesFor(slot, text, { request: frame.request, ...context }, info, false).length > 0);
  if (!fills && TASK_VERB.test(plain) && plain.split(/\s+/).length >= 3) {
    const replyDomains = detectDomains(text).filter(domain => domain !== 'conversation');
    if (!replyDomains.some(domain => frame.domains.includes(domain))) return 'new_goal';
  }
  if (!fills && DECLINE_REPLY.test(plain)) return 'decline';
  return 'answer';
}

export interface AppliedAnswer {
  frame: GoalFrame;
  record: ClarificationAnswerRecord;
  /** Slots whose value changed; any change bumps the version and invalidates approvals for the old one. */
  changed: SlotId[];
}

/** Applies one reply to a pending engine question. Never grants permission: it only records the user's values. */
export function applyAnswer(frame: GoalFrame, question: ClarificationQuestionSpec, reply: { optionId?: string | null; text?: string | null }, context: GoalContext = { request: frame.request }, now = new Date()): AppliedAnswer {
  const optionValues = question.optionValues;
  const text = reply.text?.trim() ?? '';
  let kind: ReplyKind = reply.optionId === 'stop' ? 'cancel' : reply.optionId === 'draft_only' ? 'decline' : text ? classifyReply(text, frame, question.slots, context) : 'answer';
  const before = new Map(frame.requirements.map(requirement => [requirement.slot, requirement.status === 'satisfied' ? comparable(requirement.slot, requirement.value ?? '') : null]));
  const added: GoalEvidence[] = [];
  if (kind === 'answer') {
    const chosen = reply.optionId ? optionValues[reply.optionId] : undefined;
    const index = frame.answers.length + 1;
    if (chosen) for (const [slot, value] of Object.entries(chosen) as [SlotId, string][]) added.push(...evidenceFrom(slot, [value], 'USER_CONSTRAINT', 'clarification_answer', now, { trusted: true }, index));
    if (text) {
      const info = { request: frame.request, history: true };
      const contextual = question.slots.length === 1;
      for (const slot of question.slots) {
        const values = valuesFor(slot, text, context, info, contextual);
        if (values.length) added.push(...evidenceFrom(slot, values.slice(0, 1), 'USER_CONSTRAINT', 'clarification_answer', now, { trusted: true }, index));
      }
    }
    if (!added.length && !chosen && text && DECLINE_REPLY.test(normalizeText(text))) kind = 'decline';
  }
  const constraints = kind === 'decline' && reply.optionId === 'draft_only' ? [...new Set([...frame.constraints, 'draft_only'])] : frame.constraints;
  const primaryStep = constraints.includes('draft_only') && (frame.primaryStep === 'external_write' || frame.primaryStep === 'spend') ? 'draft' : frame.primaryStep;
  const record: ClarificationAnswerRecord = { questionId: question.id, slots: [...question.slots], kind, filled: [...new Set(added.map(entry => entry.slot!).filter(Boolean))], at: iso(now) };
  const evidence = [...frame.evidence, ...added];
  while (evidence.length > MAX_EVIDENCE) {
    const drop = evidence.findIndex(entry => entry.source === 'memory' || entry.source === 'conversation');
    evidence.splice(drop >= 0 ? drop : 0, 1);
  }
  let next: GoalFrame = { ...frame, constraints, primaryStep, evidence, answers: [...frame.answers, record].slice(-8) };
  next = resolve(next, context);
  const changed = next.requirements.filter(requirement => {
    const after = requirement.status === 'satisfied' ? comparable(requirement.slot, requirement.value ?? '') : null;
    return (before.get(requirement.slot) ?? null) !== after;
  }).map(requirement => requirement.slot);
  const material = changed.length > 0 || primaryStep !== frame.primaryStep || kind === 'decline';
  next = { ...next, version: Math.min(1000, frame.version + (material ? 1 : 0)) };
  return { frame: GoalFrameSchema.parse(next), record, changed };
}

/**
 * A reply to a question the model asked, or any later user message in the task, may
 * revise a settled value ("make the budget 30"). Only explicit values are taken; a
 * bare number is not read as a budget here. Returns null when nothing changed.
 */
export function reviseFromMessage(frame: GoalFrame, text: string, context: GoalContext = { request: frame.request }, now = new Date()): AppliedAnswer | null {
  const info = { request: frame.request, history: true };
  const added: GoalEvidence[] = [];
  const index = frame.answers.length + 1;
  for (const requirement of frame.requirements) {
    if (requirement.slot === 'subject' || requirement.slot === 'change' || requirement.slot === 'ads_service') continue;
    const values = valuesFor(requirement.slot, text, context, info, false);
    if (values.length) added.push(...evidenceFrom(requirement.slot, values.slice(0, 1), 'USER_CONSTRAINT', 'clarification_answer', now, { trusted: true }, index));
  }
  if (!added.length) return null;
  const before = new Map(frame.requirements.map(requirement => [requirement.slot, requirement.status === 'satisfied' ? comparable(requirement.slot, requirement.value ?? '') : null]));
  const filled = [...new Set(added.map(entry => entry.slot!))];
  const record: ClarificationAnswerRecord = { questionId: `msg.${index}`, slots: filled.slice(0, 3), kind: 'answer', filled, at: iso(now) };
  const evidence = [...frame.evidence, ...added];
  while (evidence.length > MAX_EVIDENCE) {
    const drop = evidence.findIndex(entry => entry.source === 'memory' || entry.source === 'conversation');
    evidence.splice(drop >= 0 ? drop : 0, 1);
  }
  const next = resolve({ ...frame, evidence, answers: [...frame.answers, record].slice(-8) }, context);
  const changed = next.requirements.filter(requirement => (before.get(requirement.slot) ?? null) !== (requirement.status === 'satisfied' ? comparable(requirement.slot, requirement.value ?? '') : null)).map(requirement => requirement.slot);
  if (!changed.length) return null;
  return { frame: GoalFrameSchema.parse({ ...next, version: Math.min(1000, frame.version + 1) }), record, changed };
}

/** Records that an engine question was shown. Call only after it is persisted. */
export function markAsked(frame: GoalFrame, question: ClarificationQuestionSpec, now = new Date()): GoalFrame {
  return GoalFrameSchema.parse({ ...frame, asked: [...frame.asked, { id: question.id, slots: question.slots, at: iso(now) }].slice(-8) });
}

const QUESTION_SLOT_HINTS: [SlotId, RegExp][] = [
  ['ads_budget', /budget|ميزاني|كم تريد ان تصرف|spend/iu], ['ads_url', /\burl\b|link|landing|رابط|الموقع الالكتروني|صفح[ةه] الهبوط/iu],
  ['ads_location', /location|city|country|where|area|المنطق[ةه]|المدين[ةه]|الدول[ةه]|اين|اي منطق/iu], ['ads_language', /language|لغ[ةه]/iu],
  ['ads_service', /business|service|product|نشاط|خدم[ةه]|منتج/iu], ['project', /project|مشروع/iu], ['file_path', /file|path|ملف|مسار/iu],
  ['target_site', /website|site|الموقع/iu],
];

/**
 * Reviews a question the model wants to ask. Returns a reason to withhold it when the
 * answer is already known from trusted evidence or the same question was already asked.
 */
export function reviewModelQuestion(frame: GoalFrame, text: string, previous: readonly string[]): { verdict: 'allow' } | { verdict: 'known'; slots: SlotId[]; values: string[] } | { verdict: 'repeat' } {
  const plain = normalizeText(text).toLowerCase();
  const normalized = plain.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const earlier of previous) {
    const other = normalizeText(earlier).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (other && (other === normalized || jaccard(other, normalized) >= 0.8)) return { verdict: 'repeat' };
  }
  const slots = QUESTION_SLOT_HINTS.filter(([slot, pattern]) => pattern.test(plain) && frame.requirements.some(requirement => requirement.slot === slot)).map(([slot]) => slot);
  if (!slots.length) return { verdict: 'allow' };
  const known = slots.map(slot => frame.requirements.find(requirement => requirement.slot === slot)).filter((requirement): requirement is Requirement => Boolean(requirement && requirement.status === 'satisfied'));
  return known.length === slots.length ? { verdict: 'known', slots, values: known.map(requirement => requirement.value ?? '') } : { verdict: 'allow' };
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' ')), right = new Set(b.split(' '));
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / Math.max(1, new Set([...left, ...right]).size);
}

// ---------------------------------------------------------------------------
// Action-boundary checks and summaries
// ---------------------------------------------------------------------------

/**
 * Before a campaign is created in the account: the draft must use the budget, landing
 * page and location the user supplied, not values a model filled in.
 */
export function checkAdsCreation(frame: GoalFrame, draftText: string): { ok: boolean; reasons: ReadinessReason[] } {
  const reasons: ReadinessReason[] = [];
  const say = (ar: string, en: string) => frame.language === 'ar' ? ar : en;
  const value = (slot: SlotId) => frame.requirements.find(requirement => requirement.slot === slot && requirement.status === 'satisfied')?.value ?? null;
  const lines = (field: string) => [...draftText.matchAll(new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, 'gim'))].map(match => match[1]!);
  const budget = value('ads_budget');
  if (!budget) reasons.push({ code: 'ADS_BUDGET_UNCONFIRMED', message: say('لم تحدد الميزانية اليومية بنفسك بعد.', 'You have not set the daily budget yourself yet.'), slot: 'ads_budget' });
  else if (!lines('BUDGET').some(line => Number.parseFloat(normalizeText(line)) === Number.parseFloat(budget))) reasons.push({ code: 'ADS_BUDGET_MISMATCH', message: say(`ميزانية المسودة لا تطابق ما حددته (${budget}).`, `The draft budget does not match yours (${budget}).`), slot: 'ads_budget' });
  const url = value('ads_url');
  if (!url) reasons.push({ code: 'ADS_URL_UNCONFIRMED', message: say('لم تحدد رابط صفحة الهبوط بعد.', 'You have not given the landing page yet.'), slot: 'ads_url' });
  else if (!lines('URL').some(line => comparable('ads_url', line) === comparable('ads_url', url))) reasons.push({ code: 'ADS_URL_MISMATCH', message: say('رابط المسودة ليس الموقع الذي حددته.', 'The draft links to a different site than yours.'), slot: 'ads_url' });
  const location = value('ads_location');
  if (!location) reasons.push({ code: 'ADS_LOCATION_UNCONFIRMED', message: say('لم تحدد المنطقة المستهدفة بعد.', 'You have not set the target location yet.'), slot: 'ads_location' });
  else {
    const wanted = placeId(location);
    const drafted = [...lines('LOCATION'), ...lines('COUNTRY')];
    const matches = wanted ? drafted.some(line => placeId(line) === wanted || (wanted === 'uk' && /^gb$/i.test(line.trim())) || (wanted === 'saudi' && /^sa$/i.test(line.trim())) || (wanted === 'uae' && /^ae$/i.test(line.trim())))
      : drafted.some(line => normalizeText(line).toLowerCase().includes(normalizeText(location).toLowerCase()));
    if (!matches) reasons.push({ code: 'ADS_LOCATION_MISMATCH', message: say(`منطقة المسودة لا تطابق ما حددته (${location}).`, `The draft location does not match yours (${location}).`), slot: 'ads_location' });
  }
  if (frame.constraints.includes('draft_only')) reasons.push({ code: 'ADS_DRAFT_ONLY', message: say('طلبت مسودة فقط.', 'You asked for a draft only.'), slot: null });
  return { ok: reasons.length === 0, reasons };
}

/** The deterministic planning gate: model confidence is displayed, never used to decide. */
export function planNeedsClarification(plan: { goal: { clarifyingQuestions: readonly unknown[] }; uncertainties: readonly { impact: string }[]; steps: readonly { availability?: string }[] }): boolean {
  return plan.goal.clarifyingQuestions.length > 0 || plan.uncertainties.some(entry => entry.impact === 'high') || plan.steps.some(step => step.availability === 'unavailable');
}

export function summarizeGoal(frame: GoalFrame, assessment: ReadinessAssessment): ChatGoalSummary {
  const language = frame.language;
  const evidenceKind = (requirement: Requirement): GoalEvidence['kind'] => frame.evidence.find(entry => requirement.evidenceIds.includes(entry.id))?.kind ?? 'USER_CONSTRAINT';
  return {
    version: frame.version, outcome: assessment.outcome, status: assessment.status, domains: frame.domains,
    known: frame.requirements.filter(requirement => requirement.status === 'satisfied' && requirement.slot !== 'subject' && requirement.slot !== 'change' && requirement.slot !== 'ads_service')
      .map(requirement => ({ slot: requirement.slot, label: slotLabel(requirement.slot, language), value: (requirement.value ?? '').slice(0, 400), kind: evidenceKind(requirement) })).slice(0, 16),
    missing: frame.requirements.filter(requirement => ['missing', 'conflicting', 'declined'].includes(requirement.status) && (requirement.necessity === 'required' || requirement.slot === 'ads_conversion'))
      .map(requirement => ({ slot: requirement.slot, label: slotLabel(requirement.slot, language) })).slice(0, 16),
    assumptions: frame.requirements.filter(requirement => requirement.status === 'assumed').map(requirement => ({ slot: requirement.slot, label: slotLabel(requirement.slot, language), value: (requirement.value ?? '').slice(0, 400) })).slice(0, 16),
    blockers: assessment.reasons.filter(reason => reason.code !== 'APPROVAL_AT_BOUNDARY').slice(0, 12),
    steps: assessment.steps,
  };
}

/** Facts the user settled, written as one trusted line for the model's tool results. */
export function settledFacts(frame: GoalFrame): string {
  const items = frame.requirements.filter(requirement => (requirement.status === 'satisfied' || requirement.status === 'assumed') && requirement.slot !== 'subject' && requirement.slot !== 'change' && requirement.slot !== 'ads_service')
    .map(requirement => `${requirement.slot.replace(/^ads_/, '')}=${(requirement.value ?? '').slice(0, 120)}${requirement.status === 'assumed' ? ' (assumed)' : ''}`);
  const constraints = frame.constraints.length ? `; constraints: ${frame.constraints.join(', ')}` : '';
  return items.length || constraints ? `settled with the user: ${items.join('; ')}${constraints}` : '';
}
