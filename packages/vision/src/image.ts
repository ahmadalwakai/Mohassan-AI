import sharp, { type Metadata, type OutputInfo } from 'sharp';

/** Decoded pixels plus the plain facts a reader can state without any model. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly format: string;
  readonly gray: Uint8Array;
  readonly rgb: Uint8Array;
}

export interface DominantColor { readonly hex: string; readonly share: number; readonly name: string }
export interface ImageFacts {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly orientation: 'landscape' | 'portrait' | 'square';
  readonly meanBrightness: number;
  readonly darkBackground: boolean;
  readonly colorfulness: number;
  readonly distinctColors: number;
  readonly flatShare: number;
  readonly dominant: readonly DominantColor[];
  /** A guess from pixel statistics alone; the reader refines it with the text it finds. */
  readonly surface: 'graphic' | 'photo' | 'mixed';
}

export class ImageDecodeError extends Error {
  constructor(readonly code: 'unsupported' | 'too_large' | 'corrupt') { super(`IMAGE_${code.toUpperCase()}`); }
}

export async function decodeImage(bytes: Uint8Array, options: { maxSide?: number; maxPixels?: number } = {}): Promise<DecodedImage> {
  const maxSide = options.maxSide ?? 2600, maxPixels = options.maxPixels ?? 40_000_000;
  let image = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error', animated: false });
  let metadata: Metadata;
  try { metadata = await image.metadata(); } catch { throw new ImageDecodeError('corrupt'); }
  if (!metadata.width || !metadata.height || !metadata.format) throw new ImageDecodeError('unsupported');
  if (!['png', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'heif'].includes(metadata.format)) throw new ImageDecodeError('unsupported');
  const rotated = metadata.orientation && metadata.orientation >= 5;
  const originalWidth = rotated ? metadata.height : metadata.width, originalHeight = rotated ? metadata.width : metadata.height;
  image = image.rotate().flatten({ background: '#ffffff' });
  if (Math.max(originalWidth, originalHeight) > maxSide) image = image.resize({ width: originalWidth >= originalHeight ? maxSide : undefined, height: originalHeight > originalWidth ? maxSide : undefined, fit: 'inside', kernel: 'lanczos3' });
  let raw: { data: Buffer; info: OutputInfo };
  try { raw = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true }); } catch { throw new ImageDecodeError('corrupt'); }
  const { width, height, channels } = raw.info;
  if (channels !== 3) throw new ImageDecodeError('unsupported');
  const rgb = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 3) gray[i] = (rgb[p] * 299 + rgb[p + 1] * 587 + rgb[p + 2] * 114 + 500) / 1000 | 0;
  return { width, height, originalWidth, originalHeight, format: metadata.format, gray, rgb: Uint8Array.from(rgb) };
}

const NAMES_AR: Record<string, string> = { white: 'أبيض', black: 'أسود', gray: 'رمادي', red: 'أحمر', orange: 'برتقالي', yellow: 'أصفر', green: 'أخضر', cyan: 'سماوي', blue: 'أزرق', purple: 'بنفسجي', pink: 'وردي', brown: 'بني' };

export function colorName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2;
  if (delta < 24) return light > 215 ? NAMES_AR.white : light < 45 ? NAMES_AR.black : NAMES_AR.gray;
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6; else if (max === g) hue = (b - r) / delta + 2; else hue = (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return light < 90 && delta < 90 ? NAMES_AR.brown : NAMES_AR.red;
  if (hue < 45) return light < 110 ? NAMES_AR.brown : NAMES_AR.orange;
  if (hue < 70) return NAMES_AR.yellow;
  if (hue < 165) return NAMES_AR.green;
  if (hue < 200) return NAMES_AR.cyan;
  if (hue < 260) return NAMES_AR.blue;
  if (hue < 300) return NAMES_AR.purple;
  return NAMES_AR.pink;
}

export function describeImage(image: DecodedImage): ImageFacts {
  const { width, height, rgb, gray } = image;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  const bins = new Map<number, number>();
  let samples = 0, brightness = 0, rgSum = 0, ybSum = 0, flat = 0, flatSamples = 0;
  const fine = new Set<number>();
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x, p = i * 3, r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      samples++;
      brightness += gray[i];
      rgSum += Math.abs(r - g);
      ybSum += Math.abs((r + g) / 2 - b);
      const coarse = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      bins.set(coarse, (bins.get(coarse) ?? 0) + 1);
      fine.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      if (x + step < width) { flatSamples++; if (Math.abs(gray[i] - gray[i + step]) <= 2) flat++; }
    }
  }
  const border: number[] = [];
  for (let x = 0; x < width; x += step) { border.push(gray[x], gray[(height - 1) * width + x]); }
  for (let y = 0; y < height; y += step) { border.push(gray[y * width], gray[y * width + width - 1]); }
  border.sort((a, b) => a - b);
  const borderMedian = border.length ? border[Math.floor(border.length / 2)] : 255;
  const dominant = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([bin, count]) => {
    const r = ((bin >> 6) & 7) * 32 + 16, g = ((bin >> 3) & 7) * 32 + 16, b = (bin & 7) * 32 + 16;
    const hex = `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
    return { hex, share: count / samples, name: colorName(r, g, b) };
  });
  const colorfulness = (rgSum + ybSum) / (2 * samples), flatShare = flatSamples ? flat / flatSamples : 1;
  const surface: ImageFacts['surface'] = flatShare >= 0.45 && fine.size < 900 ? 'graphic' : flatShare < 0.2 && fine.size >= 700 ? 'photo' : 'mixed';
  return {
    width: image.originalWidth, height: image.originalHeight, format: image.format,
    orientation: width > height * 1.05 ? 'landscape' : height > width * 1.05 ? 'portrait' : 'square',
    meanBrightness: Math.round(brightness / samples), darkBackground: borderMedian < 110, colorfulness: Math.round(colorfulness * 10) / 10,
    distinctColors: fine.size, flatShare: Math.round(flatShare * 1000) / 1000, dominant, surface,
  };
}
