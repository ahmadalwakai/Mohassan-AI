import type { SiteMood } from '@mohassan/contracts';

export interface Rgb { r: number; g: number; b: number }
export interface Hsl { h: number; s: number; l: number }

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(part => part + part).join('') : clean;
  const value = Number.parseInt(full, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}
export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (part: number) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === red) h = ((green - blue) / delta) % 6;
  else if (max === green) h = (blue - red) / delta + 2;
  else h = (red - green) / delta + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sat = Math.min(100, Math.max(0, s)) / 100, light = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat, hue = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hue % 2) - 1)), m = light - c / 2;
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
export const hsl = (h: number, s: number, l: number) => rgbToHex(hslToRgb({ h, s, l }));

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (part: number) => { const value = part / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(a) + 0.05, second = luminance(b) + 0.05;
  return first > second ? first / second : second / first;
}

/** Moves the foreground lightness step by step until it reaches the contrast, or the bound. */
export function ensureContrast(foreground: string, background: string, minimum: number, direction: 'darker' | 'lighter' | 'auto' = 'auto'): string {
  if (contrastRatio(foreground, background) >= minimum) return foreground;
  const start = rgbToHsl(hexToRgb(foreground));
  const way = direction === 'auto' ? (luminance(background) > 0.4 ? 'darker' : 'lighter') : direction;
  let candidate = { ...start };
  for (let step = 0; step < 50; step++) {
    candidate = { ...candidate, l: way === 'darker' ? candidate.l - 2 : candidate.l + 2 };
    if (candidate.l < 0 || candidate.l > 100) break;
    const hex = hsl(candidate.h, candidate.s, candidate.l);
    if (contrastRatio(hex, background) >= minimum) return hex;
  }
  return way === 'darker' ? '#111111' : '#ffffff';
}

/** White or near-black, whichever reads better on the background. */
export const textOn = (background: string, ink = '#17181c') => (contrastRatio('#ffffff', background) >= contrastRatio(ink, background) ? '#ffffff' : ink);

export interface Theme {
  primary: string;
  /** Text placed on the primary colour. */
  primaryInk: string;
  /** A deeper primary for buttons and the bold hero, always readable with white text. */
  primaryDeep: string;
  /** A pale tint of the primary for badges and soft bands. */
  primarySoft: string;
  /** Text on the soft tint. */
  primarySoftInk: string;
  accent: string;
  accentInk: string;
  ink: string;
  muted: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  heroBg: string;
  heroInk: string;
  heroMuted: string;
  radius: string;
  radiusSmall: string;
  scale: number;
  headingWeight: number;
  mood: SiteMood;
}

const MOOD = {
  warm: { accentShift: 35, radius: '18px', radiusSmall: '12px', scale: 1.25, headingWeight: 700, surfaceSat: 30, surfaceLight: 98 },
  calm: { accentShift: -30, radius: '12px', radiusSmall: '8px', scale: 1.25, headingWeight: 650, surfaceSat: 0, surfaceLight: 100 },
  bold: { accentShift: 180, radius: '6px', radiusSmall: '4px', scale: 1.333, headingWeight: 800, surfaceSat: 0, surfaceLight: 100 },
} as const;

/** Every text/background pair a page uses is checked here, so a theme never ships below 4.5:1 for body text. */
export function deriveTheme(primaryHex: string, mood: SiteMood): Theme {
  const settings = MOOD[mood];
  const base = rgbToHsl(hexToRgb(primaryHex));
  const primary = hsl(base.h, base.s, base.l);
  const surface = settings.surfaceSat ? hsl(base.h, settings.surfaceSat, settings.surfaceLight) : '#ffffff';
  const surfaceAlt = hsl(base.h, Math.min(40, Math.max(12, base.s * 0.4)), mood === 'warm' ? 94 : 96);
  const line = hsl(base.h, Math.min(25, base.s * 0.3), 87);
  const ink = ensureContrast(hsl(base.h, Math.min(25, base.s * 0.4), 13), surfaceAlt, 7, 'darker');
  const muted = ensureContrast(hsl(base.h, Math.min(15, base.s * 0.25), 42), surfaceAlt, 4.6, 'darker');
  let primaryDeep = hsl(base.h, Math.min(90, Math.max(35, base.s)), Math.min(base.l, 36));
  primaryDeep = ensureContrast(primaryDeep, '#ffffff', 4.6, 'darker');
  primaryDeep = ensureContrast(primaryDeep, surface, 4.6, 'darker');
  const primaryInk = textOn(primary, ink);
  const primarySoft = hsl(base.h, Math.min(70, Math.max(20, base.s * 0.6)), 93);
  const primarySoftInk = ensureContrast(primaryDeep, primarySoft, 4.6, 'darker');
  const accentHue = (base.h + settings.accentShift + 360) % 360;
  const accent = hsl(accentHue, Math.min(80, Math.max(45, base.s)), mood === 'bold' ? 52 : 58);
  const accentInk = textOn(accent, ink);
  const heroBg = mood === 'bold' ? primaryDeep : mood === 'warm' ? primarySoft : surface;
  const heroInk = mood === 'bold' ? '#ffffff' : ensureContrast(ink, heroBg, 7, 'darker');
  // 4.6 rather than 4.5 leaves a margin above the AA line after hex rounding.
  const heroMuted = mood === 'bold' ? ensureContrast(hsl(base.h, 20, 86), heroBg, 4.6, 'lighter') : ensureContrast(muted, heroBg, 4.6, 'darker');
  return { primary, primaryInk, primaryDeep, primarySoft, primarySoftInk, accent, accentInk, ink, muted, surface, surfaceAlt, line, heroBg, heroInk, heroMuted, radius: settings.radius, radiusSmall: settings.radiusSmall, scale: settings.scale, headingWeight: settings.headingWeight, mood };
}

