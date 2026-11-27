import type { EventDateQuestion } from './event-date.js';

type Span = { at: number; end: number };

const articleName = /^(?:wikipedia|ويكيبيديا)\s+[-–—|]\s+|\s+[-–—|]\s+(?:wikipedia|ويكيبيديا)$/gu;
const institutionType = /^(?:ال)?(جامعه|مدرسه|كليه|معهد|اكاديميه|مكتبه|متحف|مستشفي|مؤسسه|شركه|جمعيه|نادي)\s+\S/u;

/** Recognize dates explicitly attributed to the historical beginning of the named subject. */
export function findEventOriginDate(request: EventDateQuestion, text: string, dates: readonly Span[], name: string, normalizedTitle?: string): { date: Span; at: number; end: number } | undefined {
  const arabic = request.lang === 'ar';
  const named = arabic
    ? `(?:عاده ما\\s+)?(?:[يت]عود|[يت]رجع)\\s+(?:تاريخ|اصل|اصول|بدايه|بدايات)\\s+${name}(?:\\s+ال(?:احترافي|رسمي))?\\s+الي(?:\\s+(?:عام|سنه|يوم))?`
    : `(?:the\\s+)?(?:history|origins?|beginnings?)\\s+of\\s+(?:the\\s+)?${name}\\s+(?:dates? back|go(?:es)? back|can be traced back)\\s+to(?:\\s+(?:the\\s+)?year)?`;
  const patterns = [named];
  const title = normalizedTitle?.trim().replace(articleName, '').replace(/\s+/gu, ' ').replace(/^the\s+/u, '');
  const type = arabic && title === request.subject.replace(/\s+/gu, ' ') ? institutionType.exec(request.subject)?.[1] : undefined;
  if (type) {
    // The definite type is a reference to the institution named by the article, not a similar institution.
    patterns.push(`(?:ان\\s+)?البدايه\\s+التي\\s+(?:انطلق(?:ت)?|بدا(?:ت)?)\\s+منها\\s+ال${type}\\s+(?:تعود|ترجع)\\s+الي(?:\\s+(?:عام|سنه|يوم))?`);
  }
  const statement = new RegExp(`^\\s*(?:${patterns.join('|')})\\s+$`, 'u');
  for (const date of dates) {
    if (statement.test(text.slice(0, date.at))) return { date, at: 0, end: date.end };
  }
}
