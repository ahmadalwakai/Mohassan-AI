import type { SiteItem, SiteLang } from '@mohassan/contracts';
import { asciiDigits } from './html.ts';

/** Arabic normalisation for matching only: never applied to text that reaches a page. */
export function normalize(text: string): string {
  return asciiDigits(text)
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[،؛]/g, match => (match === '،' ? ',' : ';'))
    .replace(/؟/g, '?')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ARABIC_LETTERS = /[؀-ۿ]/g;
const LATIN_LETTERS = /[A-Za-z]/g;
export const hasArabic = (text: string) => /[؀-ۿ]/.test(text);
export function detectLang(text: string): SiteLang {
  const arabic = (text.match(ARABIC_LETTERS) ?? []).length, latin = (text.match(LATIN_LETTERS) ?? []).length;
  return arabic >= latin ? 'ar' : 'en';
}
/** An explicit language request inside the sentence wins over the script. */
export function requestedLang(text: string): SiteLang | null {
  const norm = normalize(text);
  if (/(?:^|\s)(?:بال|ب)?(?:انجليزي|انجليزيه|انكليزي|انكليزيه|english)(?:\s|$|[.,!?])/.test(norm) || /\bin english\b|\benglish (?:site|website|version)\b/.test(norm)) return 'en';
  if (/(?:^|\s)(?:بال|ب)?(?:عربي|عربيه|arabic)(?:\s|$|[.,!?])/.test(norm) || /\bin arabic\b/.test(norm)) return 'ar';
  return null;
}

/** Items from a free-text answer: one per line or comma; "title - price" or "title: detail". */
export function parseItems(answer: string, limit = 40): SiteItem[] {
  const parts = answer.split(/\r?\n|[،,;؛]|(?:^|\s)[•*-]\s+/u).map(part => part.trim()).filter(Boolean);
  const items: SiteItem[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/^[\d]+[.)]\s*/u, '').replace(/^[-–—•*]\s*/u, '').trim();
    if (!cleaned) continue;
    const separated = cleaned.match(/^(.{1,80}?)\s*(?:[-–—:：]|\(|بسعر|سعره|سعرها|for|at)\s*(.{1,120}?)\)?\s*$/u);
    if (separated && separated[1]!.trim()) {
      const title = separated[1]!.trim(), rest = separated[2]!.trim();
      if (/\d/.test(asciiDigits(rest)) && rest.length <= 40) items.push({ title, price: rest });
      else items.push({ title, detail: rest.slice(0, 300) });
    } else items.push({ title: cleaned.slice(0, 80) });
    if (items.length >= limit) break;
  }
  const seen = new Set<string>();
  return items.filter(item => { const key = normalize(item.title); if (seen.has(key)) return false; seen.add(key); return true; });
}

export interface FoundNumber { digits: string; index: number; whatsapp: boolean }
const NUMBER_PATTERN = /(?:\+|00)?\d(?:[\d\s().-]{5,18})\d/g;
const WHATSAPP_WORDS = /(?:واتساب|واتس اب|واتس|وتساب|whatsapp|whats app|wa\b)/iu;
/** Phone-like runs of 7–15 digits; a run near the word WhatsApp is tagged as such. */
export function findNumbers(text: string): FoundNumber[] {
  const ascii = asciiDigits(text);
  const found: FoundNumber[] = [];
  for (const match of ascii.matchAll(NUMBER_PATTERN)) {
    const raw = match[0];
    const plus = raw.trim().startsWith('+') || raw.trim().startsWith('00');
    const digits = raw.replace(/\D/g, '').replace(/^00/, '');
    if (digits.length < 7 || digits.length > 15) continue;
    const before = ascii.slice(Math.max(0, match.index - 28), match.index), after = ascii.slice(match.index + raw.length, match.index + raw.length + 20);
    found.push({ digits: plus ? `+${digits}` : digits, index: match.index, whatsapp: WHATSAPP_WORDS.test(before) || WHATSAPP_WORDS.test(after) });
  }
  return found;
}
export const findEmail = (text: string) => text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
export const findUrl = (text: string) => text.match(/https:\/\/[^\s"'<>()]+/)?.[0]?.replace(/[.,،]+$/, '') ?? null;

/** Lines from a multi-line answer, trimmed; also splits on Arabic and ASCII commas. */
export const splitList = (answer: string) => answer.split(/\r?\n|[،,;؛]/u).map(part => part.trim()).filter(Boolean);

/** A "no / none / nothing" answer to an optional field. */
export const isNone = (text: string) => /^(?:لا|لا شيء|لا يوجد|لا توجد|ما عندي|بدون|بلا|لاحقا|لاحقاً|none|no|nothing|skip|n\/a|-)[.!؟?\s]*$/iu.test(text.trim());
