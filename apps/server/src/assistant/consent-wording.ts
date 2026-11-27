function normalizeConsentWording(text: string): string {
  // Existing verification folding, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/memory-verification.ts#L71-L72
  return text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/’/gu, "'").toLowerCase().trim();
}

/** Matching only. Keep the original user wording for payloads and source spans. */
export function foldConsentWording(text: string): string {
  return normalizeConsentWording(text).replace(/\s+/gu, ' ');
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
const NEGATION_EN = String.raw`(?:do\s+not|don'?t|never)`;
const MEMORY_NEGATION_EN = `(?:${NEGATION_EN}|avoid)`;
const NEGATION_AR = String.raw`(?:(?:لا|ما)\s*|(?:مش|مو|ممنوع|بلاش)\s+)`;
const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
const WORD_END = String.raw`(?![\p{L}\p{N}])`;
const NEGATIVE_PHRASE_AR = String.raw`${WORD_START}(?:و\s*)?${NEGATION_AR}`;
const MEMORY_VERBS_EN = 'save|store|record|remember';
const MEMORY_VERBS_AR = 'تحفظ|تخزن|تسجل|تتذكر';
const ARABIC_OBJECT_SUFFIX = '(?:ها|ه)?';
// Clause boundaries from the baseline check above and the owner's PR #171 review, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/pull/171
const MEMORY_CLAUSE_START = String.raw`(?:^|[.!?؟،,;\r\n]\s*|${WORD_START}(?:(?:و\s*)?(?:بس|لكن|but|and)\s+|و\s*))`;
const NO_MEMORY_WRITE_EN = new RegExp(String.raw`${MEMORY_CLAUSE_START}(?:please\s+)?(?:(?:${MEMORY_NEGATION_EN}|not)\s+(?:${MEMORY_VERBS_EN}|write|change|update)|(?:no|without)\s+(?:saving|storing))\b`, 'u');
const NO_MEMORY_WRITE_AR = new RegExp(`${MEMORY_CLAUSE_START}${NEGATION_AR}(?:${MEMORY_VERBS_AR}|تكتب|تضف|تعدل|تغير|تحدث)${ARABIC_OBJECT_SUFFIX}ش?${WORD_END}`, 'u');

function deniesMemoryWriteIn(text: string): boolean {
  // Inside a fact, a negated verb can describe its subject and ما can introduce a relative clause.
  return NO_MEMORY_WRITE_AR.test(text) || NO_MEMORY_WRITE_EN.test(text);
}

export function deniesMemoryWrite(request: string): boolean {
  return deniesMemoryWriteIn(normalizeConsentWording(request));
}

/** A leading directive gives permission only if the full request permits the write. */
export function asksToRemember(request: string): boolean {
  const text = normalizeConsentWording(request);
  if (/[?؟]$/u.test(text) || deniesMemoryWriteIn(text)) return false;
  const folded = text.replace(/\s+/gu, ' ');
  return REMEMBER_AR.test(folded) || REMEMBER_EN.test(folded);
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
// https://github.com/ahmadalwakai/Mohassan-AI/blob/2a4498e1de09edf9c4a7b2847754d197e5146b85/apps/server/src/assistant/tools.ts#L90
// https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/development.json (dev-google-ads-163 to 176)
const DRAFT_ONLY_EN = /\b(?:(?:draft|preview)[ -]+only|(?:only|as) (?:a )?(?:draft|preview)|campaign draft|draft campaign|(?:create|build|save|prepare) (?:a |the )?(?:draft|preview)|(?:keep|leave) (?:it|the campaign) (?:a )?draft)\b/u;
const DRAFT_ONLY_AR = new RegExp(`${WORD_START}(?:(?:مسوده|معاينه) (?:فقط|بس)|(?:فقط|بس) (?:مسوده|معاينه)|(?:خليها|(?:ال)?حمله) مسوده|مسوده (?:ال)?حمله)${WORD_END}`, 'u');
const CAMPAIGN_WRITE_EN = 'create|build|save|make|set up|publish';
const NO_CAMPAIGN_WRITE_EN = new RegExp(String.raw`\b(?:(?:${NEGATION_EN}|not) (?:${CAMPAIGN_WRITE_EN})|unpublished|not (?:yet )?published|(?:no|without) (?:publishing|publication))\b`, 'u');
const NO_CAMPAIGN_WRITE_AR = new RegExp(String.raw`${NEGATIVE_PHRASE_AR}(?:تنش|تعمل|تحفظ|تبن)\p{L}*|${WORD_START}(?:غير منشور(?:ه)?|لم تنشر|(?:من غير|بدون|دون) نشر)${WORD_END}`, 'u');

/** Check wording already normalized by foldConsentWording. */
export function deniesFoldedCampaignCreation(text: string): boolean {
  return DRAFT_ONLY_EN.test(text) || DRAFT_ONLY_AR.test(text)
    || NO_CAMPAIGN_WRITE_EN.test(text) || NO_CAMPAIGN_WRITE_AR.test(text);
}

/** Recheck the owner's request and recorded answers before handing off an Ads draft. */
export function deniesCampaignHandoff(request: string, trail: readonly { action: string; result: string }[]): boolean {
  // The host records clarification answers in the run trail, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L4197-L4199
  const answerPrefix = 'user answered: ';
  return deniesFoldedCampaignCreation(foldConsentWording(request)) || trail.some(({ action, result }) =>
    action === 'asked the user' && result.startsWith(answerPrefix)
    && deniesFoldedCampaignCreation(foldConsentWording(result.slice(answerPrefix.length))));
}
