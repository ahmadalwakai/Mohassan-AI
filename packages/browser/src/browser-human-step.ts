import type { AgentAction, AgentElement, AgentPage } from './agent-browser.js';
import { BrowserError } from './network.js';

export interface BrowserHumanStep {
  kind: 'hands_on';
  reason: 'login' | 'code' | 'captcha' | 'consent';
  site: string;
  prompt: string;
}

type HumanPage = Pick<AgentPage, 'url' | 'title' | 'text' | 'elements' | 'signals' | 'documentStatus'>;

// Sign-in and human-check signals ported from the browser hands detector.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/09e96baf3a9cd7184a61dfbb293898f551b37903/packages/browser/src/browser-hands-human.ts (retrieved 2026-11-27).
const AUTH_PATH = /\/(?:sign[-_]?in|log[-_]?in|oauth2?|saml2?|sso|authenticate|auth|identifier)(?:[/.]|$)/iu;
const IDENTITY_HOST = /^(?:accounts\.google\.com|login\.(?:microsoftonline|live)\.com|appleid\.apple\.com|id\.apple\.com|auth\.atlassian\.com|[^.]+\.(?:auth0\.com|okta\.com|okta-emea\.com|onelogin\.com)|[^.]+\.auth\.[^.]+\.amazoncognito\.com)$/iu;
const AUTH_TITLE = /^(?:(?:sign|log)[ -]?in|authenticate|authentication required|تسجيل الدخول|سجل الدخول)(?:$|[\s:|–-])/u;
const AUTH_WALL = /\b(?:(?:sign|log) in to (?:continue|proceed|access|view)|(?:sign[ -]?in|log[ -]?in) (?:is )?required|you (?:must|need to) (?:sign|log) in|this browser or app may not be secure|couldn['’]?t sign you in)\b|(?:تسجيل الدخول|سجل الدخول) (?:للمتابعة|للاستمرار|للوصول|لعرض)|(?:يجب|يرجى|عليك) تسجيل الدخول/u;
const CODE_WALL = /\b(?:(?:enter|type|confirm) (?:the |your )?(?:(?:verification|security|authentication|one[ -]time|sms) code|otp)|check your (?:phone|device) to (?:continue|sign in|approve)|approve (?:this |the )?sign[ -]?in)\b|(?:ادخل|اكتب) (?:رمز|كود) (?:التحقق|التاكيد|المصادقة)|(?:تحقق من هاتفك|وافق على تسجيل الدخول)/u;
const HUMAN_CHECK = /\b(?:(?:verify|verifying|confirm) (?:that )?you are (?:a )?human|are you a robot|i['’]?m not a robot|confirm this search was made by a human|(?:detected|seeing) unusual traffic|checking your browser|performing security verification|bots use duckduckgo too|complete (?:the |this )?captcha)\b|(?:انا لست روبوت|تحقق من انك انسان|اثبت انك انسان|تاكد من انك انسان|التحقق البشري)/u;
const CHECK_TITLE = /^(?:captcha|security (?:check|verification)|human verification|just a moment|one more step|التحقق البشري|التحقق الامني)(?:$|[\s:|!؟…–.-])/u;
const CHALLENGE_PLACEHOLDER = /^(?:captcha|human verification|التحقق البشري)$/u;
const PASSWORD_LABEL = /\b(?:password|passwd|passphrase|passcode)\b|كلمة (?:المرور|السر)|رقم سري/u;
const CODE_EXCEPTION = /\b(?:postal|zip|discount|promo|coupon|product|country|item|referral)\b|بريد|خصم|قسيمة|منتج|دولة|بلد|احالة/u;
// Consent extends the existing cookie and binding-terms controls.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/brain.ts#L20 (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/assistant/refusal/permissions.ts#L17 (retrieved 2026-11-27).
const CONSENT_CONTEXT = /\b(?:cookies?|consent|terms of (?:service|use)|terms and conditions|privacy (?:policy|notice|choices)|(?:grant|requesting) (?:access|permissions?))\b|ملفات (?:تعريف )?الارتباط|الكوكيز|الشروط والاحكام|شروط (?:الاستخدام|الخدمة)|سياسة الخصوصية|اذونات الوصول/u;
const CONSENT_TITLE = /^(?:consent|(?:cookie|privacy) (?:consent|preferences|choices|settings)|(?:review|accept) (?:our |the )?terms|الموافقة|(?:اعدادات|تفضيلات) (?:ملفات الارتباط|الخصوصية))(?:$|[\s:|!؟…–.-])/u;
const CONSENT_CONTROL = /^(?:(?:accept|allow|reject|decline|deny|refuse)(?: all)?(?: (?:optional |recommended )?cookies)?|(?:i )?(?:accept|agree|consent)(?: and continue)?|(?:only (?:necessary|essential)|necessary only|use (?:only )?(?:necessary|essential) cookies(?: only)?)|(?:manage|customi[sz]e|save) (?:cookies|preferences|choices|settings)|(?:ا?قبل|ا?رفض|ا?وافق)(?: على)? (?:الكل|(?:جميع )?ملفات (?:تعريف )?الارتباط(?: غير الضرورية)?)|(?:الضرورية فقط|رفض|قبول|اوافق))$/u;
const TERMS_ACTION = /\b(?:(?:accept|agree(?: to)?|consent to) (?:the |our )?(?:terms|conditions|privacy policy)|(?:allow|grant) (?:access|permissions?))\b|(?:ا?قبل|اوافق على) (?:الشروط|سياسة الخصوصية)|(?:السماح|اسمح) بالوصول/u;

const normalized = (value: string) => value.toLowerCase().normalize('NFKC')
  .replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/\s+/g, ' ').trim();
const controlLabel = (value: string) => normalized(value).replace(/[.!؟]+$/u, '');

function webUrl(value: string): URL | null {
  const url = URL.parse(value);
  return url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : null;
}

function handover(reason: BrowserHumanStep['reason'], site: URL): BrowserHumanStep {
  const instructions: Record<BrowserHumanStep['reason'], string> = {
    login: 'سجّل الدخول بنفسك في المتصفح',
    code: 'أكمل التحقق بنفسك في المتصفح أو على جهازك',
    captcha: 'أكمل التحقق البشري بنفسك في المتصفح',
    consent: 'راجع خيارات الموافقة أو الشروط واتخذ قرارك بنفسك في المتصفح',
  };
  return { kind: 'hands_on', reason, site: site.origin, prompt: `في ${site.host}، ${instructions[reason]}، ثم اضغط «متابعة».` };
}

function usableControls(page: HumanPage) {
  return page.elements.filter(element => !element.disabled);
}

function isConsentControl(element: Pick<AgentElement, 'role' | 'label'>, context: boolean) {
  if (!['button', 'link', 'checkbox', 'radio', 'switch'].includes(element.role)) return false;
  const label = controlLabel(element.label);
  return TERMS_ACTION.test(label) || context && CONSENT_CONTROL.test(label);
}

export function detectBrowserHumanStep(page: HumanPage): BrowserHumanStep | null {
  const url = webUrl(page.url);
  if (!url) return null;
  const title = normalized(page.title);
  const start = normalized(page.text.slice(0, 6000));
  const controls = usableControls(page);
  const textChallenge = HUMAN_CHECK.exec(start);
  const challengeControl = controls.some(element => ['button', 'checkbox'].includes(element.role) && HUMAN_CHECK.test(normalized(element.label)));
  if (page.signals.captcha || challengeControl || CHALLENGE_PLACEHOLDER.test(title) || CHALLENGE_PLACEHOLDER.test(start)
    || textChallenge && (textChallenge.index < 70 || CHECK_TITLE.test(title))) return handover('captcha', url);
  if (controls.some(element => element.field === 'otp' && !CODE_EXCEPTION.test(normalized(element.label))) || CODE_WALL.test(start.slice(0, 750))) return handover('code', url);
  const consentContext = CONSENT_CONTEXT.test(`${title} ${start} ${url.pathname}`);
  if (CONSENT_TITLE.test(title) || controls.some(element => isConsentControl(element, consentContext))) return handover('consent', url);
  if (controls.some(element => element.field === 'password' || element.field && PASSWORD_LABEL.test(normalized(element.label))) || page.documentStatus === 401 || IDENTITY_HOST.test(url.hostname)
    || AUTH_WALL.test(start.slice(0, 950)) || (AUTH_TITLE.test(title) || AUTH_PATH.test(url.pathname)) && controls.some(element => element.field === 'identifier')) return handover('login', url);
  return null;
}

export class BrowserHumanStepError extends BrowserError {
  constructor(public readonly step: BrowserHumanStep, public readonly page: AgentPage, public readonly beforeDispatch = false) {
    super('AGENT_HUMAN_STEP', step.prompt, 409);
  }
}

/** The addressed control can be safety-sensitive even outside the current viewport. */
export function requireBrowserHumanForAction(page: AgentPage, action: AgentAction, beforeDispatch = true): void {
  const step = detectBrowserHumanStep(page);
  if (step) throw new BrowserHumanStepError(step, page, beforeDispatch);
  const target = usableControls(page).find(element => element.ref === action.ref || action.kind === 'open' && element.href === action.text);
  const url = webUrl(page.url);
  if (!target || !url) return;
  const consentContext = CONSENT_CONTEXT.test(normalized(`${page.title} ${page.text.slice(0, 6000)} ${url.pathname}`));
  if (isConsentControl(target, consentContext)) throw new BrowserHumanStepError(handover('consent', url), page, beforeDispatch);
}
