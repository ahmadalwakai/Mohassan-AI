import { z } from 'zod';
import { PDF_LIMITS } from './limits.ts';

/**
 * A document is data, never markup: every string the owner typed is escaped before it reaches
 * Chromium, the page carries a CSP that forbids scripts and any network, and the layout comes
 * from a fixed theme. Arabic documents are right-to-left with a system Arabic font stack.
 */
export type DocumentLang = 'ar' | 'en';
export const DOCUMENT_THEMES = ['plain', 'report', 'letter', 'invoice', 'modern'] as const;
export type DocumentTheme = (typeof DOCUMENT_THEMES)[number];
export const PAGE_SIZES = ['A4', 'Letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

const cell = z.string().max(2000);
const item = z.string().min(1).max(2000);
export const DocumentBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal('paragraph'), text: z.string().min(1).max(PDF_LIMITS.textChars) }).strict(),
  z.object({ kind: z.literal('bullets'), items: z.array(item).min(1).max(300) }).strict(),
  z.object({ kind: z.literal('numbered'), items: z.array(item).min(1).max(300) }).strict(),
  z.object({ kind: z.literal('quote'), text: z.string().min(1).max(PDF_LIMITS.textChars) }).strict(),
  z.object({ kind: z.literal('table'), header: z.array(cell).min(1).max(12).optional(), rows: z.array(z.array(cell).min(1).max(12)).min(1).max(500) }).strict(),
  z.object({ kind: z.literal('keyvalue'), items: z.array(z.object({ key: z.string().min(1).max(200), value: cell }).strict()).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('code'), text: z.string().min(1).max(PDF_LIMITS.textChars) }).strict(),
  z.object({ kind: z.literal('divider') }).strict(),
  z.object({ kind: z.literal('pagebreak') }).strict(),
]);
export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;

/** Every typed string of a block, for length limits and language detection. */
export function blockStrings(block: DocumentBlock): string[] {
  switch (block.kind) {
    case 'heading': case 'paragraph': case 'quote': case 'code': return [block.text];
    case 'bullets': case 'numbered': return [...block.items];
    case 'keyvalue': return block.items.flatMap(entry => [entry.key, entry.value]);
    case 'table': return [...(block.header ?? []), ...block.rows.flat()];
    case 'divider': case 'pagebreak': return [];
  }
}

export function documentTextLength(blocks: readonly DocumentBlock[]): number {
  let total = 0;
  for (const block of blocks) for (const text of blockStrings(block)) total += text.length;
  return total;
}

export const DocumentSpecSchema = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300).optional(),
  author: z.string().trim().max(120).optional(),
  date: z.string().trim().max(60).optional(),
  lang: z.enum(['ar', 'en']).optional(),
  theme: z.enum(DOCUMENT_THEMES).default('plain'),
  /** Six-digit hex colour for headings and bands; the theme default otherwise. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  pageSize: z.enum(PAGE_SIZES).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  pageNumbers: z.boolean().default(true),
  /** Footer text beside the page number; the title when absent. */
  footer: z.string().trim().max(200).optional(),
  blocks: z.array(DocumentBlockSchema).max(PDF_LIMITS.blocks),
}).strict().superRefine((spec, context) => {
  if (documentTextLength(spec.blocks) + spec.title.length > PDF_LIMITS.textChars) context.addIssue({ code: 'custom', message: `نص المستند يتجاوز ${PDF_LIMITS.textChars} حرفًا.`, path: ['blocks'] });
});
export type DocumentSpec = z.infer<typeof DocumentSpecSchema>;
export type DocumentSpecInput = z.input<typeof DocumentSpecSchema>;

const ARABIC_LETTER = /[؀-ۿݐ-ݿ]/gu;
const LATIN_LETTER = /[A-Za-z]/gu;
/** Arabic first: a document is Arabic when at least a quarter of its letters are, English only when Arabic is rare or absent. */
export function detectLang(text: string): DocumentLang {
  const arabic = text.match(ARABIC_LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  if (arabic === 0 && latin > 0) return 'en';
  return arabic * 3 >= latin ? 'ar' : 'en';
}

const BULLET = /^\s*(?:[-*•·–—◦▪])\s+(.*)$/u;
const NUMBERED = /^\s*[0-9٠-٩۰-۹]{1,3}[.)۔-]\s+(.*)$/u;
const HEADING = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const PAGE_BREAK = /^\s*(?:={3,}|\[(?:صفحة جديدة|page ?break)\])\s*$/iu;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
const KEY_VALUE = /^\s*([^:：\n]{1,30}?)\s*[:：]\s+(\S.*)$/u;
const FENCE = /^\s*```/u;

const splitCells = (line: string) => line.replace(TABLE_ROW, '$1').split('|').map(value => value.trim());
const special = (line: string) => FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line) || DIVIDER.test(line) || PAGE_BREAK.test(line) || TABLE_ROW.test(line);

/**
 * Plain text or light Markdown into blocks, exactly as typed: # headings, - bullets, 1. numbers
 * (Arabic digits too), > quotes, | tables |, --- dividers, === page breaks, ``` code, and
 * «key: value» lines in pairs. Anything else is a paragraph that keeps its line breaks.
 */
