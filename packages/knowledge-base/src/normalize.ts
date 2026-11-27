/** Match common Arabic orthographic variants while retaining the original names for display. */
export function normalizeLookupKey(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u0640\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\p{Cf}]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 15))
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}
