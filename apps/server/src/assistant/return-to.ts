/**
 * «ارجع إلى أينشتاين: أين ولد؟», «بالعودة إلى النيل، كم طوله؟», "back to Einstein: where was he born?": the question, about the
 * subject named before it («أين ولد أينشتاين»). On 2026-11-23 the whole sentence was refused as a reference the search
 * cannot follow (artifacts/conversation-quality-2026-11-23/long-before, turn 11). Null for any other text.
 *
 * Its own module with no imports: the hands build the search from it (hands.ts webQuestion) and the request classifier
 * reads the same question (request-context.ts requestActionText), so the search guard judges what is searched.
 */
export function returnedTo(text: string): string | null {
  const parts = returnParts(text);
  return parts ? `${parts.question} ${parts.subject}` : null;
}

/** The subject returned to and the question about it, or null. */
export function returnParts(text: string): { subject: string; question: string } | null {
  const match = /^(?:(?:لن|ل|و)?(?:ارجع|إرجع|نرجع|عد|عُد|نعود|بالعودة|بالرجوع|رجوعًا|رجوعا|عودة)\s+(?:إلى|الى|ل|على)\s*|(?:let'?s\s+)?(?:go(?:ing)?\s+)?back\s+to\s+|returning\s+to\s+)(\S.{0,58}?)\s*[:،,؛—]\s*(\S.+)$/iu.exec(text.trim());
  // Only a question follows: «ارجع إلى الصفحة الرئيسية، ثم اضغط على الأخبار» is a browser command and stays as it is.
  if (!match || !QUESTION.test(match[2]!.trim())) return null;
  return { subject: match[1]!.trim(), question: match[2]!.trim().replace(/[؟?]\s*$/u, '') };
}

const fold = (text: string) => text.normalize('NFKC').replace(/[ً-ٰٟـ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().trim();

/**
 * The fuller name this conversation read the subject under: «أينشتاين» → «ألبرت أينشتاين» when an earlier answer was read
 * from that article. Searched as the one word, «أين ولد أينشتاين» was answered from the page of his father («هرمان
 * أينشتاين», long-final turn 11, 2026-11-23). `titles` are the titles of the pages earlier answers were read from, newest
 * first. Null when no title holds the subject as whole words.
 */
export function fullerName(subject: string, titles: readonly string[]): string | null {
  const words = fold(subject).split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  for (const title of titles) {
    const own = fold(title).split(/\s+/u).filter(Boolean);
    if (own.length > words.length && words.every(word => own.includes(word))) return title.trim();
  }
  return null;
}

const QUESTION = /[؟?]$|^(?:و)?(?:متى|متي|أين|اين|وين|كم|ما|ماذا|من|مين|هل|كيف|لماذا|ليش|أي|اي)(?=\s|$)|^(?:what|when|where|who|whom|how|why|which|is|are|was|were|did|does|do)\b/iu;
