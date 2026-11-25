import { safeResumeUrl } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import type { MonitorObservation } from './evaluation.js';
import type { MonitorV2Notice } from './evaluation-v2.js';

const escapeMarkdown = (value: string) => value.replace(/[\\[\]<>*_#`!|]/gu, '\\$&');
const plain = (value: string, limit: number) => escapeMarkdown(value.replace(/\s+/gu, ' ').trim().slice(0, limit));
const arabicStatus: Readonly<Record<string, string>> = Object.freeze({
  'in stock': 'متوفر', 'out of stock': 'نفدت الكمية', 'registration open': 'التسجيل مفتوح',
  'registration closed': 'التسجيل مغلق', 'tickets available': 'التذاكر متوفرة', 'tickets unavailable': 'التذاكر غير متوفرة',
  'coming soon': 'قريبًا', 'preorder': 'متاح للطلب المسبق', 'limited availability': 'الكمية محدودة',
  'scheduled': 'مجدول', 'rescheduled': 'أُعيدت جدولته', 'postponed': 'مؤجل', 'cancelled': 'أُلغي',
  'moved online': 'نُقل إلى الإنترنت', 'published': 'منشور', 'unpublished': 'غير منشور',
  'reachable': 'متاح', 'unreachable': 'يتعذّر الوصول إليه', 'not published': 'غير منشور',
  'completed': 'اكتمل', 'failed': 'تعذّر التنفيذ', 'blocked': 'متعذّر', 'unknown': 'غير معروف',
});

export function monitorV2EvidenceMessage(spec: MonitorSpec, notice: MonitorV2Notice, conversationId?: string): string {
  const ar = spec.language === 'ar';
  const language = ar ? 'ar-u-ca-gregory-nu-arab' : 'en';
  const number = new Intl.NumberFormat(language, { maximumSignificantDigits: 12 });
  const signed = new Intl.NumberFormat(language, { maximumSignificantDigits: 12, signDisplay: 'exceptZero' });
  const time = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' });
  const words = ar
    ? { before: 'قبل', after: 'بعد', absolute: 'التغيّر المطلق', percent: 'التغيّر النسبي', unavailable: 'غير منطبق',
      when: 'وقت الرصد', source: 'المصدر', yes: 'موجود', no: 'غير موجود', empty: 'لا عناصر',
      digest: 'الملخّص اليومي للمراقبة', events: 'عدد الفحوص التي رصدت تغييرًا', excerpt: 'مقتطف' }
    : { before: 'Before', after: 'After', absolute: 'Absolute change', percent: 'Percent change', unavailable: 'Not applicable',
      when: 'Observed', source: 'Source', yes: 'Present', no: 'Absent', empty: 'No items',
      digest: 'Daily monitor digest', events: 'Checks with changes', excerpt: 'Excerpt' };

  function value(observed: MonitorObservation): string {
    const { value } = observed;
    if (typeof value === 'number') return number.format(value);
    if (typeof value === 'boolean') return value ? words.yes : words.no;
    if (Array.isArray(value)) return value.length ? plain(value.join(' · '), 180) : words.empty;
    return plain(ar && Object.hasOwn(arabicStatus, value) ? arabicStatus[value] : value, 180);
  }

  const heading = notice.digest ? `${words.digest} · ${plain(spec.title, 180)}\n${words.events} · ${number.format(notice.events)}`
    : plain(spec.message, 500);
  const rows = notice.evidence.map(item => {
    const publicUrl = item.after.url && safeResumeUrl(item.after.url);
    const fallback = conversationId && /^[a-f\d-]{36}$/iu.test(conversationId) ? `/?conversation=${conversationId}` : null;
    const url = publicUrl || fallback;
    const percentage = item.percent === null ? words.unavailable : `${signed.format(item.percent)}${ar ? '٪' : '%'}`;
    return [
      `${words.before} · ${value(item.before)}`,
      `${words.after} · ${value(item.after)}`,
      `${words.absolute} · ${item.absolute === null ? words.unavailable : signed.format(item.absolute)}`,
      `${words.percent} · ${percentage}`,
      `${words.when} · ${time.format(new Date(item.after.observedAt))}`,
      `${words.excerpt} · ${plain(item.after.excerpt, 320)}`,
      ...(url ? [`[${words.source}](<${url}>)`] : []),
    ].join('  \n');
  });
  return [heading, ...rows].join('\n\n');
}
