import { arabicBase, requestTerms, STEM_STOP_WORDS, type RequestTerm } from './stems.ts';

const ARABIC = /\p{Script=Arabic}/u;
const ARABIC_CLITIC = /^[وفبلك]/u;
// PyArabic's tasheel folds seated hamza and preserves bare hamza after the inherited NFKC normalization.
// https://github.com/linuxscout/pyarabic/blob/master/pyarabic/araby.py#L841-L851 (retrieved 2026-11-27)
const foldSeatedHamza = (word: string) => word.replace(/ؤ/gu, 'و').replace(/ئ/gu, 'ي');
const STOP_WORDS = new Set([...STEM_STOP_WORDS].map(foldSeatedHamza));

/** Keep whole forms alongside light stems so an affix shared by a singular and a plural need not disappear from both. */
export function readerEvidenceTerms(text: string, maxChars = text.length): RequestTerm[] {
  return requestTerms(text, maxChars).flatMap(({ word, variants }) => {
    const folded = foldSeatedHamza(word);
    if (STOP_WORDS.has(folded)) return [];
    const forms = [...variants, word];
    if (ARABIC.test(word)) {
      forms.push(arabicBase(word));
      if (ARABIC_CLITIC.test(word) && word.length > 3) forms.push(arabicBase(word.slice(1)));
    }
    const kept = [...new Set(forms.map(foldSeatedHamza))].filter(form => !STOP_WORDS.has(form));
    return [{ word: folded, variants: kept }];
  });
}
