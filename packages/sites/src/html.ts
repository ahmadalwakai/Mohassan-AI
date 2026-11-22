/** Every user-supplied string passes through one of these before it reaches a page. */
export const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Attribute list from an object; undefined/false values are dropped, true renders a bare attribute. */
export function attrs(values: Readonly<Record<string, string | number | boolean | undefined>>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false && value !== '')
    .map(([key, value]) => (value === true ? ` ${key}` : ` ${key}="${escapeAttribute(String(value))}"`))
    .join('');
}

/** Build an element; children are trusted HTML strings, so escape user text before passing it in. */
export function el(tag: string, attributes: Readonly<Record<string, string | number | boolean | undefined>> = {}, ...children: (string | false | null | undefined)[]): string {
  return `<${tag}${attrs(attributes)}>${children.filter(Boolean).join('')}</${tag}>`;
}

export const joinLines = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join('\n');

/** Collapses whitespace in user text so headings stay on one line. */
export const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Paragraphs from multi-line user text (about, detail), escaped. */
export function paragraphs(value: string, className?: string): string {
  return value.split(/\n{2,}|\r\n\r\n|\n/).map(part => part.trim()).filter(Boolean)
    .map(part => el('p', className ? { class: className } : {}, escapeText(part))).join('');
}

/** Digits as the user wrote them: Arabic-Indic and Persian digits become ASCII for tel: links and checks. */
export const asciiDigits = (value: string) => value.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));

/** Digits only (plus kept at the front), for tel: and wa.me links. */
export function telDigits(value: string): string {
  const ascii = asciiDigits(value).trim();
  const plus = ascii.startsWith('+') || ascii.startsWith('00');
  const digits = ascii.replace(/\D/g, '').replace(/^00/, '');
  return plus ? `+${digits}` : digits;
}

/** A URL-safe ASCII slug; Arabic names fall back to the given default. */
export function slugify(value: string, fallback = 'site'): string {
  const slug = value.normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug.length >= 3 ? slug : fallback;
}
