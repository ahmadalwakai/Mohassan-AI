import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { BrowserError } from '../../network.js';
import { safeResumeUrl } from '../../session-state.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import type { SearchQuery } from '../providers.js';
import { englishHealthTopic, isKnownHealthTopic } from './health-topics.js';

export interface HealthRequestOptions {
  accept?: string;
  maxBytes?: number;
  allowAttachment?: boolean;
  gzip?: boolean;
}

export type HealthRequester = (url: URL, signal: AbortSignal, options?: HealthRequestOptions) => Promise<string>;

export function healthLimit(limit: number): number {
  return Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
}

const blockTags = new Set(['article', 'blockquote', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'section', 'td', 'tr']);

export function healthPlain(input: string, limit = 700): string {
  const text: string[] = [];
  const nodes: (DefaultTreeAdapterTypes.Node | ' ')[] = [...parseFragment(input.slice(0, 24_000)).childNodes].reverse();
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node === ' ') {
      text.push(node);
    } else if ('value' in node) {
      text.push(node.value);
    } else if ('tagName' in node && !['script', 'style', 'template'].includes(node.tagName)) {
      if (blockTags.has(node.tagName)) {
        text.push(' ');
        nodes.push(' ');
      }
      for (let index = node.childNodes.length - 1; index >= 0; index--) nodes.push(node.childNodes[index]);
    }
  }
  return publicSearchText(text.join('')).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function isHealthQuestion(query: SearchQuery): boolean {
  const subject = query.retrievalQuestion.replace(/^(?:what\s+(?:is|are)|ما(?:\s+(?:هو|هي))?)\s+/i, '');
  return isKnownHealthTopic(subject)
    || /\b(?:symptoms?|side effects?|medical treatments?|diagnos(?:is|e|ed|tic)|vaccin\w*|diseases?|health|mortality|morbidity|infection|outbreak|syndrome|virus)\b|\bhow\s+(?:is|does)\b[^?]*\bspread\b|\b(?:treatment|prevalence|incidence)\s+(?:for|of)\b/i.test(query.question)
    || /(?:أعراض|اعراض|علاج|دواء|الآثار الجانبية|الأعراض الجانبية|لقاح|مرض|أمراض|صحة|تشخيص|عدوى|معدل الوفيات|كيف ينتشر|كيف ينتقل)/u.test(query.question);
}

export function healthEnglishQuery(query: SearchQuery): string | undefined {
  const original = query.question.normalize('NFKC').replace(/\p{Cf}/gu, '');
  const decoded = publicSearchScan(original);
  if (publicSearchText(original) !== original || publicSearchText(decoded) !== decoded
    || (decoded.match(/https?:\/\/\S+/gi) ?? []).some(url => safeResumeUrl(url) === null)) {
    throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
  }
  if (query.language === 'ar') return englishHealthTopic(query.retrievalQuestion);
  const text = query.retrievalQuestion.trim().replace(/[?!.]+$/, '');
  const definition = text.replace(/^what\s+(?:is|are)\s+/i, '');
  if (definition !== text && isKnownHealthTopic(definition)) return definition;
  return text
    .replace(/^(?:what\s+(?:are|is)\s+(?:the\s+)?)?(?:symptoms?|side effects?|treatment|treatments|medical treatment|diagnosis)\s+(?:of|for)\s+/i, '')
    .replace(/^how\s+(?:is|does)\s+(.+?)\s+spread$/i, '$1')
    .replace(/^how\s+(?:do (?:i|you)|to)\s+treat\s+/i, '')
    .trim() || undefined;
}
