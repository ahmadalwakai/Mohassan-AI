import { evaluateArithmeticExpression } from '../calculator.js';
import { resolveComputationUnit } from '../mind/compute.js';
import type { Lang } from '../mind/contract.js';
import { normalizeRequest, stripCourtesyTail } from '../mind/normalize.js';
import { parseNumberWords } from './number-words.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

type Bilingual = readonly [string, string];
type Equation = {
  label: Bilingual;
  expression: string;
  unit?: Bilingual | string;
  whole?: boolean;
  nonnegative?: boolean;
};
type Problem = readonly Equation[] | 'invalid' | null;
type Grammar = { pattern: RegExp; equations: (...parts: string[]) => Problem };

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const QUANTITY = String.raw`(${NUMBER}|\p{L}+(?:[ -]\p{L}+){0,9}?)`;
const BREAK = String.raw`(?: *[,،.!;؛] *| +)`;
const ITEM = String.raw`[\p{L}]{1,30}(?:[ -][\p{L}]{1,30})?`;
const NAME = String.raw`\p{L}{1,30}`;
const TIME_EN = '(hours?|hrs?|minutes?|mins?|seconds?|secs?|days?)';
const TIME_AR = '(ساعه|ساعات|دقيقه|دقائق|ثانيه|ثواني?|يوم|ايام)';
const DISTANCE_EN = '(km|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?)';
const DISTANCE_AR = '(كم|كيلو متر(?:ات)?|كيلومتر(?:ات)?|متر(?:ا)?|امتار|ميل|اميال)';
const PER_HOUR_EN = String.raw`(?: */ *h(?:r)?| per hour| an hour)`;
const PER_HOUR_AR = String.raw`(?: */ *(?:س|ساعه)| في الساعه| بالساعه)`;
const PERCENT = String.raw` *(?:%|per ?cent|بالمئه|بالميه|بالمائه|في المئه|في المائه)`;
const MONEY_EN = '(dollars?|usd|pounds?|gbp|euros?|eur|riyals?|sar|dirhams?|aed|egp|[$€£])';
const MONEY_AR = '(ريال(?:ا|ات)?|دولار(?:ا|ات)?|درهم(?:ا)?|دراهم|جنيه(?:ا|ات)?|يورو|usd|sar|aed|egp|eur|[$€£])';
const HOW_MANY_AR = '(?:كم|قديش|اديش|كام|شكد)';
const YEARS_AR = '(?:سنه|سنوات|سنين|عام(?:ا)?|اعوام)';
const AGE_AR = String.raw`(${NAME}) عمر(?:ه|ها) ${QUANTITY}(?: ${YEARS_AR})?`;
const AGE_PREFIX_AR = String.raw`عمر (${NAME}) ${QUANTITY}(?: ${YEARS_AR})?`;

const HOURS = ['ساعة', 'hours'] as const;
const YEARS = ['سنة', 'years'] as const;
const LABEL = {
  distance: ['المسافة = السرعة × الزمن', 'Distance = speed × time'],
  speed: ['السرعة = المسافة ÷ الزمن', 'Speed = distance ÷ time'],
  duration: ['الزمن = المسافة ÷ السرعة', 'Time = distance ÷ speed'],
  hours: ['تحويل الزمن إلى ساعات', 'Convert the time to hours'],
  cost: ['التكلفة = العدد × سعر الوحدة', 'Cost = quantity × unit price'],
  count: ['العدد = المعدل × الزمن', 'Quantity = rate × time'],
  sum: ['المجموع = العدد الأصلي + العدد المضاف', 'Total = initial quantity + quantity added'],
  left: ['الباقي = العدد الأصلي − العدد المزال', 'Remaining = initial quantity − quantity removed'],
  percent: ['الجزء = الكل × النسبة ÷ 100', 'Part = whole × percentage ÷ 100'],
  discount: ['السعر بعد الخصم = السعر الأصلي − الخصم', 'Sale price = original price − discount'],
  increase: ['السعر بعد الزيادة = السعر الأصلي + الزيادة', 'New price = original price + increase'],
  share: ['النسبة المئوية = الجزء ÷ الكل × 100', 'Percentage = part ÷ whole × 100'],
  ageFuture: ['العمر لاحقًا = العمر الحالي + السنوات', 'Future age = current age + years'],
  agePast: ['العمر سابقًا = العمر الحالي − السنوات', 'Past age = current age − years'],
  ageOlder: ['عمر الأكبر = عمر الأصغر + الفرق', 'Older age = younger age + difference'],
  ageDifference: ['فرق العمر = عمر الأكبر − عمر الأصغر', 'Age difference = older age − younger age'],
  ageRatioSum: ['مجموع العمرين = عمر الابن × (المضاعف + 1)', 'Sum of ages = son’s age × (multiplier + 1)'],
  ageRatio: ['عمر الابن = مجموع العمرين ÷ (المضاعف + 1)', 'Son’s age = total age ÷ (multiplier + 1)'],
  workerHours: ['إجمالي العمل (عامل × ساعة)', 'Total work in worker-hours'],
  workerTime: ['الزمن = إجمالي العمل ÷ عدد العمال الجدد', 'Time = total work ÷ new worker count'],
  combinedRate: ['معدل الإنجاز المشترك = مجموع معدلَي الإنجاز', 'Combined work rate = sum of individual rates'],
  combinedTime: ['زمن إنجاز عمل واحد = 1 ÷ المعدل المشترك', 'Time for one job = 1 ÷ combined rate'],
  lengthUnit: ['تحويل البعد إلى وحدة الطول المطلوبة', 'Convert the dimension to the target length unit'],
  rectangleArea: ['مساحة المستطيل = الطول × العرض', 'Rectangle area = length × width'],
} satisfies Record<string, Bilingual>;

