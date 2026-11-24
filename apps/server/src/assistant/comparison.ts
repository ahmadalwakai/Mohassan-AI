import { publicSearchText } from '@mohassan/browser';
import { isMetaLine } from './answer-check.js';
import { dates, isPageInstruction, typedNumbers } from './mind/extract.js';

type Metric = 'size' | 'area' | 'length' | 'height' | 'radius' | 'mass' | 'population' | 'age' | 'count';
type Measure = Exclude<Metric, 'size' | 'age'> | 'birth' | 'foundation';
export interface ComparisonQuestion {
  subjects: [string, string];
  metric: Metric;
  smaller: boolean;
  countNoun?: string;
}
export interface ComparisonPage { title: string; url: string; text: string }
export interface ComparisonSource { title: string; url: string; line: string }
type Observation = { value: number; end: number; source: ComparisonSource };

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\p{M}ـ]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const WORD = '[\\p{L}\\p{N}]';
const matchWord = (text: string) => new RegExp(`(?<!${WORD})${escape(text)}(?!${WORD})`, 'u');
const subjectKey = (text: string) => normalized(text).replace(/^the\s+/u, '').replace(/\s+/gu, ' ');

export function namesComparisonSubject(title: string, name: string): boolean {
  const main = title.replace(/\s+[-–—|]\s+.+$/u, '').replace(/\s+\([^()]+\)$/u, '');
  return subjectKey(main) === subjectKey(name);
}

