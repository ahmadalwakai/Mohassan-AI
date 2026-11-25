import type { EvidenceSpan } from './evidence.js';
import { writingUrl, type ExtractiveWritingTask } from './request.js';

export function inline(text: string): string {
  return text.replace(/\r?\n/gu, ' ').replace(/[\\\x60*_[\]<>|#~!]/gu, '\\$&');
}

export function cite(span: EvidenceSpan, task: ExtractiveWritingTask): string {
  const { source } = span;
  const title = inline((source.title || (task.language === 'ar' ? 'المصدر' : 'Source')).slice(0, 120)).replace(/\\[\[\]]/gu, '');
  const page = source.page ? (task.language === 'ar' ? `، ص. ${source.page}` : `, p. ${source.page}`) : '';
  const url = source.url && writingUrl(source.url);
  if (url) return `[${title}${page}](${url.replace(/[<>|]/gu, encodeURIComponent)})`;
  const offset = source.offset ?? 0;
  return `〔${title}${page} ${offset + span.start}–${offset + span.end}〕`;
}

export function quote(span: EvidenceSpan, task: ExtractiveWritingTask): string {
  return `«${inline(span.text)}» ${cite(span, task)}`;
}
