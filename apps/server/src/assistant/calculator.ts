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
  [/زائد|زايد|(?<![eE])\+|plus|and\s+(?=[\d(])/giu, ' + '],
  [/ناقص|minus|less/giu, ' - '],
  [/أس|اس|to\s+the\s+power\s+of|power/giu, ' ^ '],
  [/[×x✕]/gu, ' * '], [/[÷]/gu, ' / '], [/[−–]/gu, ' - '],
];
/** Lead-in and trailing words around the sum, in both languages. */
const LEAD = /^(?:كم|قديش|اديش|ايش|شو|ما|ماذا|احسب|أحسب|حل|يساوي|تساوي|ناتج|حاصل|نتيجة|what(?:'s| is)?|whats|how much is|calculate|compute|solve|is|equals?)\s+/iu;
const TAIL = /\s*(?:=|يساوي|تساوي|كم|\?|؟|\.|!)+\s*$/u;
const THOUSANDS = /(?<![\d.,٬٫])\d{1,3}(?:(?:,\d{3})+|(?:٬\d{3})+)(?!\d|[,٬]\d)/gu;

export type ArithmeticError = 'syntax' | 'division_by_zero' | 'range' | 'domain' | 'complexity';
type Evaluation<Value> = { ok: true; value: Value } | { ok: false; error: ArithmeticError };
export type ArithmeticEvaluation = Evaluation<number>;
export interface Calculation {
  expression: string;
  /** Non-finite when error is present, preserving the existing numeric boundary. */
  value: number;
  lang: 'ar' | 'en';
  error?: Exclude<ArithmeticError, 'syntax'>;
}

function normalise(text: string): string {
  let s = text.normalize('NFC').trim();
  s = s.replace(/[٠-٩]/gu, d => String(ARABIC_DIGITS.indexOf(d))).replace(/[۰-۹]/gu, d => String(PERSIAN_DIGITS.indexOf(d)));
  s = s.replace(THOUSANDS, group => group.replace(/[,٬]/gu, '')).replace(/٫/gu, '.');
  for (let round = 0; round < 3; round++) s = s.replace(LEAD, '');
  s = s.replace(TAIL, '');
  for (const [pattern, symbol] of WORDS) s = s.replace(pattern, symbol);
  return s.replace(/\s+/g, ' ').trim();
}

type NumberToken = { kind: 'num'; literal: string };
type Token = NumberToken | { kind: 'op'; value: string };
const MAX_EXPRESSION_LENGTH = 4096;
const MAX_TOKENS = 512;
const MAX_OPERATIONS = 256;
const MAX_NESTING = 64;
type BinaryOperator = '+' | '-' | '*' | '/' | '^';
type UnaryOperator = 'positive' | 'negative' | 'percent';
type Operator = BinaryOperator | Exclude<UnaryOperator, 'percent'>;
type Instruction = NumberToken | { kind: 'op'; value: BinaryOperator | UnaryOperator };
type ArithmeticOptions = { allowPercent?: boolean };

export interface ArithmeticStep {
  left: number;
  operator: BinaryOperator;
  right: number;
  value: number;
}
interface ArithmeticDomain<Value> {
  literal(literal: string): Value;
  unary(operator: UnaryOperator, operand: Value): Value;
  binary(operator: BinaryOperator, left: Value, right: Value): Value;
}
const PRECEDENCE: Record<Operator, number> = { '+': 0, '-': 0, '*': 1, '/': 1, positive: 2, negative: 2, '^': 3 };
class ArithmeticFailure extends Error {
  constructor(readonly kind: ArithmeticError) { super(kind); }
}

function safeNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new ArithmeticFailure('range');
  return value;
}

function tokens(s: string): Token[] | null {
  const out: Token[] = [];
  const re = /\s*(?:((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)|([-+*/^()%]))/giy;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return /^\s*$/.test(s.slice(at)) ? out : null;
    if (out.length >= MAX_TOKENS) throw new ArithmeticFailure('complexity');
    if (m[1] !== undefined) out.push({ kind: 'num', literal: m[1] });
    else out.push({ kind: 'op', value: m[2] });
    at = re.lastIndex;
  }
  return out;
}

/**
 * Iterative shunting-yard parser shared by local arithmetic callers. Exponent
 * binds more tightly than a leading sign and associates to the right, while a
 * sign on its right is still allowed: -3^2 = -9 and 2^-2 = 0.25.
 * Input is numeric notation only; no language rewriting or code evaluation.
 */
function evaluateExpression<Value>(expression: string, options: ArithmeticOptions, domain: ArithmeticDomain<Value>): Evaluation<Value> {
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION_LENGTH) return { ok: false, error: 'complexity' };
  try {
    const list = tokens(expression);
    if (!list?.length) return { ok: false, error: 'syntax' };
    const operators: (Operator | '(')[] = [];
    const instructions: Instruction[] = [];
    let needsOperand = true, nesting = 0, operations = 0;
    const emit = (operator: Operator | 'percent') => {
      if (++operations > MAX_OPERATIONS) throw new ArithmeticFailure('complexity');
      instructions.push({ kind: 'op', value: operator });
    };
    for (const token of list) {
      if (token.kind === 'num') {
        if (!needsOperand) throw new ArithmeticFailure('syntax');
        instructions.push(token);
        needsOperand = false;
      } else if (token.value === '(' && needsOperand) {
        if (++nesting > MAX_NESTING) throw new ArithmeticFailure('complexity');
        operators.push('(');
      } else if (token.value === ')' && !needsOperand) {
        while (operators.length && operators.at(-1) !== '(') emit(operators.pop() as Operator);
        if (operators.pop() !== '(') throw new ArithmeticFailure('syntax');
        nesting--;
      } else if (token.value === '%' && !needsOperand && options.allowPercent) {
        emit('percent');
      } else if ((token.value === '+' || token.value === '-') && needsOperand) {
        operators.push(token.value === '+' ? 'positive' : 'negative');
      } else if (Object.hasOwn(PRECEDENCE, token.value) && !needsOperand) {
        const next = token.value as Operator;
        for (let top = operators.at(-1); top && top !== '('; top = operators.at(-1)) {
          if (PRECEDENCE[top] < PRECEDENCE[next] || (PRECEDENCE[top] === PRECEDENCE[next] && next === '^')) break;
          emit(operators.pop() as Operator);
        }
        operators.push(next);
        needsOperand = true;
      } else throw new ArithmeticFailure('syntax');
    }
    if (needsOperand || nesting !== 0) throw new ArithmeticFailure('syntax');
    for (let operator = operators.pop(); operator; operator = operators.pop()) {
      if (operator === '(') throw new ArithmeticFailure('syntax');
      emit(operator);
    }
    // Validate the entire grammar before calculating. An early division/range
    // error must not disguise a malformed suffix as a valid arithmetic request.
    const operands: Value[] = [];
    for (const instruction of instructions) {
      if (instruction.kind === 'num') {
        operands.push(domain.literal(instruction.literal));
        continue;
      }
      const operator = instruction.value;
      const right = operands.pop();
      if (right === undefined) throw new ArithmeticFailure('syntax');
      if (operator === 'positive' || operator === 'negative' || operator === 'percent') {
        operands.push(domain.unary(operator, right));
      } else {
        const left = operands.pop();
        if (left === undefined) throw new ArithmeticFailure('syntax');
        operands.push(domain.binary(operator, left, right));
      }
    }
    if (operands.length !== 1) throw new ArithmeticFailure('syntax');
    return { ok: true, value: operands[0] };
  } catch (error) {
    if (error instanceof ArithmeticFailure) return { ok: false, error: error.kind };
    throw error;
  }
}

