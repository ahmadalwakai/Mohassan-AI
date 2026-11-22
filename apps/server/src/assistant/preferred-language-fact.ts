/** A recorded self-assertion, never a profile/style instruction or factual truth. */
export interface PreferredLanguageFact {
  property: 'preferred_language';
  subject: 'self';
  languageId: 'ar' | 'en';
  quote: string;
  value: string;
  /** Half-open UTF-16 offsets into the unchanged quote. */
  valueSpan: { start: number; end: number };
}

export interface PreferredLanguageRequest {
  property: 'preferred_language';
  subject: 'self';
}

const normalize = (value: string) => value.normalize('NFKC')
  .replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\p{C}\u2028\u2029]/u.test(value);
}

function matchingSource(raw: string) {
  let text = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const point of raw) {
    const normalized = normalize(point);
    for (let index = 0; index < normalized.length; index++) {
      starts.push(offset); ends.push(offset + point.length);
    }
    text += normalized; offset += point.length;
  }
  return { text, starts, ends };
}

const fact = /^(i prefer |my preferred language is |(?:انني|انا) افضل |لغتي المفضله هي )(arabic|english|العربيه|الانجليزيه)([.!]?)$/u;

/**
 * Recognizes only whole, supported first-person statements in an actual memory
 * quote. The caller must separately establish the source is owner memory.
 * Source wrappers, quoted sentences, other subjects, clauses and actions fail
 * closed. Matching normalization never rewrites the original value or quote.
 */
export function parsePreferredLanguageFact(quote: unknown): PreferredLanguageFact | null {
  if (!boundedText(quote, 320)) return null;
  const view = matchingSource(quote), match = fact.exec(view.text);
  if (!match || view.text !== normalize(quote)) return null;
  // Keep the supported native/copular forms language-specific. This does not
  // turn an arbitrary Arabic-valued statement into a self language preference.
  const english = match[1] === 'i prefer ' || match[1] === 'my preferred language is ';
  if (english !== /^(?:arabic|english)$/u.test(match[2]!)) return null;
  const start = view.ends[match[1]!.length - 1];
  const end = match[3] ? view.starts[view.text.length - 1] : quote.length;
  if (start === undefined || end === undefined || start >= end) return null;
  const value = quote.slice(start, end);
  // Include any original Arabic combining marks/tatweel at the value edges;
  // require the entire original slice still be exactly the matched value.
  if (normalize(quote.slice(0, start)) !== match[1] || normalize(value) !== match[2]) return null;
  return { property: 'preferred_language', subject: 'self',
    languageId: /^(?:arabic|العربيه)$/u.test(match[2]!) ? 'ar' : 'en',
    quote, value, valueSpan: { start, end } };
}

const question = /^(?:from my memory,? (?:return my preferred language only[.]?|what is my preferred language\?)|من ذاكرتي[،,]? (?:اعد لغتي المفضله فقط[.]?|ما لغتي المفضله[؟?]))$/u;

/** A closed current private-read question, with no embedded source/action text. */
export function recognizePreferredLanguageRequest(request: unknown): PreferredLanguageRequest | null {
  return boundedText(request, 400) && question.test(normalize(request))
    ? { property: 'preferred_language', subject: 'self' } : null;
}

/** Non-value retrieval hint for the SAME one owner-memory read; no extra I/O. */
export function projectPreferredLanguageMemoryQuery(request: unknown): string | null {
  if (typeof request !== 'string' || !recognizePreferredLanguageRequest(request)) return null;
  const projected = `${request} prefer أفضل افضل`;
  return projected.length <= 500 ? projected : null;
}
