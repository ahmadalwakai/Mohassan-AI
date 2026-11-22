import type { SiteBrief, SitePage } from '@mohassan/contracts';
import type { Writer } from './copy/index.ts';
import { escapeAttribute, escapeText, oneLine } from './html.ts';
import type { Theme } from './theme.ts';
import type { ComposeOptions } from './types.ts';

/** Meta description from the user's own words: tagline, else name plus the first items and the city. */
export function describe(brief: SiteBrief, writer: Writer): string {
  if (brief.tagline) return oneLine(brief.tagline).slice(0, 160);
  if (brief.offer) return oneLine(`${brief.name}: ${brief.offer}`).slice(0, 160);
  const items = brief.items.slice(0, 3).map(item => item.title).join(brief.lang === 'ar' ? '، ' : ', ');
  const text = items ? `${brief.name}: ${items}${brief.city ? (brief.lang === 'ar' ? ` في ${brief.city}` : ` in ${brief.city}`) : ''}` : `${brief.name}${brief.city ? (brief.lang === 'ar' ? ` في ${brief.city}` : ` in ${brief.city}`) : ''}. ${writer.text('contactLead')}`;
  return oneLine(text).slice(0, 160);
}

/** The page CSP as a meta tag: works in the preview and in the published copy alike. */
export function cspMeta(options: ComposeOptions): string {
  const formOrigin = options.formEndpoint ? (() => { try { return new URL(options.formEndpoint!).origin; } catch { return ''; } })() : '';
  const policy = [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    // 'self' rather than 'none': the site makes no requests, but audit tools fetch robots.txt from the page.
    "connect-src 'self'",
    `form-action 'self' mailto: https://wa.me${formOrigin ? ` ${formOrigin}` : ''}`,
    "base-uri 'none'",
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

export interface HeadInput { title: string; description: string; path: string }
export function headTags(brief: SiteBrief, theme: Theme, options: ComposeOptions, input: HeadInput): string {
  const base = options.baseUrl?.replace(/\/+$/, '');
  const url = base ? `${base}/${input.path === 'index.html' ? '' : input.path}` : null;
  const fullTitle = input.path === 'index.html' ? brief.name : `${input.title} | ${brief.name}`;
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    cspMeta(options),
    `<title>${escapeText(oneLine(fullTitle))}</title>`,
    `<meta name="description" content="${escapeAttribute(input.description)}">`,
    `<meta name="theme-color" content="${theme.primaryDeep}">`,
    `<meta name="generator" content="Mohassan Sites${options.generatorVersion ? ` ${options.generatorVersion}` : ''}">`,
    url ? `<link rel="canonical" href="${escapeAttribute(url)}">` : '',
    '<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">',
    '<link rel="manifest" href="site.webmanifest">',
    '<link rel="stylesheet" href="styles.css">',
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeAttribute(oneLine(fullTitle))}">`,
    `<meta property="og:description" content="${escapeAttribute(input.description)}">`,
    `<meta property="og:locale" content="${brief.lang === 'ar' ? 'ar_AR' : 'en_GB'}">`,
    url ? `<meta property="og:url" content="${escapeAttribute(url)}">` : '',
    base ? `<meta property="og:image" content="${escapeAttribute(`${base}/assets/og.png`)}">` : '',
    '<meta name="twitter:card" content="summary">',
  ].filter(Boolean).join('\n');
}

const SCHEMA_TYPE: Readonly<Record<SiteBrief['kind'], string>> = { services: 'LocalBusiness', restaurant: 'Restaurant', clinic: 'MedicalClinic', portfolio: 'ProfessionalService', catalogue: 'Store', landing: 'Organization' };
/** Structured data from stated facts only: name, contact, city, address, social links. */
export function jsonLd(brief: SiteBrief, options: ComposeOptions, description: string): string {
  const base = options.baseUrl?.replace(/\/+$/, '');
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': SCHEMA_TYPE[brief.kind],
    name: brief.name,
    description,
    ...(base ? { url: `${base}/`, image: `${base}/assets/og.png`, logo: `${base}/assets/logo.svg` } : {}),
    ...(brief.phone ? { telephone: brief.phone } : {}),
    ...(brief.email ? { email: brief.email } : {}),
    ...(brief.address || brief.city ? { address: { '@type': 'PostalAddress', ...(brief.address ? { streetAddress: brief.address } : {}), ...(brief.city ? { addressLocality: brief.city } : {}) } } : {}),
    ...(brief.mapUrl ? { hasMap: brief.mapUrl } : {}),
    ...(brief.social ? { sameAs: Object.values(brief.social).filter(Boolean) } : {}),
  };
  if (brief.kind === 'restaurant' && brief.items.length) data.hasMenu = base ? `${base}/menu.html` : 'menu.html';
  // JSON inside a script: escape "<" so a user string can never close the element.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function sitemapXml(pages: SitePage[], baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const urls = pages.filter(page => page.path !== '404.html').map(page => `  <url><loc>${escapeText(`${base}/${page.path === 'index.html' ? '' : page.path}`)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
export const robotsTxt = (baseUrl?: string) => `User-agent: *\nAllow: /\n${baseUrl ? `Sitemap: ${baseUrl.replace(/\/+$/, '')}/sitemap.xml\n` : ''}`;
export function manifestJson(brief: SiteBrief, theme: Theme): string {
  return JSON.stringify({
    name: brief.name,
    short_name: brief.name.slice(0, 12),
    start_url: './index.html',
    display: 'browser',
    dir: brief.lang === 'ar' ? 'rtl' : 'ltr',
    lang: brief.lang,
    background_color: theme.surface,
    theme_color: theme.primaryDeep,
    icons: [{ src: 'assets/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }, null, 2);
}
