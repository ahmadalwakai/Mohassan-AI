import type { CodeAnswer, CodeBlock } from './types.js';

const labels = {
  en: {
    extracted: 'Selected passages rendered as plain text with formatting and some sections omitted.',
    abstained: 'I could not find enough evidence in the offline programming sources to answer.',
    version: 'Version', credit: 'Attribution', excerpt: 'Excerpts from', codeLicense: 'Code license', question: 'Original question', snapshot: 'Source snapshot',
  },
  ar: {
    extracted: 'مقتطفات مختارة بنص عادي مع حذف التنسيق وبعض الأقسام.',
    abstained: 'لم أجد أدلة كافية في مصادر البرمجة المحلية للإجابة.',
    version: 'الإصدار', credit: 'نسبة المحتوى إلى أصحابه', excerpt: 'مقتطفات من', codeLicense: 'ترخيص الشفرة', question: 'السؤال الأصلي', snapshot: 'نسخة المصدر',
  },
};

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|~]/gu, '\\$&');
}

function link(label: string, url: string): string {
  return `[${escapeMarkdown(label)}](<${url}>)`;
}

function fence(block: CodeBlock): string {
  const longestRun = Math.max(2, ...[...block.text.matchAll(/`+/gu)].map(match => match[0].length));
  const fenceText = '`'.repeat(longestRun + 1);
  const language = block.language && /^[\w+-]+$/u.test(block.language) ? block.language : '';
  const finalNewline = block.text.endsWith('\n') ? '' : '\n';
  return `${fenceText}${language}\n${block.text}${finalNewline}${fenceText}`;
}

export function formatAnswer(answer: CodeAnswer, locale: keyof typeof labels = 'en'): string {
  const label = labels[locale];
  if (answer.status === 'abstained') return label.abstained;
  return answer.excerpts.map(({ sentences, code, citation }) => {
    const credit = citation.attribution.map(author => author.url ? link(author.name, author.url) : escapeMarkdown(author.name));
    const headings = [
      `${label.excerpt} ${link(citation.title, citation.url)} (${escapeMarkdown(citation.sourceTitle)})`,
      citation.questionUrl ? link(label.question, citation.questionUrl) : undefined,
      `${label.version} ${escapeMarkdown(citation.version)} · ${link(label.snapshot, citation.sourceUrl)} · ${link(citation.license, citation.licenseUrl)}`,
      citation.sourceKind === 'documentation' ? label.extracted : undefined,
      credit.length ? `${label.credit} ${credit.join(', ')}` : undefined,
    ];
    const snippets = code.flatMap(block => [
      fence(block),
      block.license && block.licenseUrl ? `${label.codeLicense} ${link(block.license, block.licenseUrl)}` : undefined,
      block.copyrightNotice ? escapeMarkdown(block.copyrightNotice) : undefined,
    ]);
    const notice = citation.copyrightNotice ? escapeMarkdown(citation.copyrightNotice) : undefined;
    return [...headings, ...sentences.map(sentence => `> ${escapeMarkdown(sentence)}`), ...snippets, notice].filter(Boolean).join('\n\n');
  }).join('\n\n---\n\n');
}
