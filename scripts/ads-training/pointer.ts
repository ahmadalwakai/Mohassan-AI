/**
 * Pointer outputs (owner's choice, 2026-11-13): the model selects, it never copies text.
 *
 * Run 2's failures were copy failures: "Wigan" became "Wolverhampton", "bellabarbers" became
 * "bell Help!com", and site lines came back too long or half written. Here the brain numbers
 * the input, the model answers with numbers only, and the brain turns the numbers back into
 * the exact words of the input. A wrong pick is still possible; a misspelt copy is not.
 *
 * ads.goal.v2: the sentence's words are numbered [1] [2] ...; the answer names word spans.
 *   "make ads for kerbsidetyres.co.uk in Wigan, £20 a day"
 *   -> "intent create_campaign; url 4; locations 6; amount 7; currency £; period day"
 * ads.site.v2: the title's segments are [T1] [T2] ..., the lines [1] [2] ..., and a line with
 *   several sentences shows them as [5.1] [5.2]. The answer names units:
 *   "business T1 2; headlines B T2 4 7; descriptions 5.2 8"
 *   B is the business name; "T1 2" is the first two words of T1. Keywords are not answered:
 *   the brain derives them from the chosen headlines (keywordsFrom), as the teacher does.
 *   With usableOnly (pointer-v2) the prompt lists only lines the brain could use: a headline,
 *   a description sentence, or a line that starts with the business name. Line numbers keep
 *   their place, so the answer format is unchanged. The decoder drops picks the brain cannot
 *   use (a line too long for a headline, a menu word, a repeat), keeping the rest for the gate.
 *
 * Both checkers (checkGoal, checkSiteAds) still judge the decoded answer.
 */
import { canonicalJson } from './lib.js';
import { budgetNumbers, CURRENCY_WORDS, GOAL_WORDS, type Budget, type Currency, type Goal } from './goal.js';
import { ADS_LIMITS } from '../../packages/google-ads/src/quality.js';
import {
  businessKey, businessPrefix, descriptionCandidates, descriptionOk, headlineOk, keywordsFrom, sentencesOf, titleSegments, trimLine, words, type SiteAds, type SiteInput,
} from './site.js';

export const GOAL_POINTER_CAPABILITY = 'ads.goal.v2';
export const SITE_POINTER_CAPABILITY = 'ads.site.v2';
export const POINTER_DATASET_VERSION = 'ads-pointer-v1';
/** v2: longer training services (goal), and site prompts that number only lines the brain can use. */
export const POINTER_DATASET_VERSION_V2 = 'ads-pointer-v2';

