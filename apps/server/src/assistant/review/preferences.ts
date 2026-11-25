import { ownWords, textLanguage } from '../answer-check.js';
import { normalizeReviewText, reviewTokens, type Preference } from './ledger.js';

export interface PreferenceIssue {
  code: 'name_spelling' | 'reply_language' | 'reply_length' | 'reply_format' | 'reply_units' | 'avoided_content';
  fixed?: string;
}

const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\r\n]*`|https?:\/\/[^\s<>]+|!?\[[^\]\n]*\]\([^\)\n]*\)|«[^»\n]*»|“[^”\n]*”|"[^"\n]*"/gu;
const NAME_WORD = String.raw`[\p{L}\p{M}]+(?:[-’'][\p{L}\p{M}]+)*`;
const NAME = new RegExp(String.raw`^${NAME_WORD}(?:\s+${NAME_WORD}){0,3}$`, 'u');
const ADDRESS = /(?:^|[\n.!?؟]\s+|\n\s*)(?:\s*)(?:(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|welcome|thanks|thank you)(?=[\s,])\s*,?\s*|(?:(?:مرحب[\p{M}]*ا[\p{M}]*|[أا]هل[\p{M}]*ا[\p{M}]*|شكر[\p{M}]*ا[\p{M}]*|تحي[\p{L}\p{M}]*|صباح الخير|مساء الخير)[،,]?\s+(?:يا\s+)?|يا\s+))/gimu;
const NAMED_AS = /(?<![\p{L}\p{N}])(?:your name (?:is|should be written)|i['’]ll call you|i will call you|اسمك (?:هو|يكتب|يُكتب)|س[أا]ناديك(?: باسم)?)\s+/giu;
const VOCATIVE = /[,،]\s+/gu;
const ADDRESS_CONTEXT = /\b(?:you|your|yours)\b|(?:^|\s)(?:لك|إليك|اليك|أنت|انت|اسمك|عندك|أرسلت لك|ارسلت لك)(?!\p{L})/iu;
const GREETING_WORDS = new Set(['all', 'everyone', 'there', 'team', 'friend', 'folks', 'again', 'brother', 'sister', 'both', 'man', 'sir', 'madam', 'جميعا', 'بك', 'بكم', 'صديقي', 'صديقتي', 'اخي', 'اختي']);

const MARKDOWN_BULLET = /^\s*[-*+•]\s+\S/u;
const NUMBERED_ITEM = /^\s*\p{Nd}+[.)-]\s+\S/u;
const TABLE_ROW = /^\s*\|?.+\|.+\|?\s*$/u;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;
const MARKDOWN = /(?:^|\n)\s*(?:[-+*#>]\s+|\p{Nd}+[.)]\s+)|\*\*|__|`|\[[^\]]+\]\([^\)]+\)/u;
const UNIT_PATTERN = /(\p{Nd}[\p{Nd}.,٬٫]*)(?:\s*)(°\s*[CF]|degrees?\s+(?:celsius|fahrenheit)|millimeters?|millimetres?|centimeters?|centimetres?|kilometers?|kilometres?|kilograms?|centigrade|fahrenheit|celsius|lit(?:er|re)s?|meters?|metres?|grams?|miles?|yards?|inches|inch|feet|foot|pounds?|gallons?|ounces?|mph|kph|km|cm|mm|mi|kg|lbs?|ft|yd|oz|m|g|l|كيلو\s*(?:متر|مترات|غرام|جرام|غرامات|جرامات)|كيلو(?:متر|مترات|غرام|جرام|غرامات|جرامات)|كلم|كم|سم|ملم|كغ|كجم|متر(?:ات)?|[أا]متار|لتر(?:ات)?|غرام(?:ات)?|جرام(?:ات)?|ميل(?:ا|ات)?|[أا]ميال|قدم|[أا]قدام|بوص(?:ة|ات)|رطل|[أا]رطال|غالون(?:ات)?|درج(?:ة|ات)\s*(?:مئوية|فهرنهايت))(?![\p{L}\p{M}])/giu;

const UNIT_NAMES: Record<string, RegExp> = {
  celsius: /^(?:celsius|centigrade|degrees? celsius|c|درج(?:ه|ات) مئويه)$/u,
  fahrenheit: /^(?:fahrenheit|degrees? fahrenheit|f|درج(?:ه|ات) فهرنهايت)$/u,
  km: /^(?:km|kph|kilomet(?:er|re)s?|كيلو ?متر(?:ات)?|كم|كلم)$/u,
  mi: /^(?:mi|mph|miles?|ميل(?:ا|ات)?|اميال)$/u,
  kg: /^(?:kg|kilograms?|كيلو ?[غج]رام(?:ات)?|كغ|كجم)$/u,
  lb: /^(?:lbs?|pounds?|رطل|ارطال)$/u,
  m: /^(?:m|met(?:er|re)s?|متر(?:ات)?|امتار)$/u,
  ft: /^(?:ft|feet|foot|قدم|اقدام)$/u,
  metric: /^(?:millimet(?:er|re)s?|centimet(?:er|re)s?|lit(?:er|re)s?|grams?|mm|cm|g|l|سم|ملم|لتر(?:ات)?|[غج]رام(?:ات)?)$/u,
  imperial: /^(?:yards?|inch(?:es)?|gallons?|ounces?|yd|oz|بوص(?:ه|ات)|غالون(?:ات)?)$/u,
};

const UNIT_GROUPS: Record<string, { family: string; dimension: string }> = {
  celsius: { family: 'metric', dimension: 'temperature' },
  fahrenheit: { family: 'imperial', dimension: 'temperature' },
  km: { family: 'metric', dimension: 'length' },
  mi: { family: 'imperial', dimension: 'length' },
  kg: { family: 'metric', dimension: 'weight' },
  lb: { family: 'imperial', dimension: 'weight' },
  m: { family: 'metric', dimension: 'length' },
  ft: { family: 'imperial', dimension: 'length' },
  metric: { family: 'metric', dimension: '' },
  imperial: { family: 'imperial', dimension: '' },
};

function closeSpelling(actual: string, wanted: string): boolean {
  const first = Array.from(normalizeReviewText(actual));
  const second = Array.from(normalizeReviewText(wanted));
  if (first.join('') === second.join('')) return true;
  if (Math.min(first.length, second.length) < 3 || Math.abs(first.length - second.length) > 1) return false;
  if (/\p{Script=Arabic}/u.test(actual) !== /\p{Script=Arabic}/u.test(wanted)) return false;
  if (first.length > second.length) return closeSpelling(wanted, actual);
  const mismatch = first.findIndex((letter, index) => letter !== second[index]);
  if (mismatch === -1) return true;
  const tail = first.slice(mismatch + 1).join('');
  if (first.length !== second.length) return first.slice(mismatch).join('') === second.slice(mismatch + 1).join('');
  return tail === second.slice(mismatch + 1).join('')
    || first[mismatch] === second[mismatch + 1] && first[mismatch + 1] === second[mismatch]
      && first.slice(mismatch + 2).join('') === second.slice(mismatch + 2).join('');
}

function repairName(draft: string, preference: Preference, allowGreeting: boolean): string {
  if (!NAME.test(preference.value)) return draft;
  const blocked = [...draft.matchAll(PROTECTED)].map(match => [match.index, match.index + match[0].length] as const);
  const names = [preference.value, preference.alias].filter((name): name is string => Boolean(name && NAME.test(name)));
  const counts = [...new Set(names.map(name => name.split(/\s+/u).length))].sort((a, b) => b - a);
  const heads = [...draft.matchAll(NAMED_AS), ...(allowGreeting ? draft.matchAll(ADDRESS) : [])];
  const edits = new Map<number, string>();

  for (const head of heads) {
    const start = head.index + head[0].length;
    if (blocked.some(([from, to]) => head.index < to && start >= from)) continue;
    const tail = draft.slice(start, start + 160);
    if (tail.startsWith(preference.value) && !/^[\p{L}\p{M}]/u.test(tail.slice(preference.value.length))) continue;
    for (const count of counts) {
      const candidate = new RegExp(String.raw`^${NAME_WORD}(?:\s+${NAME_WORD}){${count - 1}}(?![\p{L}\p{M}])`, 'u').exec(tail)?.[0];
      if (!candidate || GREETING_WORDS.has(normalizeReviewText(candidate))) continue;
      if (!names.some(name => closeSpelling(candidate, name))) continue;
      edits.set(start, candidate);
      break;
    }
  }
  if (allowGreeting) for (const head of draft.matchAll(VOCATIVE)) {
    const start = head.index + head[0].length;
    if (blocked.some(([from, to]) => head.index < to && start >= from)) continue;
    const preceding = draft.slice(Math.max(0, head.index - 150), head.index).split(/[.!?؟\n]/u).at(-1) ?? '';
    if (!ADDRESS_CONTEXT.test(preceding)) continue;
    const candidate = new RegExp(String.raw`^${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,3}(?=[.!?؟،,]|$)`, 'u').exec(draft.slice(start, start + 160))?.[0];
    if (candidate && candidate !== preference.value && !GREETING_WORDS.has(normalizeReviewText(candidate))
      && names.some(name => closeSpelling(candidate, name))) edits.set(start, candidate);
  }
  let fixed = draft;
  for (const [start, actual] of [...edits].sort(([a], [b]) => b - a)) {
    fixed = `${fixed.slice(0, start)}${preference.value}${fixed.slice(start + actual.length)}`;
  }
  return fixed;
}

function responseLanguage(reply: string, name: string | undefined) {
  const plain = ownWords(reply.replace(PROTECTED, ' ')).replaceAll(name || '\0', ' ');
  const language = textLanguage(plain);
  if (language !== 'none') return language;
  const arabic = /\p{Script=Arabic}/u.test(plain);
  const latin = /\p{Script=Latin}/u.test(plain);
  return arabic === latin ? 'none' : arabic ? 'ar' : 'en';
}

function formatMatches(reply: string, format: string): boolean {
  const lines = reply.trim().split(/\r?\n/u).filter(line => line.trim());
  switch (format) {
    case 'table': return lines.some((line, index) => TABLE_DELIMITER.test(line) && TABLE_ROW.test(lines[index - 1] ?? '') && TABLE_ROW.test(lines[index + 1] ?? ''));
    case 'bullets': return lines.length > 0 && lines.every(line => MARKDOWN_BULLET.test(line));
    case 'numbered': return lines.length > 0 && lines.every(line => NUMBERED_ITEM.test(line));
    case 'plain': return !MARKDOWN.test(reply) && !lines.some(line => TABLE_DELIMITER.test(line));
    case 'paragraph': return !MARKDOWN.test(reply) && !/\n\s*\n/u.test(reply.trim());
    case 'json':
      try {
        JSON.parse(reply.trim().replace(/^```json\s*([\s\S]*?)\s*```$/iu, '$1'));
        return true;
      } catch { return false; }
    default: return true;
  }
}

function lengthMatches(reply: string, preference: Preference): boolean {
  const count = Number(preference.value);
  if (Number.isSafeInteger(count) && count > 0) {
    if (preference.limit === 'words') return reviewTokens(reply).length <= count;
    if (preference.limit === 'lines') return reply.split(/\r?\n/u).filter(line => line.trim()).length === count;
    if (preference.limit === 'sentences') {
      return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(reply)].filter(item => item.segment.trim()).length === count;
    }
  }
  return preference.value === 'short' ? reviewTokens(reply).length <= 80
    : preference.value !== 'detailed' || reviewTokens(reply).length >= 12;
}

function wrongUnits(reply: string, wanted: string): boolean {
  const preference = UNIT_GROUPS[wanted];
  if (!preference) return false;
  for (const match of reply.replace(PROTECTED, ' ').matchAll(UNIT_PATTERN)) {
    const word = normalizeReviewText(match[2]!.replace(/ة/gu, 'ه'));
    const unit = Object.keys(UNIT_NAMES).find(key => UNIT_NAMES[key]!.test(word));
    if (!unit) continue;
    const group = UNIT_GROUPS[unit]!;
    if (!preference.dimension ? preference.family !== group.family
      : group.dimension === preference.dimension && wanted !== unit) return true;
  }
  return false;
}

export function checkPreferences(preferences: readonly Preference[], draft: string, request: string): PreferenceIssue[] {
  const issues: PreferenceIssue[] = [];
  const name = preferences.findLast(preference => preference.kind === 'name');
  for (const preference of preferences) {
    switch (preference.kind) {
      case 'name': {
        if (preference !== name) break;
        const writingForOthers = /^(?:please )?(?:write|draft|compose|translate|اكتب|صغ|ترجم)(?=\s|$)/u.test(normalizeReviewText(request));
        const fixed = repairName(draft, preference, !writingForOthers);
        if (fixed !== draft) issues.push({ code: 'name_spelling', fixed });
        break;
      }
      case 'language': {
        const actual = responseLanguage(draft, name?.value);
        if (actual !== 'none' && actual !== preference.value) issues.push({ code: 'reply_language' });
        break;
      }
      case 'length':
        if (!lengthMatches(draft, preference)) issues.push({ code: 'reply_length' });
        break;
      case 'format':
        if (!formatMatches(draft, preference.value)) issues.push({ code: 'reply_format' });
        break;
      case 'units':
        if (wrongUnits(draft, preference.value)) issues.push({ code: 'reply_units' });
        break;
      case 'avoid': {
        const unwanted = normalizeReviewText(preference.value);
        const inReply = normalizeReviewText(draft);
        const emoji = /^(?:emojis?|رموز تعبيري[هة])$/u.test(unwanted);
        const markdown = /^(?:markdown|ماركداون|تنسيق)$/u.test(unwanted);
        if (emoji ? /\p{Extended_Pictographic}/u.test(draft)
          : markdown ? MARKDOWN.test(draft)
          : unwanted && ` ${inReply} `.includes(` ${unwanted} `)) issues.push({ code: 'avoided_content' });
        break;
      }
    }
  }
  return issues;
}
