import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { publicSearchText } from '../local-index.js';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const MAX_NODES = 50_000;
const MAX_RESULTS = 100;
const TITLE_LIMIT = 240;
const SNIPPET_LIMIT = 700;
const NON_CONTENT = new Set(['aside', 'footer', 'header', 'nav', 'noscript', 'script', 'style', 'svg', 'template']);
const BLOCKS = new Set(['article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'hr', 'li', 'main', 'ol', 'p', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const attribute = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value ?? '';
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const heading = (node: Element) => /^h[1-6]$/.test(node.tagName) || attribute(node, 'role') === 'heading';
const ignored = (node: Element) => NON_CONTENT.has(node.tagName) || node.attrs.some(item => item.name === 'hidden')
  || attribute(node, 'aria-hidden').toLowerCase() === 'true' || attribute(node, 'role') === 'navigation';

function* elements(root: Node, skip: (node: Element) => boolean = () => false, limit = MAX_NODES): Generator<Element> {
  const pending = [root];
  for (let visited = 0; pending.length && visited < limit; visited++) {
    const node = pending.pop()!;
    if (isElement(node)) {
      if (skip(node)) continue;
      yield node;
    }
    const nested = children(node);
    for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
  }
}

export function cleanSiteText(value: string, limit: number): string {
  return publicSearchText(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, limit).trimEnd();
}

function textOf(root: Node, limit: number): string {
  const pending: (Node | ' ')[] = [root];
  const parts: string[] = [];
  let length = 0;
  const maximum = limit + 1024;
  for (let visited = 0; pending.length && visited < MAX_NODES && length < maximum; visited++) {
    const node = pending.pop()!;
    if (node === ' ' || 'value' in node) {
      const part = node === ' ' ? node : node.value.replace(/\s+/gu, ' ').slice(0, maximum - length);
      parts.push(part);
      length += part.length;
      continue;
    }
    if (isElement(node) && (ignored(node) || node.tagName === 'form')) continue;
    const block = isElement(node) && (BLOCKS.has(node.tagName) || heading(node));
    if (block) {
      parts.push(' ');
      pending.push(' ');
      length++;
    }
    const nested = children(node);
    for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
  }
  return cleanSiteText(parts.join(''), limit);
}

export function plainSiteText(input: string, limit: number): string {
  return textOf(parseFragment(input), limit);
}

const charset = (value: string) => /(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(value)?.[1];

export function decodeSiteText(response: SafeResponse, fallbackEncoding?: string): string | undefined {
  const { body } = response;
  // BOM, transport and the first 1024 bytes for an HTML declaration.
  // https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding (checked 2026-11-27).
  const prefix = body.subarray(0, 1024).toString('latin1');
  let encoding = prefix.startsWith('\xef\xbb\xbf') ? 'utf-8' : charset(response.headers['content-type'] ?? '');
  if (!encoding) {
    encoding = /^<\?xml\s+[^?]*\bencoding\s*=\s*["']([A-Za-z][\w.-]*)["']/i.exec(prefix)?.[1];
    if (!encoding && /<meta\b/i.test(prefix)) {
      for (const node of elements(parse(prefix))) {
        if (node.tagName !== 'meta') continue;
        encoding = attribute(node, 'charset') || (attribute(node, 'http-equiv').toLowerCase() === 'content-type'
          ? charset(attribute(node, 'content')) : undefined);
        if (encoding) break;
      }
    }
  }
  // TextDecoder supplies the registered aliases for UTF-8 and Windows-1256.
  // https://encoding.spec.whatwg.org/#names-and-labels (checked 2026-11-27).
  try { return new TextDecoder(encoding || fallbackEncoding || 'utf-8', { fatal: true }).decode(body); }
  catch { return undefined; }
}

function resolveLink(href: string, base?: string): string | undefined {
  if (!href || href.startsWith('#')) return undefined;
  if (!base) return href;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

function documentBase(root: Node, responseUrl?: string): string | undefined {
  if (!responseUrl) return undefined;
  for (const node of elements(root, node => node.tagName === 'body')) {
    if (node.tagName !== 'base' || !node.attrs.some(item => item.name === 'href')) continue;
    const href = resolveLink(attribute(node, 'href').trim(), responseUrl);
    return href ?? responseUrl;
  }
  return responseUrl;
}

function commonFeedLink(href: string, base?: string): boolean {
  // WordPress publishes both path and query forms. This check only recognizes actual links.
  // https://wordpress.org/documentation/article/wordpress-feeds/ (checked 2026-11-27).
  try {
    const url = new URL(href, base ?? 'https://example.org/');
    return /(?:^|\/)(?:feed|rss|rss2|atom)(?:\.xml)?(?:\/|$)|\.(?:rss|atom)$/i.test(url.pathname)
      || /^(?:rss2?|atom|rdf)$/i.test(url.searchParams.get('feed') ?? '');
  } catch { return false; }
}

export function homepageLinks(html: string, responseUrl?: string): { descriptions: string[]; feeds: string[] } {
  const root = parse(html);
  const base = documentBase(root, responseUrl);
  const descriptions = new Set<string>();
  const feeds = new Set<string>();
  // HTML alternate feeds and OpenSearch discovery are explicitly typed.
  // https://html.spec.whatwg.org/multipage/links.html#link-type-alternate and
  // https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md (checked 2026-11-27).
  for (const node of elements(root)) {
    if (node.tagName !== 'link' && node.tagName !== 'a') continue;
    const href = resolveLink(attribute(node, 'href').trim(), base);
    if (!href) continue;
    const rel = attribute(node, 'rel').toLowerCase().split(/\s+/);
    const mediaType = attribute(node, 'type').split(';', 1)[0].trim().toLowerCase();
    if (node.tagName === 'link' && rel.includes('search') && mediaType === 'application/opensearchdescription+xml') descriptions.add(href);
    if (rel.includes('alternate') && /^application\/(?:rss|atom)\+xml$/.test(mediaType)
      || (node.tagName === 'a' || rel.includes('alternate')) && commonFeedLink(href, base)) feeds.add(href);
    if (descriptions.size + feeds.size >= MAX_RESULTS) break;
  }
  return { descriptions: [...descriptions], feeds: [...feeds] };
}

const resultItem = (node: Element) => ['article', 'li', 'dt'].includes(node.tagName)
  || /(?:^|\s)(?:search(?:[-_][\w-]+)?[-_]?result|result)(?:[-_](?:item|card|entry))?(?:\s|$)/i.test(attribute(node, 'class'));
const resultTitle = (node: Element) => heading(node) || node.tagName === 'dt'
  || /(?:^|\s)(?:result|entry|search)[-_](?:title|heading)(?:\s|$)/i.test(attribute(node, 'class'));
const resultList = (node: Element) => /(?:^|\s)(?:search[-_]?)?results(?:[-_]list)?(?:\s|$)/i.test(`${attribute(node, 'id')} ${attribute(node, 'class')}`);
const snippetField = (node: Element) => /(?:^|\s)(?:[\w-]+[-_])?(?:snippet|summary|excerpt|description)(?:\s|$)/i.test(attribute(node, 'class'))
  || attribute(node, 'itemprop') === 'description';

function resultSnippet(container: Element): string {
  let paragraph = '';
  for (const node of elements(container, node => ignored(node) || node.tagName === 'form', 240)) {
    if (node === container) continue;
    if (snippetField(node)) {
      const snippet = textOf(node, SNIPPET_LIMIT);
      if (snippet) return snippet;
    }
    if (!paragraph && node.tagName === 'p') paragraph = textOf(node, SNIPPET_LIMIT);
  }
  return paragraph;
}

function adjacentSnippet(title: Element): string {
  const siblings = title.parentNode ? children(title.parentNode) : [];
  for (let index = siblings.indexOf(title) + 1; index < siblings.length; index++) {
    const sibling = siblings[index];
    if (!isElement(sibling)) continue;
    if (ignored(sibling) || (sibling.tagName === 'dd' && /(?:^|\s)meta(?:\s|$)/i.test(attribute(sibling, 'class')))) continue;
    if (snippetField(sibling) || ['dd', 'p'].includes(sibling.tagName)) return textOf(sibling, SNIPPET_LIMIT);
    break;
  }
  return '';
}

export function htmlSearchEntries(html: string, responseUrl?: string): SearchHit[] {
  const root = parse(html);
  const base = documentBase(root, responseUrl);
  const rows = new Map<Element, { hit: SearchHit; priority: number; container?: Element }>();
  for (const node of elements(root, node => ignored(node) || ['head', 'form'].includes(node.tagName)
    || /(?:^|\s)(?:pagination|pager)(?:\s|$)/i.test(attribute(node, 'class')))) {
    if (node.tagName !== 'a') continue;
    let titled = resultTitle(node) || children(node).some(child => isElement(child) && resultTitle(child));
    let listed = false;
    let item: Element | undefined;
    let titleRegion: Element = node;
    let parent = node.parentNode;
    for (let depth = 0; depth < 8 && parent && isElement(parent); depth++, parent = parent.parentNode) {
      if (resultList(parent)) listed = true;
      if (['body', 'main'].includes(parent.tagName)) break;
      if (resultTitle(parent)) { titled = true; titleRegion = parent; }
      if (resultItem(parent)) { item = parent; break; }
    }
    if (!titled && !listed && !item) continue;
    const url = resolveLink(attribute(node, 'href').trim(), base);
    const title = textOf(node, TITLE_LIMIT);
    if (!title || !url) continue;
    const priority = titled ? 2 : 1;
    const key = item ?? node;
    if ((rows.get(key)?.priority ?? 0) >= priority) continue;
    if (rows.size >= MAX_RESULTS && !rows.has(key)) continue;
    const container = item?.tagName === 'dt' ? undefined : item;
    rows.set(key, { hit: { title, url, snippet: container ? '' : adjacentSnippet(titleRegion) }, priority, container });
  }
  return [...rows.values()].map(({ hit, container }) => container ? { ...hit, snippet: resultSnippet(container) } : hit);
}

function headFields(root: Node): { title: string; meta: Element[] } {
  let title = '';
  const meta: Element[] = [];
  for (const node of elements(root, node => node.tagName === 'body')) {
    if (node.tagName === 'title' && !title) title = textOf(node, TITLE_LIMIT);
    if (node.tagName === 'meta') meta.push(node);
  }
  return { title, meta };
}

export function htmlSource(html: string): { title: string; text: string; description: string; indexable: boolean; snippetAllowed: boolean } {
  const root = parse(html);
  const { title, meta } = headFields(root);
  const metadata = (name: string) => {
    const node = meta.find(node => [attribute(node, 'name'), attribute(node, 'property')].some(field => field.toLowerCase() === name));
    return node ? attribute(node, 'content') : '';
  };
  let indexable = true;
  let snippetAllowed = true;
  // https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag (checked 2026-11-27).
  for (const node of meta) {
    if (!['robots', 'mohassanai', 'mohassanai-research'].includes(attribute(node, 'name').toLowerCase())) continue;
    const directives = attribute(node, 'content');
    if (/(?:^|[\s,])(?:noindex|none)(?:[\s,]|$)/i.test(directives)) indexable = false;
    if (/(?:^|[\s,])(?:nosnippet|max-snippet:\s*0)(?:[\s,]|$)/i.test(directives)) snippetAllowed = false;
  }
  let body: Element | undefined;
  let main: Element | undefined;
  let articleTitle = '';
  for (const node of elements(root, ignored)) {
    if (node.tagName === 'body') body = node;
    if (!main && (node.tagName === 'main' || attribute(node, 'role') === 'main')) main = node;
    if (!articleTitle && node.tagName === 'h1') articleTitle = textOf(node, TITLE_LIMIT);
  }
  return {
    title: title || articleTitle || cleanSiteText(metadata('og:title'), TITLE_LIMIT),
    text: textOf(main ?? body ?? root, 60_000),
    description: cleanSiteText(metadata('description') || metadata('og:description'), SNIPPET_LIMIT),
    indexable,
    snippetAllowed,
  };
}

export function requiresAccount(html: string): boolean {
  if (!/<form[\s/>]/i.test(html)) return false;
  const root = parse(html);
  const { title } = headFields(root);
  const accountHeading = /(?:^|[|:–—-]\s*)(?:(?:please\s+)?(?:sign[\s-]?in|log[\s-]?in|login|authenticate)\b|(?:يرجى\s+)?(?:تسجيل\s+الدخول|الدخول\s+إلى\s+حسابك))/i;
  let login = accountHeading.test(title);
  let passwordForm = false;
  for (const node of elements(root, ignored)) {
    if (!login && node.tagName === 'h1') login = accountHeading.test(textOf(node, TITLE_LIMIT));
    if (!passwordForm && node.tagName === 'form') {
      for (const field of elements(node, ignored, 240)) {
        if (field.tagName === 'input' && attribute(field, 'type').toLowerCase() === 'password') { passwordForm = true; break; }
      }
    }
    if (login && passwordForm) return true;
  }
  return false;
}