export function parseDocumentText(input: string): DocumentBlock[] {
  const lines = input.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: DocumentBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    if (FENCE.test(line)) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index]!)) code.push(lines[index++]!);
      index++;
      if (code.join('\n').trim()) blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! }); index++; continue; }
    if (PAGE_BREAK.test(line)) { blocks.push({ kind: 'pagebreak' }); index++; continue; }
    if (DIVIDER.test(line)) { blocks.push({ kind: 'divider' }); index++; continue; }
    if (TABLE_ROW.test(line)) {
      const rows: string[][] = [];
      let header: string[] | undefined;
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        const current = lines[index++]!;
        if (TABLE_SEPARATOR.test(current)) { if (rows.length === 1 && !header) header = rows.pop(); continue; }
        rows.push(splitCells(current));
      }
      if (rows.length) blocks.push({ kind: 'table', ...(header ? { header } : {}), rows });
      else if (header) blocks.push({ kind: 'table', header, rows: [header.map(() => '')] });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const pattern = BULLET.test(line) ? BULLET : NUMBERED;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index]!)) {
        items.push(pattern.exec(lines[index++]!)![1]!.trim());
        // A wrapped item continues on indented lines.
        while (index < lines.length && /^\s{2,}\S/u.test(lines[index]!) && !special(lines[index]!)) items[items.length - 1] += `\n${lines[index++]!.trim()}`;
      }
      const kept = items.filter(Boolean);
      if (kept.length) blocks.push({ kind: pattern === BULLET ? 'bullets' : 'numbered', items: kept });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) quoted.push(QUOTE.exec(lines[index++]!)![1]!);
      if (quoted.join('\n').trim()) blocks.push({ kind: 'quote', text: quoted.join('\n').trim() });
      continue;
    }
    if (KEY_VALUE.test(line) && index + 1 < lines.length && KEY_VALUE.test(lines[index + 1]!) && !special(lines[index + 1]!)) {
      const items: { key: string; value: string }[] = [];
      while (index < lines.length && KEY_VALUE.test(lines[index]!) && !special(lines[index]!)) {
        const [, key, value] = KEY_VALUE.exec(lines[index++]!)!;
        items.push({ key: key!.trim(), value: value!.trim() });
      }
      blocks.push({ kind: 'keyvalue', items });
      continue;
    }
    // A paragraph ends where a «key: value» group begins.
    const pairs = (at: number) => KEY_VALUE.test(lines[at] ?? '') && KEY_VALUE.test(lines[at + 1] ?? '') && !special(lines[at + 1]!);
    const paragraph: string[] = [lines[index++]!];
    while (index < lines.length && lines[index]!.trim() && !special(lines[index]!) && !pairs(index)) paragraph.push(lines[index++]!);
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n').trim() });
  }
  return blocks;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
/** **bold** and `code` only, applied after escaping so no typed character becomes markup. */
function inline(value: string): string {
  return escapeHtml(value).replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>').replace(/`([^`\n]+)`/gu, '<code>$1</code>');
}

export const FONT_STACK = '"Mohassan Document", "Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", "Sakkal Majalla", Arial, sans-serif';
const MONO_STACK = 'Consolas, "Courier New", monospace';
const DEFAULT_ACCENT: Record<DocumentTheme, string> = { plain: '#1f4e79', report: '#1f4e79', letter: '#333333', invoice: '#0b6e4f', modern: '#7c3aed' };

