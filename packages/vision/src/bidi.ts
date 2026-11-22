/**
 * Visual order <-> logical order for one text line.
 *
 * Mirrors scripts/vision/charset.py exactly: the OCR model learns characters in
 * the left-to-right order they are drawn, and `toLogical` turns its output back
 * into text. The rules are the parts of the Unicode bidirectional algorithm that
 * matter for a single line of printed text (W4, W5, W7, N1, N2, I1, I2, L2, L4).
 */

export type BidiBase = 'L' | 'R';
type Kind = 'L' | 'R' | 'EN' | 'AN' | 'ET' | 'CS' | 'N';

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const TERMINATORS = new Set(['%', '٪', '$', '€', '£', '¥', '¢', '#', '°', '+', '-']);
const SEPARATORS = new Set([',', '.', ':', '/', '٬', '٫', '،']);
const LETTER = /\p{L}/u;

function isArabicLetter(code: number): boolean {
  return (code >= 0x0620 && code <= 0x064a) || (code >= 0x066e && code <= 0x06d3) || (code >= 0x06fa && code <= 0x06fc)
    || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff);
}

export function classify(char: string): Kind {
  const code = char.codePointAt(0) ?? 0;
  if (isArabicLetter(code)) return 'R';
  if (code >= 0x30 && code <= 0x39) return 'EN';
  if ((code >= 0x0660 && code <= 0x0669) || (code >= 0x06f0 && code <= 0x06f9)) return 'AN';
  if (TERMINATORS.has(char)) return 'ET';
  if (SEPARATORS.has(char)) return 'CS';
  if (LETTER.test(char)) return 'L';
  return 'N';
}

/** R when Arabic letters are at least as many as other letters, else L. */
export function detectBase(text: string): BidiBase {
  let right = 0, left = 0;
  for (const char of text) {
    const kind = classify(char);
    if (kind === 'R') right++;
    else if (kind === 'L') left++;
  }
  if (right === 0) return 'L';
  return right >= left ? 'R' : 'L';
}

export function hasArabic(text: string): boolean {
  for (const char of text) if (classify(char) === 'R') return true;
  return false;
}

function resolveLevels(chars: string[], base: BidiBase): number[] {
  const n = chars.length;
  const types: Kind[] = chars.map(classify);
  for (let i = 1; i < n - 1; i++) {
    if (types[i] !== 'CS') continue;
    if (types[i - 1] === 'EN' && types[i + 1] === 'EN' && ',.:/'.includes(chars[i])) types[i] = 'EN';
    else if (types[i - 1] === 'AN' && types[i + 1] === 'AN' && ',.،٬٫'.includes(chars[i])) types[i] = 'AN';
  }
  for (let i = 0; i < n;) {
    if (types[i] !== 'ET') { i++; continue; }
    let j = i;
    while (j < n && types[j] === 'ET') j++;
    if ((i > 0 && types[i - 1] === 'EN') || (j < n && types[j] === 'EN')) for (let k = i; k < j; k++) types[k] = 'EN';
    i = j;
  }
  let lastStrong: Kind = base;
  for (let i = 0; i < n; i++) {
    if (types[i] === 'L' || types[i] === 'R') lastStrong = types[i];
    else if (types[i] === 'EN' && lastStrong === 'L') types[i] = 'L';
  }
  const strongOf = (kind: Kind): Kind | null => kind === 'L' ? 'L' : kind === 'R' || kind === 'EN' || kind === 'AN' ? 'R' : null;
  for (let i = 0; i < n;) {
    if (types[i] !== 'N' && types[i] !== 'CS' && types[i] !== 'ET') { i++; continue; }
    let j = i;
    while (j < n && (types[j] === 'N' || types[j] === 'CS' || types[j] === 'ET')) j++;
    let prev: Kind = base, next: Kind = base;
    for (let k = i - 1; k >= 0; k--) { const strong = strongOf(types[k]); if (strong) { prev = strong; break; } }
    for (let k = j; k < n; k++) { const strong = strongOf(types[k]); if (strong) { next = strong; break; } }
    const kind = prev === next ? prev : base;
    for (let k = i; k < j; k++) types[k] = kind;
    i = j;
  }
  return types.map(kind => kind === 'L' ? (base === 'L' ? 0 : 2) : kind === 'R' ? 1 : 2);
}

function reorder(chars: string[], levels: number[]): string {
  const out = chars.map((char, index) => levels[index] % 2 === 1 && MIRROR[char] ? MIRROR[char] : char);
  const odd = levels.filter(level => level % 2 === 1);
  if (!odd.length) return out.join('');
  const lowestOdd = Math.min(...odd), highest = Math.max(...levels);
  const current = levels.slice();
  for (let level = highest; level >= lowestOdd; level--) {
    for (let i = 0; i < out.length;) {
      if (current[i] < level) { i++; continue; }
      let j = i;
      while (j < out.length && current[j] >= level) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse());
      current.splice(i, j - i, ...current.slice(i, j).reverse());
      i = j;
    }
  }
  return out.join('');
}

/** Characters in the left-to-right order they are drawn. */
export function toVisual(logical: string, base: BidiBase = detectBase(logical)): string {
  const chars = Array.from(logical);
  return reorder(chars, resolveLevels(chars, base));
}

/** A logical-order string that draws as `visual`. Bidi is many-to-one, so this is one valid reading. */
export function toLogical(visual: string, base: BidiBase = detectBase(visual)): string {
  const chars = Array.from(visual);
  return reorder(chars, resolveLevels(chars, base));
}
