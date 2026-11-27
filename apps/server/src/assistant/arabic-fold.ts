// NFC composes canonical equivalents while preserving compatibility distinctions in prices and other text.
// Unicode UAX #15 §1.2, retrieved 2026-11-27: https://www.unicode.org/reports/tr15/tr15-57.html#Norm_Forms
// The mark predicate intersects General_Category=Mark with Script_Extensions=Arabic. This includes
// marks shared with Syriac and preserves digits, decimal/thousands separators, and percent signs.
// Unicode 17 data, retrieved 2026-11-27:
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
// https://www.unicode.org/Public/17.0.0/ucd/Scripts.txt
// https://www.unicode.org/Public/17.0.0/ucd/ScriptExtensions.txt
const ARABIC_MARK = /(?=\p{Script_Extensions=Arabic})\p{Mark}/gu;
const FINAL_ARABIC_VARIANT = /[ةى](?![\p{Letter}\p{Mark}\p{Number}\p{Join_Control}])/gu;

/** Returns a comparison key. Case, whitespace and numeral scripts are left to the caller. */
export function foldArabicForMatch(text: string): string {
  return text.normalize('NFC')
    .replace(ARABIC_MARK, '')
    .replace(/ـ/gu, '') // U+0640 TATWEEL is a modifier letter.
    // The letter substitutions are application matching rules using the characters in UnicodeData.
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ؤ/gu, 'و')
    .replace(/[ئی]/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(FINAL_ARABIC_VARIANT, letter => letter === 'ة' ? 'ه' : 'ي');
}

/** Returns the original spelling, typography and numbers for display. */
export function preserveArabicForDisplay(text: string): string {
  return text;
}