const formatNumber = new Intl.NumberFormat('en', { useGrouping: false, maximumSignificantDigits: 15 });
const numericQuantity = new RegExp(`^${NUMBER}$`, 'u');

function quantity(token: string, lang: Lang): string | null {
  const value = numericQuantity.test(token) ? token : parseNumberWords(token, lang);
  if (value === null || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) return null;
  const significantDigits = value.replace(/[^0-9]/gu, '').replace(/^0+|0+$/gu, '');
  if (significantDigits.length > 15 || Number(value) === 0 && /[1-9]/u.test(value)) return null;
  return value.replace(/^\+/u, '').replace(/^-0(?:\.0+)?$/u, '0');
}

function inHours(value: string, unit: string): string {
  if (/^(?:d|يوم|ايام)/u.test(unit)) return `(${value} * 24)`;
  if (/^(?:s|ث)/u.test(unit)) return `(${value} / 3600)`;
  if (/^(?:m|دق)/u.test(unit)) return `(${value} / 60)`;
  return value;
}

function localized(pair: Bilingual, lang: Lang): string {
  return pair[lang === 'ar' ? 0 : 1];
}

function hoursStep(value: string, unit: string): Equation[] {
  const expression = inHours(value, unit);
  return expression === value ? [] : [{ label: LABEL.hours, expression, unit: HOURS }];
}

const DISTANCE_UNITS = { km: ['كم', 'km'], mi: ['ميل', 'mi'], m: ['م', 'm'] } as const;

function distanceUnit(unit: string): Bilingual {
  if (/^(?:km|kilo|كم|كيلو)/u.test(unit)) return DISTANCE_UNITS.km;
  if (/^(?:mi|ميل|اميال)/u.test(unit)) return DISTANCE_UNITS.mi;
  return DISTANCE_UNITS.m;
}

function moneyUnit(unit: string): Bilingual | string {
  if (/^(?:usd|gbp|egp|eur|sar|aed)$/u.test(unit)) return unit.toUpperCase();
  if (/^(?:ريال|riyal)/u.test(unit)) return ['ريال', 'riyals'];
  if (/^(?:درا?هم|dirham)/u.test(unit)) return ['درهم', 'dirhams'];
  if (/^(?:دولار|dollar)/u.test(unit)) return ['دولار', 'dollars'];
  if (/^(?:جنيه|pound)/u.test(unit)) return ['جنيه', 'pounds'];
  if (/^(?:يورو|euro)/u.test(unit)) return ['يورو', 'euros'];
  return unit;
}

function motion(kind: 'distance' | 'speed' | 'duration', lang: Lang, first: string, unit: string, second: string, secondUnit: string): Problem {
  const a = quantity(first, lang), b = quantity(second, lang);
  if (a === null || b === null) return 'invalid';
  const length = distanceUnit(unit);
  if (kind === 'duration') {
    if (distanceUnit(secondUnit) !== length) return 'invalid';
    return [{ label: LABEL.duration, expression: `${a} / ${b}`, unit: HOURS }];
  }
  const time = inHours(b, secondUnit);
  return [
    ...hoursStep(b, secondUnit),
    {
      label: LABEL[kind],
      expression: kind === 'distance' ? `${a} * ${time}` : `${a} / ${time}`,
      unit: kind === 'distance' ? length : [`${length[0]}/ساعة`, `${length[1]}/h`],
    },
  ];
}

function inventory(kind: 'sum' | 'left', lang: Lang, first: string, second: string): Problem {
  const a = quantity(first, lang), b = quantity(second, lang);
  if (a === null || b === null || !Number.isInteger(Number(a)) || !Number.isInteger(Number(b))) return 'invalid';
  return [{ label: LABEL[kind], expression: `${a} ${kind === 'sum' ? '+' : '-'} ${b}`, whole: true, nonnegative: true }];
}

function itemsRate(lang: Lang, rate: string, time: string, unit: string): Problem {
  const a = quantity(rate, lang), b = quantity(time, lang);
  if (a === null || b === null || !Number.isInteger(Number(a))) return 'invalid';
  return [
    ...hoursStep(b, unit),
    { label: LABEL.count, expression: `${a} * ${inHours(b, unit)}`, whole: true },
  ];
}

function cost(lang: Lang, count: string, price: string, currency: string): Problem {
  const a = quantity(count, lang), b = quantity(price, lang);
  if (a === null || b === null || !Number.isInteger(Number(a))) return 'invalid';
  return [{ label: LABEL.cost, expression: `${a} * ${b}`, unit: moneyUnit(currency) }];
}

