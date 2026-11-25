import type { DevelopmentCase } from './reasoning-development.js';

/** Deterministic development checks from templates and fixed arithmetic references. No model calls or training use. */
type Values = readonly [number, number, number];
type Wording = (first: number, second: number) => string;
const digits = (number: number) => String(number).replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]!);
const faDigits = (number: number) => String(number).replace(/\d/gu, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!);

function cases(id: string, values: readonly Values[], english: Wording, arabic: Wording): DevelopmentCase[] {
  return values.flatMap(([first, second, expected], index) =>
    ([['en', english], ['ar', arabic]] as const).map(([language, wording]) => ({
      id: `word-problem-${id}-${language}-${index + 1}`,
      category: 'word-problem' as const,
      request: wording(first, second),
      expected: String(expected),
    })));
}

function example(id: string, request: string, expected: string | null): DevelopmentCase {
  return { id: `word-problem-${id}`, category: 'word-problem', request, expected };
}

export const wordProblemCases: readonly DevelopmentCase[] = [
  ...cases('distance', [[48, 2, 96], [80, 4, 320], [50, 1.5, 75], [4.5, 3, 13.5]],
    (x, y) => `A bike travels at ${x} km/h for ${y} hours. How far will it go?`,
    (x, y) => `سيارة تسير بسرعة ${digits(x)} كم/ساعة لمدة ${digits(y)} ساعات، كم تقطع؟`),
  ...cases('minutes-to-distance', [[54, 40, 36], [72, 15, 18], [30, 90, 45]],
    (x, y) => `The car drives at ${x} kilometers per hour for ${y} minutes, how far does it travel?`,
    (x, y) => `العربية ماشية بسرعة ${faDigits(x)} كم في الساعة لمدة ${faDigits(y)} دقيقة، هتمشي قد إيه؟`),
  ...cases('speed', [[158, 2, 79], [126, 3, 42], [92, 4, 23]],
    (x, y) => `The train travels ${x} km in ${y} hours. What is its average speed?`,
    (x, y) => `قطار يقطع ${digits(x)} كيلومتر خلال ${digits(y)} ساعات، ما هو متوسط السرعة؟`),
  ...cases('duration', [[360, 90, 4], [210, 84, 2.5], [167.5, 67, 2.5]],
    (x, y) => `How long will it take to drive ${x} kilometers at ${y} km/h?`,
    (x, y) => `كم يستغرق لقطع ${digits(x)} كيلومتر بسرعة ${digits(y)} كم/ساعة؟`),
  ...cases('cost', [[3, 7, 21], [12, 2.5, 30], [4, 9.15, 36.6], [7, 4.25, 29.75]],
    (x, y) => `I bought ${x} books at ${y} dollars each. What was the total cost?`,
    (x, y) => `شريت ${digits(x)} كتب بسعر ${digits(y)} ريالات للواحد، كم دفعت؟`),
  ...cases('production', [[24, 3, 72], [11, 6, 66], [28, 2.5, 70]],
    (x, y) => `A printer prints ${x} pages per hour. How many pages will it print in ${y} hours?`,
    (x, y) => `طابعة تطبع ${digits(x)} صفحة كل ساعة، كم صفحة تطبع خلال ${digits(y)} ساعات؟`),
  ...cases('sum', [[13, 8, 21], [95, 5, 100], [35, 19, 54], [16, 23, 39]],
    (x, y) => `I have ${x} apples and buy ${y} more. How many do I have now?`,
    (x, y) => `معايا ${digits(x)} تفاحة وجبت ${digits(y)} كمان، كام معايا دلوقتي؟`),
  ...cases('remaining', [[34, 9, 25], [222, 19, 203], [67, 36, 31], [8, 8, 0]],
    (x, y) => `I had ${x} stickers and gave away ${y}. How many are left?`,
    (x, y) => `عندي ${digits(x)} كتاب وبعت ${digits(y)} منها، قديش ضل معي؟`),
  ...cases('discount', [[96, 25, 72], [80, 37.5, 50], [250, 12, 220], [150, 20, 120]],
    (x, y) => `A jacket costs ${x} dollars. It is discounted by ${y}%. What is the sale price?`,
    (x, y) => `سعر كتاب ${digits(x)} جنيه، عليه خصم ${digits(y)}٪، كام سعره دلوقتي؟`),
  ...cases('increase', [[48, 25, 60], [36, 50, 54], [75, 20, 90]],
    (x, y) => `The ticket costs ${x} euros. Its price rises by ${y}%. What is the new price?`,
    (x, y) => `سعر التذكرة ${digits(x)} يورو، ارتفع السعر بنسبة ${digits(y)} بالمئة، كم صار السعر؟`),
  ...cases('percent-count', [[25, 80, 20], [60, 25, 15], [72, 62.5, 45]],
    (x, y) => `Out of ${x} students, ${y}% passed. How many students passed?`,
    (x, y) => `في الصف ${digits(x)} طالب، ${digits(y)}٪ منهم نجحوا، كم طالب نجح؟`),
  ...cases('percent-share', [[27, 18, 66.6666666666667], [80, 20, 25], [48, 6, 12.5]],
    (x, y) => `There were ${x} students. ${y} of them attended. What percentage of them attended?`,
    (x, y) => `في الفصل ${digits(x)} طالب، حضر ${digits(y)} منهم، ما هي نسبة الحاضرين؟`),
  ...cases('age-future', [[12, 4, 16], [25, 30, 55], [43, 18, 61]],
    (x, y) => `Omar is ${x} years old. How old will he be in ${y} years?`,
    (x, y) => `عمر عمره ${digits(x)} سنة، شكد يصير عمره بعد ${digits(y)} سنوات؟`),
  ...cases('age-past', [[38, 9, 29], [55, 24, 31], [21, 6, 15]],
    (x, y) => `Lena is ${x} years old. How old was she ${y} years ago?`,
    (x, y) => `ليلى عمرها ${digits(x)} سنة، أديش كان عمرها قبل ${digits(y)} سنين؟`),
  ...cases('age-ratio', [[3, 48, 12], [4, 55, 11], [2, 81, 27]],
    (x, y) => `A father is ${x} times as old as his son. Their ages add up to ${y} years. How old is the son?`,
    (x, y) => `عمر الأب ${digits(x)} أضعاف عمر ابنه، مجموع عمريهما ${digits(y)} سنة، كم عمر الابن؟`),
  ...cases('workers', [[3, 12, 6], [12, 3, 6], [6, 9, 9]],
    (x, y) => `${x} workers take ${y} hours to finish a job. How long will 6 workers take at the same rate?`,
    (x, y) => `${digits(x)} عمال ينجزون العمل في ${digits(y)} ساعات، كم يحتاج ٦ عمال بنفس المعدل؟`),
  ...cases('combined-work', [[3, 6, 2], [12, 4, 3], [10, 15, 6], [6, 4, 2.4]],
    (x, y) => `Alice can finish a job in ${x} hours and Bob can finish it in ${y} hours. How long will they take together?`,
    (x, y) => `عامل يخلص الشغل في ${digits(x)} ساعات، وعامل ثاني يخلصه في ${digits(y)} ساعات، كم يحتاجوا مع بعض؟`),
  example('written-operands-en', 'Each battery costs two and a half dollars. How much do six batteries cost?', '15'),
  example('written-operands-ar', 'شريت ثلاثة كتب بسعر خمسة ريالات للواحد، كم دفعت؟', '15'),
  example('mixed-work-units', 'Alice can paint a room in 120 minutes. Bob can paint the same room in 6 hours. How long will it take them together?', '1.5'),
  example('age-difference-en', 'Nadia is 31 years old and Felix is 28 years old. How many years older is Nadia than Felix?', '3'),
  example('age-difference-ar', 'نادية عمرها ٣١ سنة، وفهد عمره ٢٨ سنة، كم سنة يزيد عمر نادية عن عمر فهد؟', '3'),
  example('age-order-en', 'Nadia is 7 years older than Felix. Felix is 19. How old is Nadia?', '26'),
  example('age-order-ar', 'نادية أكبر من فهد بـ٧ سنوات، عمر فهد ١٩، كم عمر نادية؟', '26'),
  example('discount-impossible', 'سعر الكتاب ٨٠ ريال، عليه خصم ١٢٠٪، كم صار السعر؟', null),
  example('zero-divisor', 'A train travels 120 km in 0 hours. What is its speed?', null),
  example('mismatched-work-unit', 'How long will it take to drive 210 km at 84 mi/h?', null),
  example('negative-remaining', 'I had 4 stickers and gave away 7. How many are left?', null),
  example('fractional-people', 'Out of 9 students, 25% passed. How many students passed?', null),
];
