const smallNumbers = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const tens = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const numberWords = new Map(smallNumbers.map((word, index) => [word, index]));
for (const [index, word] of tens.entries()) numberWords.set(word, (index + 2) * 10);

const integerWords = `(?:${tens.join('|')})(?:[ -](?:${smallNumbers.slice(1, 10).join('|')}))?|(?:${smallNumbers.join('|')})`;
const hundredWords = `(?:${smallNumbers.slice(1, 10).join('|')}) hundred(?: (?:and )?(?:${integerWords}))?`;
const wordFraction = `(?:a|an|${smallNumbers.slice(1, 10).join('|')})[ -](?:half|halves|thirds?|quarters?|fourths?|fifths?|sixths?|eighths?|tenths?)`;
const decimal = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+`;
export const numberSource = `(?:-?(?:${decimal})(?:/\\d+)?|${wordFraction}|${hundredWords}|${integerWords})`;

const denominators: Readonly<Record<string, number>> = {
  half: 2, halves: 2, third: 3, quarter: 4, fourth: 4, fifth: 5, sixth: 6, eighth: 8, tenth: 10,
};
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
const fractionSymbols: Readonly<Record<string, string>> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

export function normalizeWordProblem(text: string): string {
  return text.normalize('NFC')
    .replace(/[٠-٩]/gu, digit => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/gu, digit => String(persianDigits.indexOf(digit)))
    .replace(/(?<![\d.,٫٬])(-?)(\d{1,30}) ?([½⅓⅔¼¾⅕⅖⅗⅘⅛⅜⅝⅞])/gu, (_match, sign, whole, fraction) => {
      const [top, bottom] = fractionSymbols[fraction]!.split('/').map(BigInt);
      return `${sign}${BigInt(whole) * bottom! + top!}/${bottom}`;
    })
    .replace(/(?<!\d)[½⅓⅔¼¾⅕⅖⅗⅘⅛⅜⅝⅞]/gu, fraction => fractionSymbols[fraction]!)
    .replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/٪/gu, '%')
    .replace(/’/gu, "'").replace(/−/gu, '-').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

const numericAmount = new RegExp(`^-?(?:${decimal})(?:/\\d+)?$`, 'u');

/** Preserve the input as decimal or rational notation for the calculator. */
export function parseNumber(text: string): string | null {
  const source = normalizeWordProblem(text).toLowerCase();
  if (numericAmount.test(source)) return source.replace(/,/gu, '');
  const fraction = new RegExp(`^(?:${wordFraction})$`, 'u').exec(source);
  if (fraction) {
    const [count, name] = source.split(/[ -]/u);
    const divisor = denominators[name!] ?? denominators[name!.replace(/s$/u, '')];
    return `${numberWords.get(count!) ?? 1}/${divisor}`;
  }
  const hundred = new RegExp(`^(${smallNumbers.slice(1, 10).join('|')}) hundred(?: (?:and )?(${integerWords}))?$`, 'u').exec(source);
  if (hundred) {
    const remainder = hundred[2] ? parseNumber(hundred[2]) : '0';
    return remainder === null ? null : String(numberWords.get(hundred[1]!)! * 100 + Number(remainder));
  }
  const known = numberWords.get(source);
  if (known !== undefined) return String(known);
  const [ten, unit] = source.split(/[ -]/u);
  const ones = numberWords.get(unit!);
  return tens.includes(ten!) && ones !== undefined && ones > 0 && ones < 10
    && new RegExp(`^(?:${integerWords})$`, 'u').test(source) ? String(numberWords.get(ten!)! + ones) : null;
}

const irregularUnits: Readonly<Record<string, string>> = {
  children: 'child', people: 'person', men: 'man', women: 'woman', feet: 'foot', mice: 'mouse',
  pennies: 'penny', halves: 'half', loaves: 'loaf', scarves: 'scarf', leaves: 'leaf',
};

export function unitKey(text: string): string {
  const words = text.toLowerCase().trim().replace(/^(?:the|a|an)\s+/u, '').split(/\s+/u);
  const last = words.pop() ?? '';
  return [...words, irregularUnits[last] ?? last.replace(/([^aeiou])ies$/u, '$1y')
    .replace(/(ss|ch|sh|x|z)es$/u, '$1').replace(/(?<![su])s$/u, '')].join(' ');
}

export interface MentionedQuantity {
  value: string;
  mention: string;
  unit: string | null;
}

/** List observed quantities for clarification without inferring an operation. */
export function extractQuantities(text: string): MentionedQuantity[] {
  const mentions = new RegExp(String.raw`(?<![\p{L}\d/.])([$£€]\s*)?(${numberSource})(?![\p{L}\d/])(?:\s*(%|percent\b)|\s+([\p{L}][\p{L}-]{1,24}))?`, 'giu');
  const result: MentionedQuantity[] = [];
  for (const match of normalizeWordProblem(text).matchAll(mentions)) {
    const value = parseNumber(match[2]!);
    if (value === null) continue;
    const unit = match[1]?.trim() ?? match[3] ?? (match[4] && !/^(?:and|or|of|in|per|for|to|is|are|has|have|من|في|كل)$/iu.test(match[4]) ? match[4] : null);
    result.push({ value, unit, mention: `${match[1] ?? ''}${match[2]}${unit && !match[1] ? `${unit === '%' ? '' : ' '}${unit}` : ''}` });
  }
  return result;
}
