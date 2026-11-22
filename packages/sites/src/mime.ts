/** Exact media types: the preview route sends X-Content-Type-Options: nosniff, so each file needs the right one. */
const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
};
export const extensionOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLocaleLowerCase();
export const contentTypeFor = (path: string) => TYPES[extensionOf(path)] ?? 'application/octet-stream';
export const isTextType = (type: string) => /^(?:text\/|application\/(?:json|manifest\+json|xml)|image\/svg\+xml)/.test(type);
/** Already-compressed binaries are stored in the ZIP; text is deflated. */
export const shouldDeflate = (path: string) => !['png', 'jpg', 'jpeg', 'webp', 'woff2', 'woff'].includes(extensionOf(path));
