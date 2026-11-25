export interface WikipediaField {
  template: string;
  key: string;
  wikitext: string;
}

const ignoredMarkup = /<!--|<(ref|references|nowiki|gallery|math|syntaxhighlight|score|timeline)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const heading = /={2,6}[^=\n][^\n]*?={2,6}[ \t]*(?=\n|$)/y;
const maxLeadLength = 16_384;

function maskNonContent(text: string): string {
  const pieces: string[] = [];
  let end = 0;
  ignoredMarkup.lastIndex = 0;
  for (let match = ignoredMarkup.exec(text); match; match = ignoredMarkup.exec(text)) {
    pieces.push(text.slice(end, match.index));
    end = ignoredMarkup.lastIndex;
    if (!match[1]) {
      const close = text.indexOf('-->', end);
      end = close === -1 ? text.length : close + 3;
    } else if (!match[0].endsWith('/>')) {
      const close = new RegExp(`</${match[1]}\\s*>`, 'gi');
      close.lastIndex = end;
      const ending = close.exec(text);
      end = ending ? close.lastIndex : text.length;
    }
    // Preserve positions for exact infobox slices and ignore headings within masked markup.
    pieces.push(' '.repeat(end - match.index));
    ignoredMarkup.lastIndex = end;
  }
  return pieces.length ? pieces.join('') + text.slice(end) : text;
}

type Markup = 'template' | 'parameter' | 'table' | 'link' | 'external';
const openings: Record<Markup, string> = { template: '{{', parameter: '{{{', table: '{|', link: '[[', external: '[' };
const closings: Record<Markup, string> = { template: '}}', parameter: '}}}', table: '|}', link: ']]', external: ']' };

function opener(text: string, i: number): Markup | undefined {
  if (text[i] === '{') {
    if (text.startsWith('{{{', i)) return 'parameter';
    if (text.startsWith('{{', i)) return 'template';
    if (text.startsWith('{|', i)) return 'table';
  }
  if (text[i] === '[') {
    if (text.startsWith('[[', i)) return 'link';
    if (text.startsWith('[https://', i) || text.startsWith('[http://', i) || text.startsWith('[//', i)) return 'external';
  }
  return undefined;
}

function closeMarkup(text: string, start: number, kind: Markup): number {
  const stack = [kind];
  for (let i = start + openings[kind].length; i < text.length;) {
    const close = closings[stack[stack.length - 1]];
    if (text.startsWith(close, i)) {
      i += close.length;
      stack.pop();
      if (!stack.length) return i;
    } else {
      const open = opener(text, i);
      if (open) {
        if (stack.length === 128) return -1;
        stack.push(open);
        i += openings[open].length;
      } else {
        i++;
      }
    }
  }
  return -1;
}

interface Piece {
  start: number;
  end: number;
  kind: Markup | 'text';
  closed: boolean;
}

function* pieces(text: string, stopAtHeading = false): Generator<Piece> {
  let start = 0;
  for (let i = 0; i < text.length;) {
    if (stopAtHeading && text[i] === '=' && (i === 0 || text[i - 1] === '\n')) {
      heading.lastIndex = i;
      if (heading.test(text)) {
        if (start < i) yield { start, end: i, kind: 'text', closed: true };
        return;
      }
    }
    const open = opener(text, i);
    if (!open) {
      i++;
      continue;
    }
    if (start < i) yield { start, end: i, kind: 'text', closed: true };
    const end = closeMarkup(text, i, open);
    if (end === -1) {
      yield { start: i, end: text.length, kind: open, closed: false };
      return;
    }
    yield { start: i, end, kind: open, closed: true };
    start = i = end;
  }
  if (start < text.length) yield { start, end: text.length, kind: 'text', closed: true };
}

function* separators(text: string, separator: string): Generator<number> {
  for (const piece of pieces(text)) {
    if (piece.kind !== 'text') continue;
    for (let i = piece.start; i < piece.end; i++) {
      if (text[i] === separator) yield i;
    }
  }
}

const ignoredLink = /^(?:file|image|category|media|ملف|صورة|تصنيف|وسائط)\s*:/iu;

function linkDisplay(markup: string, kind: 'link' | 'external', depth: number): string {
  if (!depth) return '';
  if (kind === 'external') {
    const split = markup.search(/\s/u);
    return split < 0 ? '' : renderInline(markup.slice(split + 1, -1), depth - 1);
  }
  const body = markup.slice(2, -2);
  const dividers = [...separators(body, '|')];
  const target = body.slice(0, dividers[0]).trim();
  if (ignoredLink.test(target)) return '';
  return renderInline(body.slice((dividers.at(-1) ?? -1) + 1), depth - 1).replaceAll('_', ' ').trim();
}

function renderInline(body: string, depth: number): string {
  const text: string[] = [];
  for (const piece of pieces(body)) {
    if (!piece.closed) continue;
    if (piece.kind === 'text') text.push(body.slice(piece.start, piece.end));
    if (piece.kind === 'link' || piece.kind === 'external') {
      text.push(linkDisplay(body.slice(piece.start, piece.end), piece.kind, depth));
    }
  }
  return text.join('');
}

function parseInfobox(masked: string, original: string): WikipediaField[] {
  const dividers = [...separators(masked, '|'), masked.length];
  const template = masked.slice(0, dividers[0]).trim().replaceAll('_', ' ').replace(/\s+/gu, ' ');
  if (!/^(?:infobox|صندوق معلومات|معلومات|بطاقة)(?:\s|$)/iu.test(template)) return [];
  const fields = new Map<string, WikipediaField>();
  for (let i = 0; i < dividers.length - 1; i++) {
    const start = dividers[i] + 1;
    const end = dividers[i + 1];
    const separator = separators(masked.slice(start, end), '=').next().value;
    if (separator === undefined) continue;
    const key = masked.slice(start, start + separator).trim();
    if (!key || !/^[\p{L}\p{M}\p{N}_ -]{1,100}$/u.test(key) || /^\d+$/u.test(key)) continue;
    const wikitext = original.slice(start + separator + 1, end).trim();
    // MediaWiki uses the last occurrence of a named parameter, even if it clears the value.
    if (wikitext.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim()) fields.set(key, { template, key, wikitext });
    else fields.delete(key);
  }
  return [...fields.values()];
}

/** Extract a lexical lead and unexpanded named parameters from top-level lead infoboxes. */
export function parseWikipediaLead(wikitext: string): { lead: string; fields: WikipediaField[] } {
  const masked = maskNonContent(wikitext);
  const text: string[] = [];
  const fields: WikipediaField[] = [];
  for (const piece of pieces(masked, true)) {
    if (!piece.closed) continue;
    if (piece.kind === 'text') text.push(masked.slice(piece.start, piece.end));
    if (piece.kind === 'link' || piece.kind === 'external') {
      text.push(linkDisplay(masked.slice(piece.start, piece.end), piece.kind, 8));
    }
    if (piece.kind === 'template') {
      const infobox = parseInfobox(masked.slice(piece.start + 2, piece.end - 2), wikitext.slice(piece.start + 2, piece.end - 2));
      for (const field of infobox) fields.push(field);
    }
  }
  const lead = text.join('')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<\/?[a-z][^>]*>/giu, '')
    .replace(/'{2,5}|__[A-Z_]+__/g, '')
    .replace(/&(?:nbsp|#160|#x[aA]0);/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const end = lead.length > maxLeadLength ? lead.lastIndexOf(' ', maxLeadLength) : lead.length;
  return { lead: lead.slice(0, end > 0 ? end : maxLeadLength), fields };
}