function themeCss(theme: DocumentTheme, accent: string, rtl: boolean): string {
  const start = rtl ? 'right' : 'left';
  const base = `
    :root { --accent: ${accent}; --ink: #1c1c1c; --muted: #666; --line: #d9dee3; --soft: #f4f6f8; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: ${FONT_STACK}; color: var(--ink); font-size: 12.5pt; line-height: 1.75; }
    h1, h2, h3, h4, p, li, td, th, blockquote { overflow-wrap: anywhere; }
    h1 { font-size: 24pt; line-height: 1.3; margin: 0 0 6pt; color: var(--accent); }
    h2 { font-size: 17pt; margin: 18pt 0 6pt; color: var(--accent); }
    h3 { font-size: 14pt; margin: 14pt 0 4pt; color: var(--ink); }
    h4 { font-size: 12.5pt; margin: 12pt 0 3pt; color: var(--ink); }
    p { margin: 0 0 9pt; white-space: pre-line; }
    ul, ol { margin: 0 0 9pt; padding-${start}: 22pt; }
    li { margin: 0 0 3pt; white-space: pre-line; }
    blockquote { margin: 8pt 0 12pt; padding: 6pt 14pt; border-${start}: 3px solid var(--accent); background: var(--soft); color: #333; white-space: pre-line; }
    table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 11.5pt; }
    tr { page-break-inside: avoid; }
    th, td { border: 1px solid var(--line); padding: 5pt 8pt; text-align: start; vertical-align: top; }
    th { background: var(--soft); font-weight: 700; }
    table.kv th { width: 32%; color: var(--muted); font-weight: 600; background: transparent; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 14pt 0; }
    pre { font-family: ${MONO_STACK}; font-size: 10.5pt; background: #f6f8fa; border: 1px solid var(--line); border-radius: 4px; padding: 8pt 10pt; white-space: pre-wrap; direction: ltr; text-align: left; margin: 0 0 12pt; }
    code { font-family: ${MONO_STACK}; font-size: 0.92em; background: #f1f3f5; padding: 0 4px; border-radius: 3px; direction: ltr; unicode-bidi: embed; }
    .page-break { break-after: page; height: 0; }
    .subtitle { font-size: 14pt; color: var(--muted); margin: 0 0 4pt; }
    .meta { color: var(--muted); font-size: 10.5pt; margin: 0; }
    header.doc-head { margin-bottom: 18pt; }
    h2, h3, h4 { break-after: avoid; }`;
  const themes: Record<DocumentTheme, string> = {
    plain: `header.doc-head { border-bottom: 2px solid var(--accent); padding-bottom: 8pt; }`,
    report: `
      header.doc-head { background: var(--accent); color: #fff; padding: 20pt 18pt 16pt; margin: 0 0 20pt; border-radius: 6px; }
      header.doc-head h1, header.doc-head .subtitle, header.doc-head .meta { color: #fff; }
      header.doc-head .subtitle, header.doc-head .meta { opacity: 0.9; }
      h2 { border-bottom: 1.5px solid var(--line); padding-bottom: 3pt; }
      th { background: var(--accent); color: #fff; border-color: var(--accent); }
      tbody tr:nth-child(even) td { background: #fafbfc; }`,
    letter: `
      body { font-size: 13pt; line-height: 1.9; }
      header.doc-head { margin-bottom: 26pt; }
      h1 { font-size: 15pt; color: var(--ink); font-weight: 700; }
      header.doc-head .meta { margin-top: 10pt; }
      h2, h3 { color: var(--ink); }
      p { margin-bottom: 12pt; }`,
    invoice: `
      header.doc-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid var(--accent); padding-bottom: 10pt; margin-bottom: 18pt; }
      h1 { font-size: 26pt; letter-spacing: 0.5px; }
      th { background: var(--accent); color: #fff; border-color: var(--accent); }
      tbody tr:nth-child(even) td { background: #f7faf9; }
      tbody tr:last-child td { font-weight: 700; border-top: 2px solid var(--accent); }
      table.kv th, table.kv td { border: 0; border-bottom: 1px dashed var(--line); padding: 4pt 6pt; }`,
    modern: `
      body { font-size: 12pt; }
      h1 { font-size: 28pt; font-weight: 800; letter-spacing: -0.3px; }
      header.doc-head { padding-${start}: 14pt; border-${start}: 6px solid var(--accent); margin-bottom: 22pt; }
      h2 { font-size: 15pt; padding-${start}: 10pt; border-${start}: 4px solid var(--accent); }
      blockquote { border: 0; border-radius: 8px; background: #f3f0fa; }
      th { background: #efe9fb; color: var(--ink); }
      hr { border-top: 2px solid var(--accent); width: 60pt; margin-${start}: 0; }`,
  };
  return base + themes[theme];
}

