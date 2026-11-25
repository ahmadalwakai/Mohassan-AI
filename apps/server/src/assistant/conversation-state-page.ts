import { safeResumeUrl, type AgentPage } from '@mohassan/browser';
import { directRoute } from './brain.js';
import { reviewBrowserRequestScope } from './browser-request-scope.js';
import { analyzeCompoundRequest } from './compound-request.js';
import type { HandsPlan } from './hands.js';
import { assessRequestScope, requestScopeActionText } from './request-scope.js';

export interface ConversationPageAnchor {
  goal: string;
  status: string;
  openedUrl: string;
}

export interface ConversationPageSelection {
  plan: HandsPlan;
  question: string;
  previous: string | null;
}

export interface ConversationPageRead {
  expectedUrl?: string;
  readPublic?: boolean;
}

const INITIAL_OPEN = /^((?:(?:please|من فضلك)\s+)?(?:open|visit|go to|navigate to|افتح|ادخل(?:\s+على)?|اذهب إلى)\s+https?:\/\/[^\s<>"'«»،,]+)\s*[,،]?\s+(?:(?:and(?: then)?|then|ثم)\s+|و\s*)(.+)$/iu;
const READ_HEAD = /^(?:(?:read|report|state|quote|extract|list)\s+|(?:tell|show|give) me\s+|(?:[اأإ]قر[اأ]|[اأإ]خبرني|قل|[اأإ]عرض|[اأإ]ذكر)(?:\s+لي)?\s+)/iu;
const QUESTION = /^(?:what|where|who|whom|when|how|why|which)\b|(?:^|[^\p{L}])(?:ما|ماذا|اين|وين|متي|من|مين|اي|ايش|شو|وش|شنو|كم|كام|كيف|ليش|ليه|لماذا)(?!\p{L})/iu;
const FOLLOW_LEAD = /^(?:(?:and\s+)?(?:what|how) about\s+|and\s+|(?:طيب|طب|وماذا عن|وماذا بخصوص)[\s،]+|و(?=\p{Script=Arabic}))/iu;
const REFERENCE = /\b(?:it|its|that|those|there|one|same|this page)\b|(?:^|\s)(?:هناك|هنا|هذي|هذا|هذه|ذلك|تلك|نفس\p{L}*|الذي|التي|فيها|فيه|عليها|عليه)(?!\p{L})/iu;
const OTHER_ACTION = /\b(?:click|tap|submit|type|log[ -]?in|sign[ -]?in|download|upload|delete|send|purchase|buy|book|save|remember|publish|rewrite|translate|search|open|visit|navigate|replace|create)\b|(?:^|[^\p{L}])(?:[وف])?(?:اضغط|انقر|سجل|اكتب|ارسل|احذف|حمل|نزل|اشتر|احجز|احفظ|انشر|ترجم|ابحث|افتح|ادخل|بدل|انشي)(?!\p{L})/iu;

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه');

const selectorGroups = [
  ['monday', 'اثنين'], ['tuesday', 'ثلاثاء'], ['wednesday', 'اربعاء'], ['thursday', 'خميس'],
  ['friday', 'جمعه'], ['saturday', 'سبت'], ['sunday', 'احد'],
  ['morning', 'صباح', 'صباحي', 'صباحيه'], ['afternoon', 'ظهر', 'ظهرا'], ['evening', 'مساء', 'مسائي', 'مسائيه'],
  ['first', 'initial', 'start', 'begin', 'beginning', 'depart', 'اول', 'اولي', 'بدايه', 'بدا', 'تبدا', 'يبدا', 'ينطلق', 'تنطلق'],
  ['last', 'final', 'end', 'finish', 'terminus', 'اخر', 'اخير', 'اخيره', 'نهايه', 'ينتهي', 'تنتهي'],
] as const;
const relatedWords = [
  ['time', 'hour', 'ساعه', 'موعد', 'توقيت'], ['open', 'يفتح', 'تفتح', 'افتتاح', 'استقبال'],
  ['stop', 'station', 'محطه', 'موقف'], ['fee', 'charge', 'cost', 'price', 'payment', 'رسوم', 'رسم', 'تكلفه', 'سعر', 'دفع'],
  ['talk', 'lecture', 'presentation', 'محاضره', 'ندوه'], ['run', 'lead', 'host', 'give', 'given', 'manage', 'direct', 'يدير', 'تدير', 'مدير'],
  ['leave', 'depart', 'departure', 'يغادر', 'تغادر', 'مغادره'], ['duration', 'minute', 'hour', 'دقيقه', 'ساعه', 'مده', 'تستغرق', 'يستغرق'],
  ['found', 'establish', 'اسس', 'تاسيس'], ['publish', 'publication', 'نشر'],
  ['language', 'لغه', 'لغت', 'لغتا', 'لغتان', 'لغتين', 'لغات'],
] as const;
const STOP_WORDS = new Set('a an the to it its at in on for from and then of is are be been does do did was were when how what where who which whom about long that those this these they them their he she one same there please me year ما ماذا متي كيف من مين اين وين اي كم كام في علي عن الي هو هي هم اللي لي ذلك تلك هذا هذه يوم نفس سنه عام'.split(' '));
const WORD = /[\p{L}\p{N}]+/gu;
const TOKEN_VARIANTS = new Map<string, string>();
for (const [base, ...variants] of [...relatedWords, ...selectorGroups]) {
  for (const word of [base, ...variants]) TOKEN_VARIANTS.set(word, base);
}
const selectorWords = new Map<string, number>(selectorGroups.flatMap((group, index) => group.map(word => [word, index] as const)));

function stems(token: string): string[] {
  // Keep the original token as well. Prefix removal is only for matching and
  // cannot change the question or the words quoted from the page.
  if (/^\p{Script=Arabic}/u.test(token)) {
    const bare = token.replace(/^[وف]?(?:[بكل]?ال|لل)/u, '');
    const withoutPrefix = bare.replace(/^(?:[وف][بل]?|[بل])(?=\p{L}{3})/u, '');
    const withoutPronoun = withoutPrefix.replace(/(?:ها|هما|هم)$/u, '');
    const verb = withoutPronoun.replace(/ه$/u, '').replace(/^(?:ات|ان)(?=\p{L}{3})/u, '').replace(/(?:وا?|ت)$/u, '');
    return [token, bare, withoutPrefix, withoutPronoun, verb];
  }
  return [token, token.replace(/(?:ing|ed|s)$/u, ''), token.replace(/(?:es|ing|ed)$/u, 'e')];
}

function words(text: string): Set<string> {
  const result = new Set<string>();
  for (const token of fold(text).match(WORD) ?? []) {
    if (STOP_WORDS.has(token) || STOP_WORDS.has(token.replace(/^[وف](?=\p{Script=Arabic})/u, '')) || token.length < 2) continue;
    const variants = stems(token);
    const known = variants.find(variant => TOKEN_VARIANTS.has(variant));
    // Use verb stems only for known word families. Blindly trimming the end
    // of an Arabic noun can merge separate subjects into the same term.
    const term = known ? TOKEN_VARIANTS.get(known)! : variants.slice(0, /^\p{Script=Arabic}/u.test(token) ? 4 : undefined).findLast(variant => variant.length > 2) ?? token;
    if (!STOP_WORDS.has(term)) result.add(term);
  }
  return result;
}

function selectors(text: string): { token: string; group: number; family: number }[] {
  return (text.match(WORD) ?? []).flatMap(token => {
    const group = stems(fold(token)).map(word => selectorWords.get(word)).find(index => index !== undefined);
    return group === undefined ? [] : [{ token, group, family: group < 7 ? 0 : group < 10 ? 1 : 2 }];
  });
}

function explicitPage(request: string): { url: string; name: string; question: string } | null {
  const match = INITIAL_OPEN.exec(requestScopeActionText(request).trim());
  if (!match) return null;
  const open = directRoute(match[1]!);
  const url = open?.finishes && !open.screenshot ? safeResumeUrl(open.url) : null;
  const question = match[2]!.replace(READ_HEAD, '').trim();
  if (!url || !open || question === match[2] && !QUESTION.test(fold(question))) return null;
  return { url, name: open.name, question };
}

function readOnlyQuestion(question: string): boolean {
  if (!question || question.length > 300 || /https?:\/\/|[;؛\n]/iu.test(question) || OTHER_ACTION.test(fold(question))) return false;
  const analysis = analyzeCompoundRequest(question);
  const { source, operation } = assessRequestScope(analysis.outerText);
  return analysis.kind === 'single' && !analysis.literalRanges.length && (operation === 'lookup' || operation === 'unknown')
    && source !== 'prior_conversation' && source !== 'supplied_content' && source !== 'local_state';
}

function inheritPageQuestion(question: string, previous: string): string {
  if (QUESTION.test(fold(question)) && !/\b(?:one|ones)\b/iu.test(question)) return question;
  const current = selectors(question);
  const earlier = selectors(previous);
  if (current.length !== 1) return question;
  const slot = earlier.filter(item => item.family === current[0]!.family && item.group !== current[0]!.group);
  if (slot.length !== 1) return question;
  // Substitute a single observed day, period or sequence position into the
  // owner's prior question. No words from the page become instructions.
  return previous.replace(/\p{L}+/gu, word => word === slot[0]!.token ? current[0]!.token : word);
}

/** Plan a read on the user's explicit URL, or a question about the same observed page. */
export function planConversationPageRead(request: string, previous?: ConversationPageAnchor): ConversationPageSelection | null {
  if (!reviewBrowserRequestScope(request, 'browser_navigation').allowed || !reviewBrowserRequestScope(request, 'browser_action').allowed) return null;
  const explicit = explicitPage(request);
  if (explicit && readOnlyQuestion(explicit.question)) {
    return { question: explicit.question, previous: null, plan: { next: 0, lang: /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en', steps: [
      { kind: 'open', url: explicit.url, name: explicit.name },
      { kind: 'ask_page', question: explicit.question, conversationPage: {} },
    ] } };
  }
  if (previous?.status !== 'completed') return null;
  const prior = explicitPage(previous.goal);
  const expectedUrl = safeResumeUrl(previous.openedUrl);
  if (!prior || !expectedUrl || expectedUrl !== prior.url || !readOnlyQuestion(prior.question)) return null;
  const original = requestScopeActionText(request).trim();
  const question = original.replace(FOLLOW_LEAD, '').trim();
  const follows = question !== original;
  if (!readOnlyQuestion(question) || !/[?؟]\s*$/u.test(original)
    || (!follows && !REFERENCE.test(fold(question))) || (!QUESTION.test(fold(question)) && !selectors(question).length)) return null;
  const standalone = inheritPageQuestion(question, prior.question);
  if (!readOnlyQuestion(standalone)) return null;
  return { question: standalone, previous: prior.question, plan: { next: 0, lang: /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en', steps: [
    { kind: 'ask_page', question: standalone, conversationPage: { expectedUrl } },
  ] } };
}