function percentage(kind: 'percent' | 'discount' | 'increase' | 'share', lang: Lang, whole: string, rate: string, unit?: string): Problem {
  const a = quantity(whole, lang), b = quantity(rate, lang);
  if (a === null || b === null || (kind !== 'increase' && Number(b) > (kind === 'share' ? Number(a) : 100))) return 'invalid';
  if (kind === 'share') {
    return [{ label: LABEL.share, expression: `${b} / ${a} * 100`, unit: '%' }];
  }
  const expression = `${a} * (${b} / 100)`;
  const currency = unit ? moneyUnit(unit) : undefined;
  const part = { label: LABEL.percent, expression, unit: currency, whole: kind === 'percent' };
  if (kind === 'percent') return Number.isInteger(Number(a)) ? [part] : 'invalid';
  return [
    part,
    { label: LABEL[kind], expression: `${a} ${kind === 'discount' ? '-' : '+'} (${expression})`, unit: currency, nonnegative: true },
  ];
}

function age(kind: 'ageFuture' | 'agePast' | 'ageOlder' | 'ageDifference', lang: Lang, first: string, second: string): Problem {
  const a = quantity(first, lang), b = quantity(second, lang);
  if (a === null || b === null) return 'invalid';
  const operation = kind === 'ageFuture' || kind === 'ageOlder' ? '+' : '-';
  return [{ label: LABEL[kind], expression: `${a} ${operation} ${b}`, unit: YEARS, nonnegative: true }];
}

function ageRatio(lang: Lang, multiplier: string, total: string): Problem {
  const a = quantity(multiplier, lang), b = quantity(total, lang);
  if (a === null || b === null || Number(a) <= 1 || Number(b) <= 0) return 'invalid';
  return [
    { label: LABEL.ageRatioSum, expression: `${a} + 1` },
    { label: LABEL.ageRatio, expression: `${b} / (${a} + 1)`, unit: YEARS },
  ];
}

function workers(lang: Lang, first: string, duration: string, time: string, second: string): Problem {
  const a = quantity(first, lang), b = quantity(duration, lang), c = quantity(second, lang);
  if (a === null || b === null || c === null || !Number.isInteger(Number(a)) || !Number.isInteger(Number(c)) || Number(a) <= 0 || Number(b) <= 0) return 'invalid';
  const expression = `${a} * ${inHours(b, time)}`;
  return [
    ...hoursStep(b, time),
    { label: LABEL.workerHours, expression },
    { label: LABEL.workerTime, expression: `(${expression}) / ${c}`, unit: HOURS },
  ];
}

function together(lang: Lang, first: string, firstUnit: string, second: string, secondUnit: string): Problem {
  const a = quantity(first, lang), b = quantity(second, lang);
  if (a === null || b === null) return 'invalid';
  const aHours = inHours(a, firstUnit), bHours = inHours(b, secondUnit);
  const expression = `1 / ${aHours} + 1 / ${bHours}`;
  return [
    ...hoursStep(a, firstUnit), ...hoursStep(b, secondUnit),
    { label: LABEL.combinedRate, expression },
    { label: LABEL.combinedTime, expression: `1 / (${expression})`, unit: HOURS },
  ];
}

function rectangleArea(lang: Lang, first: string, firstUnit: string | undefined, second: string, secondUnit: string, squareUnit?: string): Problem {
  const [length, width] = [quantity(first, lang), quantity(second, lang)];
  const sourceLength = resolveComputationUnit(firstUnit ?? secondUnit);
  const sourceWidth = resolveComputationUnit(secondUnit);
  const target = squareUnit ? resolveComputationUnit(squareUnit
    .replace(/^(?:square|sq\.?) /u, '').replace(/(?: *\^?2| squared| (?:ال)?مربع(?:ه|ات)?)$/u, '')) : sourceLength;
  if (sourceLength?.dim !== 'length' || sourceWidth?.dim !== 'length' || target?.dim !== 'length') return null;
  if (length === null || width === null || Number(length) <= 0 || Number(width) <= 0) return 'invalid';

  const unitNames = target.names.split('|');
  const symbol = [unitNames.find(name => /\p{Script=Arabic}/u.test(name)) ?? unitNames[0], unitNames[0]] as const;
  const targetFactor = target.factor;
  const steps: Equation[] = [];
  function converted(value: string, factor: number): string {
    if (factor === targetFactor) return value;
    const metres = factor === 1 ? value : `${value} * ${factor}`;
    const expression = targetFactor === 1 ? metres : `${metres} / ${targetFactor}`;
    steps.push({ label: LABEL.lengthUnit, expression, unit: symbol });
    return `(${expression})`;
  }
  const a = converted(length, sourceLength.factor);
  const b = converted(width, sourceWidth.factor);
  return [...steps, { label: LABEL.rectangleArea, expression: `${a} * ${b}`, unit: [`${symbol[0]}²`, `${symbol[1]}²`] }];
}

function grammar(pattern: string, equations: Grammar['equations']): Grammar {
  return { pattern: new RegExp(`^${pattern}$`, 'u'), equations };
}

