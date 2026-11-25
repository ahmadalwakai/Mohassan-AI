/**
 * Browser visibility: the five levels of docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §6.1, decided by code.
 *
 *   0  no browser and no network: the computer answers by itself
 *   1  network without a browser: a public question answered by reading over HTTP
 *   2  a hidden browser in the background: the panel stays closed behind a small chip
 *   3  the browser in front of the user: an explicit ask, or a step only the user can do
 *   4  forbidden: a line with the reason and the alternative, and no browser starts
 *
 * The request-time table reads the routing the chat already decided (state.routing.route) and the owner's
 * own words; without a route it falls back to the same rules the browser hands use. A run may change the
 * level later only with a logged reason (changeBrowserVisibility): the first page it opens, a sign-in, a
 * code, a human check or an approval; after the user's step it returns to 2. Nothing here is a model.
 */
import type { ChatBrowserVisibility, ChatBrowserVisibilityLevel } from '@mohassan/contracts';
import { directRoute } from './brain.js';
import { LIVE, notWebReason, parseHands, tidy, webQuestion } from './hands.js';

export type VisibilityCode =
  | 'local_compute' | 'local_memory' | 'local_card' | 'local_chat' | 'reminder' | 'computer' | 'ads' | 'coding' | 'unsupported' | 'clarify' | 'reply' | 'unknown'
  | 'web_knowledge' | 'web_live'
  | 'browser_steps' | 'news_page' | 'browser_started' | 'background_resumed'
  | 'explicit_show' | 'open_only' | 'needs_login' | 'needs_code' | 'hands_on' | 'needs_approval'
  | 'member_no_browser';
export type VisibilityLanguage = 'ar' | 'en';
export interface VisibilityChoice { level: ChatBrowserVisibilityLevel; code: VisibilityCode; reason: string }
export interface VisibilityRequest {
  request: string;
  /** Earlier user messages of the conversation, oldest first; a follow-up borrows the previous topic. */
  earlier?: readonly string[];
  role?: 'owner' | 'member';
  /** The chat's own routing decision (state.routing.route) when it exists; the rules decide without it. */
  route?: string | null;
}

export const requestLanguage = (text: string): VisibilityLanguage => /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en';

const LEVEL_OF: Record<Exclude<VisibilityCode, 'browser_started' | 'needs_login' | 'needs_code' | 'hands_on' | 'needs_approval'>, ChatBrowserVisibilityLevel> = {
  local_compute: 0, local_memory: 0, local_card: 0, local_chat: 0, reminder: 0, computer: 0, ads: 0, coding: 0, unsupported: 0, clarify: 0, reply: 0, unknown: 0,
  web_knowledge: 1, web_live: 1,
  browser_steps: 2, news_page: 2, background_resumed: 2,
  explicit_show: 3, open_only: 3,
  member_no_browser: 4,
};
const REASONS: Record<keyof typeof LEVEL_OF, Record<VisibilityLanguage, string>> = {
  local_compute: { ar: 'حساب محلي؛ لا يحتاج متصفحًا', en: 'A local calculation; no browser needed' },
  local_memory: { ar: 'من ذاكرتك أو حسابك؛ لا يحتاج متصفحًا', en: 'From your memory or account; no browser needed' },
  local_card: { ar: 'بطاقة أسئلة ثم نص من قالب؛ لا يحتاج متصفحًا', en: 'A card of questions, then a template; no browser needed' },
  local_chat: { ar: 'رد مباشر؛ لا يحتاج متصفحًا', en: 'A direct reply; no browser needed' },
  reminder: { ar: 'تذكير؛ لا يحتاج متصفحًا', en: 'A reminder; no browser needed' },
  computer: { ar: 'أمر للحاسوب؛ لا يحتاج متصفحًا', en: 'A computer command; no browser needed' },
  ads: { ar: 'إعلانات عبر الواجهة الرسمية؛ لا يحتاج متصفحًا', en: 'Ads through the official API; no browser needed' },
  coding: { ar: 'عمل على الكود؛ لا يحتاج متصفحًا', en: 'Code work; no browser needed' },
  unsupported: { ar: 'خارج القدرات الحالية؛ لا يحتاج متصفحًا', en: 'Outside the current capabilities; no browser needed' },
  clarify: { ar: 'الطلب يحتاج توضيحًا؛ لا متصفح قبل ذلك', en: 'The request needs clarification; no browser before that' },
  reply: { ar: 'جواب على بطاقة الأسئلة؛ لا يحتاج متصفحًا', en: 'An answer to the question card; no browser needed' },
  unknown: { ar: 'لم يتحدد المسار بعد؛ لا متصفح حتى يُعرف', en: 'The path is not decided yet; no browser until it is' },
  web_knowledge: { ar: 'سؤال معرفة عامة: بحث عبر الشبكة دون متصفح', en: 'General knowledge: searched over the network without a browser' },
  web_live: { ar: 'معلومة حية: بحث عبر الشبكة، ومتصفح مخفي إن لزم', en: 'Live information: searched over the network, a hidden browser if needed' },
  browser_steps: { ar: 'خطوات داخل موقع في متصفح مخفي', en: 'Steps inside a site in a hidden browser' },
  news_page: { ar: 'قراءة عناوين الصفحة الرئيسية في متصفح مخفي', en: 'Reading the front-page headlines in a hidden browser' },
  background_resumed: { ar: 'أكملتَ الخطوة؛ يتابع في الخلفية', en: 'You finished the step; continuing in the background' },
  explicit_show: { ar: 'طلبت عرض المتصفح', en: 'You asked to see the browser' },
  open_only: { ar: 'طلبت فتح الموقع لعرضه', en: 'You asked to open the site to see it' },
  member_no_browser: { ar: 'لا متصفح حاسوب للأعضاء. اسألني سؤالًا وسأبحث لك عنه عبر الشبكة.', en: 'Members have no computer browser. Ask me a question and I will look it up over the network.' },
};

