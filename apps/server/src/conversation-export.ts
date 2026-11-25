import type { ConversationSnapshot } from '@mohassan/contracts';
import { escapeHtml, FONT_STACK, type PdfRenderer } from '@mohassan/pdf';

type ConversationMessage = ConversationSnapshot['messages'][number];

const roleLabel: Record<ConversationMessage['role'], string> = { user: 'المستخدم', assistant: 'موحسن' };

function exportSources(message: ConversationMessage) {
  if (message.role !== 'assistant') return [];
  return message.sources.flatMap(source => {
    const url = URL.parse(source.url);
    return url && (url.protocol === 'https:' || url.protocol === 'http:')
      ? [{ title: source.title || url.href, url: url.href }]
      : [];
  });
}

function markdownLabel(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/[\\[\]`*_~#!<>]/gu, '\\$&');
}

function markdownMessage(text: string): string {
  // The quotation contains each message's Markdown, including any unclosed code fence.
  return text.replace(/\r\n?/gu, '\n').replace(/</gu, '&lt;').replace(/!\[/gu, '\\![')
    .split('\n').map(line => line ? `> ${line}` : '>').join('\n');
}

function dateMarkup(value: string): string {
  const iso = escapeHtml(value);
  return `<time dir="ltr" datetime="${iso}">${iso}</time>`;
}

export function renderConversationMarkdown(snapshot: ConversationSnapshot): string {
  const sections = snapshot.messages.map(message => {
    const sources = exportSources(message).map(source => `- [${markdownLabel(source.title)}](<${source.url}>)`);
    return [
      `## ${roleLabel[message.role]}`,
      dateMarkup(message.createdAt),
      message.text ? markdownMessage(message.text) : '',
      sources.length ? `**المصادر**\n\n${sources.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  });
  return ['<div lang="ar" dir="rtl">', `# ${markdownLabel(snapshot.title)}`,
    `تاريخ المحادثة ${dateMarkup(snapshot.createdAt)}`, ...sections, '</div>', ''].join('\n\n');
}

export async function renderConversationPdf(snapshot: ConversationSnapshot, renderer: PdfRenderer, signal?: AbortSignal): Promise<Buffer> {
  const fonts = await renderer.fontFaces();
  const messages = snapshot.messages.map(message => {
    const sources = exportSources(message).map(source =>
      `<li><a dir="auto" href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a></li>`).join('');
    return `<section><header><h2>${roleLabel[message.role]}</h2>${dateMarkup(message.createdAt)}</header>
      <div class="text" dir="auto">${escapeHtml(message.text)}</div>
      ${sources ? `<h3>المصادر</h3><ul>${sources}</ul>` : ''}</section>`;
  }).join('\n');
  const title = escapeHtml(snapshot.title);
  // Noto Naskh's ccmp substitution splits some letters into glyphs that Chromium cannot map back to text.
  // Disabling it keeps the joining features and produces extractable Arabic. OpenType feature definition,
  // retrieved 2026-11-25: https://learn.microsoft.com/en-us/typography/opentype/spec/features_ae#tag-ccmp
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">
    <title>${title}</title><style>${fonts}
    body { margin: 0; color: #1c1c1c; font: 12pt/1.65 ${FONT_STACK}; font-feature-settings: "ccmp" 0; }
    h1, h2, h3, a, .text { overflow-wrap: anywhere; }
    h1, h2, h3 { margin: 0; line-height: 1.35; }
    h1 { font-size: 22pt; }
    h2 { font-size: 15pt; }
    h3 { font-size: 12pt; break-after: avoid; }
    header { break-after: avoid; }
    time { font-size: 10pt; color: #505963; unicode-bidi: isolate; }
    section { margin-block-start: 14pt; padding-block-start: 10pt; border-block-start: 1px solid #d9dee3; }
    .text { margin-block: 4pt 6pt; white-space: pre-wrap; unicode-bidi: plaintext; }
    ul { margin: 2pt 0 0; padding-inline-start: 18pt; }
    a { color: #1f4e79; }
    </style></head><body><header><h1 dir="auto">${title}</h1><div>تاريخ المحادثة ${dateMarkup(snapshot.createdAt)}</div></header>
    <main>${messages}</main></body></html>`;
  return renderer.render(html, { signal });
}
