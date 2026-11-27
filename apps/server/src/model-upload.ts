import type { ModelRunRequest } from '@mohassan/contracts';

// WHATWG MIME Sniffing, matching an image type pattern (retrieved 2026-11-27).
// https://mimesniff.spec.whatwg.org/#matching-an-image-type-pattern
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegSignature = Buffer.from('ffd8ff', 'hex');

/** Admit only the declared format before invoking a native image parser. */
export function modelUploadBytes(image: NonNullable<ModelRunRequest['image']>): Buffer | undefined {
  const bytes = Buffer.from(image.data, 'base64');
  switch (image.mimeType) {
    case 'image/png': return bytes.subarray(0, pngSignature.length).equals(pngSignature) ? bytes : undefined;
    case 'image/jpeg': return bytes.subarray(0, jpegSignature.length).equals(jpegSignature) ? bytes : undefined;
    case 'image/webp': return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 14) === 'WEBPVP' ? bytes : undefined;
  }
}
