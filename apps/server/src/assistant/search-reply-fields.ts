import type { ReplyField } from './reply-directive.js';

export type SearchReplyFields = Partial<Record<ReplyField, string>>;

const labels: Record<'en' | 'ar', Record<ReplyField, string>> = {
  en: { title: 'Page title', link: 'Source link', heading: 'Main heading', first_sentence: 'First sentence' },
  ar: { title: 'عنوان الصفحة', link: 'رابط المصدر', heading: 'العنوان الرئيسي', first_sentence: 'أول جملة في الصفحة' },
};

export function renderSearchReplyFields(fields: readonly ReplyField[], values: SearchReplyFields, lang: 'en' | 'ar') {
  const names = labels[lang];
  const lines: string[] = [];
  const missing: string[] = [];
  const quoted: string[] = [];
  for (const field of fields) {
    const value = values[field];
    if (value) {
      lines.push(`**${names[field]}:** ${value}`);
      if (field !== 'link') quoted.push(value);
    } else missing.push(names[field]);
  }
  const gap = missing.length ? (lang === 'en'
    ? `Not found on the page: ${missing.join(', ')}.`
    : `لم أجد في الصفحة: ${missing.join('، ')}.`) : '';
  return { text: [lines.join('\n'), gap].filter(Boolean).join('\n\n'), incomplete: missing.length > 0, quoted: quoted.join(' ') };
}
