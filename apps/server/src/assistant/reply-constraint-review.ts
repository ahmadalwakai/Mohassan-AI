import type { ReplyConstraints, ReplyLanguage } from './reply-directive.js';

export type ReplyConstraintFinding = 'reply_language' | 'reply_length' | 'reply_format' | 'reply_links';

export interface ConstrainedReply {
  text: string;
  findings: ReplyConstraintFinding[];
  withheld: boolean;
}

const LIST_MARKER = /^[ \t]*(?:[-+*•]|\p{Nd}+[.)-])[ \t]+/u;
const LINK = /!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)|<(?:https?:\/\/|mailto:)[^<>\s]+>|https?:\/\/[^\s<>]*[^\s<>.,!?;:»”\])}]/giu;
const INLINE_CODE = /`+[^`\r\n]+`+/gu;
const INLINE_QUOTE = /«[^»\n]*»|“[^”\n]*”|"[^"\n]*"/gu;
const FENCE = /^\s*(?:```|~~~)/u;
const HEADING = /^(?:#{1,6}\s+\S.*|\*\*[^*\n]+\*\*)$/u;
const SOURCE = /^(?:\*\*)?(?:source(?: link)?|page title|the page i read|المصدر|رابط المصدر|عنوان الصفحة|الصفحة التي قرأتها):(?:\*\*)?/iu;
const MODEL_DISCLOSURE = /^— (?:نموذج v5 تجريبي|Answer from the (?:reading model v\d+|arithmetic model)|جواب (?:«نموذج القراءة v\d+»|نموذج الحساب)) \([^\n]*\)$/iu;
const EXTRA = /^(?:\*\*)?(?:more from the same source|see also|more|a second source agrees|تفاصيل أخرى من نفس المصدر|للمزيد|مصدر ثانٍ يؤكد):(?:\*\*)?/iu;
const DETAIL_HEADING = /^(?:\*\*)?(?:more from the same source|تفاصيل أخرى من نفس المصدر):(?:\*\*)?$/iu;
const LINK_LINE = /^(?:\*\*)?(?:source(?: link)?|the page i read|see also|more|رابط المصدر|المصدر|الصفحة التي قرأتها|للمزيد):(?:\*\*)?/iu;
const PRIMARY_SOURCE = /^(?:\*\*)?(?:source|المصدر):(?:\*\*)?/iu;
const URL_SCHEME = /https?:\/\/(?=[^"\\\s<>])/giu;
const BRIEF_SENTENCES = 2;
// The conversation review already uses 80 words as its limit for a short reply.
const BRIEF_WORDS = 80;
const SENTENCES = {
  ar: new Intl.Segmenter('ar', { granularity: 'sentence' }),
  en: new Intl.Segmenter('en', { granularity: 'sentence' }),
};
const MEDICAL_ADVICE = {
  ar: 'للتشخيص والعلاج راجع طبيبًا مختصًا.',
  en: 'For diagnosis and treatment, see a doctor.',
};
const MEDICAL_NOTE = /^(?:ملاحظة: هذه معلومات عامة منقولة من المصدر، وليست تشخيصًا\.\s*|Note: this is general information quoted from the source, not a diagnosis\.\s*)?(?:للتشخيص والعلاج راجع طبيبًا مختصًا\.|For diagnosis and treatment, see (?:a qualified doctor|a doctor)\.)$/u;
const DIAGNOSIS_NOTE = /^(?:ملاحظة: هذه معلومات عامة منقولة من المصدر، وليست تشخيصًا\.|Note: this is general information quoted from the source, not a diagnosis\.)$/u;
const SOURCE_DISAGREES = /^(?:(?:\*\*)?(?:A second source differs|مصدر ثانٍ يختلف):|A second source reports a different figure\.$|يذكر مصدر ثانٍ رقمًا مختلفًا\.$)/iu;
const SOURCE_DISAGREEMENT = { ar: 'يذكر مصدر ثانٍ رقمًا مختلفًا.', en: 'A second source reports a different figure.' };

const LABELS = [
  ['المصدر', 'Source'], ['رابط المصدر', 'Source link'], ['عنوان الصفحة', 'Page title'],
  ['الصفحة التي قرأتها', 'The page I read'], ['تفاصيل أخرى من نفس المصدر', 'More from the same source'],
  ['للمزيد', 'See also'], ['مصدر ثانٍ يؤكد', 'A second source agrees'], ['مصدر ثانٍ يختلف', 'A second source differs'],
] as const;

interface Line { text: string; kind: 'body' | 'heading' | 'source' | 'code' | 'blank' }

function replyLines(text: string): Line[] {
  const lines: Line[] = [];
  const code: string[] = [];
  let fence = '';
  for (const raw of text.split(/\r?\n/u)) {
    const trimmed = raw.trim();
    if (fence) {
      code.push(raw);
      if (trimmed.startsWith(fence) && /^(`{3,}|~{3,})$/u.test(trimmed)) {
        lines.push({ text: code.splice(0).join('\n'), kind: 'code' });
        fence = '';
      }
      continue;
    }
    if (FENCE.test(raw)) {
      fence = /^(`{3,}|~{3,})/u.exec(trimmed)![0];
      code.push(raw);
      continue;
    }
    const kind = !trimmed ? 'blank' : SOURCE.test(trimmed) || MODEL_DISCLOSURE.test(trimmed) ? 'source'
      : HEADING.test(trimmed) && !/[.!?؟]\*\*$/u.test(trimmed) ? 'heading' : 'body';
    lines.push({ text: raw, kind });
  }
  if (code.length) lines.push({ text: code.join('\n'), kind: 'code' });
  return lines;
}

function maskInline(text: string): string {
  const mask = (match: string) => 'x'.repeat(match.length);
  const protectedText = text.replace(INLINE_CODE, mask).replace(LINK, mask);
  return protectedText.replace(INLINE_QUOTE, (match: string, index: number) => /\p{L}/u.test(protectedText.slice(0, index)) ? mask(match) : match);
}

function sentenceParts(text: string, lang: ReplyLanguage | undefined): string[] {
  const prefix = /^(?:\s*>\s*)?/u.exec(text)![0].length;
  const start = prefix + (LIST_MARKER.exec(text.slice(prefix))?.[0].length ?? 0);
  const masked = maskInline(text.slice(start));
  const segmenter = SENTENCES[lang ?? 'en'];
  // An Arabic or lowercase sentence can follow a full stop without an uppercase initial.
  const cuts = new Set([...segmenter.segment(masked)].map(({ index, segment }) => index + segment.length));
  for (const end of masked.matchAll(/(?<=[.!?؟。])(?=[ \t]+[\p{Ll}\p{Script=Arabic}])/gu)) {
    const at = end.index;
    const prior = masked.slice(0, at);
    if (!/(?:\b\p{L}|\b(?:mr|mrs|ms|dr|prof|st|vs|etc))\.$/iu.test(prior)) cuts.add(at);
  }
  const result: string[] = [];
  let at = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const piece = text.slice(at, start + cut).trimEnd();
    if (piece.trim()) result.push(piece);
    at = start + cut;
  }
  return result;
}

function trimLength(lines: Line[], constraints: ReplyConstraints): Line[] {
  const limit = constraints.sentences ?? (constraints.brief ? BRIEF_SENTENCES : undefined);
  if (!limit && !constraints.brief) return lines;
  let left = limit ?? Infinity;
  let wordsLeft = constraints.brief ? BRIEF_WORDS : Infinity;
  const kept: Line[] = [];
  const medical = lines.find(line => MEDICAL_NOTE.test(line.text.trim()));
  const disagreement = lines.find(line => SOURCE_DISAGREES.test(line.text.trim()));
  const tail = medical ?? disagreement;
  const includeQualifier = Boolean(tail && limit !== undefined);
  if (includeQualifier && left > 1) left--;
  let droppingDetails = false;
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (includeQualifier && (line === disagreement || line === medical || medical && DIAGNOSIS_NOTE.test(trimmed))) continue;
    if (line.kind === 'blank') { droppingDetails = false; kept.push(line); continue; }
    if (constraints.brief && DETAIL_HEADING.test(trimmed)) { droppingDetails = true; continue; }
    if (droppingDetails && LIST_MARKER.test(line.text)) continue;
    if (constraints.brief && EXTRA.test(trimmed)) continue;
    if (line.kind === 'source') { kept.push(line); continue; }
    if (!left || !wordsLeft) continue;
    if (line.kind === 'heading' || DETAIL_HEADING.test(trimmed)) { kept.push(line); continue; }
    if (line.kind === 'code') { kept.push(line); left--; continue; }
    const parts: string[] = [];
    for (const part of sentenceParts(line.text, constraints.lang).slice(0, left)) {
      const words = [...maskInline(part).matchAll(/\S+/gu)];
      if (words.length > wordsLeft) {
        if (wordsLeft === BRIEF_WORDS) {
          const end = words[wordsLeft - 1]!;
          const shortened = part.slice(0, end.index + end[0].length).replace(/[,.!?؟،:]+$/u, '');
          parts.push(`${shortened}…${((shortened.match(/\*\*/gu)?.length ?? 0) % 2) ? '**' : ''}`);
        }
        left = wordsLeft = 0;
        break;
      }
      parts.push(part);
      left--;
      wordsLeft -= words.length;
    }
    if (parts.length) kept.push({ ...line, text: parts.join(' ') });
  }
  if (includeQualifier && tail) {
    const lang = constraints.lang ?? (bodyLanguage([tail]) === 'ar' ? 'ar' : 'en');
    const qualifiers = [...(disagreement ? [SOURCE_DISAGREEMENT[lang]] : []), ...(medical ? [MEDICAL_ADVICE[lang]] : [])];
    const advice = qualifiers.map((part, index) => index === qualifiers.length - 1 ? part : part.replace(/\.$/u, '')).join(lang === 'ar' ? '، و' : ', and ');
    const lead = kept.find(line => line.kind === 'body');
    if (limit === 1 && lead) lead.text = `${lead.text.replace(/[.!?؟…]+$/u, '')} — ${advice}`;
    else kept.push({ text: advice, kind: 'body' });
  }
  return kept;
}

function localizeLabel(text: string, language: ReplyLanguage): string {
  for (const [arabic, english] of LABELS) {
    const [from, to] = language === 'ar' ? [english, arabic] : [arabic, english];
    const match = new RegExp(`^(\\s*(?:\\*\\*)?)${from}:`, 'iu');
    if (match.test(text)) return text.replace(match, `$1${to}:`);
  }
  return text;
}

function bodyLanguage(lines: Line[]): ReplyLanguage | 'none' {
  const prose = lines.filter(line => line.kind === 'body').map(({ text }) => {
    const plain = text.replace(LINK, ' ').replace(INLINE_CODE, ' ').replace(/\([^\s()]*\.[^\s()]*\)/gu, ' ');
    const unquoted = plain.replace(INLINE_QUOTE, ' ');
    const visible = /\p{L}/u.test(unquoted) ? unquoted : plain;
    return visible.replace(/\b[A-Z]{1,8}[-_]?\d[\dA-Z_-]*\b/gu, ' ');
  }).join(' ');
  const arabic = prose.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return arabic === latin ? 'none' : arabic > latin ? 'ar' : 'en';
}

function constrainLinks(lines: Line[], limit: number): Line[] {
  let left = limit;
  return lines.flatMap(line => {
    if (line.kind === 'code') return [line];
    let removed = false;
    const inlineCode = [...line.text.matchAll(INLINE_CODE)];
    const text = line.text.replace(LINK, (match: string, title: string | undefined, index: number) => {
      if (inlineCode.some(part => index >= part.index && index < part.index + part[0].length)) return match;
      if (left > 0) { left--; return match; }
      removed = true;
      return LINK_LINE.test(line.text.trim()) && !PRIMARY_SOURCE.test(line.text.trim()) ? '' : title?.replace(URL_SCHEME, '') ?? '';
    });
    if (!removed) return [line];
    const plainSource = PRIMARY_SOURCE.test(text.trim()) && /[\p{L}\p{N}]/u.test(text.trim().replace(PRIMARY_SOURCE, ''));
    if (!text.trim() || (LINK_LINE.test(line.text.trim()) && !plainSource && !LINK.test(text))) {
      LINK.lastIndex = 0;
      return [];
    }
    LINK.lastIndex = 0;
    return [{ ...line, text: text.trimEnd() }];
  });
}

function formatList(lines: Line[], wanted: boolean): Line[] {
  if (wanted) {
    return lines.map(line => line.kind !== 'body' || LIST_MARKER.test(line.text) || /^\s*>/u.test(line.text)
      ? line : { ...line, text: `- ${line.text.trim()}` });
  }
  const result: Line[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) result.push({ kind: 'body', text: items.join(' ') });
    items = [];
  };
  for (const line of lines) {
    if (line.kind === 'body' && LIST_MARKER.test(line.text)) {
      const text = line.text.replace(LIST_MARKER, '').trim();
      if (text) items.push(/[.!?؟…]$/u.test(text) ? text : `${text}.`);
    } else { flush(); result.push(line); }
  }
  flush();
  return result;
}

function render(lines: Line[]): string {
  const kept = lines.filter((line, index) => {
    if (line.kind !== 'heading' && !DETAIL_HEADING.test(line.text.trim())) return true;
    const next = lines.slice(index + 1).find(item => item.kind !== 'blank');
    return next?.kind === 'body' || next?.kind === 'code' || !DETAIL_HEADING.test(line.text.trim()) && next?.kind !== 'source';
  });
  return kept.filter((line, index) => line.kind !== 'blank' || kept[index - 1]?.kind !== 'blank')
    .map(line => line.text).join('\n').trim();
}

/** Verify and apply host-owned constraints without inventing or translating source material. */
export function enforceReplyConstraints(text: string, constraints?: ReplyConstraints): ConstrainedReply {
  const findings: ReplyConstraintFinding[] = [];
  if (!constraints || !text.trim()) return { text, findings, withheld: false };
  const { lang, sentences, brief, links, list } = constraints;
  if (!lang && !sentences && !brief && links === undefined && list === undefined) return { text, findings, withheld: false };
  const linkLimit = links ?? (brief ? 1 : undefined);
  if (/^\s*[[{]/u.test(text)) {
    try {
      JSON.parse(text);
      // JSON slash escapes preserve exact values and keep surplus addresses from becoming clickable.
      let left = linkLimit ?? Infinity;
      const json = text.replace(URL_SCHEME, scheme => left-- > 0 ? scheme : scheme.replaceAll('/', '\\/'));
      return { text: json, findings: json === text ? [] : ['reply_links'], withheld: false };
    } catch { /* Ordinary prose. */ }
  }
  let lines = replyLines(text);
  let withheld = false;
  if (lang) {
    const actual = bodyLanguage(lines);
    withheld = actual !== 'none' && actual !== lang;
    if (withheld) {
      findings.push('reply_language');
      const notice = lang === 'ar' ? 'تعذّر تقديم جواب بالعربية.' : 'I could not provide an answer in English.';
      lines = [{ text: notice, kind: 'body' }, ...lines.filter(line => line.kind === 'source')];
    }
    lines = lines.map(line => line.kind === 'source' || line.kind === 'body'
      ? { ...line, text: localizeLabel(line.text, lang) } : line);
  }
  const shorten = trimLength(lines, constraints);
  if (render(shorten) !== render(lines)) findings.push('reply_length');
  const linked = linkLimit === undefined ? shorten : constrainLinks(shorten, linkLimit);
  if (render(linked) !== render(shorten)) findings.push('reply_links');
  const formatted = list === undefined ? linked : formatList(linked, list);
  if (render(formatted) !== render(linked)) findings.push('reply_format');
  const fixed = render(formatted);
  return { text: fixed || (lang === 'ar' ? 'لا يوجد نص لعرضه بهذه الصيغة.' : 'There is no text to show in this format.'), findings, withheld: withheld || !fixed };
}