// ---------------------------------------------------------------- goal
const EDGE_START = /^[(["'“‘«]+/, EDGE_END = /[)\]"'”’»,.!?;:،؛؟]+$/;

/** The sentence's words as the model sees them: split on spaces, outer punctuation removed ("Wigan," -> "Wigan"). */
export function goalWords(message: string): string[] {
  return message.split(/\s+/).filter(Boolean).map(chunk => chunk.replace(EDGE_START, '').replace(EDGE_END, '') || chunk);
}

export const renderGoalPointerPrompt = (message: string) =>
  `Ads task: ${GOAL_POINTER_CAPABILITY}\nWords:${goalWords(message).map((word, index) => ` [${index + 1}] ${word}`).join('')}\nOutput:\n`;

const firstNumber = (word: string) => { const amounts = budgetNumbers(word); return amounts.length === 1 ? amounts[0]! : null; };
/** @offset selects an exact suffix of the first Arabic word, without inventing stripped letters. */
type Span = [number, number, number?];
const arabicWord = (word: string) => /^(?:\p{Script=Arabic}|\p{M})+$/u.test(word);
const spanText = (list: readonly string[], [start, end, offset = 0]: Span) => [list[start - 1]!.slice(offset), ...list.slice(start, end)].join(' ');
const spanRef = ([start, end, offset = 0]: Span) => `${start === end ? start : `${start}-${end}`}${offset ? `@${offset}` : ''}`;

function findSpan(list: readonly string[], value: string, taken: Set<number>): Span | null {
  const size = words(value).length;
  for (let start = 1; start + size - 1 <= list.length; start++) {
    if (taken.has(start)) continue;
    if (spanText(list, [start, start + size - 1]) === value) return [start, start + size - 1];
  }
  // A labelled Arabic entity may be written after an attached preposition/conjunction.
  // Match its exact source suffix, never remove letters or add an article by inference.
  for (let start = 1; start + size - 1 <= list.length; start++) {
    if (taken.has(start) || !arabicWord(list[start - 1]!)) continue;
    for (let offset = 1; offset <= 3 && offset < list[start - 1]!.length; offset++) {
      if (spanText(list, [start, start + size - 1, offset]) === value) return [start, start + size - 1, offset];
    }
  }
  return null;
}

/** Exact word spans, optionally starting within an Arabic word; otherwise null. */
export function goalToPointer(message: string, goal: Goal): string | null {
  if (goal.intent === 'other') return 'intent other';
  const list = goalWords(message), taken = new Set<number>();
  const parts = ['intent create_campaign'];
  const pick = (value: string) => { const span = findSpan(list, value, taken); if (span) taken.add(span[0]); return span; };
  if (goal.url !== null) { const span = pick(goal.url); if (!span) return null; parts.push(`url ${spanRef(span)}`); }
  if (goal.service !== null) { const span = pick(goal.service); if (!span) return null; parts.push(`service ${spanRef(span)}`); }
  if (goal.locations.length) {
    const spans = goal.locations.map(pick);
    if (spans.some(span => !span)) return null;
    parts.push(`locations ${(spans as Span[]).map(spanRef).join(' ')}`);
  }
  if (goal.budget) {
    const index = list.findIndex(word => !URL_WORD.test(word) && firstNumber(word) === goal.budget!.amount);
    if (index < 0) return null;
    parts.push(`amount ${index + 1}`, `currency ${goal.budget.currency ?? 'none'}`, `period ${goal.budget.period}`);
  }
  if (goal.goal) parts.push(`goal ${goal.goal}`);
  return parts.join('; ');
}

const GOAL_FIELDS = ['intent', 'url', 'service', 'locations', 'amount', 'currency', 'period', 'goal'];

/** Reads a pointer answer back into a Goal, or returns null when it is not well formed. */
export function pointerToGoal(message: string, answer: string): Goal | null {
  const list = goalWords(message);
  const fields = new Map<string, string>();
  for (const part of answer.trim().split(/\s*;\s*/).filter(Boolean)) {
    const match = part.match(/^([a-z]+)\s+(.+)$/);
    if (!match || !GOAL_FIELDS.includes(match[1]!) || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!.trim());
  }
  // Fields must come in the fixed order, so one answer has one spelling.
  const order = [...fields.keys()].map(name => GOAL_FIELDS.indexOf(name));
  if (order.some((value, index) => index && value < order[index - 1]!)) return null;
  const intent = fields.get('intent');
  if (intent === 'other') return fields.size === 1 ? { intent: 'other', url: null, service: null, locations: [], budget: null, goal: null } : null;
  if (intent !== 'create_campaign') return null;
  const span = (ref: string): string | null => {
    const match = ref.match(/^(\d+)(?:-(\d+))?(?:@([1-3]))?$/);
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2] ?? match[1]), offset = Number(match[3] ?? 0);
    if (start < 1 || end < start || end > list.length || end - start >= 6) return null;
    const first = list[start - 1]!;
    if (offset && (!arabicWord(first) || offset >= first.length || /^\p{M}/u.test(first.slice(offset)))) return null;
    return spanText(list, [start, end, offset]);
  };
  const one = (name: string) => { const ref = fields.get(name); return ref === undefined ? undefined : span(ref); };
  const url = one('url'), service = one('service');
  if (url === null || service === null) return null;
  const locations: string[] = [];
  for (const ref of (fields.get('locations') ?? '').split(/\s+/).filter(Boolean)) { const place = span(ref); if (place === null) return null; locations.push(place); }
  let budget: Budget | null = null;
  const budgetFields = ['amount', 'currency', 'period'].filter(name => fields.has(name));
  if (budgetFields.length === 3) {
    const index = Number(fields.get('amount'));
    const amount = Number.isInteger(index) && index >= 1 && index <= list.length ? firstNumber(list[index - 1]!) : null;
    const currency = fields.get('currency')!, period = fields.get('period')!;
    if (!amount || !(currency === 'none' || Object.hasOwn(CURRENCY_WORDS, currency)) || !['day', 'week', 'month'].includes(period)) return null;
    budget = { amount, currency: currency === 'none' ? null : currency as Currency, period: period as Budget['period'] };
  } else if (budgetFields.length) return null;
  const goal = fields.get('goal') ?? null;
  if (goal !== null && !['calls', 'bookings', 'leads'].includes(goal)) return null;
  return { intent: 'create_campaign', url: url ?? null, service: service ?? null, locations, budget, goal: goal as Goal['goal'] };
}

/** A word the brain can see is a web address without any model: the checker's own URL shape. */
const URL_WORD = /^[\w:/.-]+\.[a-z]{2,}(?:\/[\w/-]*)?$/i;
/** Request words that can sit at the edge of a service span ("my cleaning business", "do house removals"). */
const SERVICE_EDGE = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'i', 'we', 'do', 'for', 'in', 'at', 'on', 'of', 'to', 'and', 'with', 'from', 'around', 'near',
  'business', 'company', 'firm', 'website', 'site', 'selling', 'sell', 'sells', 'offer', 'offering', 'is', 'are', 'google', 'ads', 'campaign',
  'across', 'covering', 'targeting', 'throughout', 'only', 'please', 'thanks', 'need', 'want', 'daily', 'per', 'by', 'via', 'through',
  'في', 'على', 'من', 'إلى', 'الى', 'حول', 'فقط', 'موقع', 'موقعي', 'موقعنا', 'الموقع', 'شركتي', 'شركتنا', 'نشاطي',
  'اعلان', 'إعلان', 'إعلانات', 'اعلانات', 'حملة', 'جوجل', 'غوغل', 'ميزانية', 'الميزانية', 'أريد', 'اريد', 'بدي', 'أبغى', 'ابغى', 'استهدف', 'استهداف']);