const numericDomain = (steps: ArithmeticStep[] | undefined): ArithmeticDomain<number> => ({
  literal(literal) {
    const value = safeNumber(Number(literal));
    if (value === 0 && /[1-9]/u.test(literal.split(/e/iu)[0])) throw new ArithmeticFailure('range');
    return value;
  },
  unary(operator, operand) {
    if (operator === 'positive') return operand;
    if (operator === 'negative') return -operand;
    const result = operand / 100;
    if (result === 0 && operand !== 0) throw new ArithmeticFailure('range');
    steps?.push({ left: operand, operator: '/', right: 100, value: result });
    return result;
  },
  binary(operator, left, right) {
    if ((operator === '/' && right === 0) || (operator === '^' && left === 0 && right < 0)) throw new ArithmeticFailure('division_by_zero');
    const result = operator === '+' ? left + right : operator === '-' ? left - right
      : operator === '*' ? left * right : operator === '/' ? left / right : left ** right;
    if (Number.isNaN(result)) throw new ArithmeticFailure('domain');
    if (result === 0 && ((operator === '*' && left !== 0 && right !== 0)
        || (operator === '/' && left !== 0) || (operator === '^' && left !== 0))) throw new ArithmeticFailure('range');
    safeNumber(result);
    steps?.push({ left, operator, right, value: result });
    return result;
  },
});

