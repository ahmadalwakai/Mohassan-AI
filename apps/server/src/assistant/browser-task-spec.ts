import { publicSearchScan, publicSearchText, safeResumeUrl } from '@mohassan/browser';
import { directRoute, namedSite, sensitiveAction } from './brain.js';
import type { HandsStep } from './hands.js';
import { isEntireLiteralRequest, parseUserRequestConstraints, requestCapabilityAllowed } from './request-constraints.js';

export type BrowserTaskRisk = 'read-only' | 'reversible-write' | 'irreversible';
export type BrowserTaskHuman = 'login' | 'code' | 'payment' | 'identifier' | 'challenge';
export type BrowserTaskSection = 'main' | 'tables' | 'lists' | 'forms' | 'all';

interface Site { url: string; name: string }
interface Match { role?: string; nearby?: string; position?: number }

export type BrowserTaskTarget = ({ kind: 'site' } & Site)
  | { kind: 'search'; query: string }
  | { kind: 'current' }
  | { kind: 'missing' };

type Step = ({ kind: 'open' } & Site)
  | { kind: 'find'; scope: 'web' | 'page'; site?: Site; target: string; match?: Match }
  | { kind: 'read'; section: BrowserTaskSection; target?: string; more?: boolean }
  | { kind: 'fill'; target: string; value?: string; human?: BrowserTaskHuman; match?: Match }
  | { kind: 'select'; target: string; value?: string; match?: Match }
  | { kind: 'click'; target: string; ordinal?: number; human?: BrowserTaskHuman; match?: Match }
  | { kind: 'download'; target: string; match?: Match }
  | { kind: 'upload'; target: string; file?: string; match?: Match };

export type BrowserTaskStep = Step & { risk: BrowserTaskRisk };
export interface BrowserTaskData {
  kind: 'site' | 'target' | 'value' | 'file' | 'manual' | 'instruction';
  name: string;
  step: number | null;
  supplied: boolean;
}
export interface BrowserTaskSuccess {
  step: number;
  kind: 'page-open' | 'element-found' | 'content-read' | 'value-read-back' | 'effect-observed'
    | 'file-downloaded' | 'file-selected' | 'human-completed';
}
export interface BrowserTaskSpec {
  target: BrowserTaskTarget;
  steps: BrowserTaskStep[];
  requiredData: BrowserTaskData[];
  success: BrowserTaskSuccess[];
  risk: BrowserTaskRisk;
  lang: 'ar' | 'en';
}

const MAX_STEPS = 10;
const QUOTES = /«[^»]*»|“[^”]*”|"(?:\\.|[^"\\\r\n])*"|(?<![\p{L}\p{N}])['‘][^'’\r\n]*['’](?![\p{L}\p{N}])|`[^`\r\n]*`/gu;
const POLITE = /^(?:(?:please|kindly|could you|can you|لو سمحت|من فضلك|ممكن|بدي|عايزك|عاوزك|ابغاك|ابيك|اريد منك)[،,\s]+)+/diu;
const BROWSER_LEAD = /^(?:(?:in|using) (?:the |your )?browser|(?:في|داخل|باستخدام|من) المتصفح)[،,:\s]+/diu;
const BROWSER_TAIL = /[،,\s]+(?:(?:in|using) (?:the |your )?browser|(?:في|داخل|باستخدام|من) المتصفح)$/diu;
const VERBS = {
  open: 'navigate to|go to|visit|open|افتح(?:لي)?|ادخل|اذهب|روح|خش',
  find: 'search for|search|look up|look for|find|ابحث(?:لي)?|دور(?:لي)?|فتش(?:لي)?|القي|جد(?:لي)?',
  read: 'read|summari[sz]e|show me|show|display|extract|list|اقرا(?:ها|ه|لي)?|اعرض(?:ها|ه|لي)?|ارني|لخص(?:ها|ه|لي)?|وريني|فرجيني|شوف',
  fill: 'fill out|fill in|fill|set|type|enter|write|عبي(?:لي)?|املا(?:لي)?|ملي|اكتب(?:لي)?|ادخل|حط(?:لي)?',
  select: 'select|choose|pick|اختر|اختار|حدد|انتقي',
  click: 'click|tap|press|اضغط(?:لي)?|انقر|اكبس|دوس',
  check: 'uncheck|check|tick|untick|الغ تحديد|شيل علامه|علم علي|حط علامه',
  upload: 'upload|attach|ارفع|ارفق',
  download: 'download|نزل(?:لي)?|حمل(?:لي)?',
} as const;
type Verb = keyof typeof VERBS;