export function matchesConversationPage(page: AgentPage, context: ConversationPageRead): boolean {
  const url = safeResumeUrl(page.url);
  return url !== null && (!context.readPublic || !!context.expectedUrl) && (!context.expectedUrl || url === context.expectedUrl)
    && (page.documentStatus === undefined ? !context.readPublic : page.documentStatus >= 200 && page.documentStatus < 300);
}

/** Quote the closest supported sentence from the current page. If the request
 * selects a day, period or endpoint, a neighbouring slot cannot answer it. */
export function readConversationPageLines(page: AgentPage, question: string): string[] {
  const asked = words(question);
  if (!asked.size) return [];
  const selected = new Set(selectors(question).map(item => item.group));
  const matching = fold(question);
  const wantsYear = /\b(?:what|which) year\b|(?:^|\s)(?:سنه|عام)\s+(?:كم|كام|ايه)(?=\s|\p{P}|$)|(?:^|\s)في\s+اي\s+(?:سنه|عام)(?=\s|\p{P}|$)/u.test(matching);
  const wantsNumber = /\b(?:how (?:much|many|long)|price|cost|fee|duration|opening time|what time)\b|(?:^|\s)(?:ساعه|كم|كام|مده|رسوم|تكلفه|سعر)(?=\s|\p{P}|$)/u.test(matching);
  const segmenter = new Intl.Segmenter(/\p{Script=Arabic}/u.test(page.text) ? 'ar' : 'en', { granularity: 'sentence' });
  let best = 0;
  let answer: string[] = [];
  for (const item of segmenter.segment(page.text.slice(0, 40_000))) {
    const line = item.segment.trim();
    if (!line || line.length > 420 || (wantsNumber && !/\p{N}/u.test(line))
      || (wantsYear && !/(?<!\p{Nd})\p{Nd}{4}(?!\p{Nd})/u.test(line))) continue;
    const available = new Set(selectors(line).map(entry => entry.group));
    if ([...selected].some(group => !available.has(group))) continue;
    const observed = words(line);
    const overlap = [...asked].filter(value => observed.has(value)).length;
    if (!overlap || (asked.size > 2 && overlap < 2)) continue;
    if (overlap > best) { best = overlap; answer = [line]; }
    else if (overlap === best && !answer.includes(line)) answer.push(line);
  }
  return answer.length === 1 ? answer : [];
}
