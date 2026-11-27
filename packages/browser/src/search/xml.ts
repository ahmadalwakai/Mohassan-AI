// XML 1.0 character references and namespaces, retrieved 2026-11-27.
// https://www.w3.org/TR/xml/ and https://www.w3.org/TR/xml-names/
export interface SearchXmlNode {
  name: string;
  namespace: string;
  text: string;
  children: SearchXmlNode[];
  bindings: ReadonlyMap<string, string>;
  attributes: ReadonlyMap<string, string>;
  content?: (string | SearchXmlNode)[];
}
export class InvalidSearchXml extends Error {}
const invalid = (): never => { throw new InvalidSearchXml(); };
const XML = 'http://www.w3.org/XML/1998/namespace';
const XML_ATTRIBUTES: ReadonlyMap<string, string> = new Map();
const XML_BINDINGS: ReadonlyMap<string, string> = new Map([['xml', XML]]);
const UTF8_DECLARATION = /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/;
const XML_DECLARATION = /^<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/;
function xmlText(input: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(input)) return invalid();
  let result = '', cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('&', cursor);
    if (start < 0) return result + input.slice(cursor);
    result += input.slice(cursor, start);
    const end = input.indexOf(';', start + 1);
    if (end < 0 || end - start > 16) return invalid();
    const entity = input.slice(start + 1, end);
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) result += named[entity];
    else {
      if (!/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) return invalid();
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (![9, 10, 13].includes(code) && !(code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) return invalid();
      result += String.fromCodePoint(code);
    }
    cursor = end + 1;
  }
  return result;
}

/** Restricted, bounded XML reader. DTDs and external entities are never processed. */
export function readSearchXml(input: string, options: {
  maxNodes?: number;
  retainContent?: boolean;
  siteDocument?: boolean;
} = {}): SearchXmlNode {
  const { maxNodes = 5000, retainContent = false, siteDocument = false } = options;
  const source = input.replace(/^\ufeff/, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(source)) return invalid();
  const stack: SearchXmlNode[] = [], names: string[] = [];
  let root: SearchXmlNode | undefined, position = 0, nodes = 0;
  const append = (value: string) => {
    if (!stack.length) { if (value.trim()) invalid(); }
    else {
      const node = stack.at(-1)!;
      node.text += value;
      node.content?.push(value);
    }
  };
  while (position < source.length) {
    if (source[position] !== '<') {
      const next = source.indexOf('<', position), end = next < 0 ? source.length : next;
      const value = source.slice(position, end);
      if (value.includes(']]>')) return invalid();
      append(xmlText(value)); position = end; continue;
    }
    if (position === 0 && (siteDocument ? /^<\?xml[ \t\r\n]/.test(source) : source.startsWith('<?xml '))) {
      const end = source.indexOf('?>', position);
      if (end < 0 || !(siteDocument ? XML_DECLARATION : UTF8_DECLARATION).test(source.slice(position, end + 2))) return invalid();
      position = end + 2; continue;
    }
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      if (end < 0 || source.slice(position + 4, end).includes('--')) return invalid();
      position = end + 3; continue;
    }
    if (source.startsWith('<![CDATA[', position)) {
      const end = source.indexOf(']]>', position + 9);
      if (end < 0 || !stack.length) return invalid();
      const text = source.slice(position + 9, end);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return invalid();
      append(text); position = end + 3; continue;
    }
    if (source.startsWith('<?', position) && siteDocument) {
      const end = source.indexOf('?>', position + 2);
      // Some sitemap publishers include xml-stylesheet declarations. Treat all
      // well-formed instructions as inert XML metadata.
      if (end < 0 || !/^<\?(?!xml(?:\s|\?>))[A-Za-z_][\w.:-]*(?:\s|\?>)/i.test(source.slice(position, end + 2))) return invalid();
      position = end + 2; continue;
    }
    if (source.startsWith('<!', position) || source.startsWith('<?', position)) return invalid();
    let end = position + 1, quote = '';
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === source.length) return invalid();
    const token = source.slice(position + 1, end); position = end + 1;
    if (token.startsWith('/')) {
      if (!/^\/[A-Za-z_][\w.:-]*\s*$/.test(token) || names.pop() !== token.slice(1).trim() || !stack.pop()) return invalid();
      continue;
    }
    const selfClosing = token.endsWith('/'), tag = selfClosing ? token.slice(0, -1) : token;
    const name = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/.exec(tag)?.[0];
    if (!name || ++nodes > maxNodes || stack.length >= 24) return invalid();
    const inherited = stack.at(-1)?.bindings ?? XML_BINDINGS;
    let bindings: Map<string, string> | undefined;
    let attrs: Map<string, string> | undefined;
    const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
    let offset = name.length;
    while (offset < tag.length && tag.slice(offset).trim()) {
      attribute.lastIndex = offset;
      const match = attribute.exec(tag);
      if (!match || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(match[1]) || attrs?.has(match[1]) || (attrs?.size ?? 0) >= 40) return invalid();
      offset = attribute.lastIndex;
      const value = xmlText(match[2] ?? match[3]);
      (attrs ??= new Map()).set(match[1], value);
      if (match[1] === 'xmlns') (bindings ??= new Map(inherited)).set('', value);
      else if (match[1].startsWith('xmlns:')) {
        const prefix = match[1].slice(6);
        if (!value || prefix === 'xmlns' || prefix === 'xml' && value !== XML) return invalid();
        (bindings ??= new Map(inherited)).set(prefix, value);
      }
    }
    const namespaces = bindings ?? inherited;
    for (const attribute of attrs?.keys() ?? []) {
      const prefix = attribute.includes(':') ? attribute.split(':')[0] : '';
      if (prefix && prefix !== 'xmlns' && !namespaces.has(prefix)) return invalid();
    }
    const parts = name.split(':'), prefix = parts.length === 2 ? parts[0] : '', namespace = namespaces.get(prefix) ?? '';
    if (prefix && !namespace) return invalid();
    const node: SearchXmlNode = { name: parts.at(-1)!, namespace, text: '', children: [], bindings: namespaces, attributes: attrs ?? XML_ATTRIBUTES };
    if (retainContent) node.content = [];
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
      parent.content?.push(node);
    } else {
      if (root) return invalid();
      root = node;
    }
    if (!selfClosing) { stack.push(node); names.push(name); }
  }
  if (stack.length || !root) return invalid();
  return root;
}