const HEAD = Object.entries(VERBS).map(([kind, expression]) => ({
  kind: kind as Verb, pattern: new RegExp(`^(${expression})(?=\\s|$)\\s*`, 'diu'),
}));
const OTHER_ACTION = 'submit|send|delete|publish|pay|buy|purchase|ارسل|احذف|انشر|ادفع|اشتر';
const CONNECTOR = new RegExp(
  `[\\s،,]+(?:and\\s+then|then|ثم|وبعدين|بعدين|وبعدها|بعدها)\\s+|[؛;\\r\\n]+\\s*|[\\s،,]+(?:and\\s+|و\\s*|(?<=[،,])\\s*)(?=(?:${Object.values(VERBS).join('|')}|${OTHER_ACTION})(?=\\s|$))`, 'giu',
);
const OPEN_SITE_CONTEXT = /^(?:on|at|from|على|علي|في|داخل|من)\s+(.+?)[،,]\s+(.+)$/diu;
const ADDRESS = /^(?:https?:\/\/\S+|(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?)$/iu;
const CONTROL = /^(?:(?:the |this )?(button|link|checkbox|radio button|radio|drop-down|dropdown|select|field|textbox|option)\s+(.+)|(?:ال)?(زر|رابط|خانه|حقل|مربع اختيار|قائمه منسدله|قائمه|خيار)\s+(.+))$/diu;
const CONTROL_SUFFIX = /^(.+?)\s+(button|link|checkbox|radio button|radio|drop-down|dropdown|select|field|textbox|option)$/diu;
const CONTEXT = /^(.+?)\s+(?:near|beside|next to|under|بجانب|جنب|قرب|تحت|عند)\s+(.+)$/diu;
const POSITION = /^(?:(first|second|third|fourth|fifth|(?:\d+)(?:st|nd|rd|th)?)\s+(.+)|(.+?)\s+(الاول|الثاني|الثالث|الرابع|الخامس|[0-9٠-٩]+))$/diu;
const POSITIONS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  الاول: 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5,
};
const ROLES: Record<string, string> = {
  button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio', 'radio button': 'radio',
  dropdown: 'select', 'drop-down': 'select', select: 'select', field: 'textbox', textbox: 'textbox', option: 'option',
  زر: 'button', رابط: 'link', خانه: 'textbox', حقل: 'textbox', 'مربع اختيار': 'checkbox',
  'قائمه منسدله': 'select', قائمه: 'select', خيار: 'option',
};

function syntax(raw: string, maskQuotes = true) {
  const source = maskQuotes ? raw.replace(QUOTES, value => 'x'.repeat(value.length)) : raw;
  const offsets: number[] = [];
  let text = '';
  for (let index = 0; index < source.length; index += 1) {
    const letter = source[index];
    if (/[ـ\u064b-\u065f\u0670]/u.test(letter)) continue;
    offsets.push(index);
    text += letter.replace(/[أإآٱ]/u, 'ا').replace(/ى/u, 'ي').replace(/ة/u, 'ه');
  }
  offsets.push(raw.length);
  return {
    text,
    slice(start: number, end = text.length) {
      return raw.slice(offsets[start], offsets[end]);
    },
  };
}

/** Only syntax is folded. The matched spans return the supplied URL, labels and values verbatim. */
function groups(raw: string, pattern: RegExp): string[] | null {
  const view = syntax(raw);
  const match = pattern.exec(view.text);
  if (!match?.indices) return null;
  return match.indices.slice(1).map(span => span ? view.slice(...span).trim() : '');
}

