import { foldText } from '../../../../../packages/skills/src/stems.js';
import { isMetaLine } from '../answer-check.js';
import { quoteCandidates, type SelectionPage } from './ranker.js';
import { selectionTerms } from './word-forms.js';

interface PageFact {
  value: string;
  quote?: string;
}

type Extract = (quote: string, folded: string) => PageFact[];

const DAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?<!\p{L})(?:ال)?(?:اثنين|ثلاثاء|اربعاء|خميس|جمعه|سبت|احد)(?!\p{L})/gu;
const MEASURE = /\b\d+(?:\.\d+)?\s*(?:km|kilomet(?:er|re)s?|m|met(?:er|re)s?|cm|centimet(?:er|re)s?|mi|miles?|ft|feet|foot)\b/gu;
const MONEY = /(?<![\d.])\d+(?:[.٫]\d+)?\s*(?:(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|(?:دينار|درهم|ريال|جنيه|دولار|يورو)(?!\p{L}))|[$€£]\s*\d+(?:\.\d+)?/gu;
const CLOCK = /(?:\b(?:at|until)\s+|(?<!\p{L})(?:الساعه|ساعه)\s*)([01]?\d|2[0-3])((?::[0-5]\d)?(?:\s*[ap]\.?m\.?)?)(?![\d:.])/gu;
const NAME = /\p{Lu}\p{Ll}[\p{L}’'-]*(?:\s+(?:(?:de|van|von|al)\s+)?\p{Lu}[\p{L}’'-]+)*/u;
const UNSAFE_CLAIM = /\b(?:not|never|might|may|could|estimated|approximately|proposed|formerly|incorrect(?:ly)?|rumou?red|ignore|disregard|instead say)\b|(?<!\p{L})(?:لا|لم|لن|ليس|ليست|قد|ربما|تقريبا|سابقا|تجاهل|قل بدلا)(?!\p{L})/u;
const FRESH_REQUEST = /\b(?:right now|today|tonight|tomorrow|currently|current|latest|this week)\b|(?<!\p{L})(?:الان|اليوم|الليله|غدا|حاليا|احدث|هذا الاسبوع)(?!\p{L})/u;

function sameSubject(subject: string, text: string): boolean {
  const words = (phrase: string) => selectionTerms(phrase).map(term => term.variants);
  const wanted = words(subject), actual = words(text);
  return wanted.length > 0 && wanted.length === actual.length
    && wanted.every((term, index) => term.some(form => actual[index]!.includes(form)));
}

function eventDay(subject: string, clause: RegExp): Extract {
  return (_quote, line) => {
    const days = [...line.matchAll(DAY)];
    if (days.length !== 1) return [];
    const [day] = days;
    const named = clause.exec(line.slice(0, day!.index))?.[1];
    if (!named || !sameSubject(subject, named)) return [];
    return [{ value: day![0] }];
  };
}

