import { escapeAttribute, escapeText } from './html.ts';
import { pick } from './seed.ts';
import type { Theme } from './theme.ts';

/** The first letter of the name, Arabic or Latin, for the monogram. */
export function initialOf(name: string): string {
  // Skip articles and honorifics ("د. سارة" → س, "Dr Amina" → A) so the mark shows the name itself.
  const trimmed = name.trim().replace(/^(?:(?:د|م|أ|ا|الدكتور|الدكتوره|الدكتورة|دكتور|دكتوره|دكتورة|المهندس|المهندسة|الأستاذ|الأستاذة|dr|mr|mrs|ms|miss|eng|prof)\.?\s+)+/iu, '').replace(/^(?:ال|the\s+|a\s+|an\s+)/iu, '');
  const match = trimmed.match(/\p{L}/u);
  return (match?.[0] ?? name.trim().charAt(0) ?? '•').toLocaleUpperCase();
}

export type MonogramShape = 'circle' | 'square' | 'shield';
export const MONOGRAM_SHAPES: readonly MonogramShape[] = ['circle', 'square', 'shield'];

/** A letter mark: the initial on a coloured shape. Standalone SVG file content. */
export function monogramSvg(name: string, theme: Theme, shape: MonogramShape, size = 64): string {
  const letter = escapeText(initialOf(name));
  const shapes: Record<MonogramShape, string> = {
    circle: `<circle cx="32" cy="32" r="30" fill="${theme.primaryDeep}"/>`,
    square: `<rect x="2" y="2" width="60" height="60" rx="14" fill="${theme.primaryDeep}"/>`,
    shield: `<path d="M32 2 58 12v18c0 15-11 27-26 32C17 57 6 45 6 30V12z" fill="${theme.primaryDeep}"/>`,
  };
  const accent = `<circle cx="48" cy="16" r="5" fill="${theme.accent}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${escapeAttribute(name)}">${shapes[shape]}${accent}<text x="32" y="38" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, 'Segoe UI', 'Noto Sans Arabic', Tahoma, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${letter}</text></svg>`;
}

export type PatternKind = 'stars' | 'waves' | 'dots';
export const PATTERNS: readonly PatternKind[] = ['stars', 'waves', 'dots'];

/** A seamless tile used as a CSS background (assets/pattern.svg), drawn in the theme's colours. */
export function patternSvg(kind: PatternKind, colour: string, opacity = 0.12): string {
  const paint = `fill="none" stroke="${colour}" stroke-opacity="${opacity}" stroke-width="1.5"`;
  if (kind === 'stars') {
    // Eight-point star lattice: two squares rotated 45° inside each cell.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><g ${paint}><rect x="20" y="20" width="56" height="56"/><rect x="20" y="20" width="56" height="56" transform="rotate(45 48 48)"/><circle cx="48" cy="48" r="6"/></g></svg>`;
  }
  if (kind === 'waves') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><g ${paint}><path d="M0 20c15-14 30-14 45 0s30 14 45 0 20-10 30-6"/><path d="M0 34c15-14 30-14 45 0s30 14 45 0 20-10 30-6"/><path d="M0 6c15-14 30-14 45 0s30 14 45 0 20-10 30-6"/></g></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><g fill="${colour}" fill-opacity="${opacity * 1.5}"><circle cx="12" cy="12" r="2.5"/><circle cx="36" cy="36" r="2.5"/><circle cx="36" cy="12" r="1.5"/><circle cx="12" cy="36" r="1.5"/></g></svg>`;
}

/** Decorative hero art when the user gave no hero photo: layered shapes in the theme's colours. */
export function heroArtSvg(theme: Theme, seed: number, initial: string): string {
  const variant = pick(seed, 'heroArt', ['orbit', 'blocks', 'arc'] as const);
  const letter = escapeText(initial);
  const text = `<text x="200" y="215" text-anchor="middle" font-family="system-ui, 'Segoe UI', 'Noto Sans Arabic', Tahoma, Arial, sans-serif" font-size="140" font-weight="800" fill="${theme.primaryInk}" fill-opacity="0.9">${letter}</text>`;
  if (variant === 'orbit') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-hidden="true"><circle cx="200" cy="200" r="170" fill="${theme.primary}"/><circle cx="200" cy="200" r="130" fill="none" stroke="${theme.accent}" stroke-width="6" stroke-dasharray="18 14"/><circle cx="330" cy="120" r="28" fill="${theme.accent}"/><circle cx="90" cy="300" r="18" fill="${theme.primarySoft}"/>${text}</svg>`;
  }
  if (variant === 'blocks') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-hidden="true"><rect x="40" y="40" width="320" height="320" rx="48" fill="${theme.primary}"/><rect x="240" y="60" width="110" height="110" rx="28" fill="${theme.accent}"/><rect x="60" y="250" width="90" height="90" rx="24" fill="${theme.primarySoft}"/>${text}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-hidden="true"><path d="M40 360A160 160 0 0 1 360 360Z" fill="${theme.primary}"/><path d="M90 360A110 110 0 0 1 310 360Z" fill="${theme.primaryDeep}"/><circle cx="320" cy="90" r="40" fill="${theme.accent}"/>${text}</svg>`;
}

/** Favicon: the monogram at 64px (browsers scale SVG). */
export const faviconSvg = (name: string, theme: Theme, shape: MonogramShape) => monogramSvg(name, theme, shape, 64);
