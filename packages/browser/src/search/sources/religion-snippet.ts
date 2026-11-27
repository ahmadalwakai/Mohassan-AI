// Match the SearchEngine snippet cap, which counts JavaScript string length.
export const religionSnippetLimit = 2_000;

export function wholeReligionQuote(text: string): string {
  return text.length <= religionSnippetLimit ? text : '';
}
