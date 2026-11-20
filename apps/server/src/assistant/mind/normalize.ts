import type { Lang } from './contract.js';

const ARABIC_MARKS = /[\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/gu;
const COURTESY = /^(?:please|kindly|من فضلك|لو سمحت|اذا سمحت|رجاء(?:ا)?|ارجوك)$/iu;
const COURTESY_START = new Set(['من', 'لو', 'اذا']);
const ADDRESS = /https?:\/\/[^\s<>«»"'`]+/giu;
const TRAILING_COURTESY = /[\s,،;؛]+(?:please|kindly|thanks|thank you|لو سمحت|[اإ]ذا سمحت|من فضلك|[اأ]رجوك|رجاء(?:ا)?|شكرا)[\s,.!?؟،]*$/iu;

function normalizeArabicDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));
}

/** Letter folding is used to match rules. It is never applied to a displayed value or URL. */
export function matchText(text: string): string {
  return normalizeArabicDigits(text.normalize('NFKC'))
    .replace(ARABIC_MARKS, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/[ىی]/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .toLowerCase();
}

/** Courtesy at the end is useful for matching without changing the request. */
export function stripCourtesyTail(text: string): string {
  return text.replace(TRAILING_COURTESY, '').trimEnd();
}

export function normalizeRequest(request: string): { text: string; match: string; lang: Lang } {
  const trimmed = request.trim();
  const words = /([\p{L}\p{M}ـ]+)[,،:\s]*/uy;
  let foreword = '';
  let prefixEnd = 0;
  for (let token = words.exec(trimmed); token; token = words.exec(trimmed)) {
    const word = matchText(token[1]);
    const phrase = foreword ? `${foreword} ${word}` : word;
    if (COURTESY.test(phrase)) {
      prefixEnd = words.lastIndex;
      foreword = '';
    } else if (!foreword && COURTESY_START.has(word)) {
      foreword = word;
    } else {
      break;
    }
  }
  const rest = trimmed.slice(prefixEnd);
  const normalized: string[] = [];
  let end = 0;
  for (const address of rest.matchAll(ADDRESS)) {
    normalized.push(normalizeArabicDigits(rest.slice(end, address.index).normalize('NFKC')).replace(ARABIC_MARKS, ''), address[0]);
    end = address.index + address[0].length;
  }
  normalized.push(normalizeArabicDigits(rest.slice(end).normalize('NFKC')).replace(ARABIC_MARKS, ''));
  const text = normalized.join('').trim();
  const spoken = (text || trimmed).replace(ADDRESS, ' ');
  const originalWords = trimmed.replace(ADDRESS, ' ');
  const englishLead = /^(?:who|what|where|when|why|how|which|is|are|does|do|did|can|could|find|open|check|read|write|translate|calculate|convert|compare|contrast|explain|tell|show|list|state|report|provide|present|display|return|quote|extract)\b/iu;
  const hasArabic = /\p{Script=Arabic}/u.test(spoken) || /[؟٠-٩۰-۹]/u.test(originalWords);
  const lang = hasArabic && !englishLead.test(spoken) ? 'ar' : 'en';
  return { text, match: matchText(text), lang };
}