function sameEnglishNoun(first: string, second: string): boolean {
  if (first === second) return true;
  const [singular, plural] = first.length < second.length ? [first, second] : [second, first];
  return plural === `${singular}s` || plural === `${singular}es`
    || singular.endsWith('y') && plural === `${singular.slice(0, -1)}ies`;
}

const MOVE_HEAD_EN = String.raw`(?:if )?(?:(?:a|the) )?(?:car|train|bus|bike|truck|cyclist|runner|boat) (?:travels?|drives?|goes|moves?|runs?|rides?)`;
const MOVE_HEAD_AR = String.raw`(?:(?:اذا |لو )?(?:(?:ال)?(?:سياره|قطار|حافله|باص|عربيه|موتر|دراجه|قارب) (?:يسير|تسير|يمشي|تمشي|ماشيه|ماشي|يقطع|تقطع|يجري|تجري)|(?:يسير|تسير|يقطع|تقطع) (?:سياره|قطار|حافله|دراجه|قارب)))`;
const PRICE_HEAD_EN = String.raw`(?:(?:a|the|an) )?${ITEM} (?:originally )?(?:costs|is priced at|is)`;
const PRICE_HEAD_AR = String.raw`(?:سعر ${ITEM}|ثمن ${ITEM})`;
const STUDENTS_AR = String.raw`(?:طالب(?:ا|ه)?|طلاب|تلميذ(?:ا)?|تلاميذ)`;
const STUDENT_ACTION_AR = String.raw`(نجح(?:وا)?|شارك(?:وا)?|حضر(?:وا)?|صوت(?:وا)?)`;
const STUDENT_GROUP_AR: Readonly<Record<string, string>> = {
  الناجحين: 'نجح', المشاركين: 'شارك', الحاضرين: 'حضر', المصوتين: 'صوت',
};
const BUY_HEAD_AR = String.raw`(?:(?:اذا |لو )?(?:اشتريت|شريت|بشتري|هشتري|اشتري|اشتريتي))`;
const TIME_QUESTION_AR = String.raw`(?:${HOW_MANY_AR} (?:يستغرق|تستغرق|الوقت|يحتاج|تحتاج|ياخذ|تاخذ)|في ${HOW_MANY_AR} (?:ساعه|وقت))`;

const UNIT_WORDS = String.raw`\p{L}+(?: \p{L}+)??`;
const LENGTH_UNIT = `(${UNIT_WORDS})`;
const SQUARE_UNIT = String.raw`((?:square|sq\.?) ${UNIT_WORDS}|${UNIT_WORDS}(?: *\^?2| squared| (?:ال)?مربع(?:ه|ات)?))`;
const EN_RECTANGLE = '(?:(?:a|the|this) )?rectangle';
const EN_AREA_ASK = '(?:(?:what is|what\'s|calculate|compute|find|work out) (?:the |its )?)area';
const EN_DIMENSION_LINK = '(?: (?:measuring|with(?: (?:dimensions|sides) of)?))?';
const AR_RECTANGLE = '(?:(?:ال)?مستطيل|شكل مستطيل)';
const AR_AREA_ASK = `(?:(?:احسب|اوجد|${HOW_MANY_AR}|شو|ايش|ما(?: هي)?) )?(?:ال)?مساح(?:ه|ته)`;
const AR_DIMENSION_PAIR = `طول(?:ه)? ${QUANTITY} ?${LENGTH_UNIT} و ?عرض(?:ه)? ${QUANTITY} ?${LENGTH_UNIT}`;
const EN_AREA_IN = `(?: in ${SQUARE_UNIT})?`;
const AR_AREA_IN = `(?: (?:ب|في وحده )${SQUARE_UNIT})?`;

const AREA_GRAMMARS = [
  ...[
    `${QUANTITY}(?: ?${LENGTH_UNIT}(?: long)?)?(?: by | *[×x] *)${QUANTITY} ?${LENGTH_UNIT}(?: wide)?`,
    `${QUANTITY} ?${LENGTH_UNIT} long and ${QUANTITY} ?${LENGTH_UNIT} wide`,
    `(?:a )?length(?: of)? ${QUANTITY} ?${LENGTH_UNIT} and (?:a )?width(?: of)? ${QUANTITY} ?${LENGTH_UNIT}`,
  ].flatMap(dimensions => [
    grammar(`${EN_AREA_ASK} in ${SQUARE_UNIT} of ${EN_RECTANGLE}${EN_DIMENSION_LINK} ${dimensions}`,
      (requested, first, firstUnit, second, secondUnit) => rectangleArea('en', first, firstUnit, second, secondUnit, requested)),
    grammar(`${EN_AREA_ASK} of ${EN_RECTANGLE}${EN_DIMENSION_LINK} ${dimensions}${EN_AREA_IN}`,
      (first, firstUnit, second, secondUnit, requested) => rectangleArea('en', first, firstUnit, second, secondUnit, requested)),
    grammar(`${EN_RECTANGLE} (?:has |measures |is )?${dimensions}${BREAK}${EN_AREA_ASK}${EN_AREA_IN}`,
      (first, firstUnit, second, secondUnit, requested) => rectangleArea('en', first, firstUnit, second, secondUnit, requested)),
  ]),
  grammar(`${AR_AREA_ASK}${AR_AREA_IN} (?:ل ?)?${AR_RECTANGLE} ${AR_DIMENSION_PAIR}${AR_AREA_IN}`,
    (before, first, firstUnit, second, secondUnit, after) => before && after ? null : rectangleArea('ar', first, firstUnit, second, secondUnit, before ?? after)),
  grammar(`(?:(?:عندي|لدينا|عندنا) )?${AR_RECTANGLE} ${AR_DIMENSION_PAIR}${BREAK}${AR_AREA_ASK}${AR_AREA_IN}`,
    (first, firstUnit, second, secondUnit, requested) => rectangleArea('ar', first, firstUnit, second, secondUnit, requested)),
];