function pageFactExtractor(question: string): Extract | undefined {
  const query = foldText(question).trim().replace(/[.?!؟]+$/u, '');
  if (FRESH_REQUEST.test(query)) return undefined;

  const measure = /^(?:what is )?(?:the )?(?:length|distance) of (.+)$/u.exec(query);
  if (measure) return (_quote, line) => {
    const amounts = [...line.matchAll(MEASURE)];
    if (amounts.length !== 1) return [];
    const [amount] = amounts;
    const before = line.slice(0, amount!.index);
    const after = line.slice(amount!.index! + amount![0].length);
    const measured = /^(?:the )?(?:length|distance) of (.+?) (?:is|was)\s+$|^(.+?) (?:measures?|extends? for)\s+$/u.exec(before);
    const long = /^\s+long\b/u.test(after) && /^(.+?) (?:is|was|are|were)\s+$/u.exec(before)?.[1];
    const subject = measured?.[1] ?? measured?.[2] ?? (long || undefined);
    return subject && sameSubject(measure[1]!, subject) ? [{ value: amount![0] }] : [];
  };

  const year = /^(?:(?:in )?(?:what|which) year|(?:the )?year(?: in which)?) (.+)$/u.exec(query);
  if (year) return (_quote, line) => {
    const dates = [...line.matchAll(/\b(?:in|during) (?:the year )?(\d{4})\b/gu)];
    return dates.length === 1 && sameSubject(year[1]!, line.slice(0, dates[0]!.index)) ? [{ value: dates[0]![1]! }] : [];
  };

  const weekday = /^(?:which|what) (?:week)?day (.+?) (?:is |are |does |do )?(closed|closes?|opens?|starts?|begins?|ends?)$/u.exec(query);
  if (weekday) {
    const predicate = weekday[2]!.replace(/s$/u, '');
    return eventDay(weekday[1]!, new RegExp(`^(.+?) (?:is |are |was |were )?${predicate}s? (?:on )?$`, 'u'));
  }
  const arabicWeekday = /^(?:في )?اي يوم (تبدا|يبدا|تنتهي|ينتهي|تفتح|يفتح|تغلق|يغلق) (.+)$/u.exec(query);
  if (arabicWeekday) return eventDay(arabicWeekday[2]!, new RegExp(`^${arabicWeekday[1]}\\s+([^،؛.!?؟]+?)(?:\\s+يوم)?\\s+$`, 'u'));

  const closeTime = /^(?:the )?closing time(?: (?:on |يوم )?(.+))?$/u.exec(query);
  if (closeTime && (!closeTime[1] || [...closeTime[1].matchAll(DAY)].length === 1)) return (_quote, line) => {
    const days = [...line.matchAll(DAY)];
    if (closeTime[1] && (days.length !== 1 || closeTime[1] !== days[0]![0]
        || !/(?:\bon |(?<!\p{L})يوم )$/u.test(line.slice(0, days[0]!.index)))) return [];
    const clocks = [...line.matchAll(CLOCK)];
    if (clocks.length !== 1) return [];
    const [clock] = clocks;
    const before = line.slice(0, clock!.index);
    const after = line.slice(clock!.index! + clock![0].length);
    const direct = !clock![0].startsWith('until') && /\b(?:closes?|closing time)\s*$|(?<!\p{L})(?:تغلق|يغلق|الاغلاق)\s*$/u.test(before);
    const closes = direct
      || /(?:\buntil\s*$|(?<!\p{L})الي\s*$)/u.test(before) && /^(?:\s+)(?:then closes?|ثم (?:تغلق|يغلق))(?!\p{L})/u.test(after);
    return closes ? [{ value: `${clock![1]}${clock![2]}`.replace(/\s+/gu, '') }] : [];
  };

  const attribution = /^who (made|created|designed|built|painted|wrote) (.+)$/u.exec(query);
  if (attribution) return (quote, line) => {
    const action = attribution[1] === 'wrote' ? 'written' : attribution[1];
    const agent = new RegExp(`\\b(?:was|were|is|are) ${action} by\\s+`, 'u').exec(line);
    const subject = agent && line.slice(0, agent.index).replace(/^(?:the )?(?:set|pair|collection|series) of\s+/u, '');
    if (!subject || !sameSubject(attribution[2]!, subject)) return [];
    // Preserve the original spelling and the capitalization that identifies a name.
    const name = new RegExp(`\\b(?:was|were|is|are) ${action} by\\s+(${NAME.source})`, 'u').exec(quote)?.[1];
    return name ? [{ value: foldText(name) }] : [];
  };

  const identifier = /^(?:what is )?(?:the )?([\p{L}-]+) number(?:\s*[,،]?\s+(?:(?:the )?(?:number|value|الرقم|القيمه) )?(only|فقط))?$/u.exec(query);
  if (identifier) return (quote) => {
    const label = identifier[1]!;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${label} number\\s*(?::\\s*)?(\\p{Nd}+)(?![\\p{L}\\p{N}/-]|\\.[\\p{L}\\p{N}])`, 'giu');
    return [...quote.matchAll(pattern)].map(match => ({ value: foldText(match[1]!), quote: identifier[2] ? match[1] : undefined }));
  };

  const price = /^(?:(?:what is )?the )?(?:(?:price|cost|fare) (?:of|for) |(?:سعر|تكلفه|اجره) )(.+)$/u.exec(query);
  if (price) return (_quote, line) => {
    const amounts = [...line.matchAll(MONEY)];
    if (amounts.length !== 1) return [];
    const [amount] = amounts;
    const before = line.slice(0, amount!.index);
    const labelled = /^(?:the )?(?:price|cost|fare) (?:of|for) (.+?) (?:is|was)\s+$|^(?:(?:تبلغ|يبلغ) )?(?:سعر|تكلفه|اجره) (.+?)\s+$/u.exec(before);
    const subject = labelled?.[1] ?? labelled?.[2] ?? /^(.+?) costs?\s+$/u.exec(before)?.[1];
    return subject && sameSubject(price[1]!, subject) ? [{ value: amount![0] }] : [];
  };
  return undefined;
}

/** Find a single, directly observed fact on a page the user chose. An empty result means the recognized field was unproved. */
export function selectPageFact(page: SelectionPage, question: string): string[] | undefined {
  const extract = pageFactExtractor(question);
  if (!extract) return undefined;
  const facts = new Map<string, string>();
  for (const candidate of quoteCandidates(page)) {
    if (candidate.kind === 'title' || isMetaLine(candidate.text)) continue;
    const folded = foldText(candidate.text);
    if (UNSAFE_CLAIM.test(folded)) continue;
    for (const fact of extract(candidate.text, folded)) {
      if (!facts.has(fact.value)) facts.set(fact.value, fact.quote ?? candidate.text);
    }
  }
  return facts.size === 1 ? [...facts.values()] : [];
}