/** The pairs the stylesheet relies on, for the checker and the tests. */
export function themePairs(theme: Theme): { name: string; foreground: string; background: string; minimum: number }[] {
  return [
    { name: 'ink on surface', foreground: theme.ink, background: theme.surface, minimum: 4.5 },
    { name: 'ink on surfaceAlt', foreground: theme.ink, background: theme.surfaceAlt, minimum: 4.5 },
    { name: 'muted on surface', foreground: theme.muted, background: theme.surface, minimum: 4.5 },
    { name: 'muted on surfaceAlt', foreground: theme.muted, background: theme.surfaceAlt, minimum: 4.5 },
    { name: 'button text on primaryDeep', foreground: '#ffffff', background: theme.primaryDeep, minimum: 4.5 },
    { name: 'badge text on primarySoft', foreground: theme.primarySoftInk, background: theme.primarySoft, minimum: 4.5 },
    { name: 'hero ink on hero', foreground: theme.heroInk, background: theme.heroBg, minimum: 4.5 },
    { name: 'hero muted on hero', foreground: theme.heroMuted, background: theme.heroBg, minimum: 4.5 },
    { name: 'primaryDeep link on surface', foreground: theme.primaryDeep, background: theme.surface, minimum: 4.5 },
  ];
}

/** Named colours the card offers and the commands understand (Arabic and English). */
export const COLOUR_WORDS: readonly { ar: string; en: string; hex: string; aliases: readonly string[] }[] = [
  { ar: 'أزرق', en: 'blue', hex: '#1d4ed8', aliases: ['ازرق', 'كحلي', 'navy', 'azure'] },
  { ar: 'أخضر', en: 'green', hex: '#15803d', aliases: ['اخضر', 'زيتي', 'olive', 'emerald'] },
  { ar: 'فيروزي', en: 'teal', hex: '#0f766e', aliases: ['تركواز', 'turquoise', 'cyan', 'سماوي'] },
  { ar: 'أحمر', en: 'red', hex: '#b91c1c', aliases: ['احمر', 'crimson', 'خمري', 'maroon', 'burgundy'] },
  { ar: 'برتقالي', en: 'orange', hex: '#c2410c', aliases: ['orange', 'coral'] },
  { ar: 'ذهبي', en: 'gold', hex: '#a16207', aliases: ['أصفر', 'اصفر', 'yellow', 'amber', 'عسلي'] },
  { ar: 'بنفسجي', en: 'purple', hex: '#6d28d9', aliases: ['موف', 'violet', 'indigo', 'نيلي', 'لافندر', 'lavender'] },
  { ar: 'وردي', en: 'pink', hex: '#be185d', aliases: ['زهري', 'rose', 'magenta', 'فوشيا', 'fuchsia'] },
  { ar: 'بني', en: 'brown', hex: '#7c4a1e', aliases: ['بيج', 'beige', 'ترابي', 'chocolate', 'كراميل'] },
  { ar: 'أسود', en: 'black', hex: '#1f2937', aliases: ['اسود', 'فحمي', 'charcoal', 'رمادي', 'gray', 'grey', 'graphite'] },
];
export function colourFromWord(text: string): { hex: string; word: string } | null {
  const lower = text.toLocaleLowerCase();
  for (const colour of COLOUR_WORDS) {
    for (const word of [colour.ar, colour.en, ...colour.aliases]) {
      if (new RegExp(`(?:^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(lower)) return { hex: colour.hex, word };
    }
  }
  const hex = lower.match(/#([0-9a-f]{6})(?![0-9a-f])/i);
  return hex ? { hex: `#${hex[1]!.toLocaleLowerCase()}`, word: `#${hex[1]}` } : null;
}

/** A default primary per kind, used only until the user picks a colour. */
export const KIND_COLOURS: Readonly<Record<string, string>> = {
  services: '#1d4ed8', restaurant: '#b45309', clinic: '#0f766e', portfolio: '#1f2937', catalogue: '#6d28d9', landing: '#c2410c',
};
export const KIND_MOODS: Readonly<Record<string, SiteMood>> = {
  services: 'calm', restaurant: 'warm', clinic: 'calm', portfolio: 'bold', catalogue: 'warm', landing: 'bold',
};
