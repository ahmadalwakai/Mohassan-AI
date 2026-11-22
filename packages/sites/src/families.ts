import type { SiteBlock, SiteBrief, SiteKind, SiteLang, SitePage } from '@mohassan/contracts';
import { COPY } from './copy/index.ts';

/** File name of the items page per kind; landing pages keep everything on index.html. */
export const ITEMS_PAGE: Readonly<Record<SiteKind, string | null>> = {
  services: 'services.html', restaurant: 'menu.html', clinic: 'services.html', portfolio: 'works.html', catalogue: 'products.html', landing: null,
};
/** How many items the home page previews before linking to the full list. */
export const HIGHLIGHT_COUNT: Readonly<Record<SiteKind, number>> = { services: 6, restaurant: 6, clinic: 6, portfolio: 6, catalogue: 8, landing: 60 };

export const PAGE_TITLES: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ar: { about: 'من نحن', contact: 'تواصل', team: 'فريقنا', faq: 'الأسئلة الشائعة', pricing: 'الأسعار', projects: 'المشاريع', posts: 'الأخبار', gallery: 'الصور', features: 'ما يميّزنا', steps: 'كيف نعمل', facts: 'أرقامنا', testimonials: 'آراء العملاء', hours: 'ساعات العمل' },
  en: { about: 'About', contact: 'Contact', team: 'Our team', faq: 'FAQ', pricing: 'Pricing', projects: 'Projects', posts: 'News', gallery: 'Photos', features: 'Why us', steps: 'How it works', facts: 'In numbers', testimonials: 'Reviews', hours: 'Opening hours' },
};

/** Content the user supplied for requested blocks; absent content means the block is not built. */
export interface PageContent {
  about?: string;
  team?: Extract<SiteBlock, { type: 'team' }>['members'];
  faq?: Extract<SiteBlock, { type: 'faq' }>['entries'];
  pricing?: Extract<SiteBlock, { type: 'pricing' }>['plans'];
  projects?: SiteBrief['items'];
  features?: Extract<SiteBlock, { type: 'features' }>['points'];
  steps?: Extract<SiteBlock, { type: 'steps' }>['steps'];
  facts?: Extract<SiteBlock, { type: 'facts' }>['items'];
  posts?: Extract<SiteBlock, { type: 'posts' }>['posts'];
}
export interface PlanOptions { singlePage?: boolean; form?: boolean; map?: boolean; gallery?: boolean }
type Core = Pick<SiteBrief, 'lang' | 'kind' | 'name' | 'items' | 'offer' | 'hours' | 'testimonials' | 'images' | 'mapUrl' | 'address'>;

/**
 * The pages of a site: the defaults a site of this kind needs, plus every block the user asked for.
 * Blocks with user content land on their own page when they are long, on the home page when short.
 */
