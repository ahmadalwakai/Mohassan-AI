/**
 * Shortening the previous answer without a model (2026-11-23): «اختصر جوابك السابق في جملة واحدة», «لخّصه», «باختصار»,
 * "make it shorter", "in one sentence". The reply quotes the previous answer's sentences or list items with their sources.
 * Until 2026-11-23 these requests were refused as a reference the web search cannot follow
 * (artifacts/conversation-quality-2026-11-23/long-before, turn 17). The whole message must be the request: «لخص لي مقالة عن
 * الطاقة» or «لخص الخبر الثالث» name something else to summarise and keep their own paths.
 */
export interface ShorterRequest { sentences: number; lang: 'ar' | 'en'; asSentences?: true }

const AR = /^(?:من فضلك\s+|لو سمحت\s+)?(?:(?:اختصر|إختصر|اختصري|لخص|لخّص|لخصي|أوجز|اوجز)(?:ه|ها)?(?:\s+لي)?(?:\s+(?:جوابك|إجابتك|اجابتك|ردك|الجواب|ال[إا]جاب[ةه]|الرد|كلامك|القائمة)(?:\s+(?:السابق|السابقة|الأخير|الاخير|الأخيرة|الاخيرة))?)?|باختصار|بإيجاز|أقصر|اقصر|بشكل (?:أقصر|اقصر|مختصر)|(?=(?:في|ب)\s*(?:جمل|سطر)))(?:\s*(?:في|ب)\s*(جملة|جمله|جملتين|سطر|سطرين)(?:\s+(?:واحدة|واحده|واحد))?)?[\s.!؟?]*$/u;
const EN = /^(?:please\s+)?(?:make (?:it|that|this|the list) shorter|shorter|shorten (?:it|that|this|the list|your (?:answer|reply))|summari[sz]e (?:it|that|this|your (?:answer|reply))|tl;?dr|briefly|(?=in\s+(?:one|a single|two)\s+sentences?))(?:\s*,?\s*in\s+(one|a single|two)\s+sentences?)?[\s.!?]*$/iu;

/** The request to shorten the previous answer, with the number of sentences asked for (one unless two are named). */
export function shorterRequest(text: string): ShorterRequest | null {
  const message = text.normalize('NFC').replace(/[ً-ٰٟ]/gu, '').trim();
  if (!message || message.length > 80) return null;
  const ar = AR.exec(message);
  if (ar && ar[0].trim()) return { sentences: /جملتين|سطرين/u.test(ar[1] ?? '') ? 2 : 1, lang: 'ar', ...(ar[1]?.startsWith('جمل') && { asSentences: true }) };
  const en = EN.exec(message);
  if (en && en[0].trim()) return { sentences: /two/iu.test(en[1] ?? '') ? 2 : 1, lang: 'en', ...(en[1] && { asSentences: true }) };
  return null;
}