/**
 * The brain's repair of a goal answer before decoding (owner, 2026-11-14: "improve understanding").
 *
 * The goal model learnt where the link usually sits in its training phrasings ("ads for <url>"),
 * so on a new phrasing ("ads for mobile tyre fitting on <url>") it points one word early and
 * checkGoal rejects the whole answer, though the service and places it chose are right. Only
 * what the brain can see in the sentence itself is repaired; what the model understood is kept:
 *   - url: the one word shaped like a web address, wherever the model pointed;
 *   - amount: the one word with a number in it, when the model pointed at a word without one;
 *   - service: the link word and request words at its edges are cut off ("bakery sweetcrumbs.com",
 *     "my cleaning business"); a service with nothing left is dropped, not the whole answer;
 *   - locations: a pick that is the link or a number is dropped;
 *   - goal: a goal no word of the sentence names ("leads" when nobody asked for any) is dropped.
 * With two links or two numbers the brain cannot tell which one is meant, so it keeps the model's pick.
 */
export function repairGoalPointer(message: string, answer: string): string {
  const list = goalWords(message);
  const parts = answer.trim().split(/\s*;\s*/).filter(Boolean).map(part => { const match = part.match(/^([a-z]+)\s+(.+)$/); return match ? [match[1]!, match[2]!.trim()] as [string, string] : null; });
  if (parts.some(part => part === null) || parts[0]?.[0] !== 'intent' || parts[0][1] !== 'create_campaign') return answer;
  const fields = parts as [string, string][];
  const urls = list.flatMap((word, index) => URL_WORD.test(word) ? [index + 1] : []);
  const numbers = list.flatMap((word, index) => firstNumber(word) && !URL_WORD.test(word) ? [index + 1] : []);
  const at = (name: string) => fields.findIndex(([field]) => field === name);
  const set = (name: string, value: string | null) => {
    const index = at(name);
    if (value === null) { if (index >= 0) fields.splice(index, 1); return; }
    if (index >= 0) { fields[index]![1] = value; return; }
    // A new field goes in its fixed place, so the answer keeps one spelling.
    const order = GOAL_FIELDS.indexOf(name), after = fields.findIndex(([field]) => GOAL_FIELDS.indexOf(field) > order);
    fields.splice(after < 0 ? fields.length : after, 0, [name, value]);
  };
  const parseSpan = (ref: string): Span | null => { const match = ref.match(/^(\d+)(?:-(\d+))?(?:@([1-3]))?$/); return match ? [Number(match[1]), Number(match[2] ?? match[1]), Number(match[3] ?? 0)] : null; };

  const url = urls.length === 1 ? urls[0]! : null;
  if (url !== null) set('url', String(url));
  const link = url ?? (at('url') >= 0 ? parseSpan(fields[at('url')]![1])?.[0] ?? null : null);

  // Arabic prefix offsets are explicit model choices. Protect that field, while allowing
  // independent URL/amount/goal repairs; an offset is not a reason to skip the whole answer.
  if (at('service') >= 0 && !fields[at('service')]![1].includes('@')) {
    let span = parseSpan(fields[at('service')]![1]);
    if (span && link !== null && span[0] <= link && link <= span[1]) span = span[0] < link ? [span[0], link - 1] : link < span[1] ? [link + 1, span[1]] : null;
    while (span && span[0] <= span[1] && SERVICE_EDGE.has(list[span[0] - 1]?.toLowerCase() ?? '')) span = [span[0] + 1, span[1]];
    while (span && span[0] <= span[1] && SERVICE_EDGE.has(list[span[1] - 1]?.toLowerCase() ?? '')) span = [span[0], span[1] - 1];
    // A plain next word is not evidence that it belongs to the service. Keep the model's
    // ending rather than extending into another clause based on an incomplete stop-list.
    set('service', span && span[0] <= span[1] ? spanRef(span) : null);
  }
  if (at('locations') >= 0) {
    const kept = fields[at('locations')]![1].split(/\s+/).filter(ref => {
      const span = parseSpan(ref);
      return !span || !(span[0] <= (link ?? 0) && (link ?? 0) <= span[1]) && !list.slice(span[0] - 1, span[1]).some(word => firstNumber(word));
    });
    set('locations', kept.length ? kept.join(' ') : null);
  }
  const goal = at('goal') >= 0 ? fields[at('goal')]![1] : null;
  if (goal !== null && goal in GOAL_WORDS && !GOAL_WORDS[goal as keyof typeof GOAL_WORDS].test(message)) set('goal', null);
  if (at('amount') >= 0 && numbers.length === 1) {
    const index = Number(fields[at('amount')]![1]);
    if (!Number.isInteger(index) || !firstNumber(list[index - 1] ?? '') || URL_WORD.test(list[index - 1] ?? '')) set('amount', String(numbers[0]));
  }
  return fields.map(([field, value]) => `${field} ${value}`).join('; ');
}