function renderBlock(block: DocumentBlock): string {
  switch (block.kind) {
    case 'heading': return `<h${block.level + 1} dir="auto">${inline(block.text)}</h${block.level + 1}>`;
    case 'paragraph': return `<p dir="auto">${inline(block.text)}</p>`;
    case 'bullets': return `<ul>${block.items.map(entry => `<li dir="auto">${inline(entry)}</li>`).join('')}</ul>`;
    case 'numbered': return `<ol>${block.items.map(entry => `<li dir="auto">${inline(entry)}</li>`).join('')}</ol>`;
    case 'quote': return `<blockquote dir="auto">${inline(block.text)}</blockquote>`;
    case 'table': {
      const width = Math.max(block.header?.length ?? 0, ...block.rows.map(row => row.length));
      const pad = (row: readonly string[]) => [...row, ...Array<string>(Math.max(0, width - row.length)).fill('')];
      const head = block.header ? `<thead><tr>${pad(block.header).map(value => `<th dir="auto">${inline(value)}</th>`).join('')}</tr></thead>` : '';
      return `<table>${head}<tbody>${block.rows.map(row => `<tr>${pad(row).map(value => `<td dir="auto">${inline(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'keyvalue': return `<table class="kv"><tbody>${block.items.map(entry => `<tr><th dir="auto">${inline(entry.key)}</th><td dir="auto">${inline(entry.value)}</td></tr>`).join('')}</tbody></table>`;
    case 'code': return `<pre>${escapeHtml(block.text)}</pre>`;
    case 'divider': return '<hr>';
    case 'pagebreak': return '<div class="page-break"></div>';
  }
}

export interface PrintOptions {
  format: PageSize;
  landscape: boolean;
  margin: { top: string; right: string; bottom: string; left: string };
  displayHeaderFooter: boolean;
  headerTemplate: string;
  footerTemplate: string;
}
export interface RenderedDocument {
  html: string;
  title: string;
  lang: DocumentLang;
  theme: DocumentTheme;
  /** Chromium print options matching the specification. */
  print: PrintOptions;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

/** The whole page for Chromium, from a validated specification. `fontFaces` is optional @font-face CSS for bundled fonts. */
export function renderDocumentHtml(input: DocumentSpecInput, fontFaces = ''): RenderedDocument {
  const spec = DocumentSpecSchema.parse(input);
  const sample = [spec.title, spec.subtitle ?? '', ...spec.blocks.slice(0, 12).flatMap(blockStrings)].join(' ');
  const lang = spec.lang ?? detectLang(sample);
  const rtl = lang === 'ar';
  const accent = spec.accent ?? DEFAULT_ACCENT[spec.theme];
  const meta = [spec.author, spec.date].filter((value): value is string => Boolean(value)).map(escapeHtml).join(' · ');
  const head = `<header class="doc-head"><div><h1 dir="auto">${inline(spec.title)}</h1>${spec.subtitle ? `<p class="subtitle" dir="auto">${inline(spec.subtitle)}</p>` : ''}</div>${meta ? `<p class="meta" dir="auto">${meta}</p>` : ''}</header>`;
  const html = `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${escapeHtml(spec.title)}</title><style>${fontFaces}${themeCss(spec.theme, accent, rtl)}</style></head><body class="theme-${spec.theme}">${head}<main>${spec.blocks.map(renderBlock).join('\n')}</main></body></html>`;
  const footerText = escapeHtml(spec.footer ?? spec.title).slice(0, 160);
  const pageLabel = rtl ? 'صفحة <span class="pageNumber"></span> من <span class="totalPages"></span>' : 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>';
  const footerTemplate = `<div style="font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 8.5px; color: #777; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between; direction: ${rtl ? 'rtl' : 'ltr'};"><span>${footerText}</span><span>${spec.pageNumbers ? pageLabel : ''}</span></div>`;
  const side = spec.theme === 'letter' ? '24mm' : '17mm';
  return {
    html, title: spec.title, lang, theme: spec.theme,
    print: { format: spec.pageSize, landscape: spec.orientation === 'landscape', margin: { top: '18mm', bottom: '20mm', left: side, right: side },
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate },
  };
}

/** One A4 page with the watermark text alone; the editor scales it onto every page of an existing PDF. */
export function watermarkHtml(text: string, options: { color?: string; opacity?: number; angle?: number } = {}): string {
  const color = /^#[0-9a-fA-F]{6}$/u.test(options.color ?? '') ? options.color! : '#7a8699';
  const opacity = Math.min(1, Math.max(0.05, options.opacity ?? 0.22));
  const angle = Math.max(-90, Math.min(90, options.angle ?? -32));
  const size = text.length > 24 ? 44 : text.length > 12 ? 64 : 92;
  return `<!doctype html><html dir="${detectLang(text) === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
    html, body { margin: 0; padding: 0; width: 210mm; height: 297mm; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; font-family: ${FONT_STACK}; }
    .mark { transform: rotate(${angle}deg); font-size: ${size}pt; font-weight: 700; color: ${color}; opacity: ${opacity}; text-align: center; max-width: 180mm; overflow-wrap: anywhere; line-height: 1.2; }
  </style></head><body><div class="mark">${escapeHtml(text)}</div></body></html>`;
}
export const WATERMARK_PRINT: PrintOptions = { format: 'A4', landscape: false, margin: { top: '0', right: '0', bottom: '0', left: '0' }, displayHeaderFooter: false, headerTemplate: '', footerTemplate: '' };