const GRAMMARS_EN = [
  grammar(`${MOVE_HEAD_EN} at ${QUANTITY} ${DISTANCE_EN}${PER_HOUR_EN} for ${QUANTITY} ${TIME_EN}${BREAK}how far (?:does|will) it (?:travel|go|drive|move|run|ride)`,
    (rate, unit, time, timeUnit) => motion('distance', 'en', rate, unit, time, timeUnit)),
  grammar(`${MOVE_HEAD_EN} ${QUANTITY} ${DISTANCE_EN} in ${QUANTITY} ${TIME_EN}${BREAK}what is (?:its|the) (?:average )?speed`,
    (distance, unit, time, timeUnit) => motion('speed', 'en', distance, unit, time, timeUnit)),
  grammar(`how long (?:does|will) it take to (?:travel|drive|go|run|ride) ${QUANTITY} ${DISTANCE_EN} at ${QUANTITY} ${DISTANCE_EN}${PER_HOUR_EN}`,
    (distance, distanceUnit, speed, speedUnit) => motion('duration', 'en', distance, distanceUnit, speed, speedUnit)),
  grammar(`(?:if )?(?:i|you|we) (?:buy|bought|purchase|purchased) ${QUANTITY} ${ITEM} at ${QUANTITY} ${MONEY_EN}(?: each| apiece)${BREAK}(?:what (?:is|was) the total cost|how much (?:does it cost|did i pay|did we pay|do i pay|will i pay))`, (...parts) => cost('en', parts[0], parts[1], parts[2])),
  grammar(`each (${ITEM}) costs ${QUANTITY} ${MONEY_EN}${BREAK}how much (?:do|does|would) ${QUANTITY} (${ITEM}) cost`,
    (item, price, currency, count, requested) => sameEnglishNoun(item, requested) ? cost('en', count, price, currency) : null),
  grammar(`(?:a|the) (?:machine|printer|factory|pump) (make|print|produce|fill)s ${QUANTITY} (${ITEM}) (?:per|an) hour${BREAK}how many(?: (?:of them|(${ITEM})))? (?:does|will) it \\1 in ${QUANTITY} ${TIME_EN}`,
    (_verb, rate, item, requested, time, unit) => !requested || sameEnglishNoun(item, requested) ? itemsRate('en', rate, time, unit) : null),
  grammar(`(?:if )?(?:i|you|we) (?:have|had|start(?:ed)? with) ${QUANTITY} ${ITEM} and (?:buy|bought|get|got|add|added|receive|received) ${QUANTITY} more${BREAK}how many (?:do (?:i|you|we) have(?: now)?|are there(?: now| in total)?)`, (...parts) => inventory('sum', 'en', parts[0], parts[1])),
  grammar(`(?:if )?(?:i|you|we) (?:have|had|start(?:ed)? with) ${QUANTITY} ${ITEM} and (?:give away|gave away|lose|lost|sell|sold|use|used|eat|ate) ${QUANTITY}${BREAK}how many (?:are left|(?:do (?:i|you|we) have left))`, (...parts) => inventory('left', 'en', parts[0], parts[1])),
  grammar(`${PRICE_HEAD_EN} ${QUANTITY} ${MONEY_EN}${BREAK}(?:(?:and )?(?:(?:it|the price) )?(?:is|was) discounted by|with a discount of|there is a discount of) ${QUANTITY}${PERCENT}${BREAK}(?:what is the (?:sale|new|final) price|how much (?:is it now|does it cost now))`,
    (price, currency, rate) => percentage('discount', 'en', price, rate, currency)),
  grammar(`${PRICE_HEAD_EN} ${QUANTITY} ${MONEY_EN}${BREAK}(?:its|the) price (?:rises|increases|went up) by ${QUANTITY}${PERCENT}${BREAK}(?:what is the (?:new|final) price|how much (?:is it now|does it cost now))`, (...parts) => percentage('increase', 'en', parts[0], parts[2], parts[1])),
  grammar(`(?:out of |there (?:are|were) )?${QUANTITY} students(?: (?:in a|in the) class)?${BREAK}${QUANTITY}${PERCENT}(?: of them)? (joined|passed|voted|attended|participated)${BREAK}how many(?: students)? \\3`, (...parts) => percentage('percent', 'en', parts[0], parts[1])),
  grammar(`(?:out of |there (?:are|were) )?${QUANTITY} students(?: (?:in a|in the) class)?${BREAK}${QUANTITY}(?: of them| students)? (joined|passed|voted|attended|participated)${BREAK}what percentage(?: of (?:them|students))? \\3`, (...parts) => percentage('share', 'en', parts[0], parts[1])),
  grammar(`(${NAME}) is ${QUANTITY} years? old${BREAK}how old will (?:\\1|she|he|they) be in ${QUANTITY} years?(?: from now)?`, (...parts) => age('ageFuture', 'en', parts[1], parts[2])),
  grammar(`(${NAME}) is ${QUANTITY} years? old${BREAK}how old was (?:\\1|she|he) ${QUANTITY} years? ago`, (...parts) => age('agePast', 'en', parts[1], parts[2])),
  grammar(`(${NAME}) is ${QUANTITY} years? older than (${NAME})${BREAK}\\3 is ${QUANTITY}(?: years? old)?${BREAK}how old is \\1`, (older, gap, younger, value) => older === younger ? null : age('ageOlder', 'en', value, gap)),
  grammar(`(${NAME}) is ${QUANTITY}(?: years? old)?${BREAK}(?:and )?(${NAME}) is ${QUANTITY}(?: years? old)?${BREAK}how many years? older is \\1 than \\3`, (older, first, younger, second) => older === younger ? null : age('ageDifference', 'en', first, second)),
  grammar(`(?:a|the) father is ${QUANTITY} times as old as his son${BREAK}their ages (?:add up to|total) ${QUANTITY}(?: years?)?${BREAK}how old is (?:his|the) son`, (...parts) => ageRatio('en', parts[0], parts[1])),
  grammar(`(${NAME}) can (?:finish|complete|do) (?:a|the) job in ${QUANTITY} ${TIME_EN}${BREAK}(?:and )?(${NAME}) can (?:finish|complete|do) (?:it|the (?:same )?job) in ${QUANTITY} ${TIME_EN}${BREAK}how long (?:will|would) (?:they take|it take them) (?:if they work )?together`, (first, a, unitA, second, b, unitB) => first === second ? null : together('en', a, unitA, b, unitB)),
  grammar(`(${NAME}) can paint (?:a|the) room in ${QUANTITY} ${TIME_EN}${BREAK}(?:and )?(${NAME}) can paint (?:it|the (?:same )?room) in ${QUANTITY} ${TIME_EN}${BREAK}how long (?:will|would) (?:they take|it take them) (?:if they work )?together`, (first, a, unitA, second, b, unitB) => first === second ? null : together('en', a, unitA, b, unitB)),
  grammar(`${QUANTITY} workers take ${QUANTITY} ${TIME_EN} to (?:finish|complete|do) (?:a|the) job${BREAK}how long (?:will|would) ${QUANTITY} workers take at the same rate`, (...parts) => workers('en', parts[0], parts[1], parts[2], parts[3])),
];