// ---------------------------------------------------------------- site
interface SiteUnits { segments: string[]; lines: string[]; sentences: string[][] }
const siteUnits = (input: SiteInput): SiteUnits => {
  const lines = input.text ? input.text.split('\n') : [];
  return { segments: titleSegments(input.title), lines, sentences: lines.map(sentencesOf) };
};

const headlineText = (units: SiteUnits, ref: string) => { const text = unitText(units, ref); return text === null ? null : trimLine(text); };
const usableSentence = (sentence: string) => { const text = descriptionCandidates(sentence)[0]; return text !== undefined && descriptionOk(text); };

export function renderSitePointerPrompt(input: SiteInput, options: { usableOnly?: boolean } = {}): string {
  const units = siteUnits(input), key = businessKey(input.site);
  const rows = [`Ads task: ${SITE_POINTER_CAPABILITY}`, `Site: ${input.site}`];
  units.segments.forEach((segment, index) => rows.push(`[T${index + 1}] ${segment}`));
  units.lines.forEach((line, index) => {
    const parts = units.sentences[index]!;
    if (!options.usableOnly) {
      if (parts.length === 1) rows.push(`[${index + 1}] ${line}`);
      else parts.forEach((sentence, part) => rows.push(`[${index + 1}.${part + 1}] ${sentence}`));
      return;
    }
    const whole = headlineOk(trimLine(line)) || businessPrefix(line, key) !== null;
    if (parts.length === 1) { if (whole || usableSentence(line)) rows.push(`[${index + 1}] ${line}`); return; }
    if (whole) rows.push(`[${index + 1}] ${line}`);
    parts.forEach((sentence, part) => { if (usableSentence(sentence)) rows.push(`[${index + 1}.${part + 1}] ${sentence}`); });
  });
  return `${rows.join('\n')}\nOutput:\n`;
}

const unitText = (units: SiteUnits, ref: string): string | null => {
  const title = ref.match(/^T(\d+)$/);
  if (title) return units.segments[Number(title[1]) - 1] ?? null;
  return /^\d+$/.test(ref) ? units.lines[Number(ref) - 1] ?? null : null;
};
const businessText = (text: string, count: number) => words(text).slice(0, count).join(' ').replace(/[,.;:&-]+$/, '').trim();
function descriptionText(units: SiteUnits, ref: string): string | null {
  const match = ref.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const parts = units.sentences[Number(match[1]) - 1];
  if (!parts || (match[2] === undefined) !== (parts.length === 1)) return null;
  return descriptionCandidates(parts[Number(match[2] ?? 1) - 1] ?? '')[0] ?? null;
}

