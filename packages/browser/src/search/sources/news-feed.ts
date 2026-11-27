import { SearchProviderFailure } from '../providers.js';

// XML syntax and namespaces, RSS 2.0, and Atom 1.0 (checked 2026-11-27).
// https://www.w3.org/TR/2008/REC-xml-20081126/ and https://www.w3.org/TR/xml-names/
// https://www.rssboard.org/rss-specification and https://www.rfc-editor.org/rfc/rfc4287.html
const ATOM = 'http://www.w3.org/2005/Atom';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XML_NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const XML_SPACE = '[ \\t\\r\\n]';
const XML_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const invalid = (): never => { throw new SearchProviderFailure('invalid_response'); };

interface Element {
  name: string;
  namespace: string;
  attributes: Map<string, string>;
  parts: (Element | string)[];
}

function decodeEntities(input: string): string {
  return input.replace(/&(?:#x[\da-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});|&/g, reference => {
    const name = reference.slice(1, -1);
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!name.startsWith('#') || !(
      code === 9 || code === 10 || code === 13 ||
      code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff
    )) return invalid();
    return String.fromCodePoint(code);
  });
}

/** Restricted XML reader. Declarations cannot define entities or fetch resources. */
function readFeed(input: string): Element {
  const source = input.replace(/^\ufeff/, '');
  if (source.length > 2_000_000 || XML_CONTROL.test(source)) return invalid();
  const opening = new RegExp(`<(${XML_NAME})`, 'y');
  const closing = new RegExp(`</(${XML_NAME})${XML_SPACE}*>`, 'y');
  const attribute = new RegExp(`${XML_SPACE}+(${XML_NAME})${XML_SPACE}*=${XML_SPACE}*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
  const spaces = new RegExp(`${XML_SPACE}*`, 'y');
  const stack: { qualified: string; element: Element; namespaces: Map<string, string> }[] = [];
  let root: Element | undefined;
  let position = 0;
  let elements = 0;
  const append = (value: string) => {
    const parent = stack.at(-1);
    if (parent) parent.element.parts.push(value);
    else if (!/^[ \t\r\n]*$/.test(value)) invalid();
  };

  while (position < source.length) {
    if (source[position] !== '<') {
      const marker = source.indexOf('<', position);
      const end = marker < 0 ? source.length : marker;
      const value = source.slice(position, end);
      if (value.includes(']]>')) return invalid();
      append(decodeEntities(value));
      position = end;
      continue;
    }
    if (source.startsWith('<!--', position) || source.startsWith('<?', position)) {
      const comment = source.startsWith('<!--', position);
      const separator = comment ? '-->' : '?>';
      const offset = position + (comment ? 4 : 2);
      const end = source.indexOf(separator, offset);
      if (end < 0 || comment && source.indexOf('--', offset) !== end) return invalid();
      position = end + separator.length;
      continue;
    }
    if (source.startsWith('<![CDATA[', position)) {
      const end = source.indexOf(']]>', position + 9);
      if (end < 0 || !stack.length) return invalid();
      append(source.slice(position + 9, end));
      position = end + 3;
      continue;
    }
    if (source.startsWith('</', position)) {
      closing.lastIndex = position;
      const match = closing.exec(source);
      if (!match || stack.pop()?.qualified !== match[1]) return invalid();
      position = closing.lastIndex;
      continue;
    }

    opening.lastIndex = position;
    const match = opening.exec(source);
    if (!match || stack.length >= 32 || ++elements > 12_000) return invalid();
    const qualified = match[1];
    const attributes = new Map<string, string>();
    const inherited = stack.at(-1)?.namespaces ?? new Map([['xml', XML]]);
    let namespaces = inherited;
    attribute.lastIndex = opening.lastIndex;
    let endOfAttributes = attribute.lastIndex;
    for (let field = attribute.exec(source); field; field = attribute.exec(source)) {
      const key = field[1];
      if (attributes.has(key) || attributes.size >= 48) return invalid();
      const value = decodeEntities(field[2] ?? field[3]);
      attributes.set(key, value);
      endOfAttributes = attribute.lastIndex;
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (prefix === 'xmlns' || prefix === 'xml' && value !== XML || prefix && !value) return invalid();
        if (namespaces === inherited) namespaces = new Map(inherited);
        namespaces.set(prefix, value);
      }
    }
    spaces.lastIndex = endOfAttributes;
    spaces.exec(source);
    const end = spaces.lastIndex;
    const selfClosing = source.startsWith('/>', end);
    if (!selfClosing && source[end] !== '>') return invalid();
    const split = qualified.indexOf(':');
    const prefix = split < 0 ? '' : qualified.slice(0, split);
    if (prefix && !namespaces.has(prefix)) return invalid();
    const element: Element = { name: qualified.slice(split + 1), namespace: namespaces.get(prefix) ?? '', attributes, parts: [] };
    const parent = stack.at(-1);
    if (parent) parent.element.parts.push(element);
    else if (root) return invalid();
    else root = element;
    if (!selfClosing) stack.push({ qualified, element, namespaces });
    position = end + (selfClosing ? 2 : 1);
  }
  if (stack.length || !root) return invalid();
  return root;
}

function children(node: Element, name: string): Element[] {
  return node.parts.filter((part): part is Element => typeof part !== 'string' && part.name === name && part.namespace === node.namespace);
}

function body(node: Element): string {
  return node.parts.map(part => typeof part === 'string' ? part :
    ['script', 'style'].includes(part.name.toLowerCase()) ? '' : ` ${body(part)} `).join('').trim();
}

interface FeedArticle {
  title: string;
  url: string;
  summary: string;
  date: string;
  dateKind: 'published' | 'updated';
}

/** RSS 2.0 and Atom article metadata. Callers validate links and sanitize text for display. */
export function parseNewsFeed(input: string): FeedArticle[] {
  const root = readFeed(input);
  const atom = root.name === 'feed' && root.namespace === ATOM;
  const channel = root.name === 'rss' && !root.namespace ? children(root, 'channel')[0] : undefined;
  if (!atom && !channel) return invalid();

  return children(channel ?? root, atom ? 'entry' : 'item').flatMap(item => {
    const field = (name: string) => children(item, name).map(body).find(Boolean) ?? '';
    const title = field('title');
    const summary = atom ? field('summary') || field('content') : field('description');
    const published = field(atom ? 'published' : 'pubDate');
    const date = published || (atom ? field('updated') : '');
    const url = atom ? children(item, 'link').find(({ attributes }) => {
      const type = attributes.get('type');
      return (attributes.get('rel') ?? 'alternate') === 'alternate' &&
        (!type || /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) && Boolean(attributes.get('href')?.trim());
    })?.attributes.get('href')?.trim() : field('link');
    return title && url && date ? [{ title, url, summary, date, dateKind: published ? 'published' : 'updated' }] : [];
  });
}