const GRAMMARS_AR = [
  grammar(`${MOVE_HEAD_AR} بسرعه ${QUANTITY} ${DISTANCE_AR}${PER_HOUR_AR} (?:لمده|مده|خلال|ل) ?${QUANTITY} ${TIME_AR}${BREAK}(?:${HOW_MANY_AR}(?: ${DISTANCE_AR})? (?:يقطع|تقطع|يقطعها|تقطعها|يمشي|تمشي|بيقطع|بتقطع|تكون المسافه|المسافه)|(?:هتمشي|هيمشي) قد ايه)`,
    (rate, unit, time, timeUnit, requested) => !requested || distanceUnit(unit) === distanceUnit(requested) ? motion('distance', 'ar', rate, unit, time, timeUnit) : null),
  grammar(`${MOVE_HEAD_AR} ${QUANTITY} ${DISTANCE_AR} (?:في|خلال) ${QUANTITY} ${TIME_AR}${BREAK}(?:(?:ما|ما هي|كم|قديش|كام) (?:متوسط )?سرعت(?:ه|ها)|(?:ما|ما هو|كم) متوسط السرعه)`,
    (distance, unit, time, timeUnit) => motion('speed', 'ar', distance, unit, time, timeUnit)),
  grammar(`${TIME_QUESTION_AR} (?:لقطع|حتى يقطع) ${QUANTITY} ${DISTANCE_AR} بسرعه ${QUANTITY} ${DISTANCE_AR}${PER_HOUR_AR}`,
    (distance, distanceUnit, speed, speedUnit) => motion('duration', 'ar', distance, distanceUnit, speed, speedUnit)),
  grammar(`${BUY_HEAD_AR} ${QUANTITY} ${ITEM} (?:بسعر|ب) ?${QUANTITY} ${MONEY_AR} (?:للواحد(?:ه)?|للوحده|لكل واحد(?:ه)?|الواحد(?:ه)?)${BREAK}${HOW_MANY_AR} (?:دفعت|بدفع|هدفع|ادفع|المجموع|التكلفه|الحساب|يكلف|يطلع الحساب)`, (...parts) => cost('ar', parts[0], parts[1], parts[2])),
  grammar(`(?:اله|ماكينه|مكنه|مصنع|طابعه) (تنتج|ينتج|تطبع|تسوي|تعمل) ${QUANTITY} (${ITEM}) (?:في الساعه|بالساعه|كل ساعه)${BREAK}${HOW_MANY_AR}(?: (منها|منهم|${ITEM}))? \\1 (?:في|خلال) ${QUANTITY} ${TIME_AR}`,
    (_verb, rate, item, requested, time, unit) => !requested || requested === item || requested === 'منها' || requested === 'منهم' ? itemsRate('ar', rate, time, unit) : null),
  grammar(`(?:اذا |لو )?(?:معي|معايا|عندي|معانا|عندنا|كان عندي|كان معي) ${QUANTITY} ${ITEM} (?:و|ثم )(?:اشتريت|شريت|اضفت|استلمت|اخذت|اخدت|جبت) ${QUANTITY} (?:زياده|كمان|اضافيه|اخرى)${BREAK}${HOW_MANY_AR} (?:صار عندي|صار معي|بقي معي|بقي عندي|معي الان|عندي الان|معايا دلوقتي|صاروا|المجموع)`, (...parts) => inventory('sum', 'ar', parts[0], parts[1])),
  grammar(`(?:اذا |لو )?(?:معي|معايا|عندي|معانا|عندنا|كان عندي|كان معي) ${QUANTITY} ${ITEM} (?:و|ثم )(?:بعت|اعطيت|اديت|خسرت|فقدت|استخدمت|اكلت|وزعت) ${QUANTITY}(?: (?:منها|منهم))?${BREAK}${HOW_MANY_AR} (?:بقي(?:ت)?(?: معي| عندي)?|ضل(?:وا| معي| عندي)?|فاضل(?: معايا)?|باقي(?: معي| عندي)?|تبقي(?: منها| معي)?)`, (...parts) => inventory('left', 'ar', parts[0], parts[1])),
  grammar(`${PRICE_HEAD_AR} ${QUANTITY} ${MONEY_AR}${BREAK}(?:عليه|عليها|مع|علي السعر) خصم(?: نسبته)? ${QUANTITY}${PERCENT}${BREAK}(?:${HOW_MANY_AR}|ما هو|ما) (?:السعر بعد الخصم|السعر الجديد|صار السعر|صار سعره|سعره الحين|سعره دلوقتي)`, (...parts) => percentage('discount', 'ar', parts[0], parts[2], parts[1])),
  grammar(`${PRICE_HEAD_AR} ${QUANTITY} ${MONEY_AR}${BREAK}(?:زاد|ارتفع) (?:السعر|سعره) (?:بنسبه |ب)?${QUANTITY}${PERCENT}${BREAK}(?:${HOW_MANY_AR}|ما هو|ما) (?:السعر الجديد|السعر بعد الزياده|صار السعر|صار سعره)`, (...parts) => percentage('increase', 'ar', parts[0], parts[2], parts[1])),
  grammar(`(?:في (?:الصف|الفصل) |من بين )?${QUANTITY} ${STUDENTS_AR}${BREAK}${QUANTITY}${PERCENT}(?: منهم)? ${STUDENT_ACTION_AR}${BREAK}${HOW_MANY_AR}(?: ${STUDENTS_AR})? ${STUDENT_ACTION_AR}`,
    (whole, rate, action, requested) => action.replace(/وا$/u, '') === requested.replace(/وا$/u, '') ? percentage('percent', 'ar', whole, rate) : null),
  grammar(`(?:في (?:الصف|الفصل) |من بين )?${QUANTITY} ${STUDENTS_AR}${BREAK}(نجح|شارك|حضر|صوت) ${QUANTITY}(?: منهم)?${BREAK}(?:${HOW_MANY_AR}|ما|ما هي) (?:نسبه |النسبه المئويه ل ?)(الناجحين|المشاركين|الحاضرين|المصوتين)`,
    (whole, action, part, requested) => STUDENT_GROUP_AR[requested] === action ? percentage('share', 'ar', whole, part) : null),
  ...[AGE_AR, AGE_PREFIX_AR].flatMap(statement => [
    grammar(`${statement}${BREAK}${HOW_MANY_AR} (?:يصير عمره|تصير عمرها|سيصبح عمر(?:ه|ها)|سيكون عمر(?:ه|ها)|بيصير عمر(?:ه|ها)|هيبقي عمر(?:ه|ها)|يكون عمر(?:ه|ها)|عمره|عمرها|عمر \\1) بعد ${QUANTITY} ${YEARS_AR}`,
      (_name, current, years) => age('ageFuture', 'ar', current, years)),
    grammar(`${statement}${BREAK}${HOW_MANY_AR} (?:كان عمر(?:ه|ها)|كان عمر \\1) قبل ${QUANTITY} ${YEARS_AR}`,
      (_name, current, years) => age('agePast', 'ar', current, years)),
  ]),
  grammar(`(${NAME}) اكبر من (${NAME}) (?:ب|بمقدار )${QUANTITY} ${YEARS_AR}${BREAK}عمر \\2 ${QUANTITY}(?: ${YEARS_AR})?${BREAK}${HOW_MANY_AR} عمر \\1`, (older, younger, gap, value) => older === younger ? null : age('ageOlder', 'ar', value, gap)),
  grammar(`${AGE_AR}${BREAK}(?:و ?)?${AGE_AR}${BREAK}${HOW_MANY_AR} (?:سنه )?يزيد عمر \\1 عن عمر \\3`, (older, first, younger, second) => older === younger ? null : age('ageDifference', 'ar', first, second)),
  grammar(`عمر الاب ${QUANTITY} (?:امثال|اضعاف) عمر ابن(?:ه|ه الصغير)${BREAK}مجموع عمريهما ${QUANTITY}(?: ${YEARS_AR})?${BREAK}${HOW_MANY_AR} عمر الابن`, (...parts) => ageRatio('ar', parts[0], parts[1])),
  grammar(`(?:عامل|عامل اول) (?:ينجز|يكمل|يخلص) (?:عملا|العمل|المهمه|الشغل) (?:في|خلال) ${QUANTITY} ${TIME_AR}${BREAK}(?:و ?)?عامل (?:اخر|ثان(?:ي)?) (?:ينجزه|يكمله|يخلصه|ينجز (?:نفس العمل|نفس المهمه|نفس الشغل)) (?:في|خلال) ${QUANTITY} ${TIME_AR}${BREAK}${HOW_MANY_AR} (?:ساعه )?(?:يحتاجان|يحتاجون|يحتاجوا|يخلصون|يخلصوا|يستغرق العمل) (?:معا|سوا|مع بعض)`, (...parts) => together('ar', parts[0], parts[1], parts[2], parts[3])),
  grammar(`${QUANTITY} (?:عمال|عامل(?:ا)?) (?:ينجزون|ينجزوا|يكملون|يكملوا|يخلصون|يخلصوا) (?:عملا|العمل|المهمه) (?:في|خلال) ${QUANTITY} ${TIME_AR}${BREAK}${HOW_MANY_AR} (?:يستغرق|يحتاج) ${QUANTITY} (?:عمال|عامل(?:ا)?) (?:بنفس|بالمعدل نفسه|بالمعدل ذات(?:ه)?)(?: المعدل)?`, (...parts) => workers('ar', parts[0], parts[1], parts[2], parts[3])),
];

