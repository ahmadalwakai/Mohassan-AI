/**
 * HTML cleanup before the HTTP page reader extracts text for the hands.
 *
 * The shared extractor (readableSource in packages/browser) joins every node with a space, so an image or video caption
 * runs into the next sentence of the article. Measured on 2026-11-22 (artifacts/plan-2026-11-22/3-answers-and-questions.md
 * §2.5): «من اخترع الهاتف؟» led with «فنان يرسم ألكساندر جراهام بيل يتحدث إلى هاتف نموذجي مبكر كان اختراع الهاتف…», and
 * «ما أعراض المياه البيضاء في العين؟» with «مثال على رؤية طبيعية مثال على رؤية بوجود مرض السّاد تختلف أعراض…». In the
 * hidden browser the same captions are separate lines. A figure is an illustration with its caption, never the article's
 * own sentence, so it is left out of the text.
 *
 * A hatnote («المقالة الرئيسة: عائلة أينشتاين», "Main article: …", `<div role="note" class="hatnote …">`) is navigation too,
 * and it ran into the section's first sentence the same way: «المقالة الرئيسة: عائلة أينشتاين ولد ألبرت أينشتاين في أولم…»
 * was dropped whole as a line about the page, so «أين ولد أينشتاين» had no birth sentence to quote (2026-11-23). Hatnotes hold
 * no nested block, so each ends at its first </div>.
 */
const FIGURE = /<figure\b[^>]*>[\s\S]*?<\/figure>/giu;
const HATNOTE = /<div\b[^>]*\bclass="[^"]*\bhatnote\b[^"]*"[^>]*>[\s\S]*?<\/div>/giu;

export function withoutFigures(html: string): string {
  // A hatnote becomes a sentence break, not a space: its own closing «.» kept the text before it (an infobox caption, a
  // short description) apart from the article's first sentence, and joined to it the definition of «Photosynthesis» was lost
  // (rq028 of the 107 real requests, 2026-11-23).
  return html.replace(FIGURE, ' ').replace(HATNOTE, ' <p>.</p> ');
}
