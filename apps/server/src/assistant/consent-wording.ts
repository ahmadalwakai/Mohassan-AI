/** Matching only. Keep the original user wording for payloads and source spans. */
export function foldConsentWording(text: string): string {
  // Existing verification folding, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/memory-verification.ts#L71-L72
  return text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/’/gu, "'").toLowerCase().replace(/\s+/gu, ' ').trim();
}

// Leading memory directives from the existing brain and structured memory parser, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/brain.ts#L52-L54
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/structured-memory-parser.ts#L26-L28
const REMEMBER_AR = /^(?:(?:من فضلك|لو سمحت|رجاء)[،,\s]+)?(?:تذكر|احفظ|لا تنسي?|افتكر|خلي (?:ب ?ذاكرتك|في ذاكرتك|ببالك))(?=[\s:،,])/u;
const REMEMBER_EN = /^(?:please[,\s]+)?(?:remember|don'?t forget|save (?:this|that|it)|keep in mind)\b/u;

// Negation markers and memory operations from the existing verification and constraint rules,
// including dialect corrections in request context, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/memory-verification.ts#L79-L83
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/brain.ts#L54
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/request-constraints.ts#L105-L122 (including ما ... ش)
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/request-context.ts#L307-L318
const NEGATION_EN = String.raw`(?:do not|don'?t|never)`;
const MEMORY_NEGATION_EN = `(?:${NEGATION_EN}|avoid)`;
const NEGATION_AR = String.raw`(?:(?:لا|ما)\s*|(?:مش|مو|ممنوع|بلاش) )`;
const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
const WORD_END = String.raw`(?![\p{L}\p{N}])`;
const NEGATIVE_PHRASE_AR = String.raw`${WORD_START}(?:و\s*)?${NEGATION_AR}`;
const MEMORY_VERBS_EN = 'save|store|record|remember';
const MEMORY_VERBS_AR = 'تحفظ|تخزن|تسجل|تتذكر';
const ARABIC_OBJECT_SUFFIX = '(?:ها|ه)?';
const NO_MEMORY_WRITE_EN = new RegExp(String.raw`\b(?:${MEMORY_NEGATION_EN}|not) (?:${MEMORY_VERBS_EN}|write|change|update)\b|\b(?:no|without) (?:saving|storing)\b`, 'u');
const NO_MEMORY_WRITE_AR = new RegExp(`${NEGATIVE_PHRASE_AR}(?:${MEMORY_VERBS_AR}|تكتب|تضف|تعدل|تغير|تحدث)${ARABIC_OBJECT_SUFFIX}ش?${WORD_END}`, 'u');

function deniesMemoryWriteIn(text: string): boolean {
  // Require a matching operation after the negator. Arabic ما can introduce a relative clause.
  return NO_MEMORY_WRITE_AR.test(text) || NO_MEMORY_WRITE_EN.test(text);
}

export function deniesMemoryWrite(request: string): boolean {
  return deniesMemoryWriteIn(foldConsentWording(request));
}

/** A leading directive gives permission only if the full request permits the write. */
export function asksToRemember(request: string): boolean {
  const text = foldConsentWording(request);
  return !/[?؟]$/u.test(text) && !deniesMemoryWriteIn(text) && (REMEMBER_AR.test(text) || REMEMBER_EN.test(text));
}

// The verification questions accept a closed write-only clause with the same verb lists.
// The allowed objects are from the two existing verifiers, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/memory-verification.ts#L79-L83
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/user-fact-memory-verification.ts#L60-L67
function writeOnlyPattern(englishObject: string, arabicObject: string): RegExp {
  const english = `${MEMORY_NEGATION_EN} (?:${MEMORY_VERBS_EN})(?: (?:anything|any (?:data|information)|it|this|that|the (?:${englishObject})))?(?: (?:in|to) (?:my |your |the )?memory)?`;
  const arabic = `${NEGATION_AR}(?:${MEMORY_VERBS_AR})${ARABIC_OBJECT_SUFFIX}ش?(?: (?:اي شيء|شيئا|${arabicObject}|البيانات|المعلومات))?(?: في (?:ذاكرتي|ذاكرتك|الذاكره))?`;
  return new RegExp(`^(?:${english}|${arabic})$`, 'u');
}
const WRITE_ONLY_RESULT = writeOnlyPattern('result|answer|value', 'النتيجه|الناتج|الجواب');
const WRITE_ONLY_NOTE = writeOnlyPattern('note|statement', 'الملاحظه|العباره');

export function isMemoryWriteOnlyProhibition(request: string, subject: 'result' | 'note'): boolean {
  const text = foldConsentWording(request).replace(/^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)+/u, '');
  return (subject === 'result' ? WRITE_ONLY_RESULT : WRITE_ONLY_NOTE).test(text);
}

