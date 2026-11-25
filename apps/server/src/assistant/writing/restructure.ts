import { matchText } from '../mind/normalize.js';
import { sentenceSpans, type EvidenceSpan, type WritingSource } from './evidence.js';
import type { WritingFormat } from './summary.js';

export interface RestructureOptions {
  format: WritingFormat;
  headings?: boolean;
  chronological?: 'ascending' | 'descending';
  extract?: 'actions' | 'dates' | 'both';
}

export interface RestructureGroup {
  heading?: EvidenceSpan;
  spans: EvidenceSpan[];
}

export interface RestructureResult {
  groups: RestructureGroup[];
  actions: EvidenceSpan[];
  dates: EvidenceSpan[];
}

interface TextBlock {
  start: number;
  end: number;
  bullet: boolean;
  checked?: boolean;
}

interface TextGroup {
  heading?: EvidenceSpan;
  blocks: TextBlock[];
}

const listMarker = /^(?:[-*+•▪◦‣]|\p{Nd}{1,3}[.)]|[(]\p{Nd}{1,3}[)])[ \t]+/u;
const checkMarker = /^\[([ xX])\][ \t]+/u;
const markdownHeading = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/du;
const boldHeading = /^\*\*(.+?)\*\*:?$/du;
const labelHeading = /^[\p{L}\p{N}][^.!؟?\r\n]{0,69}[:：]$/u;
const shortLabel = /^[\p{L}\p{N}][^\p{P}\r\n]{0,59}$/u;

function sourceSpan(source: WritingSource, start: number, end: number): EvidenceSpan {
  return { source, start, end, text: source.text.slice(start, end) };
}