export function buildPages(core: Core, content: PageContent, options: PlanOptions = {}): SitePage[] {
  const titles = PAGE_TITLES[core.lang];
  const labels = COPY[core.lang].labels;
  const hasGallery = options.gallery !== false && core.images.some(image => image.role === 'gallery');
  /** A landing page, or an explicit one-page request, keeps every block on index.html. */
  const single = Boolean(options.singlePage) || core.kind === 'landing';
  const home: SiteBlock[] = [{ type: 'hero' }];
  const extra: SitePage[] = [];
  const itemsPath = ITEMS_PAGE[core.kind];

  if (core.kind === 'landing') {
    // The offer is the hero lead; the band below it only invites, so the same sentence is not shown twice.
    if (core.items.length) home.push({ type: 'items', layout: 'cards' });
  } else if (core.items.length) {
    const split = Boolean(itemsPath) && core.items.length > HIGHLIGHT_COUNT[core.kind] && !single;
    home.push({ type: 'items', limit: split ? HIGHLIGHT_COUNT[core.kind] : undefined });
    if (split && itemsPath) extra.push({ path: itemsPath, title: labels.nav.items[core.kind], inNav: true, blocks: [{ type: 'items' }, { type: 'cta' }] });
  }
  if (content.features?.length) home.push({ type: 'features', points: content.features });
  if (content.steps?.length) home.push({ type: 'steps', steps: content.steps });
  if (content.facts?.length) home.push({ type: 'facts', items: content.facts });
  if (hasGallery && core.kind === 'portfolio') home.splice(1, 0, { type: 'gallery' });
  else if (hasGallery) home.push({ type: 'gallery' });
  const longAbout = Boolean(content.about && content.about.length > 400) && !single;
  if (content.about) {
    if (!longAbout) home.push({ type: 'text', title: titles.about, body: content.about });
    else extra.push({ path: 'about.html', title: titles.about!, inNav: true, blocks: [{ type: 'text', title: titles.about, body: content.about }, ...(content.team?.length ? [{ type: 'team' as const, members: content.team }] : [])] });
  }
  if (content.team?.length && !longAbout) {
    if (single || content.team.length <= 4) home.push({ type: 'team', members: content.team });
    else extra.push({ path: 'team.html', title: titles.team!, inNav: true, blocks: [{ type: 'team', members: content.team }, { type: 'cta' }] });
  }
  if (content.projects?.length) {
    if (single) home.push({ type: 'items', title: titles.projects, layout: 'tiles', items: content.projects });
    else extra.push({ path: 'projects.html', title: titles.projects!, inNav: true, blocks: [{ type: 'items', title: titles.projects, layout: 'tiles', items: content.projects }, { type: 'cta' }] });
  }
  if (content.pricing?.length) {
    if (single || content.pricing.length <= 3) home.push({ type: 'pricing', plans: content.pricing });
    else extra.push({ path: 'pricing.html', title: titles.pricing!, inNav: true, blocks: [{ type: 'pricing', plans: content.pricing }, { type: 'cta' }] });
  }
  if (core.testimonials.length) home.push({ type: 'testimonials' });
  if (content.faq?.length) {
    if (single || content.faq.length <= 5) home.push({ type: 'faq', entries: content.faq });
    else extra.push({ path: 'faq.html', title: titles.faq!, inNav: true, blocks: [{ type: 'faq', entries: content.faq }, { type: 'cta' }] });
  }
  if (content.posts?.length) {
    if (single) home.push({ type: 'posts', posts: content.posts });
    else extra.push({ path: 'news.html', title: titles.posts!, inNav: true, blocks: [{ type: 'posts', posts: content.posts }] });
  }
  if (core.hours?.length && (core.kind === 'restaurant' || core.kind === 'clinic' || single)) home.push({ type: 'hours' });
  if (core.kind !== 'landing') home.push({ type: 'cta' });

  const contactBlocks: SiteBlock[] = [{ type: 'contact', form: options.form ?? core.kind !== 'restaurant' }];
  if (options.map || core.mapUrl) contactBlocks.push({ type: 'map' });
  if (core.hours?.length && !single) contactBlocks.push({ type: 'hours' });
  if (single) home.push(...contactBlocks);

  const pages: SitePage[] = [{ path: 'index.html', title: core.name, inNav: true, blocks: home.slice(0, 16) }];
  if (!single) {
    pages.push(...extra);
    pages.push({ path: 'contact.html', title: titles.contact!, inNav: true, blocks: contactBlocks });
  }
  return pages.slice(0, 12);
}

/** Where a block added later belongs, mirroring buildPages. Returns the pages unchanged when the block exists. */
export function placeBlock(pages: SitePage[], block: SiteBlock, lang: SiteLang): SitePage[] {
  const sameKind = (existing: SiteBlock) => existing.type === block.type && (block.type !== 'items' || Boolean((existing as { items?: unknown }).items) === Boolean(block.items));
  if (pages.some(page => page.blocks.some(sameKind))) return pages;
  const titles = PAGE_TITLES[lang];
  const index = pages.findIndex(page => page.path === 'index.html');
  const single = pages.length <= 2 || !pages.some(page => page.path === 'contact.html');
  const ownPage = (path: string, title: string) => [...pages.filter(page => page.path !== 'contact.html'), { path, title, inNav: true, blocks: [block, { type: 'cta' as const }] }, ...pages.filter(page => page.path === 'contact.html')];
  const beforeCta = (blocks: SiteBlock[]) => { const position = blocks.findIndex(existing => existing.type === 'cta' || existing.type === 'contact'); return position < 0 ? [...blocks, block] : [...blocks.slice(0, position), block, ...blocks.slice(position)]; };
  const onIndex = () => pages.map((page, position) => (position === index ? { ...page, blocks: beforeCta(page.blocks) } : page));
  switch (block.type) {
    case 'map': case 'hours': case 'contact': {
      const contact = pages.findIndex(page => page.path === 'contact.html');
      return contact >= 0 ? pages.map((page, position) => (position === contact ? { ...page, blocks: [...page.blocks, block] } : page)) : onIndex();
    }
    case 'team': return single || block.members.length <= 4 ? onIndex() : ownPage('team.html', titles.team!);
    case 'faq': return single || block.entries.length <= 5 ? onIndex() : ownPage('faq.html', titles.faq!);
    case 'pricing': return single || block.plans.length <= 3 ? onIndex() : ownPage('pricing.html', titles.pricing!);
    case 'posts': return single ? onIndex() : ownPage('news.html', titles.posts!);
    case 'text': return single || block.body.length <= 400 ? onIndex() : ownPage('about.html', titles.about!);
    case 'items': return single || !block.items ? onIndex() : ownPage('projects.html', block.title ?? titles.projects!);
    default: return onIndex();
  }
}

/** Drops every block of a type; a page left empty disappears unless it is index.html. */
export function removeBlocks(pages: SitePage[], type: SiteBlock['type']): SitePage[] {
  return pages.map(page => ({ ...page, blocks: page.blocks.filter(block => block.type !== type) })).filter(page => page.path === 'index.html' || page.blocks.length > 0);
}
