/**
 * Arithmetic without a model: «كم يساوي 15 ضرب 23؟», «what is (3+4)*2», «٢٠ قسمة على ٤».
 * The request is turned into + - * / ^ and parentheses, then read by a small parser; nothing is ever passed to
 * eval. Anything that is not a plain calculation returns null and the request goes on as before.
 */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const WORDS: [RegExp, string][] = [
  [/قسم[ةه]?\s+على|تقسيم|مقسوم(?:ة|ه)?\s+على|divided\s+by|over/giu, ' / '],
  [/ضرب|مضروب(?:ة|ه)?\s+في|في\s+(?=[\d(])|times|multiplied\s+by/giu, ' * '],
  [/زائد|زايد|\+|plus|and\s+(?=[\d(])/giu, ' + '],
  [/ناقص|minus|less/giu, ' - '],
  [/أس|اس|to\s+the\s+power\s+of|power/giu, ' ^ '],
  [/[×x✕]/gu, ' * '], [/[÷]/gu, ' / '], [/[−–]/gu, ' - '],
];
/** Lead-in and trailing words around the sum, in both languages. */
const LEAD = /^(?:كم|قديش|اديش|ايش|شو|ما|ماذا|احسب|أحسب|حل|يساوي|تساوي|ناتج|حاصل|نتيجة|what(?:'s| is)?|whats|how much is|calculate|compute|solve|is|equals?)\s+/iu;
const TAIL = /\s*(?:=|يساوي|تساوي|كم|\?|؟|\.|!)+\s*$/u;

export interface Calculation { expression: string; value: number; lang: 'ar' | 'en' }

function normalise(text: string): string {
  let s = text.normalize('NFC').trim();
  s = s.replace(/[٠-٩]/gu, d => String(ARABIC_DIGITS.indexOf(d))).replace(/[۰-۹]/gu, d => String(PERSIAN_DIGITS.indexOf(d)));
  s = s.replace(/(\d)٫(\d)/gu, '$1.$2').replace(/(\d),(\d{3})(?!\d)/gu, '$1$2').replace(/٬/gu, '');
  for (let round = 0; round < 3; round++) s = s.replace(LEAD, '');
  s = s.replace(TAIL, '');
  for (const [pattern, symbol] of WORDS) s = s.replace(pattern, symbol);
  return s.replace(/\s+/g, ' ').trim();
}

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string };

function tokens(s: string): Token[] | null {
  const out: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([-+*/^()]))/gy;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return /^\s*$/.test(s.slice(at)) ? out : null;
    out.push(m[1] !== undefined ? { kind: 'num', value: Number(m[1]) } : { kind: 'op', value: m[2] });
    at = re.lastIndex;
  }
  return out;
}

/** Recursive descent: expr = term (+|- term)*, term = power (*|/ power)*, power = unary (^ power)?, unary = -unary | atom. */
function parse(list: Token[]): number | null {
  let i = 0;
  const peek = () => list[i];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()!.value === value;
  const atom = (): number | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === 'num') { i++; return t.value; }
    if (t.value === '(') {
      i++;
      const v = expr();
      if (v === null || !isOp(')')) return null;
      i++;
      return v;
    }
    return null;
  };
  const unary = (): number | null => {
    if (isOp('-')) { i++; const v = unary(); return v === null ? null : -v; }
    if (isOp('+')) { i++; return unary(); }
    return atom();
  };
  const power = (): number | null => {
    const base = unary();
    if (base === null) return null;
    if (isOp('^')) { i++; const exp = power(); return exp === null ? null : base ** exp; }
    return base;
  };
  const term = (): number | null => {
    let v = power();
    while (v !== null && (isOp('*') || isOp('/'))) {
      const op = list[i++].value;
      const r = power();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v !== null && (isOp('+') || isOp('-'))) {
      const op = list[i++].value;
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const value = expr();
  return value !== null && i === list.length ? value : null;
}

/** A plain calculation in the request, or null. At least one operator between two numbers is required. */
export function calculate(request: string): Calculation | null {
  if (!request || request.length > 160) return null;
  const expression = normalise(request);
  if (!/^[\d\s.+\-*/^()]+$/.test(expression) || !/\d\s*[-+*/^]\s*[\d(-]|\)\s*[-+*/^]/.test(expression)) return null;
  const list = tokens(expression);
  if (!list?.length) return null;
  const value = parse(list);
  if (value === null || Number.isNaN(value)) return null;
  return { expression, value, lang: /[؀-ۿ]/u.test(request) ? 'ar' : 'en' };
}

const pretty = (expression: string) => expression.replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s*([-+×÷^])\s*/g, ' $1 ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 1e10) / 1e10;
  return Math.abs(rounded) >= 1e15 ? rounded.toExponential(6) : rounded.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** The answer, shown with the expression it read, so a misread is visible at once. */
export function calculationReply(calc: Calculation): string {
  if (!Number.isFinite(calc.value)) return calc.lang === 'ar' ? `لا يمكن حساب ${pretty(calc.expression)}: القسمة على صفر غير معرّفة.` : `${pretty(calc.expression)} cannot be computed: division by zero is undefined.`;
  return `${pretty(calc.expression)} = **${format(calc.value)}**`;
}