/** Blank lines group paragraphs; list markers and headings are formatting, with literal content offsets retained. */
function readTextGroups(source: WritingSource): TextGroup[] {
  const groups: TextGroup[] = [];
  let current: TextGroup | undefined;
  for (const match of source.text.matchAll(/[^\r\n]*(?:\r\n?|\n|$)/gu)) {
    const line = match[0].trim();
    if (!line) {
      if (!current?.heading || current.blocks.length) current = undefined;
      continue;
    }
    const start = match.index + match[0].indexOf(line);
    const end = start + line.length;
    const marker = listMarker.exec(line);
    const heading = !marker && (markdownHeading.exec(line) ?? boldHeading.exec(line));
    const beforeList = !current && shortLabel.test(line) && listMarker.test(source.text.slice(match.index + match[0].length).trimStart());
    if (heading || !marker && (labelHeading.test(line) || beforeList)) {
      const [from, to] = heading && heading.indices?.[1] ? heading.indices[1] : [0, line.length];
      current = { heading: sourceSpan(source, start + from, start + to), blocks: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { blocks: [] };
      groups.push(current);
    }
    const contentStart = start + (marker?.[0].length ?? 0);
    const checkbox = checkMarker.exec(source.text.slice(contentStart, end));
    const previous = current.blocks.at(-1);
    if (!marker && !checkbox && previous && (!previous.bullet || /^[ \t]{2,}/u.test(match[0]))) {
      previous.end = end;
      continue;
    }
    current.blocks.push({ start: contentStart, end, bullet: Boolean(marker || checkbox), ...(checkbox ? { checked: checkbox[1] !== ' ' } : {}) });
  }
  return groups;
}

function blockSpans(source: WritingSource, block: TextBlock, itemize: boolean): EvidenceSpan[] {
  const whole = sourceSpan(source, block.start, block.end);
  if (block.bullet || !itemize) return [whole];
  const parts = sentenceSpans({ ...source, text: whole.text });
  return parts.length ? parts.map(part => sourceSpan(source, block.start + part.start, block.start + part.end)) : [whole];
}

function leadingHeading(item: EvidenceSpan): EvidenceSpan {
  const firstWords = /^\S+(?:[^\S\r\n]+\S+){0,5}/u.exec(item.text)?.[0] ?? item.text;
  return sourceSpan(item.source, item.start, item.start + firstWords.length);
}

const actionLabel = /^(?:action items?|actions?|to[ -]?do|next steps|required actions?|اجراءات مطلوبه|الاجراءات المطلوبه|المهام(?: المطلوبه)?|الخطوات التاليه|مطلوب)\s*[:：]?$/u;
const actionCue = /^(?:(?:action item|action|to[ -]?do|task|مهمه|اجراء مطلوب|مطلوب)\s*[:：]|(?:[\p{L}][\p{L} .-]{0,32}[:：]\s*)?(?:please\s+|(?:لا|رجاء)\s+)?(?:send|submit|review|prepare|call|email|schedule|check|confirm|update|complete|follow up|deliver|file|book|notify|assign|contact|verify|pay|sign|bring|provide|report|publish|ارسل|ارسلوا|ارسلي|سلم|سلمي|قدم|قدمي|راجع|راجعي|اتصل|اتصلي|اكد|اكدي|جهز|جهزي|حدث|اكمل|اكملوا|انشر|احجز|بلغ|وقع|تابع|ادفع|تحقق)(?![\p{L}\p{N}]))|\b(?:must|shall|needs? to|required to|should|due (?:by|on)|will (?:send|provide|review|prepare|contact|update|complete|confirm|submit|publish))\b|(?<!\p{L})(?:يجب|يتعين|ينبغي|عليكم|مطلوب|سوف يقوم|سوف تقوم)(?!\p{L})/u;

const months = [
  'january|jan|يناير|كانون الثاني|جانفي', 'february|feb|فبراير|شباط|فيفري', 'march|mar|مارس|اذار',
  'april|apr|ابريل|نيسان|افريل', 'may|مايو|ايار|ماي', 'june|jun|يونيو|حزيران|جوان',
  'july|jul|يوليو|يوليوز|تموز|جويليه', 'august|aug|اغسطس|اب|اوت|غشت', 'september|sept|sep|سبتمبر|ايلول|شتنبر',
  'october|oct|اكتوبر|تشرين الاول', 'november|nov|نوفمبر|تشرين الثاني|نونبر', 'december|dec|ديسمبر|كانون الاول|دجنبر',
].flatMap((row, index) => row.split('|').map(name => [name, index + 1] as const));

const monthChars: Record<string, string> = { ا: '[اأإآٱ]', ي: '[يىی]', ه: '[هة]' };
const monthPattern = [...months].sort(([a], [b]) => b.length - a.length).map(([name]) => [...name].map(char => {
  if (char === ' ') return '[ \\t]+';
  return /\p{Script=Arabic}/u.test(char) ? `${monthChars[char] ?? char}\\p{M}*` : char;
}).join('')).join('|');
const y = '[\\p{Nd}]{4}';
const d = '[\\p{Nd}]{1,2}';
const day = `(?:${d}(?:st|nd|rd|th)?|ال[اأ]ول)`;
const space = '[ \\t]+';
const seps = '[-/.]';
const namedDate = `(?:(?<namedDay>${day})${space}(?:(?:of|من)${space})?(?<dayMonth>${monthPattern})(?:[ \\t]*/[ \\t]*(?<monthAlias>${monthPattern}))?(?:[.,]?${space}(?<afterDayYear>${y}))?|(?<firstMonth>${monthPattern})\\.?${space}(?:(?<monthDay>${day})(?:,?${space}(?<afterMonthYear>${y}))?|(?<monthYear>${y})))`;
const enDays = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const arDays = '(?:ال)?(?:[أا]حد|[إا]ثنين|ثلاثاء|[أا]ربعاء|خميس|جمع[هة]|سبت)';
const relativeDate = `(?:(?:next|last|this)${space}${enDays}|(?<=(?:on|by|before|until|since)${space})${enDays}|today|tomorrow|yesterday|${arDays}${space}(?:المقبل|القادم|الماضي)|(?<=يوم${space})${arDays}|اليوم|غد[ًَ]?ا?[ًَ]?|[أا]مس)`;
const dateBoundary = '(?:(?<![\\p{L}\\p{M}\\p{N}])|(?<=(?:^|\\s)[وف])(?=\\p{Nd}))';
const datePattern = new RegExp(`${dateBoundary}(?:${y}${seps}${d}${seps}${d}|${d}${seps}${d}${seps}${y}|${namedDate}|${relativeDate})(?![\\p{L}\\p{M}\\p{N}])`, 'giu');

interface DateOrder { value: number; basis: 'calendar' | 'month-day' | 'relative' }
interface WrittenDate { span: EvidenceSpan; order?: DateOrder }

function numericDate(text: string): [number, number, number] | undefined {
  const parts = text.split(/[-/.]/u);
  if (parts.length !== 3 || parts.some(part => !/^\d+$/u.test(part))) return undefined;
  const [first, second, last] = parts.map(Number) as [number, number, number];
  if (parts[0]!.length === 4) return [first, second, last];
  // Year-last dates use day/month/year unless the second component can only be a day.
  return second > 12 && first <= 12 ? [last, first, second] : [last, second, first];
}

function namedMonth(name: string): number {
  const folded = matchText(name).replace(/\s+/gu, ' ');
  return months.find(([value]) => value === folded)?.[1] ?? 0;
}

function dateOrder(match: RegExpMatchArray): DateOrder | null | undefined {
  const groups = match.groups ?? {};
  const monthName = groups.dayMonth ?? groups.firstMonth;
  const explicitYear = groups.afterDayYear ?? groups.afterMonthYear ?? groups.monthYear;
  const dayValue = groups.namedDay ?? groups.monthDay;
  if (monthName && groups.monthAlias && namedMonth(monthName) !== namedMonth(groups.monthAlias)) return undefined;
  const folded = matchText(match[0]);
  const writtenDay = matchText(dayValue ?? '1');
  const parts = monthName ? [explicitYear ? Number(matchText(explicitYear)) : 2000, namedMonth(monthName),
    writtenDay === 'الاول' ? 1 : Number.parseInt(writtenDay, 10)] : numericDate(folded);
  if (!parts) {
    const dayOffsets: Record<string, number> = { yesterday: -1, today: 0, tomorrow: 1, امس: -1, اليوم: 0, غدا: 1, غد: 1 };
    return Object.hasOwn(dayOffsets, folded) ? { value: dayOffsets[folded]!, basis: 'relative' } : undefined;
  }
  const [year, month, date] = parts;
  if (year < 1000 || month < 1 || month > 12 || date < 1 || date > 31) return null;
  const stamp = Date.UTC(year, month - 1, date);
  return new Date(stamp).getUTCDate() === date ? { value: stamp, basis: monthName && !explicitYear ? 'month-day' : 'calendar' } : null;
}

function datesIn(span: EvidenceSpan): WrittenDate[] {
  return [...span.text.matchAll(datePattern)].flatMap(match => {
    const order = dateOrder(match);
    if (order === null) return [];
    const start = span.start + match.index;
    return [{ span: sourceSpan(span.source, start, start + match[0].length), order }];
  });
}

function sortSpans(spans: EvidenceSpan[], direction: NonNullable<RestructureOptions['chronological']>): EvidenceSpan[] {
  const sign = direction === 'ascending' ? 1 : -1;
  const entries = spans.map(span => ({ span, dates: datesIn(span) }));
  const basis = (['calendar', 'month-day', 'relative'] as const).find(basis => entries.some(entry => entry.dates.some(date => date.order?.basis === basis)));
  return entries.map(({ span, dates }) => ({ span, date: dates.find(date => date.order?.basis === basis)?.order?.value }))
    .sort((a, b) => a.date === undefined || b.date === undefined ? Number(a.date === undefined) - Number(b.date === undefined) : sign * (a.date - b.date))
    .map(({ span }) => span);
}

/** Restructuring changes layout. Every heading, item and explicit date is a span of the user's text. */
export function restructure(source: WritingSource, options: RestructureOptions): RestructureResult {
  const textGroups = readTextGroups(source);
  if (options.extract) {
    const actions: EvidenceSpan[] = [];
    const dates: EvidenceSpan[] = [];
    for (const group of textGroups) {
      if (group.heading && options.extract !== 'actions') dates.push(...datesIn(group.heading).map(date => date.span));
      const actionGroup = Boolean(group.heading && actionLabel.test(matchText(group.heading.text)));
      for (const block of group.blocks) {
        for (const span of blockSpans(source, block, true)) {
          if (options.extract !== 'dates' && block.checked !== true && (block.checked === false || actionGroup || actionCue.test(matchText(span.text)))) actions.push(span);
          if (options.extract !== 'actions') dates.push(...datesIn(span).map(date => date.span));
        }
      }
    }
    return { groups: [], actions: options.chronological ? sortSpans(actions, options.chronological) : actions,
      dates: options.chronological ? sortSpans(dates, options.chronological) : dates };
  }

  const groups = textGroups.map(group => ({
    heading: group.heading,
    spans: group.blocks.flatMap(block => blockSpans(source, block, options.format !== 'paragraph' || Boolean(options.chronological))),
  }));
  if (options.chronological) {
    const sorted = sortSpans(groups.flatMap(({ heading, spans }) => heading ? [heading, ...spans] : spans), options.chronological);
    return { groups: sorted.length ? [{ ...(options.headings ? { heading: leadingHeading(sorted[0]!) } : {}), spans: sorted }] : [], actions: [], dates: [] };
  }
  if (options.headings) {
    for (const group of groups) if (!group.heading && group.spans[0]) group.heading = leadingHeading(group.spans[0]);
  }
  return { groups, actions: [], dates: [] };
}