const GRAMMARS = [...AREA_GRAMMARS, ...GRAMMARS_EN, ...GRAMMARS_AR];

function normalizedProblem(text: string): string {
  return normalizeRequest(stripCourtesyTail(text)).match
    .replace(/^(?:solve(?: this)?(?: word)? problem|حل(?: هذه)? المساله)\s*:\s*/u, '')
    .replace(/(?<![\d.,٬٫])\d{1,3}(?:(?:,\d{3})+|(?:٬\d{3})+)(?!\d|[,٬]\d)/gu, group => group.replace(/[,٬]/gu, ''))
    .replace(/٫/gu, '.').replace(/٪/gu, '%').replace(/’/gu, "'")
    .replace(/([$€£])\s*(\d+(?:\.\d+)?)/gu, '$2 $1')
    .replace(/\s+/gu, ' ').replace(/[.!?؟]+$/gu, '').trim();
}

function pretty(expression: string): string {
  return expression.replace(/\*/gu, '×').replace(/\//gu, '÷').replace(/ - /gu, ' − ');
}

function solve(equations: readonly Equation[], lang: Lang): { value: string; lines: string[] } | null {
  const lines: string[] = [];
  let value = '';
  for (const step of equations) {
    const result = evaluateArithmeticExpression(step.expression);
    if (!result.ok || step.nonnegative && result.value < 0) return null;
    value = formatNumber.format(result.value);
    if (step.whole && !Number.isInteger(Number(value))) return null;
    const unit = typeof step.unit === 'string' || !step.unit ? step.unit : localized(step.unit, lang);
    const shown = !unit ? value : /^[$€£]$/u.test(unit) ? `${unit}${value}` : `${value}${unit === '%' ? '' : ' '}${unit}`;
    lines.push(`${localized(step.label, lang)}. ${pretty(step.expression)} ${Number(value) === result.value ? '=' : '≈'} ${shown}.`);
  }
  return { value, lines };
}

/** The full grammar assigns semantic roles before selecting the operations. */
export function reasonWordProblem(text: string, lang: Lang): ReasoningResult | null {
  // Preserve a squared unit such as m², but never flatten raised or lowered digits in a quantity.
  if (text.length > 900 || /[¹³\u2070-\u209f]|(?<!\p{L})²/u.test(text)) return null;
  const input = normalizedProblem(text);
  for (const { pattern, equations } of GRAMMARS) {
    const match = pattern.exec(input);
    if (!match) continue;
    const problem = equations(...match.slice(1));
    if (!problem) continue;
    const result = problem === 'invalid' ? null : solve(problem, lang);
    if (!result) {
      return reasoningGap(lang, lang === 'ar'
        ? 'لم أتمكن من حل هذه المسألة بالقيم المعطاة. راجع الأعداد والوحدات.'
        : 'I couldn’t solve this problem with the supplied values. Check the quantities and units.');
    }
    return reasoned(lang, result.lines.join('\n'), result.value);
  }
  return null;
}
