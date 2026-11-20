import type { Claim, Evidence, Frame, Lang, MindReply } from './contract.js';
import { boundedQuote } from './extract.js';
import { matchText } from './normalize.js';

export const replyCopy = {
  ar: {
    confirmed: 'مصدران مستقلان متفقان', conflict: 'المصادر مختلفة', single_source: 'من مصدر واحد',
    partial: 'نتيجة جزئية', pageDate: 'تاريخ المصدر', readAt: 'وقت القراءة',
    cannotRead: 'تعذّرت قراءة الصفحة المحددة.',
    siteMissing: 'لم أجد الجواب في الصفحات التي قرأتها', notFound: 'لم أجد جوابًا مسنودًا',
    searches: 'الاستعلامات', pages: 'الصفحات', differentHost: 'تغيّر النطاق',
    protocol: 'البروتوكول', title: 'العنوان', language: 'اللغة المعلنة', identity: 'اسم الجهة المعلن',
    last_modified: 'آخر تعديل وفق الترويسة', page_date: 'التاريخ الذي تعرضه الصفحة', content_type: 'نوع المحتوى',
    sameHash: 'تطابق بصمة القراءة المفهرسة', differentHash: 'تختلف بصمة القراءة المفهرسة',
  },
  en: {
    confirmed: 'Two independent sources agree', conflict: 'The sources disagree', single_source: 'From a single source',
    partial: 'Partial result', pageDate: 'Source date', readAt: 'Read at',
    cannotRead: 'I could not read the requested page.',
    siteMissing: 'I did not find the answer in the pages I read', notFound: 'I found no supported answer',
    searches: 'searches', pages: 'pages', differentHost: 'different host',
    protocol: 'Protocol', title: 'Title', language: 'Declared page language', identity: 'Declared organisation name',
    last_modified: 'Last modified per response header', page_date: 'Date reported by the page', content_type: 'Content type',
    sameHash: 'Matches the indexed read', differentHash: 'Differs from the indexed read',
  },
} as const;

const explicitlyCurrent = /\b(?:as of today|currently|current|right now|today|latest|newest|most recent|live|this (?:week|month|year))\b|(?:الان|حاليا|الحالي|الحاليه|اليوم|احدث|الاخير|الاخيره|هذا (?:الاسبوع|الشهر|العام))/iu;

export function requiresSourceDate(frame: Frame, source: Evidence['source']) {
  const namedPage = source === 'site' && frame.urls.length > 0;
  return frame.timeSensitive && (!namedPage || explicitlyCurrent.test(matchText(frame.text)));
}

export function showBareValue(frame: Frame, status: Claim['status'], evidence: readonly Evidence[], timedOut = false) {
  return frame.valueOnly && !timedOut && status !== 'conflict' && evidence.every(item => !requiresSourceDate(frame, item.source));
}

export function missingText(lang: Lang, pages: number, searches?: number) {
  const labels = replyCopy[lang];
  if (searches === undefined) return `${labels.siteMissing} (${pages}).`;
  const checked = lang === 'ar' ? `${labels.searches} ${searches}، ${labels.pages} ${pages}` : `${searches} ${labels.searches}, ${pages} ${labels.pages}`;
  return `${labels.notFound} (${checked}).`;
}

function researchCitation(item: Evidence, lang: Lang) {
  const labels = replyCopy[lang];
  const date = item.pageDate ? ` · ${labels.pageDate} ${item.pageDate}` : '';
  const read = item.fetchedAt ? ` · ${labels.readAt} ${item.fetchedAt}` : '';
  return `«${item.quote}» ${item.url}${date}${read}`;
}

export function researchText(
  lang: Lang,
  status: Extract<Claim['status'], 'confirmed' | 'single_source' | 'conflict'>,
  evidence: readonly Evidence[],
  partial = false,
  selection?: string,
) {
  const labels = replyCopy[lang];
  const heading = partial ? `${labels.partial} · ${labels[status]}` : labels[status];
  return [...(selection ? [selection] : []), heading, ...evidence.map(item => researchCitation(item, lang))].join('\n');
}

export function siteQuoteText(lang: Lang, item: Evidence, includeDate = false) {
  const labels = replyCopy[lang];
  const date = includeDate && item.pageDate ? ` · ${labels.pageDate} ${item.pageDate}` : '';
  return `«${item.quote}» ${item.url} (${labels.readAt} ${item.fetchedAt}${date})`;
}

export function composeReply(reply: MindReply): MindReply {
  const quotes = new Map<string, string>();
  const evidence = reply.evidence.map(item => {
    if (item.source !== 'memory' && item.source !== 'knowledge') return item;
    const clipped = boundedQuote(item.quote, item.value);
    if (!clipped || clipped === item.quote || !item.quote.includes(clipped)) return item;
    quotes.set(item.id, clipped);
    return { ...item, quote: clipped };
  });
  const originals = new Map(reply.evidence.map(item => [item.id, item]));
  const claims = reply.claims.map(claim => {
    let text = claim.text;
    for (const id of claim.support) {
      const original = originals.get(id);
      const quote = quotes.get(id);
      if (original && quote) text = text.replaceAll(`«${original.quote}»`, `«${quote}»`);
    }
    if (claim.status === 'single_source' && claim.support.length === 1) {
      const item = originals.get(claim.support[0]);
      if (item?.source === 'site' && item.quote && text === siteQuoteText(reply.frame.lang, item)) {
        return { ...claim, text: siteQuoteText(reply.frame.lang, item, true) };
      }
    }
    return { ...claim, text };
  });
  const originalText = reply.claims.map(claim => claim.text).join('\n');
  const text = originalText === reply.text ? claims.map(claim => claim.text).join('\n') : reply.text;
  return { ...reply, evidence, claims, text };
}
