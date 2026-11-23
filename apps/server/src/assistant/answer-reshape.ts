/**
 * Shortening the previous answer without a model (2026-11-23): «اختصر جوابك السابق في جملة واحدة», «لخّصه», «باختصار»,
 * "make it shorter", "in one sentence". The reply is the previous answer's own opening sentences with its source line, quoted
 * and never rewritten. Until 2026-11-23 these requests were refused as a reference the web search cannot follow
 * (artifacts/conversation-quality-2026-11-23/long-before, turn 17). The whole message must be the request: «لخص لي مقالة عن
 * الطاقة» or «لخص الخبر الثالث» name something else to summarise and keep their own paths.
 */
export interface ShorterRequest { sentences: number; lang: 'ar' | 'en' }

const AR = /^(?:من فضلك\s+|لو سمحت\s+)?(?:(?:اختصر|إختصر|اختصري|لخص|لخّص|لخصي|أوجز|اوجز)(?:ه|ها)?(?:\s+لي)?(?:\s+(?:جوابك|إجابتك|اجابتك|ردك|الجواب|الإجابة|الاجابة|الرد|كلامك)(?:\s+(?:السابق|السابقة|الأخير|الاخير|الأخيرة|الاخيرة))?)?|باختصار|بإيجاز|أقصر|اقصر|بشكل (?:أقصر|اقصر|مختصر)|(?=(?:في|ب)\s*(?:جمل|سطر)))(?:\s*(?:في|ب)\s*(جملة|جمله|جملتين|سطر|سطرين)(?:\s+(?:واحدة|واحده|واحد))?)?[\s.!؟?]*$/u;
const EN = /^(?:please\s+)?(?:make (?:it|that|this) shorter|shorter|shorten (?:it|that|this|your (?:answer|reply))|summari[sz]e (?:it|that|this|your (?:answer|reply))|tl;?dr|briefly|(?=in\s+(?:one|a single|two)\s+sentences?))(?:\s*,?\s*in\s+(one|a single|two)\s+sentences?)?[\s.!?]*$/iu;

/** The request to shorten the previous answer, with the number of sentences asked for (one unless two are named). */
export function shorterRequest(text: string): ShorterRequest | null {
  const message = text.normalize('NFC').replace(/[ً-ٰٟ]/gu, '').trim();
  if (!message || message.length > 80) return null;
  const ar = AR.exec(message);
  if (ar && ar[0].trim()) return { sentences: /جملتين|سطرين/u.test(ar[1] ?? '') ? 2 : 1, lang: 'ar' };
  const en = EN.exec(message);
  if (en && en[0].trim()) return { sentences: /two/iu.test(en[1] ?? '') ? 2 : 1, lang: 'en' };
  return null;
}

/** Markdown as plain text: links keep their words, emphasis marks go. */
const plain = (text: string) => text.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1').replace(/\*\*|__|`/gu, '').replace(/^>\s?/gmu, '').trim();

/**
 * The previous answer's first `sentences` sentences, from its first paragraph that is not a label line («**عنوان الصفحة:**»),
 * then its source line when it had one. Null when there is no text to shorten.
 */
export function shorterAnswer(previous: string, request: ShorterRequest): string | null {
  const paragraphs = previous.split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean);
  const lead = paragraphs.find(part => !/^\*\*[^*]{1,40}:\*\*/u.test(part) && !/^[-*]\s/u.test(part) && !/^\d+\.\s/u.test(part));
  if (!lead) return null;
  // A sentence ends at . ! ? ؟ followed by a space, never inside a number («2.5»).
  const sentences = plain(lead).replace(/\s*\n\s*/gu, ' ').split(/(?<=[.!?؟])\s+/u).filter(Boolean);
  const short = sentences.slice(0, request.sentences).join(' ').trim();
  if (!short) return null;
  const source = previous.split('\n').find(line => /^\*\*(?:المصدر|Source):\*\*/u.test(line.trim()));
  return source ? `${short}\n\n${source.trim()}` : short;
}

/** Said when the conversation holds no earlier answer to shorten. */
export function noPreviousAnswer(lang: 'ar' | 'en'): string {
  return lang === 'ar' ? 'لا يوجد في هذه المحادثة جواب سابق أختصره. اسألني أولًا، ثم اطلب الاختصار.' : 'There is no earlier answer in this conversation to shorten. Ask me first, then ask for a shorter answer.';
}
