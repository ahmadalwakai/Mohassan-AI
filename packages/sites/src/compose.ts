import type { SiteBrief, SitePage } from '@mohassan/contracts';
import { SiteBriefSchema } from '@mohassan/contracts';
import { MONOGRAM_SHAPES, PATTERNS, faviconSvg, monogramSvg, patternSvg } from './art.ts';
import { footer, header, notFound, pageTitleBlock, primaryAction, renderBlock } from './blocks.ts';
import { createWriter } from './copy/index.ts';
import { stylesheet } from './css.ts';
import { el, escapeAttribute, escapeText } from './html.ts';
import { describe, headTags, jsonLd, manifestJson, robotsTxt, sitemapXml } from './meta.ts';
import { contentTypeFor } from './mime.ts';
import { siteScript } from './script.ts';
import { pick, seedOf } from './seed.ts';
import { deriveTheme } from './theme.ts';
import type { ComposeOptions, ComposedSite, RenderContext, SiteFile } from './types.ts';

export const GENERATOR_VERSION = '0.1.0';

function document(ctx: RenderContext, main: string, input: { title: string; description: string; path: string }): string {
  const { brief, theme, options } = ctx;
  return `<!DOCTYPE html>
<html lang="${brief.lang}" dir="${ctx.dir}">
<head>
${headTags(brief, theme, options, input)}
</head>
<body>
<a class="skip-link" href="#main">${escapeText(ctx.writer.labels.skip)}</a>
${header(ctx)}
<main id="main">
${main}
</main>
${footer(ctx)}
${jsonLd(brief, options, input.description)}
<script src="site.js" defer></script>
</body>
</html>
`;
}

/**
 * Composes a complete static site from a validated brief: one HTML file per page plus the stylesheet,
 * the script, generated SVG assets, the user's images, a 404 page, a manifest and robots/sitemap.
 * Deterministic: the same brief, images and options always produce the same bytes.
 */
export function composeSite(input: SiteBrief, options: ComposeOptions = {}): ComposedSite {
  const brief = SiteBriefSchema.parse(input);
  const seed = seedOf(brief.name, brief.kind);
  const theme = deriveTheme(brief.primary, brief.mood);
  const writer = createWriter(brief, seed);
  const images = options.images ?? [];
  const warnings: string[] = [];
  const missingImages = brief.images.filter(ref => !images.some(image => image.id === ref.id));
  if (missingImages.length) warnings.push(`${missingImages.length} image reference(s) have no stored image and were skipped.`);
  const heroVariant = brief.mood === 'bold' ? 'cover' : brief.images.some(image => image.role === 'hero') ? 'split' : pick(seed, 'hero', ['split', 'centered'] as const);
  const itemsVariant = brief.kind === 'restaurant' ? 'menu' : brief.kind === 'portfolio' ? 'tiles' : brief.kind === 'clinic' && brief.items.length > 8 ? 'list' : 'cards';
  const base: Omit<RenderContext, 'page'> = { brief, kind: brief.kind, lang: brief.lang, dir: brief.lang === 'ar' ? 'rtl' : 'ltr', theme, writer, seed, images: images.filter(image => brief.images.some(ref => ref.id === image.id)), pages: brief.pages, options, variants: { hero: heroVariant, items: itemsVariant } };
  const description = describe(brief, writer);
  const files: SiteFile[] = [];
  const add = (path: string, content: string | Uint8Array) => files.push({ path, content, contentType: contentTypeFor(path) });

  for (const page of brief.pages) {
    const ctx: RenderContext = { ...base, page };
    const blocks = page.blocks.map((block, index) => renderBlock(ctx, block, index)).filter(Boolean);
    if (!blocks.length) { warnings.push(`Page ${page.path} rendered no block and was skipped.`); continue; }
    const needsTitle = page.path !== 'index.html' && page.blocks[0]?.type !== 'hero';
    add(page.path, document(ctx, [needsTitle ? pageTitleBlock(ctx) : '', ...blocks].filter(Boolean).join('\n'), { title: page.title, description, path: page.path }));
  }
  const notFoundPage: SitePage = { path: '404.html', title: writer.text('notFoundTitle'), inNav: false, blocks: [{ type: 'cta' }] };
  add('404.html', document({ ...base, page: notFoundPage }, notFound({ ...base, page: notFoundPage }), { title: notFoundPage.title, description, path: '404.html' }));

  add('styles.css', stylesheet(theme, brief.lang));
  add('site.js', siteScript());
  const shape = pick(seed, 'monogram', MONOGRAM_SHAPES);
  add('assets/logo.svg', monogramSvg(brief.name, theme, shape, 80));
  add('assets/favicon.svg', faviconSvg(brief.name, theme, shape));
  add('assets/pattern.svg', patternSvg(pick(seed, 'pattern', PATTERNS), brief.mood === 'bold' ? '#ffffff' : theme.primaryDeep, brief.mood === 'bold' ? 0.18 : 0.14));
  for (const image of base.images) {
    add(`assets/${image.id}.${image.ext}`, image.bytes);
    if (image.small) add(`assets/${image.id}-small.${image.ext}`, image.small);
  }
  add('site.webmanifest', manifestJson(brief, theme));
  add('robots.txt', robotsTxt(options.baseUrl));
  if (options.baseUrl) add('sitemap.xml', sitemapXml(brief.pages, options.baseUrl));

  const action = primaryAction({ ...base, page: brief.pages[0]! });
  if (!action) warnings.push('No primary action: the goal has no matching contact channel.');
  if (!brief.items.length && brief.kind !== 'landing') warnings.push('No items: the home page has no services, dishes or products to show.');

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, pages: brief.pages.map(page => ({ path: page.path, title: page.title })), warnings, theme };
}

/** Small helper for hosts: the text files only, for hashing and previews. */
export const textFiles = (files: SiteFile[]) => files.filter((file): file is SiteFile & { content: string } => typeof file.content === 'string');
export const fileBytes = (file: SiteFile) => (typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : file.content.byteLength);
export { el, escapeAttribute };