// Draft and publication wording from the original Ads gate, production publication
// signals and the published V1 development split, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/tools.ts#L87-L93
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/monitors/decision/signals.ts#L51
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/conversation-state.ts#L259
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/brain.ts#L43-L44
// https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/development.json (dev-google-ads-163 to 176)
const DRAFT_ONLY_EN = /\b(?:(?:draft|preview)[ -]+only|(?:only|as) (?:a )?(?:draft|preview)|campaign draft|draft campaign|(?:create|build|save|prepare) (?:a |the )?(?:draft|preview)|(?:keep|leave) (?:it|the campaign) (?:a )?draft)\b/u;
const DRAFT_ONLY_AR = new RegExp(`${WORD_START}(?:(?:مسوده|معاينه) (?:فقط|بس)|(?:فقط|بس) (?:مسوده|معاينه)|(?:خليها|(?:ال)?حمله) مسوده|مسوده (?:ال)?حمله)${WORD_END}`, 'u');
const NO_CAMPAIGN_WRITE_EN = new RegExp(String.raw`\b(?:${NEGATION_EN}|unpublished|not (?:yet )?published|not (?:create|save|publish|launch)|(?:no|without) (?:publishing|publication))\b`, 'u');
const NO_CAMPAIGN_WRITE_AR = new RegExp(String.raw`${NEGATIVE_PHRASE_AR}(?:تنش|تعمل|تحفظ|تبن|تطلق|تفعل)\p{L}*|${WORD_START}(?:غير منشور(?:ه)?|لم تنشر|(?:من غير|بدون|دون) نشر)${WORD_END}`, 'u');

function deniesCampaignCreationIn(text: string): boolean {
  return DRAFT_ONLY_EN.test(text) || DRAFT_ONLY_AR.test(text)
    || NO_CAMPAIGN_WRITE_EN.test(text) || NO_CAMPAIGN_WRITE_AR.test(text);
}

export function deniesCampaignCreation(request: string): boolean {
  return deniesCampaignCreationIn(foldConsentWording(request));
}

// Affirmative account-creation wording preserved from the original gate, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/tools.ts#L88-L93
const CREATE_CAMPAIGN_EN = /^(?:(?:please|can you|could you|i want you to) ){0,2}(?:create|build|save)\b/u;
const CREATE_CAMPAIGN_AR = /^(?:(?:من فضلك|لو سمحت) )?(?:(?:اريد|احتاج)(?: منك)? (?:ان )?(?:تنشئ|انشاء|تبني|بناء|تحفظ|حفظ)|انشئ|انشاء|ابن|ابني|احفظ)(?: |$)/u;

export function requestsPausedCampaign(request: string): boolean {
  const text = foldConsentWording(request);
  return !deniesCampaignCreationIn(text) && (CREATE_CAMPAIGN_EN.test(text) || CREATE_CAMPAIGN_AR.test(text))
    && /حمله|\bcampaign\b/u.test(text) && /حساب|google ads|جوجل ادز|غوغل ادز|\baccount\b/u.test(text);
}
