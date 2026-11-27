// The alef, teh marbuta/heh, and alef maksura/yeh search folds are described by
// Condon et al., Table 1: https://aclanthology.org/2009.mtsummit-papers.3.pdf
// Unicode 17 §9.2.4 describes teh marbuta and modern Arabic alef maksura as trailing:
// https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-9/
// Both retrieved 2026-11-27. The ending folds apply only to complete matching tokens.
export function foldSearchAlef(text: string): string {
  return text.replace(/[أإآٱ]/gu, 'ا');
}

const finalVariants: Readonly<Record<string, string | undefined>> = { ة: 'ه', ه: 'ة', ى: 'ي', ي: 'ى' };

export function alternateSearchWord(word: string): string {
  return word.replace(/[ةهيى](?=\p{N}*$)/u, letter => finalVariants[letter] ?? letter);
}

export function matchingSearchWord(word: string): string {
  return /[هى](?=\p{N}*$)/u.test(word) ? alternateSearchWord(word) : word;
}
