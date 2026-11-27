import type { CodeBlock } from '../types.js';

type CodeLicense = Pick<CodeBlock, 'license' | 'licenseUrl' | 'copyrightNotice'>;
type Section = { title: string; anchor?: string; text: string; code: CodeBlock[] };

const entities: Readonly<Record<string, string>> = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: '\u00a0',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][\da-z]*);/gi, (whole: string, body: string) => {
    if (body[0] !== '#') return Object.hasOwn(entities, body) ? entities[body] : whole;
    const hex = body[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : whole;
  });
}

const htmlTags = /<!--[\s\S]*?-->|<\/?[a-z][^<>]*>/gi;
function htmlInline(value: string): string {
  return decodeEntities(value.replace(/<a\b[^>]*class="headerlink"[^>]*>[\s\S]*?<\/a>/gi, '').replace(htmlTags, ''));
}

export function htmlSection(html: string, defaultLanguage?: string, license: CodeLicense = {}): Omit<Section, 'title'> {
  const code: CodeBlock[] = [];
  const body = html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_whole, attributes: string, inner: string) => {
    const withoutTags = inner.replace(htmlTags, '');
    // The supported exporters use numeric references and a small set of named references.
    // Leave any rare unrecognized entity out of the index rather than altering its code.
    if ([...withoutTags.matchAll(/&([a-z][\da-z]*);/gi)].some(match => !Object.hasOwn(entities, match[1]))) return '\n\n';
    const text = decodeEntities(withoutTags);
    const language = (attributes + ' ' + (inner.match(/^\s*<code\b([^>]*)>/i)?.[1] ?? ''))
      .match(/\b(?:language|lang)-([\w+-]+)/i)?.[1] ?? defaultLanguage;
    if (text.trim()) code.push({ text, ...(language ? { language } : {}), ...license });
    return '\n\n';
  });
  const text = htmlInline(body
    .replace(/<(?:nav|script|style|table)\b[^>]*>[\s\S]*?<\/\s*(?:nav|script|style|table)>/gi, '')
    .replace(/<\/(?:p|li|ul|ol|div|dd|section|blockquote)>|<br\s*\/?\s*>/gi, '\n\n'))
    .split(/\n\s*\n/).map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
  return { text, code };
}

export function pythonSections(html: string, license: CodeLicense): Section[] {
  const content = html.split(/<div class="body" role="main">/)[1]?.split(/\s*<div class="(?:sphinxsidebar|footer)"/)[0];
  if (content === undefined) throw new Error('Python documentation lost its article container');
  const sections: Section[] = [];
  let title = '';
  let anchor: string | undefined;
  let end = 0;
  const headings = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>|<dt class="sig sig-object py" id="([^"]+)">[\s\S]*?<\/dt>/gi;
  for (const heading of content.matchAll(headings)) {
    if (title) {
      const section = htmlSection(content.slice(end, heading.index), 'python', license);
      if (section.text) sections.push({ title, anchor, ...section });
    }
    anchor = heading[3] ?? heading[2]?.match(/class="headerlink" href="#([^"]+)"/)?.[1];
    title = heading[3] ?? htmlInline(heading[2]).trim();
    end = heading.index + heading[0].length;
  }
  if (title) {
    const section = htmlSection(content.slice(end), 'python', license);
    if (section.text) sections.push({ title, anchor, ...section });
  }
  return sections;
}

function cleanMarkdown(value: string): string {
  const inline: string[] = [];
  const withoutInline = value.replace(/`([^`\n]+)`/g, (_whole, code: string) => {
    inline.push(code);
    return '\u0001' + (inline.length - 1) + '\u0002';
  });
  return decodeEntities(withoutInline
    .replace(/<!--[^]*?-->/g, '')
    .replace(/\{\{\s*(?:jsxref|domxref|glossary|cssxref|httpheader|httpstatus)\("([^"]+)"(?:\s*,\s*"([^"]+)")?[^]*?\)\}\}/gi, (_whole, reference: string, label?: string) => label ?? reference)
    .replace(/\{\{[^]*?\}\}/g, '')
    .replace(/!?\[([^\]]*)\]\([^\s)]+(?:\([^)]*\)[^\s)]*)?(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/(^|\n)\s{0,3}(?:>\s*|[-+]\s+(?::\s*)?)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '$1')
    .replace(htmlTags, ''))
    .replace(/\u0001(\d+)\u0002/g, (_whole, index: string) => inline[Number(index)])
    .split(/\r?\n\s*\r?\n/).map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

export function markdownSections(
  raw: string,
  retainCode: ((block: CodeBlock) => CodeBlock | undefined),
): { frontmatter: Record<string, string>; sections: Section[] } {
  const header = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) throw new Error('Markdown documentation lost its front matter');
  const frontmatter = Object.fromEntries([...header[1].matchAll(/^([\w-]+):\s*([^\r\n]+)$/gm)]
    .map(([, key, value]) => [key, value.trim().replace(/^["'](.*)["']$/, '$1')]));
  if (!frontmatter.title) throw new Error('Markdown documentation lost its title');
  const sections: Section[] = [];
  let title = frontmatter.title;
  let anchor: string | undefined;
  let prose: string[] = [];
  let code: CodeBlock[] = [];
  const flush = () => {
    const body = prose.join('');
    const text = cleanMarkdown(body);
    if (text || code.length) {
      sections.push({ title, anchor, text, code });
    }
    prose = [];
    code = [];
  };

  let fence: { marker: string; language?: string; role?: CodeBlock['role']; lines: string[] } | undefined;
  for (const line of raw.slice(header[0].length).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker[0] && delimiter[1].length >= fence.marker.length && !delimiter[2].trim()) {
        const text = fence.lines.join('');
        const block = text.trim() ? retainCode({ text, language: fence.language, role: fence.role }) : undefined;
        if (block) code.push(block);
        fence = undefined;
      } else fence.lines.push(line);
      continue;
    }
    if (delimiter) {
      const [language, ...flags] = delimiter[2].trim().split(/\s+/);
      const role = flags.includes('example-good') ? 'fix' : flags.includes('example-bad') ? 'failure' : undefined;
      fence = { marker: delimiter[1], language: language || undefined, role, lines: [] };
      continue;
    }
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading) {
      flush();
      title = cleanMarkdown(heading);
      anchor = title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    } else prose.push(line);
  }
  flush();
  return { frontmatter, sections };
}
