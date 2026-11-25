const presentationForm = /^[\uFB50-\uFDFF\uFE70-\uFEFC]$/u;
const arabicLetter = /(?=\p{L})\p{Script=Arabic}/u;
const latinLetter = /(?=\p{L})\p{Script=Latin}/u;

/** PDF.js returns some shaped Arabic as single glyphs in left-to-right drawing order. */
export function pdfMonitorLine(items) {
  const plain = () => items.map(item => item.str).join(' ');
  if (items.filter(item => presentationForm.test(item.str)).length < 2 ||
    items.some((item, index) => index && item.transform[4] < items[index - 1].transform[4])) return plain();

  const words = [];
  let word = [];
  for (const item of items) {
    for (const part of item.str.split(/(\s+)/u)) {
      if (!part) continue;
      if (/^\s/u.test(part)) {
        if (word.length) words.push(word);
        word = [];
      } else {
        word.push(part);
      }
    }
  }
  if (word.length) words.push(word);

  const runs = [];
  for (const parts of words) {
    const text = parts.join('');
    if (arabicLetter.test(text) && !latinLetter.test(text)) {
      // Reverse the positions of glyph runs and keep the logical character order inside each PDF.js run.
      runs.push({ text: parts.reverse().join(''), latin: false });
    } else if (latinLetter.test(text) && runs.at(-1)?.latin) {
      runs.at(-1).text += ' ' + text;
    } else {
      runs.push({ text, latin: latinLetter.test(text) });
    }
  }
  return runs.reverse().map(run => run.text).join(' ');
}