const choose = (code: keyof typeof LEVEL_OF, lang: VisibilityLanguage): VisibilityChoice => ({ level: LEVEL_OF[code], code, reason: REASONS[code][lang] });

/** «أرني», «اعرض لي», «شوفني», "show me", "let me see": a wish to watch. */
const SHOW_VERB = /(?:^|[\s،,])(?:و?أرني|و?اعرض(?:ي|ه|ها)?(?:\s+لي)?|و?عرض\s+لي|و?شوفني|و?ورّ?يني|خل(?:ي|ني|يني)\s+أشوف)(?=[\s،,.؟?!]|$)|\b(?:show (?:me|it|us)|let me (?:see|watch)|display (?:it|the page))\b/iu;
/** The thing to watch is the browser itself, not an answer: «اعرض لي أخبار اليوم» wants headlines in the chat, «اعرض لي الصفحة» wants the panel. */
// No \b after Arabic letters: JavaScript's \b knows only ASCII word characters.
const BROWSER_OBJECT = /(?:^|\s)(?:موقعً?ا?|المتصفح|الموقع|الصفحة|الفيديو)(?=[\s،,.؟?!]|$)|\b(?:the )?(?:browser|site|website|page|video)\b/iu;
/** Words that name the browser outright. */
const BROWSE = /(?:^|\s)و?(?:تصفح|افتح\s+(?:لي\s+)?المتصفح)(?=[\s،,.؟?!]|$)|\b(?:open the browser|browse)\b/iu;
/** Only a site to open and nothing to do there: seeing it is the whole request. */
const OPEN_ONLY = /^(?:(?:افتح|open)\s+)?(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?[\s.!]*$/iu;
const explicitShow = (text: string, browserCommand: boolean) => BROWSE.test(text) || SHOW_VERB.test(text) && (browserCommand || BROWSER_OBJECT.test(text));
const ROUTE_CODES: Record<string, keyof typeof LEVEL_OF> = {
  compute: 'local_compute', memory: 'local_memory', writing: 'local_card', planning: 'local_card', chat: 'local_chat', reminder: 'reminder',
  pc: 'computer', ads: 'ads', coding: 'coding', unsupported: 'unsupported', image: 'unsupported', media: 'unsupported', clarify: 'clarify', reply: 'reply',
};
const NOT_WEB_CODES: Record<string, keyof typeof LEVEL_OF> = {
  arithmetic: 'local_compute', reminder: 'reminder', writing: 'local_card', planning: 'local_card', chat: 'local_chat', memory_ads_pc: 'local_memory', empty: 'clarify',
};

function browserCommand(text: string, role: 'owner' | 'member', lang: VisibilityLanguage, bareOpen: boolean): VisibilityChoice {
  if (role === 'member') return choose('member_no_browser', lang);
  if (explicitShow(text, true)) return choose('explicit_show', lang);
  if (bareOpen || OPEN_ONLY.test(text)) return choose('open_only', lang);
  return choose('browser_steps', lang);
}

function webLevel(text: string, lang: VisibilityLanguage): VisibilityChoice { return choose(LIVE.test(text) ? 'web_live' : 'web_knowledge', lang); }
function newsLevel(role: 'owner' | 'member', lang: VisibilityLanguage): VisibilityChoice { return role === 'member' ? choose('web_knowledge', lang) : choose('news_page', lang); }

/** The request-time table (§6.1). Deterministic: the same words and routing always give the same level. */
export function decideBrowserVisibility(input: VisibilityRequest): VisibilityChoice {
  const text = tidy(input.request.normalize('NFC'));
  const lang = requestLanguage(input.request);
  const role = input.role ?? 'owner';
  if (!text) return choose('clarify', lang);
  const base = tableChoice(text, role, lang, input);
  // A wish to watch a public lookup («اعرض لي الصفحة») puts the browser in front; members have no panel to watch.
  if (role === 'owner' && (base.level === 1 || base.level === 2) && explicitShow(text, false)) return choose('explicit_show', lang);
  return base;
}

function tableChoice(text: string, role: 'owner' | 'member', lang: VisibilityLanguage, input: VisibilityRequest): VisibilityChoice {
  const route = input.route ?? null;
  const direct = directRoute(text);
  if (route && route in ROUTE_CODES) return choose(ROUTE_CODES[route]!, lang);
  if (route === 'news') return newsLevel(role, lang);
  if (route === 'browser_command') return browserCommand(text, role, lang, Boolean(direct?.finishes));
  if (route === 'web_search') return webLevel(text, lang);
  // No routing decision: the browser hands' own rules, as rulesRoute() in router.ts reads them.
  const steps = parseHands(text);
  if (steps) return steps.some(step => step.kind === 'news') ? newsLevel(role, lang) : browserCommand(text, role, lang, false);
  if (direct) return browserCommand(text, role, lang, direct.finishes);
  if (webQuestion(text, input.earlier ?? [])) return webLevel(text, lang);
  const reason = notWebReason(text);
  if (reason === 'address') return browserCommand(text, role, lang, OPEN_ONLY.test(text));
  if (reason && reason in NOT_WEB_CODES) return choose(NOT_WEB_CODES[reason]!, lang);
  return choose('unknown', lang);
}

/** The run opened its first page: a hidden browser is now working. `step` is the last step label the run logged. */
export function browserStartedChoice(step: string | null, lang: VisibilityLanguage): VisibilityChoice {
  const label = step?.replace(/…+$/u, '').trim();
  return { level: 2, code: 'browser_started', reason: label ? lang === 'ar' ? `فُتح متصفح مخفي: ${label}` : `A hidden browser opened: ${label}` : lang === 'ar' ? 'فُتح متصفح مخفي لقراءة الصفحة' : 'A hidden browser opened to read the page' };
}

/** A step only the user can do: the panel opens in front of them with this line in its header. */
export function userStepChoice(secure: { kind: 'login' | 'code' | 'hands_on'; site: string }, lang: VisibilityLanguage): VisibilityChoice {
  const site = secure.site.replace(/^https?:\/\//u, '');
  if (secure.kind === 'login') return { level: 3, code: 'needs_login', reason: lang === 'ar' ? `هذه الخطوة تحتاجك: تسجيل الدخول إلى ${site}` : `This step needs you: sign in to ${site}` };
  if (secure.kind === 'code') return { level: 3, code: 'needs_code', reason: lang === 'ar' ? `هذه الخطوة تحتاجك: رمز التحقق من ${site}` : `This step needs you: the verification code from ${site}` };
  return { level: 3, code: 'hands_on', reason: site ? lang === 'ar' ? `هذه الخطوة تحتاجك في ${site}` : `This step needs you at ${site}` : lang === 'ar' ? 'هذه الخطوة تحتاجك' : 'This step needs you' };
}

/** A sensitive send waits for the owner's review: the page is shown with the approval card. */
export function approvalChoice(host: string, lang: VisibilityLanguage): VisibilityChoice {
  return { level: 3, code: 'needs_approval', reason: lang === 'ar' ? `مراجعة قبل الإرسال إلى ${host}` : `Review before sending to ${host}` };
}

export const backgroundChoice = (lang: VisibilityLanguage): VisibilityChoice => choose('background_resumed', lang);

export function createBrowserVisibility(choice: VisibilityChoice, options: { canView: boolean; lang: VisibilityLanguage; at?: Date }): ChatBrowserVisibility {
  const at = (options.at ?? new Date()).toISOString();
  return { version: 1, level: choice.level, code: choice.code, reason: choice.reason, lang: options.lang, decidedAt: at, requested: choice.level, canView: options.canView,
    history: [{ level: choice.level, code: choice.code, at }] };
}

/** Raises or lowers the level with its reason; the request-time level stays in `requested`. Unchanged input returns the same object. */
export function changeBrowserVisibility(current: ChatBrowserVisibility, choice: VisibilityChoice, at = new Date()): ChatBrowserVisibility {
  if (current.level === choice.level && current.code === choice.code) return current;
  const stamp = at.toISOString();
  return { ...current, level: choice.level, code: choice.code, reason: choice.reason, decidedAt: stamp, history: [...current.history, { level: choice.level, code: choice.code, at: stamp }].slice(-8) };
}

export interface DerivedVisibilityInput {
  /** The latest user message of the conversation. */
  request: string;
  route?: string | null;
  role: 'owner' | 'member';
  /** The conversation has a browser page (live or saved). */
  hasPage: boolean;
  status: string;
  secure: { kind: 'login' | 'code' | 'hands_on'; site: string } | null;
  approval: { prompt?: string } | null;
  handsOn?: VisibilityChoice;
  /** The first step the run logged, for the reason of a hidden browser that the table did not expect. */
  firstStep?: string | null;
  decidedAt: string;
}

const APPROVAL_HOST = /(?:إلى|to)\s+([\w.-]+\.[a-z]{2,})/iu;

/**
 * The level the conversation is at now, read from what the server already stores: the request-time table, then
 * a step that waits for the user (level 3), or a page the table did not expect (level 2). Nothing is written
 * to decide it, so the same rows always give the same record, and the run returns to 2 by itself once the user's
 * step is answered.
 */
export function deriveBrowserVisibility(input: DerivedVisibilityInput): ChatBrowserVisibility {
  const lang = requestLanguage(input.request);
  const requested = decideBrowserVisibility({ request: input.request, route: input.route ?? null, role: input.role });
  let current = requested;
  if (input.status === 'waiting_input' && input.secure) current = input.handsOn ?? userStepChoice(input.secure, lang);
  else if (input.status === 'waiting_approval' && input.approval) current = approvalChoice(APPROVAL_HOST.exec(input.approval.prompt ?? '')?.[1] ?? (lang === 'ar' ? 'الموقع' : 'the site'), lang);
  else if (input.hasPage && requested.level < 2) current = browserStartedChoice(input.firstStep ?? null, lang);
  const history = current === requested ? [{ level: requested.level, code: requested.code, at: input.decidedAt }]
    : [{ level: requested.level, code: requested.code, at: input.decidedAt }, { level: current.level, code: current.code, at: input.decidedAt }];
  return { version: 1, level: current.level, code: current.code, reason: current.reason, lang, decidedAt: input.decidedAt, requested: requested.level, canView: input.role === 'owner', history };
}

/** True when the panel should open by itself for this record under the owner's setting. */
export function opensPanel(visibility: Pick<ChatBrowserVisibility, 'level' | 'code' | 'canView'>, setting: 'needed' | 'always' | 'necessary'): boolean {
  if (!visibility.canView) return false;
  if (setting === 'always') return visibility.level >= 2;
  if (visibility.level !== 3) return false;
  return setting === 'needed' || visibility.code !== 'explicit_show' && visibility.code !== 'open_only';
}
