import type { EvidenceSpan, WritingSource } from './evidence.js';
import { explain, explanationSections, type ExplanationGroup } from './explanation.js';
import { restructure } from './restructure.js';
import { summarize } from './summary.js';
import { writingUrl, type ExtractiveWritingTask } from './request.js';

const LABELS = {
  ar: { definition: 'التعريف', how: 'كيف يعمل', why: 'لماذا', example: 'مثال', limits: 'الحدود', missing: 'لم أجد',
    section: 'الجانب', excerpt: 'الاقتباس', text: 'النص', actions: 'المهام', dates: 'التواريخ', source: 'المصدر' },
  en: { definition: 'Definition', how: 'How it works', why: 'Why', example: 'Example', limits: 'Limits', missing: 'لم أجد',
    section: 'Aspect', excerpt: 'Quote', text: 'Text', actions: 'Action items', dates: 'Dates', source: 'Source' },
};

export interface ExtractiveWritingReply {
  text: string;
  evidence: EvidenceSpan[];
  complete: boolean;
}

function inline(text: string): string {
  return text.replace(/\r?\n/gu, ' ').replace(/[\\\x60*_[\]<>|#~!]/gu, '\\$&');
}

function cite(span: EvidenceSpan, task: ExtractiveWritingTask): string {
  const { source } = span;
  const title = inline((source.title || LABELS[task.language].source).slice(0, 120)).replace(/\\[\[\]]/gu, '');
  const page = source.page ? (task.language === 'ar' ? `، ص. ${source.page}` : `, p. ${source.page}`) : '';
  const url = source.url && writingUrl(source.url);
  if (url) return `[${title}${page}](${url.replace(/[<>|]/gu, encodeURIComponent)})`;
  const offset = source.offset ?? 0;
  return `〔${title}${page} ${offset + span.start}–${offset + span.end}〕`;
}

function quote(span: EvidenceSpan, task: ExtractiveWritingTask): string {
  return `«${inline(span.text)}» ${cite(span, task)}`;
}

function summaryReply(task: ExtractiveWritingTask, sources: readonly WritingSource[]): ExtractiveWritingReply {
  const evidence = summarize(sources, task.format, task.count);
  const quotes = evidence.map(span => quote(span, task));
  const labels = LABELS[task.language];
  const text = task.format === 'table' && quotes.length
    ? [`| ${labels.excerpt} | ${labels.source} |`, '| --- | --- |', ...evidence.map(span => `| «${inline(span.text)}» | ${cite(span, task)} |`)].join('\n')
    : task.format === 'bullets' ? quotes.map(line => `- ${line}`).join('\n')
      : quotes.join(task.format === 'detailed' ? '\n\n' : ' ');
  return { text: text || labels.missing, evidence, complete: Boolean(evidence.length) };
}

function explanationReply(task: ExtractiveWritingTask, sources: readonly WritingSource[]): ExtractiveWritingReply {
  const labels = LABELS[task.language];
  const options = { language: task.language, subjects: task.subjects, topic: task.topic,
    detailed: task.format === 'detailed', short: task.format === 'line' };
  const groups = task.kind === 'comparison' && !task.subjects && sources.length > 1
    ? sources.map(source => ({ ...explain([source], options)[0], subject: source.title }))
    : explain(sources, options);
  const evidence = groups.flatMap(group => explanationSections.flatMap(section => group.sections[section]));
  const fill = (spans: EvidenceSpan[]) => spans.length ? spans.map(span => quote(span, task)).join(' ') : labels.missing;
  const title = (group: ExplanationGroup) => group.subject ? inline(group.subject) : labels.excerpt;
  let text: string;
  if (task.format === 'table') {
    text = [
      `| ${labels.section} | ${groups.map(title).join(' | ')} |`,
      `| --- | ${groups.map(() => '---').join(' | ')} |`,
      ...explanationSections.map(section => `| ${labels[section]} | ${groups.map(group => fill(group.sections[section])).join(' | ')} |`),
    ].join('\n');
  } else {
    const blocks = groups.map(group => {
      const rows = explanationSections.map(section => `**${labels[section]}** — ${fill(group.sections[section])}`);
      const body = task.format === 'bullets' ? rows.map(row => `- ${row}`).join('\n')
        : rows.join(task.format === 'line' ? ' · ' : '\n\n');
      return group.subject ? `**${title(group)}**${task.format === 'line' ? ' · ' : '\n\n'}${body}` : body;
    });
    text = blocks.join(task.format === 'line' ? ' · ' : '\n\n');
  }
  return { text, evidence, complete: groups.length > 0 && groups.every(group => explanationSections.every(section => group.sections[section].length > 0)) };
}

function restructureReply(task: ExtractiveWritingTask, source?: WritingSource): ExtractiveWritingReply {
  const labels = LABELS[task.language];
  if (!source) return { text: labels.missing, evidence: [], complete: false };
  const { groups, actions, dates } = restructure(source, task.structure);
  const evidence = [...groups.flatMap(group => group.heading ? [group.heading, ...group.spans] : group.spans), ...actions, ...dates];
  const join = (spans: EvidenceSpan[]) => {
    if (task.format === 'bullets') return spans.map(span => `- ${inline(span.text)}`).join('\n');
    if (task.format === 'detailed') return spans.map(span => inline(span.text)).join('\n\n');
    return spans.map(span => inline(span.text)).join(' ');
  };
  let text: string;
  if (task.structure.extract) {
    const combined = task.structure.extract === 'both';
    const result = (spans: EvidenceSpan[]) => spans.length ? join(spans) : labels.missing;
    const lists = [
      ...(task.structure.extract !== 'dates' ? [`${combined ? `**${labels.actions}**\n\n` : ''}${result(actions)}`] : []),
      ...(task.structure.extract !== 'actions' ? [`${combined ? `**${labels.dates}**\n\n` : ''}${result(dates)}`] : []),
    ];
    text = lists.join('\n\n');
  } else {
    text = groups.map(group => [group.heading ? `**${inline(group.heading.text)}**` : '', join(group.spans)].filter(Boolean).join('\n\n')).join('\n\n');
  }
  const complete = task.structure.extract === 'both' ? actions.length > 0 && dates.length > 0 : evidence.length > 0;
  return { text: text || labels.missing, evidence, complete };
}

export function renderExtractiveWriting(task: ExtractiveWritingTask, sources: readonly WritingSource[]): ExtractiveWritingReply {
  if (task.kind === 'summary') return summaryReply(task, sources);
  if (task.kind === 'restructure') return restructureReply(task, sources[0]);
  return explanationReply(task, sources);
}
