import { operation, quantity, type WordExpression } from './word-problem-graph.js';
import { parseNumber } from './word-problem-quantities.js';

const word = String.raw`([\p{Script=Arabic}]+)`;
const time = String.raw`(ثوان|ثانية|دقائق|دقيقة|ساعات|ساعة|أيام|ايام|يوم|أسابيع|اسابيع|أسبوع|اسبوع|شهر|أشهر|اشهر)`;
const amount = String.raw`(\d+(?:\.\d+)?(?:/\d+)?)`;
const pattern = (source: string) => new RegExp(`^${source}$`, 'u');
const timeForms: Readonly<Record<string, string>> = {
  ثوان: 'ثانية', دقائق: 'دقيقة', ساعات: 'ساعة', ايام: 'يوم', اسابيع: 'اسبوع', اشهر: 'شهر',
};

function unit(text: string): string {
  const key = text.replace(/[أإآ]/gu, 'ا').replace(/^ال/u, '');
  return timeForms[key] ?? key;
}

function value(text: string): WordExpression | null {
  const number = parseNumber(text);
  return number === null ? null : quantity(number);
}

const arabicVerb = String.raw`(ينتج|تنتج|يصنع|تصنع|يقرأ|تقرأ|يطبع|تطبع|يجمع|تجمع)`;
const rateTail = String.raw`${amount} ${word} (?:في كل|كل|في) ${time}`;
const subjectFirst = pattern(String.raw`\p{Script=Arabic}+ ${arabicVerb} ${rateTail}`);
const verbFirst = pattern(String.raw`${arabicVerb} \p{Script=Arabic}+ ${rateTail}`);
const rateQuestion = pattern(String.raw`كم ${word} (سينتج|ستنتج|سيصنع|ستصنع|سيقرأ|ستقرأ|سيطبع|ستطبع|سيجمع|ستجمع|ينتج|تنتج|يصنع|تصنع|يقرأ|تقرأ|يطبع|تطبع|يجمع|تجمع) (?:في|خلال|على مدى) ${amount} ${time}`);
const stock = pattern(String.raw`(?:لدى|مع|عند) ${word} ${amount} ${word}`);
const transfer = pattern(String.raw`(?:ثم )?(أعطى|اعطى|أعطت|اعطت|باع|باعت|اشترى|اشترت|أضاف|اضاف|أضافت|اضافت) ${word} ${amount} (?:منها|منه|${word})`);
const stockQuestion = pattern(String.raw`كم (?:بقي|تبقى|أصبح|اصبح) (?:من ${word} )?(?:لدى|مع|عند) ${word}`);

export function parseArabicWordProblem(statements: readonly string[], question: string): WordExpression | null {
  if (statements.length === 1) {
    const given = subjectFirst.exec(statements[0]!) ?? verbFirst.exec(statements[0]!);
    const asked = rateQuestion.exec(question);
    if (!given || !asked || given[1] !== asked[2]!.replace(/^س/u, '')
      || unit(given[3]!) !== unit(asked[1]!) || unit(given[4]!) !== unit(asked[4]!)) return null;
    const output = value(given[2]!);
    const periods = value(asked[3]!);
    return output && periods ? operation('*', output, periods) : null;
  }
  if (statements.length !== 2) return null;
  const given = stock.exec(statements[0]!);
  const event = transfer.exec(statements[1]!);
  const asked = stockQuestion.exec(question);
  if (!given || !event || !asked || given[1] !== event[2] || given[1] !== asked[2]
    || event[4] && unit(given[3]!) !== unit(event[4]) || asked[1] && unit(given[3]!) !== unit(asked[1])) return null;
  const initial = value(given[2]!);
  const change = value(event[3]!);
  const added = /^(?:اشتر|[أا]ضاف)/u.test(event[1]!);
  return initial && change ? operation(added ? '+' : '-', initial, change) : null;
}
