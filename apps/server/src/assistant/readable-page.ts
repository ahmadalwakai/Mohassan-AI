/**
 * HTML cleanup before a page read over HTTP becomes text for the hands (app.ts readPage).
 *
 * The shared extractor (readableSource in packages/browser) joins every node with a space, so an image or video caption
 * runs into the next sentence of the article. Measured on 2026-11-22 (artifacts/plan-2026-11-22/3-answers-and-questions.md
 * §2.5): «من اخترع الهاتف؟» led with «فنان يرسم ألكساندر جراهام بيل يتحدث إلى هاتف نموذجي مبكر كان اختراع الهاتف…», and
 * «ما أعراض المياه البيضاء في العين؟» with «مثال على رؤية طبيعية مثال على رؤية بوجود مرض السّاد تختلف أعراض…». In the
 * hidden browser the same captions are separate lines. A figure is an illustration with its caption, never the article's
 * own sentence, so it is left out of the text.
 */
const FIGURE = /<figure\b[^>]*>[\s\S]*?<\/figure>/giu;

export function withoutFigures(html: string): string {
  return html.replace(FIGURE, ' ');
}