const SOURCE = /\*\*(?:المصدر|Source):\*\*/u;
const LABEL = /^\*\*[^*]{1,40}:\*\*/u;
const ITEM = /^([-*+•]|[0-9٠-٩۰-۹]+[.)])[ \t]+/u;
const LINK = /\[[^\]]+\]\((?:[^()]|\([^()]*\))*\)/gu;
const STANDALONE_CITATION = new RegExp(`^(?:[—–-]\\s*)?(?:${LINK.source}|\\(${LINK.source}\\))[.!?؟]?$`, 'u');
const SENTENCE_END = /[.!?؟](?:\*\*|__|`|["”»’)\]])*$/u;

interface AnswerPart {
  marker: string;
  supplemental: boolean;
  text: string;
  sources: string[];
}

function answerParts(previous: string) {
  const parts: AnswerPart[] = [];
  const sources: string[] = [];
  let part: AnswerPart | undefined;
  let afterLabel = false;
  for (const rawLine of previous.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sourceAt = line.search(SOURCE);
    if (sourceAt === 0) {
      const lastPart = parts.at(-1);
      if (lastPart?.marker && /^\s/u.test(rawLine)) lastPart.sources.push(line);
      else {
        sources.push(line);
        part = undefined;
        afterLabel = false;
      }
      continue;
    }
    const label = LABEL.test(line);
    if (!line || label) {
      if (label) afterLabel = true;
      part = undefined;
      continue;
    }
    const item = ITEM.exec(line);
    if (item || !part) {
      if (!item) afterLabel = false;
      part = { marker: item?.[1] ?? '', supplemental: afterLabel, text: '', sources: [] };
      parts.push(part);
    }
    const text = line.slice(item?.[0].length ?? 0, sourceAt < 0 ? undefined : sourceAt).replace(/^>\s?/u, '').trim();
    part.text = part.text ? `${part.text} ${text}` : text;
    if (sourceAt > 0) part.sources.push(line.slice(sourceAt));
  }
  return { parts, sources };
}

function sentencesIn(text: string): string[] {
  // Mask links at their original offsets so punctuation in link labels cannot break the Markdown.
  const masked = text.replace(LINK, link => '_'.repeat(link.length));
  const sentences: string[] = [];
  let start = 0;
  for (const gap of masked.matchAll(/(?<=[.!?؟])(?:\*\*|__|`|["”»’)\]])*\s+/gu)) {
    const end = gap.index + gap[0].length;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

function excerptPart(part: AnswerPart) {
  const sentences = sentencesIn(part.text);
  const last = sentences.at(-1);
  if (part.marker && sentences.length > 1 && last && STANDALONE_CITATION.test(last)) {
    sentences.pop();
    return { ...part, text: sentences.join(' '), sentences, sources: [last, ...part.sources] };
  }
  return { ...part, sentences };
}

/** Extract a shorter reply from the previous answer. Null means there is no shorter excerpt. */
export function shorterAnswer(previous: string, request: ShorterRequest): string | null {
  const parsed = answerParts(previous);
  const parts = parsed.parts.filter(part => part.text).map(excerptPart);
  const lead = parts.find(part => !part.marker);
  const items = parts.filter(part => part.marker);
  const count = request.sentences;
  if (request.asSentences && items.length) {
    const priorityLead = items.some(item => item.supplemental) ? lead : undefined;
    const opening = priorityLead?.sentences.map(text => ({ text, sources: priorityLead.sources })) ?? [];
    const ordered = lead && !priorityLead ? [lead, ...items] : items;
    const first = ordered.map(part => ({ text: part.sentences[0], sources: part.sources }));
    const rest = ordered.flatMap(part => part.sentences.slice(1).map(text => ({ text, sources: part.sources })));
    const selected = [...opening, ...first, ...rest].slice(0, count);
    if (selected.length !== count) return null;
    const text = selected.map(({ text }) => SENTENCE_END.test(text) ? text : `${text}.`).join(' ');
    return [text, ...new Set([...selected.flatMap(part => part.sources), ...parsed.sources])].join('\n\n');
  }
  const mainItems = lead ? items.filter(item => !item.supplemental) : items;
  const trimItems = mainItems.some(part => part.sentences.length > 1);
  const selected = trimItems ? mainItems : mainItems.slice(0, count);
  const shortened = trimItems || selected.length < items.length || (lead?.sentences.length ?? 0) > count
    || parts.length > items.length + Number(Boolean(lead));
  if (!shortened) return null;
  const intro = lead?.sentences.slice(0, count).join(' ');
  const list = selected.map(({ marker, text, sentences, sources }) => [
    `${marker} ${trimItems ? sentences[0] : text}`,
    ...sources.map(source => `${' '.repeat(marker.length + 1)}${source}`),
  ].join('\n')).join('\n');
  return [intro, ...(lead?.sources ?? []), list, ...parsed.sources].filter(Boolean).join('\n\n');
}

export function shortenPreviousAnswer(previous: string | null, request: ShorterRequest, experimental: boolean): {
  kind: 'shortened' | 'no_previous' | 'cannot_shorten'; text: string;
} {
  const ar = request.lang === 'ar';
  if (previous === null) return { kind: 'no_previous', text: ar
    ? 'لا يوجد في هذه المحادثة جواب سابق أختصره. اسألني أولًا، ثم اطلب الاختصار.'
    : 'There is no earlier answer in this conversation to shorten. Ask me first, then ask for a shorter answer.' };
  if (experimental) return { kind: 'cannot_shorten', text: ar
    ? 'لا أستطيع اختصار الجواب السابق في هذا الوضع التجريبي.'
    : 'I can’t shorten the previous answer in this experimental mode.' };
  const text = shorterAnswer(previous, request);
  if (text !== null) return { kind: 'shortened', text };
  return { kind: 'cannot_shorten', text: ar
    ? 'الجواب السابق مختصر بالفعل، ولا أستطيع اختصاره أكثر دون حذف مضمونه.'
    : 'The previous answer is already short. I can’t shorten it further without losing its substance.' };
}
