type Language = 'ar' | 'en';

interface Acknowledgement {
  language: Language;
  thanks: boolean;
}

// Sources retrieved 2026-11-27. Start with the request-context confirmations,
// then add the conversation-state approval vocabulary.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/request-context.ts#L130
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L262
const AR_CONTEXT_CONFIRMATIONS = ['نعم', 'لا', 'اي', 'ايوه', 'تمام', 'طيب', 'حسنا', 'موافق'];
const EN_CONTEXT_CONFIRMATIONS = ['yes', 'no', 'ok', 'okay', 'sure', 'fine', 'agreed'];
const AR_APPROVAL = [...AR_CONTEXT_CONFIRMATIONS, 'ايوا', 'اجل', 'اوافق', 'اكيد', 'ماشي'];
const EN_APPROVAL = [...EN_CONTEXT_CONFIRMATIONS, 'yeah', 'yep', 'nope'];
const NEGATIVE_APPROVAL = new Set(['لا', 'no', 'nope']);

export const acknowledgementForms: Readonly<Record<Language, readonly string[]>> = {
  ar: [
    ...AR_APPROVAL.filter(form => !NEGATIVE_APPROVAL.has(form)),
    // Existing hands spellings and Egyptian forms in Atlas of Arabic Dialects.
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/hands.ts#L362
    // https://www.atlasallhajaat.com/country_word/EG/1164
    'اوك', 'اوكي', 'اوكه',
    // Iraqi Dictionary and Darija Marocain dictionary, respectively.
    // https://www.iraqidictionary.com/word/zain
    // https://www.darijamarocain.com/en/mots/wakha.html
    'زين', 'واخا',
    // Published bilingual glossary, p. 4 (فهمت / “(I) got it”).
    // https://www.nok.se/contentassets/a2fc7104f8564436a6e6023b7714bcc3/skills5_ordlista_arabiska_tb_unit1.pdf#page=4
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/review/coverage.ts#L30
    'فهمت',
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L260
    'ممتاز', 'رائع', 'جميل', 'حلو',
  ],
  en: [
    ...EN_APPROVAL.filter(form => !NEGATIVE_APPROVAL.has(form)),
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/hands.ts#L362
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L260
    'good', 'great', 'nice', 'cool', 'perfect', 'awesome',
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/review/coverage.ts#L30
    'got it', 'understood',
    // https://dictionary.cambridge.org/dictionary/english/sure-thing?topic=words-and-phrases-expressing-agreement-and-acceptance
    'sure thing',
  ],
};

// Existing thanks vocabulary. Acknowledgement + thanks is composed from these
// entries, as in the Cambridge Dictionary example “Great, thanks.”
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L260
// https://dictionary.cambridge.org/dictionary/english/great
export const acknowledgementThanksForms: Readonly<Record<Language, readonly string[]>> = {
  ar: ['شكرا', 'شكرا لك', 'شكرا جزيلا', 'شكرا كثيرا', 'مشكور', 'تسلم', 'يعطيك العافيه', 'الله يعطيك العافيه'],
  en: ['thanks', 'thank you', 'thx'],
};

const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').toLowerCase();
const trimPunctuation = (text: string) => text.replace(/^[\s،,.!؟?:؛;]+|[\s،,.!؟?:؛;]+$/gu, '');
const whole = (text: string) => trimPunctuation(fold(text));
const QUESTION_END = /[؟?][\s،,.!؟?:؛;]*$/u;

