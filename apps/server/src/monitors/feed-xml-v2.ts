// Deliberately small XML subset for RSS 2.0, Atom (RFC 4287), and the Sitemap protocol.
// Only predefined XML 1.0 character references and numeric references are supported.
const MAX_XML_BYTES = 512 * 1024;
const MAX_DEPTH = 24;
const MAX_TOKENS = 12_000;
const MAX_ENTRIES = 100;
const MAX_VALUE = 2_100;
const XML_NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
const tagName = new RegExp('^' + XML_NAME, 'u');
const attribute = new RegExp('^(' + XML_NAME + ')\\s*=\\s*(?:"([^"<]*)"|\'([^\'<]*)\')', 'u');
const standardEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export interface MonitorFeedEntry { url: string; title?: string; published?: string }
export interface MonitorFeedXml {
  kind: 'feed' | 'sitemap' | 'index';
  entries: MonitorFeedEntry[];
}

interface Frame {
  name: string;
  local: string;
  fields: Record<string, string>;
  entry?: true;
  text: string;
}

export function xmlEntityText(value: string): string {
  let invalid = false;
  const result = value.replace(/&(?:#x([0-9a-fA-F]+);|#([0-9]+);|([A-Za-z]+);)?/gu, (_match, hex?: string, decimal?: string, named?: string) => {
    if (named && Object.hasOwn(standardEntities, named)) return standardEntities[named as keyof typeof standardEntities];
    const code = hex ? Number.parseInt(hex, 16) : decimal ? Number(decimal) : -1;
    if (code === 0x9 || code === 0xa || code === 0xd || code >= 0x20 && code <= 0xd7ff ||
      code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff) return String.fromCodePoint(code);
    invalid = true;
    return '';
  });
  if (invalid) throw new Error('Unsupported XML character reference.');
  return result;
}

function xmlTag(source: string): { name: string; attributes: Map<string, string>; empty: boolean } {
  const name = tagName.exec(source)?.[0];
  if (!name) throw new Error('Invalid XML element.');
  let rest = source.slice(name.length);
  const attributes = new Map<string, string>();
  while (rest.trim() && rest.trim() !== '/') {
    if (!/^\s/u.test(rest)) throw new Error('Missing XML attribute separator.');
    rest = rest.trimStart();
    const pair = attribute.exec(rest);
    if (!pair || attributes.has(pair[1])) throw new Error('Invalid XML attribute.');
    attributes.set(pair[1], xmlEntityText(pair[2] ?? pair[3]));
    rest = rest.slice(pair[0].length);
  }
  return { name, attributes, empty: rest.trim() === '/' };
}

function publishedTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A date with no observed clock time cannot train a time-of-day model.
  if (!/\d{2}:\d{2}.*(?:z|[+-]\d{2}:?\d{2}|\b(?:gmt|ut|utc))$/iu.test(value.trim())) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function parseMonitorFeedXml(body: string): MonitorFeedXml | undefined {
  if (Buffer.byteLength(body) > MAX_XML_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body)) return undefined;
  // Each match advances at least one character. Declarations never enter the element parser.
  // Comments and CDATA may contain declaration-like text without executing it.
  const tokenizer = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gyu;
  const entries: MonitorFeedEntry[] = [];
  const stack: Frame[] = [];
  let kind: MonitorFeedXml['kind'] | undefined;
  let root: string | undefined;
  let tokens = 0;
  let cursor = 0;

  const append = (text: string) => {
    const top = stack.at(-1);
    if (!top && !text.trim()) return;
    if (!top) throw new Error('XML text outside document root.');
    if (top.text.length < MAX_VALUE) top.text = (top.text + text).slice(0, MAX_VALUE);
  };
  const close = () => {
    const frame = stack.pop()!;
    const parent = stack.at(-1);
    if (frame.entry) {
      const fields = frame.fields;
      const rawUrl = kind === 'feed' ? fields.link ?? fields.guid ?? fields.id : fields.loc;
      if (rawUrl && entries.length < MAX_ENTRIES) {
        const date = kind === 'feed' ? fields.published ?? fields.pubDate ?? fields.date ?? fields.updated : fields.lastmod;
        const published = publishedTime(date);
        entries.push({ url: rawUrl, ...(fields.title && { title: fields.title }), ...(published && { published }) });
      }
    } else if (parent?.entry && frame.text.trim() && !Object.hasOwn(parent.fields, frame.local)) {
      parent.fields[frame.local] = frame.text.trim();
    } else if (parent?.local === 'title') {
      append(frame.text);
    }
  };

  try {
    while (cursor < body.length) {
      const match = tokenizer.exec(body);
      if (!match || ++tokens > MAX_TOKENS) return undefined;
      const raw = match[0];
      cursor = tokenizer.lastIndex;
      if (!raw.startsWith('<')) {
        append(xmlEntityText(raw));
        continue;
      }
      if (raw.startsWith('<!--') || raw.startsWith('<?')) continue;
      if (raw.startsWith('<![CDATA[')) {
        if (!stack.length) return undefined;
        append(raw.slice(9, -3));
        continue;
      }
      if (raw.startsWith('<!')) return undefined;
      if (raw.startsWith('</')) {
        if (stack.at(-1)?.name !== raw.slice(2, -1).trim() || !stack.length) return undefined;
        close();
        continue;
      }
      const { name, attributes, empty } = xmlTag(raw.slice(1, -1));
      const local = name.split(':').at(-1)!;
      const parent = stack.at(-1);
      if (!parent) {
        if (root) return undefined;
        root = local;
        if (root === 'rss' || root === 'feed' || root === 'RDF') kind = 'feed';
        else if (root === 'urlset') kind = 'sitemap';
        else if (root === 'sitemapindex') kind = 'index';
        if (!kind) return undefined;
      }
      if (stack.length >= MAX_DEPTH) return undefined;
      const isEntry = root === 'feed' ? local === 'entry' && parent?.local === 'feed'
        : root === 'rss' ? local === 'item' && parent?.local === 'channel' && stack.length === 2
        : root === 'RDF' ? local === 'item' && parent?.local === 'RDF'
        : parent?.local === root && (kind === 'sitemap' ? local === 'url' : local === 'sitemap');
      if (parent?.entry && local === 'link' && (!attributes.has('rel') || attributes.get('rel') === 'alternate') && !parent.fields.link) {
        const href = attributes.get('href')?.trim();
        if (href) parent.fields.link = href.slice(0, MAX_VALUE);
      }
      stack.push({ name, local, fields: Object.create(null), ...(isEntry && { entry: true as const }), text: '' });
      if (empty) close();
    }
  } catch {
    return undefined;
  }
  return kind && !stack.length ? { kind, entries } : undefined;
}