/** The pointer answer for the teacher's ads, or null when a line cannot be found again. */
export function siteToPointer(input: SiteInput, ads: SiteAds): string | null {
  const units = siteUnits(input);
  const refs = [...units.segments.map((_, index) => `T${index + 1}`), ...units.lines.map((_, index) => String(index + 1))];
  const parts: string[] = [];
  if (ads.business !== null) {
    let found: string | null = null;
    for (const ref of refs) {
      const text = unitText(units, ref)!;
      for (let count = 1; count <= words(text).length && !found; count++) if (businessText(text, count) === ads.business) found = `${ref} ${count}`;
      if (found) break;
    }
    if (!found) return null;
    parts.push(`business ${found}`);
  }
  const headlineRefs: string[] = [];
  for (const headline of ads.headlines) {
    const ref = headline === ads.business ? 'B' : refs.find(item => headlineText(units, item) === headline);
    if (!ref) return null;
    headlineRefs.push(ref);
  }
  parts.push(`headlines ${headlineRefs.join(' ')}`);
  const descriptionRefs: string[] = [];
  for (const description of ads.descriptions) {
    let ref: string | undefined;
    units.sentences.forEach((sentences, line) => sentences.forEach((_, part) => {
      const candidate = sentences.length === 1 ? String(line + 1) : `${line + 1}.${part + 1}`;
      if (!ref && descriptionText(units, candidate) === description) ref = candidate;
    }));
    if (!ref) return null;
    descriptionRefs.push(ref);
  }
  parts.push(`descriptions ${descriptionRefs.join(' ')}`);
  return parts.join('; ');
}

/** Reads a pointer answer back into ads in the site's own words, or returns null when it is not well formed. */
export function pointerToSite(input: SiteInput, answer: string): SiteAds | null {
  const units = siteUnits(input);
  const fields = new Map<string, string>();
  for (const part of answer.trim().split(/\s*;\s*/).filter(Boolean)) {
    const match = part.match(/^(business|headlines|descriptions)\s+(.+)$/);
    if (!match || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!.trim());
  }
  if (!fields.has('headlines') || !fields.has('descriptions')) return null;
  let business: string | null = null;
  if (fields.has('business')) {
    const match = fields.get('business')!.match(/^(T?\d+)\s+(\d+)$/);
    const text = match ? unitText(units, match[1]!) : null;
    if (!match || text === null || Number(match[2]) < 1 || Number(match[2]) > words(text).length) return null;
    business = businessText(text, Number(match[2]));
  }
  // A ref to a unit that does not exist is a malformed answer. A ref the brain cannot use
  // (not a headline, not a description, a repeat, or past Google's maximum) is dropped.
  const headlines: string[] = [], seen = new Set<string>();
  for (const ref of fields.get('headlines')!.split(/\s+/)) {
    if (ref !== 'B' && unitText(units, ref) === null) return null;
    const text = ref === 'B' ? business : headlineText(units, ref);
    if (!text || !headlineOk(text) || seen.has(text.toLowerCase()) || headlines.length >= ADS_LIMITS.maxHeadlines) continue;
    seen.add(text.toLowerCase());
    headlines.push(text);
  }
  const descriptions: string[] = [];
  for (const ref of fields.get('descriptions')!.split(/\s+/)) {
    const match = ref.match(/^(\d+)(?:\.(\d+))?$/);
    const parts = match ? units.sentences[Number(match[1]) - 1] : undefined;
    if (!match || !parts || (match[2] === undefined) !== (parts.length === 1) || Number(match[2] ?? 1) > parts.length) return null;
    const text = descriptionText(units, ref);
    if (!text || !descriptionOk(text) || descriptions.some(item => item.toLowerCase() === text.toLowerCase()) || descriptions.length >= ADS_LIMITS.maxDescriptions) continue;
    descriptions.push(text);
  }
  return { business, headlines, descriptions, keywords: keywordsFrom(headlines, business) };
}

export const samePointerAds = (a: SiteAds, b: SiteAds) => canonicalJson(a) === canonicalJson(b);
