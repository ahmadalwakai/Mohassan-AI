import type { DefaultTreeAdapterTypes as Html } from 'parse5';
import { attrs } from './page.js';
import { htmlNodes } from './page-structured-v2.js';
import type { MonitorFeedEntry, MonitorFeedXml } from './feed-xml-v2.js';

export interface MonitorDiscoveries { feed?: string; sitemap?: string }
export interface MonitorFeedCache {
  requestedUrl: string;
  url: string;
  etag?: string;
  lastModified?: string;
  data: MonitorFeedXml;
}
export interface MonitorDiscoveryCache {
  links: MonitorDiscoveries;
  documents: MonitorFeedCache[];
}

function localUrl(value: string, base: string): string | undefined {
  if (!value || value.length > 2048 || !URL.canParse(value, base)) return undefined;
  const url = new URL(value, base);
  return url.origin === new URL(base).origin ? url.href : undefined;
}

export function findMonitorDiscoveries(document: Html.Document | undefined, base: string, robotsSitemap?: string): MonitorDiscoveries {
  const links = document ? htmlNodes(document).filter(({ node }) => ['link', 'a'].includes(node.tagName)) : [];
  let feed: string | undefined;
  let sitemap: string | undefined;
  for (const { node } of links) {
    const rel = attrs(node, 'rel').toLowerCase().split(/\s+/u);
    const type = attrs(node, 'type').toLowerCase().split(';', 1)[0].trim();
    const href = attrs(node, 'href');
    if (rel.includes('alternate') && ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml'].includes(type) &&
        href && href.length <= 2048 && URL.canParse(href, base)) feed ??= new URL(href, base).href;
    if (rel.includes('sitemap')) sitemap ??= localUrl(href, base);
  }
  const sitemapUrl = sitemap ?? (robotsSitemap && localUrl(robotsSitemap, base)) ?? new URL('/sitemap.xml', base).href;
  return { ...(feed && { feed }), sitemap: sitemapUrl || new URL('/sitemap.xml', base).href };
}

export function sitemapEntriesForPage(entries: MonitorFeedEntry[], target: string): MonitorFeedEntry[] {
  const page = new URL(target);
  const prefix = page.pathname.replace(/\/$/u, '') + '/';
  // A topic's sitemap descendants may be new items. Siblings are unrelated to that topic.
  return entries.filter(entry => {
    const url = localUrl(entry.url, target);
    return url && new URL(url).pathname.startsWith(prefix) && new URL(url).pathname !== page.pathname;
  });
}