export function matchAcknowledgement(text: string): Acknowledgement | null {
  const folded = fold(text);
  if (QUESTION_END.test(folded)) return null;
  const candidate = trimPunctuation(folded);
  const language = /\p{Script=Arabic}/u.test(candidate) ? 'ar' : 'en';
  const forms = acknowledgementForms[language];
  if (forms.includes(candidate)) return { language, thanks: false };
  for (const thanks of acknowledgementThanksForms[language]) {
    if (candidate === thanks) return { language, thanks: true };
    if (!candidate.endsWith(thanks)) continue;
    const before = candidate.slice(0, -thanks.length);
    if (!/[،,\s]$/u.test(before)) continue;
    const lead = before.replace(/[،,\s]+$/u, '');
    if (forms.includes(lead)) return { language, thanks: true };
    // A polite refusal gets the plain reply. Arabic follows the attested شكرا construction.
    // https://dictionary.cambridge.org/grammar/british-grammar/thank-you
    // https://pure.manchester.ac.uk/ws/portalfiles/portal/57431091/FULL_TEXT.PDF#page=186
    if (NEGATIVE_APPROVAL.has(lead) && (language === 'en' || /^شكرا(?: |$)/u.test(thanks))) return { language, thanks: false };
  }
  return null;
}

export function isBareAcknowledgement(text: string): boolean {
  return matchAcknowledgement(text) !== null;
}

/** The existing exact replies that cannot supply a pending card's literal field value. */
export function isContextConfirmation(text: string): boolean {
  const candidate = fold(text).replace(/[.!?؟]+$/u, '');
  return AR_CONTEXT_CONFIRMATIONS.includes(candidate) || EN_CONTEXT_CONFIRMATIONS.includes(candidate);
}

// Atlas of Arabic Dialects, Cambridge Dictionary and the existing manners copy.
// https://www.atlasallhajaat.com/public/word/1164
// https://dictionary.cambridge.org/dictionary/english/all-right
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/manners/replies.ts#L17-L19
export function acknowledgementText(match: Acknowledgement): string {
  if (match.language === 'ar') return match.thanks ? 'العفو!' : 'تمام.';
  return match.thanks ? 'You’re welcome!' : 'All right.';
}

/** Remove a punctuation-delimited conversational lead, preserving the original substantive text. */
export function stripAcknowledgementLead(text: string): string {
  if (isBareAcknowledgement(text)) return text;
  let rest = text;
  for (const delimiter of text.matchAll(/[،,؛;:]|[.!](?=\s)/gu)) {
    const lead = text.slice(0, delimiter.index);
    if (!isBareAcknowledgement(lead) || NEGATIVE_APPROVAL.has(whole(lead).split(/[،,\s]/u, 1)[0])) break;
    const tail = text.slice(delimiter.index + 1).trimStart();
    if (tail) rest = tail;
  }
  return rest;
}

// Preserve the original approval prefix and confirmation rules. Understanding
// and gratitude on their own carry no approval meaning.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state.ts#L262
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/conversation-state-decisions.ts#L44
const APPROVAL_START = new RegExp(`^(?:${[...AR_APPROVAL, ...EN_APPROVAL, 'يلا', 'approve', 'approved'].join('|')})(?!\\p{L})`, 'u');
const CONFIRMATION_LEADS = 'طيب|تمام|حسنا|موافق|اوكي|ok|okay|yes|sure';
const CONFIRMATION_FORMS = [
  ...AR_APPROVAL.filter(form => form !== 'طيب'), 'ايه', 'اه', 'طبعا', 'صحيح', 'اوكي', 'يلا', 'كمل', 'اكمل', 'تابع', 'واصل', 'نفذ', 'تم', 'خلصت',
  ...EN_APPROVAL, 'yup', 'approved', 'correct', 'exactly', 'done', 'go ahead', 'go on', 'proceed', 'continue', 'do it', 'carry on', 'resume',
].join('|');
const CONFIRMATION = new RegExp(`^(?:(?:${CONFIRMATION_LEADS})[،,\\s]+)?(?:${CONFIRMATION_FORMS})(?:\\s+(?:شكرا|please|thanks|من فضلك))?$`, 'u');

export function startsCardApproval(text: string): boolean {
  return APPROVAL_START.test(whole(text));
}

export function isCardConfirmation(text: string): boolean {
  const folded = fold(text);
  const candidate = trimPunctuation(folded);
  return !(candidate === 'ايه' && QUESTION_END.test(folded)) && CONFIRMATION.test(candidate);
}
