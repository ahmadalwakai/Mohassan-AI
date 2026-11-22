/** Closed complete CURRENT-user PC reads only; no context, I/O or authority. */
const EN_SURFACE = '(?:(?:my|the|this|current|shared|open|active)\\s+){0,3}(?:pc|computer|notepad|desktop|terminal|application|program|window|screen)(?:\\s+(?:window|screen|dialog))?';
const EN_FIELD = '(?:(?:the|current)\\s+)?(?:title|text|message|contents?|button labels?)';
const AR_SURFACE = '(?:كمبيوتري|حاسوبي|جهازي|الكمبيوتر|الحاسوب|(?:نافذه|النافذه|شاشه|الشاشه)(?:\\s+(?:الكمبيوتر|الحاسوب|البرنامج))?(?:\\s+(?:الحاليه|المفتوحه|المشاركه|النشطه))?)';
const READ = new RegExp(`^(?:(?:read|view|inspect|look at|show)\\s+(?:${EN_FIELD}\\s+(?:of|on|in)\\s+)?${EN_SURFACE}|what (?:is|can you see|do you see) (?:(?:currently )?(?:visible|shown|displayed) )?(?:on|in) ${EN_SURFACE}|what does ${EN_SURFACE} (?:currently )?(?:show|display)|what is ${EN_FIELD} (?:of|on|in) ${EN_SURFACE}|(?:اقرا|اعرض|شوف|بص|شاهد|افحص|انظر)(?:\\s+(?:الي|في|داخل))?\\s+${AR_SURFACE}|(?:(?:ماذا|ما الذي) (?:يظهر|يعرض|يوجد)|ما (?:الظاهر|المعروض|الموجود)) (?:علي|في|داخل) ${AR_SURFACE})[.!?؟]*$`, 'u');
const AR_TITLE = /^ما عنوان (?:نافذه الكمبيوتر الحاليه|النافذه الحاليه)[.!?؟]*$/u;
const TITLE_HEAD = /^(?:(?:read|view|inspect|look at|show)\s+(?:(?:the|current)\s+)?title\s+(?:of|on|in)\s+|what is\s+(?:(?:the|current)\s+)?title\s+(?:of|on|in)\s+)/u;

/** No literal stripping: a quoted/report/body question is not an outer request. */
function matchingText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\u0000\ud800-\udfff]/u.test(value)) return null;
  return value.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().replace(/\s+/gu, ' ').trim()
    .replace(/^(?:(?:please|kindly|من فضلك|لو سمحت|رجاء)[,،:\s]+)+/u, '');
}
export function isCurrentComputerReadRequest(value: unknown): boolean {
  const text = matchingText(value);
  return text !== null && (READ.test(text) || AR_TITLE.test(text));
}
/** Exact title-field subset only; the complete shared read must also match. */
export function isCurrentComputerTitleReadRequest(value: unknown): boolean {
  const text = matchingText(value);
  return text !== null && (AR_TITLE.test(text) || READ.test(text) && TITLE_HEAD.test(text)
    && !/\b(?:notepad|desktop|terminal|application|program)\b/u.test(text));
}

/** Opaque sharing-origin metadata cannot verify a named app or surface kind. */
export function isUnverifiedComputerTitleTargetRequest(value: unknown): boolean {
  const text = matchingText(value);
  return text !== null && READ.test(text) && TITLE_HEAD.test(text)
    && /\b(?:notepad|desktop|terminal|application|program)\b/u.test(text);
}
