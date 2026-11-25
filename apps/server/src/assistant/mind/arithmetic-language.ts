import { parseNumberWords } from '../reasoning/number-words.js';

const INTRO = /^(?:calculate|compute|evaluate|solve|what is|what['’]s|how much is|(?:كم|ما)(?: (?:هو|هي))?(?: (?:يساوي|تساوي))?|(?:(?:نبي|نبغي|ابغي|ابي|بدي|بدنا|عايز|عايزة|عايزين|اريد|نريد)\s+(?:ان\s+)?)?(?:احسب(?:وا|ي)?|نحسب)(?:\s*(?:لي|لنا))?)[\s:،]+/iu;
const RESULT_HEAD = /^(?:(?:the )?(?:result|value) of|(?:ال)?(?:ناتج|حاصل|نتيج[ةه]))[\s:،]+/iu;
const CONDITIONAL = /^(?:if\s+(?:we|you)\s+|(?:اذا|لو)\s+)(.+?)[,،]\s*(?:what (?:is|would be) (?:the (?:result|answer)|left)|what['’]s the (?:result|answer)|(?:كم|كام|قديش|اديش|شكد)(?:\s+(?:(?:ب|ي|ت|بي|هي)?طلع|(?:ي|ت)ساوي|(?:ال)?ناتج|(?:ال)?نتيج[ةه]))?)$/iu;

const OPERAND_COMMANDS = [
  { match: /^(?:subtract|اطرح|طرح(?:نا|ت)|نطرح)[\s:،]+(.+?)\s+(?:from|من)\s+(.+)$/iu, operator: '-', reverse: true },
  { match: /^(?:divide|اقسم|قسم(?:نا|ت)|نقسم)[\s:،]+(.+?)\s+(?:by|علي)\s+(.+)$/iu, operator: '/' },
  { match: /^(?:multiply|اضرب|ضرب(?:نا|ت)|نضرب)[\s:،]+(.+?)\s+(?:by|في)\s+(.+)$/iu, operator: '*' },
  { match: /^(?:add|اجمع|اضف|جمع(?:نا|ت)|نجمع|اضفنا|نضيف)[\s:،]+(.+?)\s+(?:to|and|الي|مع)\s+(.+)$/iu, operator: '+' },
] as const;

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const TOKEN = /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[()+*/^%\-]|\p{L}+(?:(?:\s+|-)\p{L}+)*/giu;

function directedExpression(input: string): string {
  for (const rule of OPERAND_COMMANDS) {
    const match = rule.match.exec(input);
    if (!match) continue;
    const [, first, second] = match;
    const [left, right] = 'reverse' in rule ? [second, first] : [first, second];
    return `(${left}) ${rule.operator} (${right})`;
  }
  return input;
}

function replaceSpokenNumbers(expression: string): string | null {
  const parts = [...expression.matchAll(TOKEN)];
  if (!parts.length || parts.map(part => part[0].replace(/\s+/gu, '')).join('') !== expression.replace(/\s+/gu, '')) return null;
  if (!parts.some(part => /^\p{L}/u.test(part[0]))) return expression;
  if (!parts.some(part => /^[+*/^%\-]$/u.test(part[0]))) return null;

  let previousNumber = false;
  const parsed: string[] = [];
  for (const [token] of parts) {
    const spoken = /^\p{L}/u.test(token);
    const number = spoken || DECIMAL.test(token);
    if (number && previousNumber) return null;
    const value = spoken ? parseNumberWords(token, /\p{Script=Arabic}/u.test(token) ? 'ar' : 'en') : token;
    if (value === null) return null;
    parsed.push(value);
    previousNumber = number;
  }
  return parsed.join(' ').replace(/\(\s+/gu, '(').replace(/\s+\)/gu, ')');
}

/** Converts one complete arithmetic clause to the numeric parser's input. */
export function arithmeticExpression(input: string): string | null {
  const conditional = CONDITIONAL.exec(input);
  const math = (conditional?.[1] ?? input).replace(INTRO, '').replace(RESULT_HEAD, '');
  if (/\b0(?:x[0-9a-f]+|b[01]+|o[0-7]+)\b/iu.test(math)) return null;
  const expression = directedExpression(math)
    .replace(/\b(?:percent|per cent|pct)\b|(?<!\p{L})(?:بال|في\s+ال)م(?:ا?ئ[ةه]|ي[ةه])(?!\p{L})/giu, '%')
    .replace(/%\s*(?:of\b|من(?!\p{L}))/giu, '% *')
    .replace(/\b(?:divided by|over)\b|(?<!\p{L})(?:مقسوم(?:ا|ة|ه)?\s+علي|قسم[ةه](?:\s+علي(?!\p{L}))?|تقسيم)(?!\p{L})/giu, '/')
    .replace(/\b(?:times|multiplied by)\b|(?<!\p{L})(?:مضروب(?:ا|ة|ه)?\s+في|ضرب(?:\s+في(?!\p{L}))?)(?!\p{L})|(?<=\d)\s*[xX]\s*(?=\d)|[×·]/giu, '*')
    .replace(/\bplus\b|(?<!\p{L})(?:زائد|زايد|جمع)(?!\p{L})/giu, '+')
    .replace(/\bminus\b|(?<!\p{L})(?:ناقص|طرح)(?!\p{L})/giu, '-')
    .replace(/÷/gu, '/').trim();
  return replaceSpokenNumbers(expression);
}
