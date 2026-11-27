import type { SearchHit } from '../../research.js';
import type { SearchQuery } from '../providers.js';
import { InvalidSearchXml, readSearchXml, type SearchXmlNode } from '../xml.js';
import { cleanSiteText, plainSiteText } from './site-search-html.js';

// OpenSearch 1.1, retrieved 2026-11-27.
// https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md
const OPEN_SEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
// Atom and RSS, retrieved 2026-11-27.
// https://www.rfc-editor.org/rfc/rfc4287
// https://www.rssboard.org/rss-specification
// https://web.resource.org/rss/1.0/spec
const ATOM = 'http://www.w3.org/2005/Atom';
const XHTML = 'http://www.w3.org/1999/xhtml';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RSS = 'http://purl.org/rss/1.0/';
// Sitemaps protocol, retrieved 2026-11-27.
// https://www.sitemaps.org/protocol.html
const SITEMAP = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const OPEN_SEARCH_MEDIA = ['application/rss+xml', 'application/atom+xml', 'text/html', 'application/xhtml+xml'] as const;
type Encoding = 'UTF-8' | 'windows-1256';

export interface OpenSearchTemplate {
  media: typeof OPEN_SEARCH_MEDIA[number];
  url: string;
  indexOffset: string;
  pageOffset: string;
  inputEncoding: Encoding;
  outputEncoding: Encoding;
  languages: string[];
  namespaces: ReadonlyMap<string, string>;
}

function readSiteXml(text: string, maxNodes: number, retainContent = false): SearchXmlNode | undefined {
  try { return readSearchXml(text, { maxNodes, retainContent, siteDocument: true }); }
  catch (error) {
    if (error instanceof InvalidSearchXml) return undefined;
    throw error;
  }
}

const children = (node: SearchXmlNode, name: string, namespace = node.namespace) =>
  node.children.filter(child => child.name === name && child.namespace === namespace);
const child = (node: SearchXmlNode, name: string, namespace = node.namespace) =>
  node.children.find(candidate => candidate.name === name && candidate.namespace === namespace);
const leaf = (node: SearchXmlNode | undefined) => node && !node.children.length ? node.text.trim() : '';
const mime = (input = '') => input.split(';', 1)[0].trim().toLowerCase();

function encoding(root: SearchXmlNode, field: string): Encoding | undefined {
  const values = children(root, field);
  if (!values.length) return 'UTF-8';
  const supported = values.flatMap(node => {
    try { return [new TextDecoder(leaf(node)).encoding]; } catch { return []; }
  });
  return supported.includes('utf-8') ? 'UTF-8' : supported.includes('windows-1256') ? 'windows-1256' : undefined;
}

export function openSearchTemplates(text: string): OpenSearchTemplate[] {
  const root = readSiteXml(text, 5000);
  if (!root || root.name !== 'OpenSearchDescription' || root.namespace !== OPEN_SEARCH) return [];
  const rights = children(root, 'SyndicationRight');
  if (rights.length > 1 || rights.some(node => !['open', 'limited'].includes(leaf(node).toLowerCase()))) return [];
  const inputEncoding = encoding(root, 'InputEncoding'), outputEncoding = encoding(root, 'OutputEncoding');
  if (!inputEncoding || !outputEncoding) return [];
  const languages = children(root, 'Language').map(leaf).filter(value => /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(value));
  const templates = children(root, 'Url').flatMap(node => {
    const media = OPEN_SEARCH_MEDIA.find(type => type === mime(node.attributes.get('type')));
    const url = node.attributes.get('template')?.trim();
    const rel = (node.attributes.get('rel') ?? 'results').trim().toLowerCase().split(/\s+/);
    const method = node.attributes.get('method')?.toUpperCase() ?? 'GET';
    const indexOffset = node.attributes.get('indexOffset') ?? '1', pageOffset = node.attributes.get('pageOffset') ?? '1';
    if (!media || !url || url.length > 2500 || !rel.includes('results') || method !== 'GET' ||
        ![indexOffset, pageOffset].every(value => /^[+-]?\d{1,12}$/.test(value))) return [];
    return [{ media, url, indexOffset, pageOffset, inputEncoding, outputEncoding, languages, namespaces: node.bindings }];
  });
  return templates.sort((a, b) => Number(a.media.includes('html')) - Number(b.media.includes('html')));
}

// Invert the runtime's WHATWG single-byte decoder to encode the query using
// the declared OpenSearch InputEncoding.
// https://encoding.spec.whatwg.org/#windows-1256 (retrieved 2026-11-27).
let windows1256Bytes: Map<string, number> | undefined;
function encodeSearchTerms(value: string, charset: Encoding): string | undefined {
  if (charset === 'UTF-8') {
    try { return encodeURIComponent(value); } catch { return undefined; }
  }
  if (!windows1256Bytes) {
    const decoder = new TextDecoder('windows-1256');
    windows1256Bytes = new Map(Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]));
  }
  const encoded = [];
  for (const char of value) {
    const byte = windows1256Bytes.get(char);
    if (byte === undefined) return undefined;
    encoded.push(byte < 128 ? encodeURIComponent(char) : '%' + byte.toString(16).toUpperCase().padStart(2, '0'));
  }
  return encoded.join('');
}