/** Two explicit alternatives leave a superlative or a vague follow-up to its normal handler. */
export function comparisonQuestion(question: string): ComparisonQuestion | null {
  const text = question.replace(/[\s.!?؟]+$/u, '').trim();
  const alternatives = text.split(/\s+(?:or|versus|vs\.?|[أا]م|[أا]و)\s+/iu);
  if (alternatives.length !== 2) return null;
  const [left, right] = alternatives as [string, string];
  const english = /^which(?: (?:one|country|city|planet|river|mountain|company|person)| of (?:them|these))?\s+(?:is|was|has|had)\s+(.+)$/iu.exec(left);
  const arabic = /^[أا]يهما(?:\s+(?:هو|هي))?[،,:]?\s+(.+)$/u.exec(left);
  const prefix = english?.[1] ?? arabic?.[1];
  if (!prefix) return null;
  const head = /^([^،,:]+)[،,:]\s*(.+)$/u.exec(prefix);
  // Without a comma, the supported adjectival forms still have an unambiguous end.
  const elided = /^(?:(more|fewer|less)\s+([\p{L}]+)\s+(.+))$/iu.exec(prefix);
  const adjective = /^((?:larger|bigger|smaller)(?:\s+(?:in\s+)?(?:area|population))?|older|younger|earlier|newer|longer|shorter|taller|heavier|lighter|[أا](?:كبر|صغر)(?:\s+(?:مساح[ةه]\p{M}*|سكان\p{M}*ا?|سن\p{M}*ا?|من حيث المساح[ةه]))?|[أا](?:قدم|حدث|طول|قصر|ثقل|خف)|[أا](?:كثر|قل)\s+[\p{L}\p{M}]+)\s+(.+)$/iu.exec(prefix);
  const parts = head ?? adjective ?? (elided && ['', `${elided[1]} ${elided[2]}`, elided[3]]);
  if (!parts) return null;
  const qualifier = normalized(parts[1]!);
  const subjects = [parts[2]!.trim(), right.trim()] as [string, string];
  if (subjects.some(name => !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}.'’() -]{0,75}$/u.test(name)) || subjectKey(subjects[0]) === subjectKey(subjects[1])) return null;
  const smaller = /^(?:smaller|younger|newer|shorter|lighter|less|fewer|lower|a smaller|اصغر|احدث|اقصر|اخف|اقل)\b/u.test(qualifier)
    || /^(?:اصغر|احدث|اقصر|اخف|اقل)(?: |$)/u.test(qualifier);
  if (/\b(?:older|younger|earlier|newer)\b|^(?:اقدم|احدث)$|سنا?$/u.test(qualifier)) return { subjects, metric: 'age', smaller };
  if (/\b(?:population|inhabitants|residents|people)\b|سكان/u.test(qualifier)) return { subjects, metric: 'population', smaller };
  if (/\barea\b|مساحه/u.test(qualifier)) return { subjects, metric: 'area', smaller };
  if (/\b(?:taller|height)\b|ارتفاع/u.test(qualifier)) return { subjects, metric: 'height', smaller };
  if (/\b(?:diameter|radius)\b|قطر/u.test(qualifier)) return { subjects, metric: 'radius', smaller };
  if (/\b(?:longer|shorter|length)\b|^(?:اطول|اقصر)$/u.test(qualifier)) return { subjects, metric: 'length', smaller };
  if (/\b(?:heavier|lighter|mass|weight)\b|^(?:اثقل|اخف)$/u.test(qualifier)) return { subjects, metric: 'mass', smaller };
  if (/^(?:larger|bigger|smaller|اكبر|اصغر)$/u.test(qualifier)) return { subjects, metric: 'size', smaller };
  const count = /^(?:more|fewer|اكثر|اقل)\s+([\p{L}]+(?:\s+[\p{L}]+)?)$/u.exec(qualifier);
  return count ? { subjects, metric: 'count', smaller, countNoun: count[1] } : null;
}

const NUMBER = '[+−-]?\\p{Nd}+(?:[,،٬ ]\\p{Nd}{3}(?!\\p{Nd}))*(?:[.٫]\\p{Nd}+)?';
const SCALE = 'billions?|millions?|thousands?|مليار(?:ات)?|مليون(?:ا|ين)?|الاف|الف(?:ا)?';
const numberValue = (text: string) => Number(text.replace(/[٠-٩۰-۹]/gu, char => String(char.charCodeAt(0) & 15))
  .replace(/[,،٬ ]/gu, '').replace('٫', '.').replace('−', '-'));
const scaleValue = (scale: string | undefined) => !scale ? 1 : /billion|مليار/u.test(scale) ? 1e9 : /million|مليون/u.test(scale) ? 1e6 : 1e3;
const kmArea = 'km\\s*(?:2|²)|(?:square|sq\\.?)\\s+kilomet(?:ers?|res?)|كيلو\\s*متر(?:ا)?\\s+مربع(?:ا)?|كم\\s*(?:2|²|مربع)';
const mileArea = 'mi\\s*(?:2|²)|(?:square|sq\\.?)\\s+miles?';
const meterArea = 'm\\s*(?:2|²)|square\\s+met(?:ers?|res?)|متر(?:ا)?\\s+مربع(?:ا)?';
const area = new RegExp(`(?<!${WORD})(${NUMBER})(?:\\s+(${SCALE}))?\\s*(${kmArea}|${mileArea}|${meterArea})(?!${WORD})`, 'gu');
const isSquareKilometers = new RegExp(`^(?:${kmArea})$`, 'u');
const isSquareMiles = new RegExp(`^(?:${mileArea})$`, 'u');
const population = new RegExp(`(?<!${WORD})(${NUMBER})(?:\\s+(${SCALE}))?(?:\\s+(?:people|inhabitants|residents|نسمه)(?!${WORD}))?`, 'gu');
const populationWord = /\bpopulation\b|(?<!\p{L})(?:(?:عدد|اجمالي|تعداد)\s+)?(?:ال)?سكان(?:ها)?(?!\p{L})/u;
const historicCount = /\b(?:formerly|at its peak|projected to|expected to|will reach)\b|(?:سابقا|من المتوقع|من المنتظر|من المرجح|سيبلغ|كانت تبلغ)/u;
const areaWord = /\barea\b|(?<!\p{L})(?:ال)?مساح(?:ه|ته|تها)(?!\p{L})/u;
const lengthWord = /\b(?:length|long)\b|(?<!\p{L})(?:ال)?طول(?:ه|ها)?(?!\p{L})/u;
const heightWord = /\b(?:height|tall)\b|(?<!\p{L})(?:ال)?ارتفاع(?:ه|ها)?(?!\p{L})/u;
const radiusWord = /\b(?:radius|diameter)\b|(?<!\p{L})(?:نصف )?(?:ال)?قطر(?:ه|ها)?(?!\p{L})/u;
const diameterWord = /\bdiameter\b|(?<![\p{L} ])(?:ال)?قطر(?:ه|ها)?(?!\p{L})|(?<!نصف ) (?:ال)?قطر(?:ه|ها)?(?!\p{L})/u;
const massWord = /\b(?:weight|mass|weighs)\b|(?<!\p{L})(?:وزن|كتل)(?:ه|ها|ته|تها)?(?!\p{L})/u;
const birth = /\bborn\b|(?<!\p{L})(?:ولد(?:ت)?|الميلاد)(?!\p{L})/u;
const foundation = /\b(?:founded|established|formed|incorporated)\b|(?<!\p{L})(?:تاسس(?:ت)?|تاسيس|تاسست|اسس(?:ت)?|انشئ(?:ت)?)(?!\p{L})/u;

function dateRanges(line: string): { value: number; end: number }[] {
  return dates(line).flatMap(({ key }) => {
    const parsed = /^(?:date|year):(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(key);
    if (!parsed) return [];
    const [, year, month, day] = parsed;
    const start = Date.UTC(Number(year), Number(month ?? '1') - 1, Number(day ?? '1'));
    const end = day ? start : Date.UTC(Number(year), Number(month ?? '12'), 0);
    return [{ value: start, end }];
  });
}

function measures(question: ComparisonQuestion, line: string): [Measure, number, number][] {
  const found: [Measure, number, number][] = [];
  const keep = (type: Measure, value: number, end = value) => { if (Number.isFinite(value)) found.push([type, value, end]); };
  if (question.metric === 'age') {
    for (const [cue, type] of [[birth, 'birth'], [foundation, 'foundation']] as const) {
      const match = cue.exec(line);
      if (!match) continue;
      const values = dateRanges(line.slice(match.index + match[0].length));
      if (values.length === 1) keep(type, values[0]!.value, values[0]!.end);
    }
  }
  if ((question.metric === 'size' || question.metric === 'area') && areaWord.test(line)) {
    for (const [, amount, scale, unit] of line.matchAll(area)) {
      const factor = isSquareKilometers.test(unit!) ? 1e6 : isSquareMiles.test(unit!) ? 2_589_988.110336 : 1;
      keep('area', numberValue(amount!) * scaleValue(scale) * factor);
    }
  }
  const physical = [[lengthWord, 'length', 'length:m'], [heightWord, 'height', 'length:m'], [radiusWord, 'radius', 'length:m'], [massWord, 'mass', 'mass:g']] as const;
  const relevant = physical.filter(([cue, type]) => (question.metric === 'size' || question.metric === type) && cue.test(line));
  if (relevant.length === 1) {
    const [, type, unit] = relevant[0]!;
    const quantities = typedNumbers(line).filter(measurement => measurement.unit === unit);
    if (quantities.length === 1) keep(type, quantities[0]!.number / (type === 'radius' && diameterWord.test(line) ? 2 : 1));
  }
  if (question.metric === 'population' && populationWord.test(line) && !historicCount.test(line)) {
    const after = line.slice(line.search(populationWord));
    const amounts = [...after.matchAll(population)].filter(match => match[2] || /(?:people|inhabitants|residents|نسمه)$/u.test(match[0])
      || /^\s*(?:(?:of|is|was|about|around|approximately|est(?:imate)?|حوالي|نحو|يبلغ|بلغ)\s+|[:=]\s*)*$/u.test(after.slice(populationWord.exec(after)![0].length, match.index)));
    if (amounts.length === 1) keep('population', numberValue(amounts[0]![1]!) * scaleValue(amounts[0]![2]));
  }
  if (question.countNoun) {
    const count = new RegExp(`(?<!${WORD})(${NUMBER})(?:\\s+(${SCALE}))?\\s+${escape(question.countNoun)}(?!${WORD})`, 'gu');
    for (const [, amount, scale] of line.matchAll(count)) keep('count', numberValue(amount!) * scaleValue(scale));
  }
  return found;
}

const articleField = /^(?:total area|surface area|area|population|mass|weight|length|height|(?:mean )?radius|diameter|born|founded|established|(?:ال)?مساحه|(?:ال)?سكان|عدد السكان|الميلاد|تاسس(?:ت)?)(?!\p{L})/u;
const negated = /\b(?:not|never|didn't|wasn't|isn't|doesn't)\b|(?<!\p{L})(?:لا|لم|ليس|ليست)(?!\p{L})/u;
const subjectPredicate = /^(?:['’]s\s+)?(?:has|had|is|was|covers|measures|weighs|contains|includes|boasts|born|founded|established|total area|surface area|area|population|height|length|mass|weight|(?:نصف )?قطر(?:ه|ها)?|(?:ي|ت)بلغ|(?:ي|ت)غطى|(?:ي|ت)غطي|(?:ي|ت)ضم|(?:ي|ت)متد|(?:ي|ت)زن|(?:ي|ت)قدر|(?:ي|ت)زيد|(?:ي|ت)ملك|ل(?:ه|ها|ديه|ديها)|مساح(?:ه|ته|تها)|عدد سكان(?:ه|ها)?|تاسس(?:ت)?|ولد(?:ت)?)(?!\p{L})/u;
const countPredicate = /^(?:has|had|contains|includes|hosts|boasts|employs|is home to|(?:ي|ت)ضم|(?:ي|ت)ملك|ل(?:ه|ها|ديه|ديها))(?!\p{L})/u;
const attributeBeforeSubject = /(?:\b(?:area|population|length|height|radius|diameter|mass|weight) of(?: the)?|(?<!\p{L})(?:مساحه|عدد السكان في|سكان|قطر|طول|ارتفاع|وزن|كتله|ولد(?:ت)?(?: في)?|تاسس(?:ت)?(?: شركه)?))\s*$/u;
const indirectClause = /\b(?:reported|claimed|said|stated|announced|according to|whose|which|who|that)\b|(?<!\p{L})(?:قال|قالت|اعلن|اعلنت|اوضح|اوضحت|ذكر|ذكرت|الذي|التي)(?!\p{L})/u;
const subjectPrefix = /^(?:the\s+)?(?:country|planet|city|company|river|mountain|دوله|كوكب|مدينه|شركه|نهر|جبل)?\s*$/u;
const datedPrefix = /^(?:as of|in|في|اعتبارا من)\s+[^,،]{0,40}\p{Nd}{4}[^,،]{0,12}[,،]\s*$/u;

function statesMeasure(question: ComparisonQuestion, line: string, name: RegExpExecArray | null, ownPage: boolean): boolean {
  if (negated.test(line)) return false;
  if (!name) return ownPage && articleField.test(line) && !indirectClause.test(line);
  const before = line.slice(0, name.index);
  const after = line.slice(name.index + name[0].length).replace(/^\s*(?:inc\.|corp\.|ltd\.)?\s*/u, '')
    .replace(/^[,،]\s*(?:officially|also called|also known as|رسميا)[^,،]{0,90}[,،]\s*/u, '')
    .replace(/^\([^()]{1,100}\)\s*/u, '').replace(/^[\s,:،(]+/u, '');
  // A number in a reported statement or relative clause does not describe the named subject.
  if (indirectClause.test(after.split(/\p{Nd}/u, 1)[0]!)) return false;
  const namesTheSubject = subjectPrefix.test(before) || datedPrefix.test(before);
  if (question.metric === 'count') return namesTheSubject && countPredicate.test(after);
  return attributeBeforeSubject.test(before) || namesTheSubject && subjectPredicate.test(after);
}

function observations(question: ComparisonQuestion, pages: readonly ComparisonPage[], index: 0 | 1): Map<Measure, Observation> {
  const mine = matchWord(subjectKey(question.subjects[index]));
  const other = matchWord(subjectKey(question.subjects[index === 0 ? 1 : 0]));
  const values = new Map<Measure, Observation>();
  const conflicts = new Set<Measure>();
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const page of pages) {
    const ownPage = namesComparisonSubject(page.title, question.subjects[index]);
    for (const paragraph of page.text.slice(0, 200_000).split('\n')) {
      for (const { segment } of segmenter.segment(paragraph)) {
        const quote = segment.trim().replace(/\s+/gu, ' ');
        if (!quote || quote.length > 550 || isMetaLine(quote) || isPageInstruction(quote) || publicSearchText(quote) !== quote) continue;
        const line = normalized(quote);
        const name = mine.exec(line);
        if (other.test(line) || !statesMeasure(question, line, name, ownPage)) continue;
        for (const [type, value, end] of measures(question, line)) {
          const seen = values.get(type);
          if (seen && (seen.end < value || end < seen.value)) conflicts.add(type);
          else if (!seen || value >= seen.value && end <= seen.end && end - value < seen.end - seen.value) {
            values.set(type, { value, end, source: { title: page.title, url: page.url, line: quote } });
          }
        }
      }
    }
  }
  for (const type of conflicts) values.delete(type);
  return values;
}

export function comparePages(question: ComparisonQuestion, pages: readonly ComparisonPage[], lang: 'ar' | 'en') {
  const left = observations(question, pages, 0), right = observations(question, pages, 1);
  const shared = [...left.keys()].filter(type => right.has(type));
  const type = (['area', 'length', 'height', 'radius', 'mass'] as const).find(metric => shared.includes(metric)) ?? shared[0];
  if (!type) return null;
  const first = left.get(type)!, second = right.get(type)!;
  // For a vague size question, compare only like measurements and decline when the measurements disagree about the order.
  if (shared.some(metric => Math.sign(left.get(metric)!.value - right.get(metric)!.value) !== Math.sign(first.value - second.value))) return null;
  const earlier = type === 'birth' || type === 'foundation';
  const equal = first.value === first.end && second.value === second.end && first.value === second.value;
  if (earlier && !equal && first.end >= second.value && second.end >= first.value) return null;
  const swap = earlier !== question.smaller ? first.value > second.value : first.value < second.value;
  const [winner, loser] = swap ? [question.subjects[1], question.subjects[0]] : question.subjects;
  const dimensions = {
    area: ['surface area', 'المساحة', 'larger by surface area', 'أكبر مساحة', 'smaller by surface area', 'أصغر مساحة'],
    length: ['length', 'الطول', 'longer', 'أطول', 'shorter', 'أقصر'],
    height: ['height', 'الارتفاع', 'taller', 'أعلى', 'shorter', 'أقل ارتفاعًا'],
    radius: ['radius', 'نصف القطر', 'larger by radius', 'أكبر نصف قطرًا', 'smaller by radius', 'أصغر نصف قطرًا'],
    mass: ['mass', 'الكتلة', 'heavier', 'أثقل', 'lighter', 'أخف'],
    population: ['population', 'عدد السكان', 'more populous', 'أكثر سكانًا', 'less populous', 'أقل سكانًا'],
    birth: ['date of birth', 'تاريخ الميلاد', 'older', 'أكبر سنًا', 'younger', 'أصغر سنًا'],
    foundation: ['founding date', 'تاريخ التأسيس', 'older', 'أقدم', 'newer', 'أحدث'],
    count: [question.countNoun, question.countNoun, '', '', '', ''],
  };
  const [dimension, arabicDimension, higher, arabicHigher, lower, arabicLower] = dimensions[type];
  const result = equal ? lang === 'ar' ? `${winner} و${loser} متساويان في ${arabicDimension}.` : `${winner} and ${loser} have the same ${dimension}.`
    : type === 'count' ? lang === 'ar' ? `${winner} ${question.smaller ? 'أقل' : 'أكثر'} ${dimension} من ${loser}.` : `${winner} has ${question.smaller ? 'fewer' : 'more'} ${dimension} than ${loser}.`
    : lang === 'ar' ? `${winner} ${question.smaller ? arabicLower : arabicHigher} من ${loser}.` : `${winner} is ${question.smaller ? lower : higher} than ${loser}.`;
  return { result, sources: [first.source, second.source], winner };
}
