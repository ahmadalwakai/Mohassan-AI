import type { SiteBrief, SiteImageRef, SiteKind, SiteLang, SitePage } from '@mohassan/contracts';
import type { Writer } from './copy/index.ts';
import type { Theme } from './theme.ts';

/** One generated file. Text files are strings; images and fonts are bytes. */
export interface SiteFile { path: string; content: string | Uint8Array; contentType: string }

/** A user image as the server stores it, normalised to PNG/JPEG/WebP. */
export interface SiteImageAsset extends SiteImageRef { bytes: Uint8Array; width: number; height: number; small?: Uint8Array }

export interface ComposeOptions {
  images?: SiteImageAsset[];
  /** Absolute origin of the published site, e.g. https://acme.vercel.app; enables sitemap and canonical links. */
  baseUrl?: string;
  /** Where the contact form posts when the host offers an inbox; otherwise the form opens WhatsApp or mail. */
  formEndpoint?: string;
  /** Stamped into a generator comment so an exported ZIP says which version built it. */
  generatorVersion?: string;
}

export interface ComposedSite {
  files: SiteFile[];
  pages: { path: string; title: string }[];
  warnings: string[];
  theme: Theme;
}

export interface RenderContext {
  brief: SiteBrief;
  kind: SiteKind;
  lang: SiteLang;
  dir: 'rtl' | 'ltr';
  theme: Theme;
  writer: Writer;
  seed: number;
  images: SiteImageAsset[];
  pages: SitePage[];
  page: SitePage;
  options: ComposeOptions;
  /** Variant choices made once per site so every page agrees. */
  variants: { hero: 'split' | 'centered' | 'cover'; items: 'cards' | 'menu' | 'tiles' | 'list' };
}