export function expandOpenSearch(template: OpenSearchTemplate, query: SearchQuery, limit: number): string | undefined {
  const searchTerms = encodeSearchTerms(query.retrievalQuestion, template.inputEncoding);
  if (!searchTerms) return undefined;
  const language = template.languages.find(code => code.toLowerCase().split('-')[0] === query.language) ??
    (!template.languages.length || template.languages.includes('*') ? query.language : '*');
  const values = new Map([
    ['searchTerms', searchTerms], ['count', String(limit)], ['language', language],
    ['startIndex', template.indexOffset], ['startPage', template.pageOffset],
    ['inputEncoding', template.inputEncoding], ['outputEncoding', template.outputEncoding],
  ]);
  let includesTerms = false, unsupported = false;
  const expanded = template.url.replace(/\{(?:([\w.-]+):)?([\w.-]+)(\?)?\}/g, (_, prefix: string | undefined, name: string, optional: string | undefined) => {
    const namespace = prefix ? template.namespaces.get(prefix) : OPEN_SEARCH;
    const value = namespace === OPEN_SEARCH ? values.get(name) : undefined;
    if (namespace === undefined || value === undefined && !optional) unsupported = true;
    if (value !== undefined && name === 'searchTerms') includesTerms = true;
    return value ?? '';
  });
  return includesTerms && !unsupported && !/[{}]/.test(expanded) ? expanded : undefined;
}

function xhtmlText(node: SearchXmlNode): string {
  if (node.namespace !== XHTML || ['script', 'style', 'template'].includes(node.name) || node.attributes.has('hidden')) return '';
  const text = (node.content ?? []).map(part => typeof part === 'string' ? part : xhtmlText(part)).join('');
  return ['br', 'div', 'li', 'p'].includes(node.name) ? ` ${text} ` : text;
}

function atomText(node: SearchXmlNode | undefined, limit: number): string {
  if (!node) return '';
  const kind = node.attributes.get('type') ?? 'text';
  if (kind === 'text') return cleanSiteText(leaf(node), limit);
  if (kind === 'html' || mime(kind) === 'text/html') return plainSiteText(leaf(node), limit);
  if (kind === 'xhtml') {
    const root = child(node, 'div', XHTML);
    return root ? cleanSiteText(xhtmlText(root), limit) : '';
  }
  return '';
}

function resolveUrl(input: string | undefined, base: string): string | undefined {
  if (!input?.trim() || input.length > 2500) return undefined;
  try { return new URL(input, base).href; } catch { return undefined; }
}

function xmlBase(base: string, node: SearchXmlNode): string {
  return resolveUrl(node.attributes.get('xml:base'), base) ?? base;
}

function atomEntries(feed: SearchXmlNode, base: string): SearchHit[] {
  const feedBase = xmlBase(base, feed);
  return children(feed, 'entry').flatMap(entry => {
    const entryBase = xmlBase(feedBase, entry);
    const title = atomText(child(entry, 'title'), 240);
    if (!title) return [];
    const snippet = atomText(child(entry, 'summary') ?? child(entry, 'content'), 1400);
    return children(entry, 'link').flatMap(link => {
      const rel = link.attributes.get('rel') ?? 'alternate', type = mime(link.attributes.get('type'));
      if (rel !== 'alternate' || type && !['text/html', 'application/xhtml+xml'].includes(type)) return [];
      const url = resolveUrl(link.attributes.get('href'), xmlBase(entryBase, link));
      return url ? [{ title, url, snippet }] : [];
    });
  });
}

function rssEntries(container: SearchXmlNode, base: string, namespace: string): SearchHit[] {
  return children(container, 'item', namespace).flatMap(item => {
    const itemBase = xmlBase(base, item);
    const title = plainSiteText(leaf(child(item, 'title')), 240);
    const snippet = plainSiteText(leaf(child(item, 'description')), 1400);
    const link = child(item, 'link'), guid = child(item, 'guid');
    const permalink = guid?.attributes.get('isPermaLink')?.toLowerCase() ?? 'true';
    const url = (link && resolveUrl(leaf(link), xmlBase(itemBase, link))) ||
      (guid && permalink === 'true' ? resolveUrl(leaf(guid), xmlBase(itemBase, guid)) : undefined);
    return title && url ? [{ title, url, snippet }] : [];
  });
}

export function feedEntries(text: string, base: string): SearchHit[] | undefined {
  const root = readSiteXml(text, 20_000, true);
  if (!root) return undefined;
  if (root.name === 'feed' && root.namespace === ATOM) return atomEntries(root, base);
  if (root.name === 'RDF' && root.namespace === RDF && child(root, 'channel', RSS)) {
    return rssEntries(root, xmlBase(base, root), RSS);
  }
  const channel = root.name === 'rss' && !root.namespace ? child(root, 'channel') : undefined;
  return channel ? rssEntries(channel, xmlBase(xmlBase(base, root), channel), '') : undefined;
}

// W3C profile used by the Sitemaps protocol, retrieved 2026-11-27.
// https://www.w3.org/TR/NOTE-datetime
function lastModified(text: string): number {
  if (!/^\d{4}(?:-\d{2}(?:-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/.test(text)) return 0;
  const datePart = text.split('T', 1)[0];
  const day = Date.parse(datePart);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, datePart.length) !== datePart) return 0;
  const observed = Date.parse(text);
  return Number.isFinite(observed) ? observed : 0;
}

export function sitemapEntries(text: string): { index: boolean; entries: { url: string; updated: number }[] } | undefined {
  const root = readSiteXml(text, 200_001);
  if (!root || root.namespace !== SITEMAP || !['urlset', 'sitemapindex'].includes(root.name)) return undefined;
  const index = root.name === 'sitemapindex';
  const rows = children(root, index ? 'sitemap' : 'url');
  if (rows.length > 50_000) return undefined;
  const entries = rows.flatMap(row => {
    const url = leaf(child(row, 'loc'));
    if (!/^https?:\/\//i.test(url) || url.length >= 2048) return [];
    return [{ url, updated: lastModified(leaf(child(row, 'lastmod'))) }];
  });
  return { index, entries };
}
