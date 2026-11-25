import type { HandsPlan } from '../hands.js';
import { normalizeRequest, stripCourtesyTail } from '../mind/normalize.js';

const OPEN_SITE_AR = /^(?:افتح|ادخل|اذهب)(?:\s+لي)?(?:\s+(?:الي|علي))?\s+/u;
const OPEN_SITE_EN = /^(?:open|visit|go to|navigate to)\s+/u;
const SITE_REFERENCE_AR = /^(?:(?<demonstrative>هذا|هذه)\s+)?(?:ال)?(?:موقعا?|صفحه|رابطا?)(?:\s+(?:ما|ويب|الكترونيا?|انترنت))?(?:\s+(?:(?<active>الحاليه?|المفتوحه?)|(?:الذي|التي|اللي)\s+(?:(?<visible>عندك|لديك)|(?:اقصد|تقصد|اعني|تعني)(?:ه|ها)?)))?$/u;
const SITE_REFERENCE_EN = /^(?:(?<determiner>a|any|some|the|this|that)\s+)?(?:(?<active>current|active|open)\s+)?(?:web ?site|site|web ?page|page|link|url)(?:\s+for (?:me|us))?$/u;

export interface UnnamedSite { read: boolean; lang: 'ar' | 'en' }

interface SiteGrammar {
  openThenRead: RegExp;
  tidy(text: string): string;
  fold(text: string): string;
}

/** Find requests without a website address or name. An explicit current-page reference can use the live page. */
export function resolveUnnamedSite(request: string, { openThenRead, tidy, fold }: SiteGrammar,
  readCurrentPage?: (plan: HandsPlan) => void): UnnamedSite | null {
  if (typeof request !== 'string' || request.length > 200) return null;
  const text = tidy(stripCourtesyTail(normalizeRequest(request).text));
  const read = openThenRead.exec(text);
  const head = fold(read?.[1] ?? read?.[2] ?? text);
  const ar = OPEN_SITE_AR.test(head) ? SITE_REFERENCE_AR.exec(head.replace(OPEN_SITE_AR, '')) : null;
  const en = !ar && OPEN_SITE_EN.test(head) ? SITE_REFERENCE_EN.exec(head.replace(OPEN_SITE_EN, '')) : null;
  if (!ar && !en) return null;
  const lang = ar ? 'ar' : 'en';
  const current = ar ? ar.groups?.demonstrative || ar.groups?.active || ar.groups?.visible : en?.groups?.determiner === 'this' || en?.groups?.active;
  if (read && current && readCurrentPage) {
    readCurrentPage({ steps: [{ kind: 'read', more: false }], next: 0, lang });
    return null;
  }
  return { read: Boolean(read), lang };
}