function operand(raw: string) {
  const text = raw.trim();
  if (/^(?:«[^»]*»|“[^”]*”|"[^"]*"|'[^']*'|‘[^’]*’|`[^`]*`)$/u.test(text)) return text.slice(1, -1);
  return text;
}

const key = (text: string) => syntax(text, false).text.toLowerCase().replace(/\s+/gu, ' ').trim();
function containsCredential(text: string) {
  const scanned = publicSearchScan(text);
  return publicSearchText(scanned) !== scanned;
}

function resolveSite(text: string): Site | null {
  const input = operand(text.replace(/^(?:the )?(?:website|site|page|موقع|صفحه|صفحة)\s+/iu, '').trim());
  const found = ADDRESS.test(input) ? { url: input, name: '' } : namedSite(input);
  if (!found || containsCredential(found.url)) return null;
  try {
    const url = new URL(/https?:\/\//iu.test(found.url) ? found.url : `https://${found.url}`);
    const full = url.href;
    const anchor = url.hash;
    url.hash = '';
    if (!safeResumeUrl(url.href) || /(?:token|password|secret|credential|session|code)=/iu.test(anchor)) return null;
    return { url: full, name: found.name || url.hostname };
  } catch { return null; }
}

function siteAtEnd(raw: string) {
  const view = syntax(raw);
  const matches = [...view.text.matchAll(/\s+(?:on|at|from|in|في|علي|من|داخل)\s+/giu)];
  for (const match of matches.reverse()) {
    const site = resolveSite(view.slice(match.index + match[0].length));
    if (site && match.index > 0) return { subject: view.slice(0, match.index).trim(), site };
  }
  return null;
}

function fieldTarget(raw: string) {
  const context = groups(raw, CONTEXT);
  const main = (context?.[0] ?? raw).replace(/^(?:the|this|that)\s+/iu, '').replace(/\s+(?:on (?:the|this) page|في (?:هذه )?الصفحة)$/iu, '');
  const candidatePosition = groups(main, POSITION);
  // Labels such as First Name or Address 2 must retain the words and numbers from the request.
  const ordinalSubject = candidatePosition?.[1] || candidatePosition?.[2] || '';
  const ordinalRole = ROLES[key(ordinalSubject).replace(/^ال/u, '')];
  const positioned = groups(ordinalSubject, CONTROL) || ordinalRole || /^(?:results?|نتيجه|النتيجه)$/iu.test(key(ordinalSubject));
  const position = positioned ? candidatePosition : null;
  const described = position?.[1] || position?.[2] || main;
  const control = groups(described, CONTROL);
  const suffix = groups(described, CONTROL_SUFFIX);
  const roleLabel = control?.[0] || control?.[2] || suffix?.[1];
  const role = roleLabel ? ROLES[key(roleLabel)] : ordinalRole;
  const rawTarget = ordinalRole ? '' : control?.[1] || control?.[3] || suffix?.[0] || described;
  const target = operand(rawTarget.replace(/^(?:the|this|that)\s+/iu, ''));
  const order = position?.[1] ? position[0] : position?.[3];
  const index = order ? POSITIONS[key(order)] ?? Number.parseInt(order.replace(/[٠-٩]/gu, number => String(number.charCodeAt(0) - 0x660)), 10) : 0;
  const match = { ...(role ? { role } : {}), ...(context?.[1] ? { nearby: operand(context[1]) } : {}), ...(index > 0 ? { position: index } : {}) };
  return { target, ...(Object.keys(match).length ? { match } : {}) };
}

function humanField(label: string): BrowserTaskHuman | undefined {
  const field = key(label);
  if (/\b(?:otp|one[- ]time (?:code|password)|verification code|2fa code)\b|(?:رمز|كود) (?:التحقق|التاكيد|التفعيل|مره واحده)/u.test(field)) return 'code';
  if (/\b(?:password|passphrase|passcode)\b|(?:كلمه المرور|كلمه السر|الباسورد|الرقم السري)/u.test(field)) return 'login';
  if (/\b(?:card (?:number|security code|expiry|expiration|cvv|cvc|pin)|credit card|cvv|cvc)\b|(?:رقم|رمز) (?:البطاقه|بطاقه الدفع|بطاقه الائتمان)/u.test(field)) return 'payment';
  if (/\b(?:(?:national |passport |government )?id (?:number|no)|passport (?:number|no)|identification number|social security number|ssn|national insurance number|tax id|driver'?s? licen[cs]e number)\b|(?:رقم|معرف) (?:الهويه|هويه|الاقامه|جواز السفر|البطاقه الشخصيه|البطاقه الوطنيه)|الرقم القومي/u.test(field)) return 'identifier';
  return undefined;
}

function humanClick(label: string): BrowserTaskHuman | undefined {
  const text = key(label);
  if (/^(?:pay(?: now| securely| [\p{Sc}\p{N}][\s\p{N}.,]*)?|checkout|check out|confirm payment|complete payment|place (?:your |the )?order|buy now|purchase now|اشتر الان|ادفع(?: الان)?|الدفع(?: الان)?|(?:اتمام|تاكيد) (?:الدفع|الشراء|الطلب))$/u.test(text)) return 'payment';
  if (/^(?:captcha|recaptcha|hcaptcha|human verification|verify you are human|i['’]m not a robot|انا لست روبوتا|التحقق البشري)$/u.test(text)) return 'challenge';
  return undefined;
}

function readSection(raw: string): BrowserTaskSection | null {
  const text = key(raw).replace(/\s+(?:(?:of|on|in|from) (?:the|this) page|(?:في|علي|من) (?:هذه )?الصفحه)$/u, '');
  if (!text || /^(?:(?:me|لي)\s+)?(?:the |this |its )?(?:page|article|main content|content|contents|text|it|more|everything|المحتوي(?: الرئيسي)?|محتواها|محتواه|النص|الصفحه|المقال(?:ه)?|المزيد|الباقي|البقيه|الكل)$/u.test(text)) return /^(?:everything|الكل)$/u.test(text) ? 'all' : 'main';
  if (/^(?:(?:all|the|this)\s+)*(?:tables?|الجدول|الجداول|جدول|جداول)$/u.test(text)) return 'tables';
  if (/^(?:(?:all|the|this)\s+)*(?:lists?|القائمه|القوائم|قائمه|قوائم)$/u.test(text)) return 'lists';
  if (/^(?:(?:all|the|this)\s+)*(?:forms?|fields|الاستماره|الاستمارات|النموذج|النماذج|الحقول|نموذج|استماره)$/u.test(text)) return 'forms';
  return null;
}

const SITE_JOINER = /^(?:(?:لي\s+)?(?:في|إلى|الى|الي|على|علي)\s+)/iu;
const BROWSER_BEFORE_QUERY = /^(?:(?:in|using) (?:the |your )?browser|(?:في|داخل|باستخدام|من) المتصفح)\s+(?:for\s+|عن\s+)?/diu;
const COORDINATED_VALUE = /(?:\s+(?:and\s+|و\s*)|[،,]\s*)[^\r\n]+?\s+(?:with|to|بقيمة|بقيمه|=)\s+\S/u;
const FIELD_VALUE = /^(?:(?:the|this|ال)\s+)?(.+?)\s+(?:with|to|as|بقيمه|بقيمة|بـ?|الى|الي|علي|على|=)\s+(.+)$/diu;
const VALUE_FIELD = /^(.+?)\s+(?:in|into|داخل|في)\s+(.+)$/diu;
const OPTION_FIELD = /^(.+?)\s+(?:from|in|for|من|في)\s+(.+)$/diu;
const FILE_FIELD = /^(.+?)\s+(?:to|into|in|في|الي|على|علي)\s+(.+)$/diu;
const MORE = /^(?:(?:the |all |every )?pages?|more|المزيد|الباقي|البقيه|(?:كل )?الصفحات)$/u;
const ALONG_PAGES = /^(.*?)\s+(?:across (?:all )?(?:the )?pages|on (?:all|every) pages?|(?:عبر|من|في) (?:كل )?الصفحات)$/diu;

function parseAction(kind: Verb, verb: string, untrimmed: string, hasPage: boolean): Step | null {
  const args = untrimmed.trim();
  if (kind === 'open') {
    const site = resolveSite(args.replace(SITE_JOINER, ''));
    return site ? { kind, ...site } : null;
  }
  if (kind === 'find') {
    const query = args.replace(/^(?:لي\s+)?(?:عن|علي|على)\s+/iu, '');
    const scoped = siteAtEnd(query);
    const subject = scoped?.subject ?? query;
    const target = operand(subject);
    if (!target || containsCredential(target)) return null;
    return hasPage && !scoped ? { kind, scope: 'page', ...fieldTarget(subject) }
      : { kind, scope: 'web', target, ...(scoped ? { site: scoped.site } : {}) };
  }
  if (kind === 'read') {
    const paging = groups(args, ALONG_PAGES);
    const section = readSection(paging?.[0] ?? args) ?? (MORE.test(key(args)) ? 'main' : null);
    if (section) return { kind, section, ...(paging || MORE.test(key(args)) && key(args) !== 'page' && key(args) !== 'the page' ? { more: true } : {}) };
    const qualifier = groups(args, /^(.+?)\s+(?:named|called|titled|المسمي|بعنوان|اسمها|اسمه)\s+(.+)$/diu);
    const structured = qualifier && readSection(qualifier[0]);
    return structured && !containsCredential(qualifier[1]) ? { kind, section: structured, target: operand(qualifier[1]) } : null;
  }
  if (kind === 'fill') {
    const valueFirst = /^(?:type|enter|write|اكتب(?:لي)?|ادخل|حط(?:لي)?)$/u.test(verb);
    const pair = groups(args, valueFirst ? VALUE_FIELD : FIELD_VALUE);
    const target = fieldTarget(pair?.[valueFirst ? 1 : 0] ?? args);
    if (!target.target || containsCredential(target.target) || (valueFirst && !pair)) return null;
    if (/^(?:write|اكتب(?:لي)?)$/u.test(verb) && !target.match?.role) return null;
    const human = humanField(target.target);
    const rawValue = pair?.[valueFirst ? 0 : 1];
    const value = rawValue === undefined ? undefined : operand(rawValue);
    if (rawValue && COORDINATED_VALUE.test(syntax(rawValue).text)) return null;
    if (human) return { kind, ...target, human };
    if (value === undefined || containsCredential(value)) return { kind, ...target };
    return { kind, ...target, value };
  }
  if (kind === 'check') {
    const target = fieldTarget(args);
    if (!target.target || containsCredential(target.target)) return null;
    return { kind: 'fill', ...target, match: { ...target.match, role: 'checkbox' }, value: /^(?:uncheck|untick|الغ|شيل)/u.test(verb) ? 'false' : 'true' };
  }
  if (kind === 'select') {
    const option = groups(args, OPTION_FIELD);
    const assignment = option ? null : groups(args, FIELD_VALUE);
    const target = fieldTarget(option?.[1] ?? assignment?.[0] ?? args);
    const value = operand(option?.[0] ?? assignment?.[1] ?? '');
    if (!target.target || (!value && !target.match?.role) || containsCredential(target.target) || containsCredential(value)) return null;
    const human = humanField(target.target);
    if (human) return { kind: 'fill', ...target, human };
    if (!value && (target.match?.role === 'radio' || target.match?.role === 'checkbox')) return { kind: 'fill', ...target, value: 'true' };
    return { kind, ...target, ...(value ? { value } : {}) };
  }
  if (kind === 'click') {
    const { target, match } = fieldTarget(args.replace(/^(?:on|علي|على|عل)\s+/iu, ''));
    if ((!target && (!match?.role || !match.position)) || containsCredential(target)) return null;
    const human = humanClick(target);
    return { kind, target, ...(match ? { match } : {}), ...(human ? { human } : {}) };
  }
  if (kind === 'download') {
    const target = fieldTarget(args);
    return target.target && !containsCredential(target.target) ? { kind, ...target } : null;
  }
  const pair = groups(args, FILE_FIELD);
  const target = fieldTarget(pair?.[1] ?? args.replace(/^(?:to|into|in|في|إلى|الى|الي|على|علي)\s+/iu, ''));
  if (!target.target || containsCredential(target.target)) return null;
  const file = pair && operand(pair[0]);
  return { kind, ...target, ...(file && !/[\\/:]/u.test(file) && !containsCredential(file) ? { file } : {}) };
}

function riskFor(step: Step): BrowserTaskRisk {
  if (step.kind === 'click') {
    if (step.human === 'payment' || sensitiveAction(step.target) || /^(?:submit|confirm|ارسال|ارسل|تاكيد|اعتمد)(?:\s|$)/u.test(key(step.target))) return 'irreversible';
    return step.match?.role === 'link' ? 'read-only' : 'reversible-write';
  }
  if (step.kind === 'fill' && step.human === 'payment') return 'irreversible';
  return ['fill', 'select', 'upload'].includes(step.kind) ? 'reversible-write' : 'read-only';
}

function successFor(step: Step): BrowserTaskSuccess['kind'] {
  if ('human' in step && step.human) return 'human-completed';
  switch (step.kind) {
    case 'open': return 'page-open';
    case 'find': return 'element-found';
    case 'read': return 'content-read';
    case 'fill':
    case 'select': return 'value-read-back';
    case 'click': return 'effect-observed';
    case 'download': return 'file-downloaded';
    case 'upload': return 'file-selected';
  }
}

function splitSteps(raw: string) {
  const view = syntax(raw);
  const parts: string[] = [];
  let from = 0;
  for (const match of view.text.matchAll(CONNECTOR)) {
    parts.push(view.slice(from, match.index).replace(/[،,\s]+$/u, '').trim());
    from = match.index + match[0].length;
  }
  parts.push(view.slice(from).trim());
  return parts;
}

function legacyOpenRead(legacy: readonly HandsStep[] | null | undefined): Step[] | null {
  if (!legacy?.length || !legacy.some(step => step.kind === 'open')
    || !legacy.every(step => step.kind === 'open' || step.kind === 'read')) return null;
  const steps: Step[] = [];
  for (const step of legacy) {
    if (step.kind === 'open') {
      const site = resolveSite(step.url);
      if (!site) return null;
      steps.push({ kind: 'open', ...site });
    } else if (step.kind === 'read') {
      steps.push({ kind: 'read', section: 'main', ...(step.more ? { more: true } : {}) });
    }
  }
  return steps;
}

function completeSpec(target: BrowserTaskTarget, steps: Step[], requiredData: BrowserTaskData[], lang: 'ar' | 'en'): BrowserTaskSpec {
  const rated = steps.map(step => ({ ...step, risk: riskFor(step) }));
  const risk = rated.some(step => step.risk === 'irreversible') ? 'irreversible'
    : rated.some(step => step.risk === 'reversible-write') ? 'reversible-write' : 'read-only';
  for (const [index, step] of steps.entries()) {
    if ('human' in step && step.human) {
      requiredData.push({ kind: 'manual', name: step.human, step: index, supplied: false });
    } else if (step.kind === 'fill' || step.kind === 'select') {
      requiredData.push({ kind: 'value', name: step.target, step: index, supplied: step.value !== undefined });
    } else if (step.kind === 'upload') {
      requiredData.push({ kind: 'file', name: step.target, step: index, supplied: step.file !== undefined });
    }
  }
  return { target, steps: rated, requiredData, success: steps.map((step, index) => ({ step: index, kind: successFor(step) })), risk, lang };
}

export interface BrowserTaskParseOptions { hasPage?: boolean; legacy?: readonly HandsStep[] | null }

/** Plan only explicit requests or controls on an already open page. Ordinary lookup stays on the HTTP-first path. */
export function parseBrowserTask(request: string, options: BrowserTaskParseOptions = {}): BrowserTaskSpec | null {
  if (!request.trim() || request.length > 8000 || isEntireLiteralRequest(request)) return null;
  const constraints = parseUserRequestConstraints(request);
  if (!requestCapabilityAllowed(constraints, 'browser_action') || !requestCapabilityAllowed(constraints, 'browser_navigation')) return null;
  const lang = /\p{Script=Arabic}/u.test(syntax(request).text) ? 'ar' : 'en';
  const source = (constraints?.safeActionText ?? request).trim().replace(/[.!?؟]+$/u, '');
  if (directRoute(source)?.screenshot || options.legacy?.some(step => step.kind === 'ask_page' || step.kind === 'news')) return null;
  const initial = syntax(source);
  const polite = POLITE.exec(initial.text);
  let current = initial.slice(polite?.[0].length ?? 0);
  const qualifier = syntax(current);
  const lead = BROWSER_LEAD.exec(qualifier.text);
  const tail = BROWSER_TAIL.exec(qualifier.text);
  const explicitBrowser = Boolean(lead || tail);
  if (!explicitBrowser && options.legacy?.some((step, index, legacy) =>
    step.kind === 'search' && (step.site || step.here || legacy.slice(0, index).some(previous => previous.kind === 'open')))) return null;
  current = qualifier.slice(lead?.[0].length ?? 0, tail?.index).trim();
  const suppliedAddress = ADDRESS.test(current) ? resolveSite(current) : null;
  if (suppliedAddress) {
    return completeSpec({ kind: 'site', ...suppliedAddress },
      [{ kind: 'open', ...suppliedAddress }, { kind: 'read', section: 'main' }], [], lang);
  }

  const sequence = groups(current, OPEN_SITE_CONTEXT);
  const named = sequence && resolveSite(sequence[0]);
  if (named) current = sequence[1];
  const parts = splitSteps(current);
  const steps: Step[] = named ? [{ kind: 'open', ...named }] : [];
  const requiredData: BrowserTaskData[] = [];
  let target: BrowserTaskTarget = named ? { kind: 'site', ...named } : options.hasPage ? { kind: 'current' } : { kind: 'missing' };
  let browserIntent = Boolean(named || explicitBrowser);
  for (const [index, part] of parts.entries()) {
    const view = syntax(part);
    // Search verbs, form typing and navigation can share Arabic wording.
    let choice = HEAD.find(({ pattern }) => pattern.test(view.text));
    const match = choice?.pattern.exec(view.text);
    if (choice?.kind === 'open' && match && key(match[1]) === 'ادخل' && groups(view.slice(match[0].length), VALUE_FIELD)) {
      choice = { ...choice, kind: 'fill' };
    }
    if (!choice || !match) {
      requiredData.push({ kind: 'instruction', name: 'step', step: index, supplied: false });
      continue;
    }
    const verb = key(match[1]);
    let rest = view.slice(match[0].length);
    if (choice.kind === 'find') {
      const query = syntax(rest);
      const qualifier = BROWSER_BEFORE_QUERY.exec(query.text);
      if (qualifier) {
        browserIntent = true;
        rest = query.slice(qualifier[0].length);
      }
    }
    let site: Site | undefined;
    if (choice.kind === 'read' || choice.kind === 'click' || choice.kind === 'download' || choice.kind === 'upload') {
      const scoped = siteAtEnd(rest);
      if (scoped) { rest = scoped.subject; site = scoped.site; }
    }
    const step = parseAction(choice.kind, verb, rest, target.kind === 'site' || target.kind === 'current');
    const openTarget = step?.kind === 'open' || choice.kind === 'open' && (Boolean(directRoute(part))
      || /^(?:(?:a|any|the|this) )?(?:web ?site|site|url|link|موقعا?|رابطا?)(?=\s|$)/u.test(key(rest)));
    const genericWrite = /^(?:write|set|اكتب(?:لي)?)$/u.test(verb);
    const isPageControl = ['click', 'fill', 'select', 'check', 'download', 'upload'].includes(choice.kind)
      && (!genericWrite || step?.kind === 'fill' && Boolean(step.match?.role));
    if (openTarget || site || options.hasPage && (isPageControl || step?.kind === 'read')) browserIntent = true;
    // Ambiguous conversational imperatives must not become actions on an unrelated active page.
    if (!browserIntent && choice.kind !== 'find') return null;
    if (site && step) {
      steps.push({ kind: 'open', ...site });
      if (target.kind !== 'site' && target.kind !== 'search') target = { kind: 'site', ...site };
    }
    if (!step) {
      requiredData.push({ kind: choice.kind === 'open' ? 'site' : 'instruction', name: choice.kind === 'open' ? 'site' : 'step', step: index, supplied: false });
      continue;
    }
    if (step.kind === 'open' && target.kind !== 'site' && target.kind !== 'search') target = { kind: 'site', url: step.url, name: step.name };
    else if (step.kind === 'find' && step.scope === 'web' && target.kind !== 'site') target = { kind: 'search', query: step.target };
    steps.push(step);
  }
  if (!browserIntent) return null;
  if (requiredData.length) {
    const legacy = legacyOpenRead(options.legacy);
    if (legacy?.[0]?.kind === 'open') {
      const first = legacy[0];
      return completeSpec({ kind: 'site', url: first.url, name: first.name }, legacy, [], lang);
    }
  }
  const forbidsSearch = !requestCapabilityAllowed(constraints, 'public_search');
  if (forbidsSearch && steps.some(step => step.kind === 'find' && step.scope === 'web')) return null;
  if (target.kind === 'missing' && !requiredData.some(item => item.kind === 'site')) requiredData.unshift({ kind: 'site', name: 'site', step: null, supplied: false });
  if (steps.length > MAX_STEPS || parts.length > MAX_STEPS) return completeSpec(target, [], [{ kind: 'instruction', name: 'limit', step: null, supplied: false }], lang);
  return completeSpec(target, steps, requiredData, lang);
}
