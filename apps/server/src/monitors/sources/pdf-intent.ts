import type { MonitorSpec } from '@mohassan/contracts';
import { maskRequestLiteralData } from '../../assistant/request-scope.js';
import { monitorMatchText, type MonitorNeed } from '../detection.js';
import { generateMonitorSpec, monitorTimingForNeed } from '../spec.js';

const ADDRESS = /https?:\/\/[^\s<>"'`«»“”]+/giu;
const PDF_MENTION = /\bpdf\b|(?<!\p{L})(?:بي دي اف)(?!\p{L})/u;
const NEW_LIST_ITEM = /\b(?:new list (?:items?|entries)|(?:items?|entries) (?:are |get )?added)\b|(?<!\p{L})(?:عناصر جديده|بنود جديده|اضافه (?:عنصر|بند))(?!\p{L})/u;
const PDF_CHANGE = /\b(?:chang(?:e|es|ed|ing)|revis(?:ion|ions|ed)|updat(?:e|es|ed))\b|(?<!\p{L})(?:يتغير|تتغير|تغير|تعديل|تحديث)(?!\p{L})/u;

export function pdfMonitorSource(need: Pick<MonitorNeed, 'sourceUrl' | 'text'>) {
  if (!need.sourceUrl) return;
  const url = new URL(need.sourceUrl);
  const body = monitorMatchText(maskRequestLiteralData(need.text.replace(ADDRESS, ' ')));
  if (/\.pdf$/iu.test(url.pathname) || PDF_MENTION.test(body)) return { kind: 'pdf', url: url.href } as const;
}

export function pdfMonitorSpec(need: MonitorNeed, now: Date): MonitorSpec | null {
  const source = pdfMonitorSource(need);
  const timing = source && monitorTimingForNeed(source.kind, need, now);
  if (!source || !timing || need.blocked) return null;
  const body = monitorMatchText(need.text.replace(ADDRESS, ' '));
  const ar = need.language === 'ar';
  // Supply the normal page parser with a generic text target for PDF-only wording such as “when the PDF changes”.
  const base = generateMonitorSpec(need, now, true) ?? ((PDF_CHANGE.test(body) || NEW_LIST_ITEM.test(body))
    ? generateMonitorSpec({ ...need, text: `${need.text} ${ar ? 'يتغير النص' : 'text changes'}` }, now, true) : null);
  if (!base || base.source.kind !== 'page') return null;
  const anchor = base.source.anchor;
  const pdfSource = { ...source, ...(anchor && { anchor }) };
  if (NEW_LIST_ITEM.test(body) && base.read.kind !== 'number' && base.read.kind !== 'phrase') {
    const title = `${new URL(source.url).hostname} · ${ar ? 'عناصر جديدة في ملف PDF' : 'New PDF list items'}`;
    return { ...base, source: pdfSource, read: { kind: 'items' }, condition: { kind: 'new-item' }, timing, title,
      message: ar ? `تحقّق شرط المراقبة لـ «${title}».` : `The monitoring condition was met for ${title}.` };
  }
  if (base.read.kind === 'main') {
    const title = `${new URL(source.url).hostname} · ${ar ? 'نص ملف PDF' : 'PDF text'}`;
    return { ...base, source: pdfSource, timing, title,
      message: ar ? `تحقّق شرط المراقبة لـ «${title}».` : `The monitoring condition was met for ${title}.` };
  }
  if (!['number', 'phrase', 'items'].includes(base.read.kind)) return null;
  return { ...base, source: pdfSource, timing };
}