export function evaluateArithmeticExpression(expression: string, options: ArithmeticOptions & { steps?: ArithmeticStep[] } = {}): ArithmeticEvaluation {
  return evaluateExpression(expression, options, numericDomain(options.steps));
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

const MAX_RATIONAL_BITS = 1024;
const absolute = (value: bigint) => value < 0n ? -value : value;
const bitLength = (value: bigint) => absolute(value).toString(2).length;

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new ArithmeticFailure('division_by_zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let divisor = denominator;
  let remainder = absolute(numerator) % divisor;
  while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
  numerator /= divisor;
  denominator /= divisor;
  if (bitLength(numerator) > MAX_RATIONAL_BITS || bitLength(denominator) > MAX_RATIONAL_BITS) throw new ArithmeticFailure('range');
  return { numerator, denominator };
}

const rationalDomain: ArithmeticDomain<Rational> = {
  literal(literal) {
    const [mantissa, exponentText = '0'] = literal.split(/e/iu);
    const exponent = Number(exponentText);
    const [whole, decimals = ''] = mantissa.split('.');
    if (Math.abs(exponent) > MAX_RATIONAL_BITS) throw new ArithmeticFailure('range');
    const scale = decimals.length - exponent;
    const numerator = BigInt(whole + decimals);
    return scale < 0 ? rational(numerator * 10n ** BigInt(-scale), 1n) : rational(numerator, 10n ** BigInt(scale));
  },
  unary(operator, operand) {
    if (operator === 'positive') return operand;
    if (operator === 'negative') return { ...operand, numerator: -operand.numerator };
    return rational(operand.numerator, operand.denominator * 100n);
  },
  binary(operator, left, right) {
    const { numerator: a, denominator: b } = left;
    const { numerator: c, denominator: d } = right;
    switch (operator) {
      case '+': return rational(a * d + b * c, b * d);
      case '-': return rational(a * d - b * c, b * d);
      case '*': return rational(a * c, b * d);
      case '/': return rational(a * d, b * c);
      case '^': {
        if (d !== 1n) throw new ArithmeticFailure('domain');
        const exponent = absolute(c);
        const baseBits = Math.max(bitLength(a), bitLength(b));
        if (exponent > BigInt(MAX_RATIONAL_BITS) || BigInt(baseBits - 1) * exponent >= BigInt(MAX_RATIONAL_BITS)) {
          throw new ArithmeticFailure('range');
        }
        return c < 0n ? rational(b ** exponent, a ** exponent) : rational(a ** exponent, b ** exponent);
      }
    }
  },
};

function displayRational({ numerator, denominator }: Rational): string {
  if (denominator === 1n) return numerator.toString();
  let remainder = denominator;
  let twos = 0;
  let fives = 0;
  while (remainder % 2n === 0n) { remainder /= 2n; twos++; }
  while (remainder % 5n === 0n) { remainder /= 5n; fives++; }
  if (remainder !== 1n) return `${numerator}/${denominator}`;
  const places = Math.max(twos, fives);
  const scaled = absolute(numerator) * (10n ** BigInt(places) / denominator);
  const digits = scaled.toString().padStart(places + 1, '0');
  return `${numerator < 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** Exact numeric notation with bounded rational intermediates and integer powers. */
export function evaluateExactArithmeticExpression(expression: string, options: ArithmeticOptions = {}): Evaluation<string> {
  const result = evaluateExpression(expression, options, rationalDomain);
  return result.ok ? { ok: true, value: displayRational(result.value) } : result;
}

/** A plain calculation in the request, or null. At least one operator between two numbers is required. */
export function calculate(request: string): Calculation | null {
  if (!request || request.length > 160) return null;
  // Numeric code literals are unsupported. In particular, do not silently
  // rewrite a hexadecimal prefix into the ordinary multiplication letter x.
  if (/\b0(?:x[0-9a-f]+|b[01]+|o[0-7]+)\b/iu.test(request)) return null;
  const expression = normalise(request);
  if (!/^[\deE\s.+\-*/^()]+$/.test(expression) || !/[-+*/^]/u.test(expression)) return null;
  // Scientific exponent signs and a single leading minus are not binary sums.
  const numbers = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/giu);
  if (!numbers || numbers.length < 2) return null;
  const result = evaluateArithmeticExpression(expression);
  const common = { expression, lang: /[؀-ۿ]/u.test(request) ? 'ar' as const : 'en' as const };
  if (result.ok) return { ...common, value: result.value };
  if (result.error === 'syntax') return null;
  return { ...common, value: Number.NaN, error: result.error };
}

const pretty = (expression: string) => expression.replace(/\*/g, '×').replace(/\//g, '÷').replace(/(?<![eE])\s*([-+×÷^])\s*/g, ' $1 ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value !== 0 && Math.abs(value) < 1e-6) return Number(value.toPrecision(11)).toString();
  return Math.abs(value) >= 1e15 ? value.toExponential() : value.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** The answer, shown with the expression it read, so a misread is visible at once. */
export function calculationReply(calc: Calculation): string {
  const error = calc.error ?? (!Number.isFinite(calc.value) ? 'range' : undefined);
  if (error) {
    const messages: Record<Exclude<ArithmeticError, 'syntax'>, { ar: string; en: string }> = {
      division_by_zero: { ar: 'القسمة على صفر غير معرّفة.', en: 'division by zero is undefined.' },
      range: { ar: 'النتيجة خارج نطاق الأعداد الذي يمكن تمثيله بدقة كافية.', en: 'the result exceeds the number range that can be represented reliably.' },
      domain: { ar: 'التعبير خارج نطاق الحساب بالأعداد الحقيقية المدعوم.', en: 'the expression is outside the supported real-number domain.' },
      complexity: { ar: 'التعبير يتجاوز حدود تعقيد الحساب المدعومة.', en: 'the expression exceeds the supported calculation complexity.' },
    };
    return calc.lang === 'ar' ? `لا يمكن حساب ${pretty(calc.expression)}: ${messages[error].ar}` : `${pretty(calc.expression)} cannot be computed: ${messages[error].en}`;
  }
  return `${pretty(calc.expression)} = **${format(calc.value)}**`;
}
