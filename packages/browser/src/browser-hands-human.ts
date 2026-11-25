import { setTimeout as delay } from 'node:timers/promises';
import type { AgentElement, AgentPage } from './agent-browser.js';
import { BrowserError } from './network.js';

export type BrowserHumanReason = 'login' | 'code' | 'bot_check' | 'payment' | 'identity';
type SensitiveFieldReason = Exclude<BrowserHumanReason, 'bot_check'>;

export interface BrowserHumanStep {
  kind: 'login' | 'code' | 'hands_on';
  reason: BrowserHumanReason;
  site: string;
  prompt: string;
}

interface FieldMetadata {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  label?: string;
  placeholder?: string;
}

/** Only field metadata reaches this classifier. It never needs the current value. */
export function sensitiveBrowserField(field: FieldMetadata): SensitiveFieldReason | null {
  const metadata = [field.name, field.id, field.autocomplete, field.label, field.placeholder].join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().normalize('NFKC')
    .replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا')
    .replace(/[-_.:/]+/g, ' ').replace(/\s+/g, ' ');
  const identityEn = /\b(?:national ?(?:id|identifier)(?: ?number)?|(?:government|civil|emirates|personal|identity|identification) ?(?:id|number)|(?:identity|id) ?(?:no|number)|passport ?(?:number|no)|social security(?: number)?|ssn|iqama|aadhar|aadhaar)\b/u;
  const identityAr = /(?:رقم|معرف) (?:الهوية|هويتك|الاقامة|جواز السفر|الجواز|البطاقة (?:الشخصية|القومية|الوطنية|المدنية)|السجل المدني|الضمان الاجتماعي)|الرقم (?:الوطني|القومي|المدني)/u;
  if (identityEn.test(metadata) || identityAr.test(metadata)) return 'identity';
  if (/\b(?:cc (?:number|csc|name|exp|type|given|family|additional)|card ?number|cardholder|card (?:security|verification) code|cvv2?|cvc2?|cid)\b|(?:رقم|رمز|اسم صاحب) (?:البطاقة|بطاقة (?:الائتمان|الدفع))|الرقم الموجود خلف البطاقة/u.test(metadata)) return 'payment';
  if (/\b(?:one ?time (?:password|code)|otp|totp|(?:verification|verify|authentication|auth|sms|security|confirmation) ?code|2fa|mfa)\b|(?:رمز|كود|رقم) (?:التحقق|التاكيد|المصادقة|التفعيل|لمرة واحدة)|رمز مؤقت/u.test(metadata)) return 'code';
  if (field.type?.toLowerCase() === 'password' || /\b(?:password|passwd|passphrase|passcode)\b|كلمة (?:المرور|السر)|رقم سري/u.test(metadata)) return 'login';
  return null;
}

// The same fixed classifier is evaluated inside the browser's isolated DOM observer.
export const BROWSER_HANDS_SENSITIVE_FIELD_SCRIPT = `(${sensitiveBrowserField.toString()})`;

type HumanPageElement = Pick<AgentElement, 'field' | 'label' | 'disabled' | 'role'> & {
  match?: { humanOnly?: SensitiveFieldReason | null };
};

export type BrowserHumanPage = Pick<AgentPage, 'url' | 'title' | 'text' | 'signals' | 'documentStatus'> & {
  elements: readonly HumanPageElement[];
};

const IDENTITY_PROVIDER = /^(?:accounts\.google\.com|login\.(?:microsoftonline|live)\.com|appleid\.apple\.com|id\.apple\.com|auth\.atlassian\.com|[^.]+\.(?:auth0\.com|okta\.com|okta-emea\.com|onelogin\.com)|[^.]+\.auth\.[^.]+\.amazoncognito\.com)$/i;
const AUTH_PATH = /\/(?:oauth2?|saml2?|sso|authenticate)(?:[/.]|$)/i;
const AUTH_CONTINUE = /\b(?:(?:sign|log) in to (?:continue|proceed|access|view)|(?:sign[ -]?in|log[ -]?in) (?:is )?required|you (?:must|need to) (?:sign|log) in|this browser or app may not be secure|couldn['’]?t sign you in)\b|(?:تسجيل الدخول|سجل الدخول) (?:للمتابعة|للاستمرار|للوصول|لعرض)|(?:يجب|يرجى|عليك) تسجيل الدخول|(?:المتصفح غير امن|رفض تسجيل الدخول)/u;
const AUTH_TITLE = /^(?:(?:sign|log)[ -]?in|authenticate|authentication required|تسجيل الدخول|سجل الدخول)(?:$|[\s:|–-])/u;
const CODE_PROMPT = /\b(?:(?:enter|type|confirm) (?:the |your )?(?:(?:verification|security|authentication|one[ -]time|sms) code|otp)|we (?:sent|have sent) (?:you )?(?:a |the )?(?:verification |security )?code|check your (?:phone|device) to (?:continue|sign in|approve)|approve (?:this |the )?sign[ -]?in)\b|(?:ادخل|اكتب) (?:رمز|كود) (?:التحقق|التاكيد|المصادقة)|(?:ارسلنا|تم ارسال) (?:لك )?(?:رمز|كود) (?:التحقق|التاكيد)|(?:تحقق من هاتفك|وافق على تسجيل الدخول)/u;
const HUMAN_CHECK = /\b(?:(?:verify|verifying) (?:that )?you are (?:a )?human|confirm (?:that )?you are (?:a )?human|are you a robot|i['’]?m not a robot|confirm this search was made by a human|(?:detected|seeing) unusual traffic|checking your browser|performing security verification|bots use duckduckgo too|complete (?:the |this )?captcha)\b|(?:انا لست روبوت|تحقق من انك انسان|اثبت انك انسان|تاكد من انك انسان|التحقق البشري)/u;
const CHECK_TITLE = /^(?:captcha|security (?:check|verification)|human verification|just a moment|one more step|التحقق البشري|التحقق الامني)(?:$|[\s:|!؟…–.-])/u;
const CHALLENGE_PLACEHOLDER = /^(?:captcha|human verification|التحقق البشري)$/u;
const PAYMENT_HEADING = /^(?:(?:checkout|check out)(?:\s*[-:–]\s*payment)?|payment(?: (?:details|method|information|required))?|billing and payment|الدفع|صفحة الدفع|بيانات الدفع|طريقة الدفع|اتمام الدفع)(?:$|[\s:|–-])/u;
const PAYMENT_PATH = /\/(?:payment(?:s)?|checkout|billing)(?:\/|$)/i;
const PAYMENT_REQUIRED = /^(?:payment (?:is )?required to continue|complete (?:your |the )?payment to (?:continue|proceed)|يجب اتمام الدفع للمتابعة|اكمل الدفع للمتابعة)/u;

const normalized = (text: string) => text.toLowerCase().normalize('NFKC')
  .replace(/[\u0640\u064b-\u065f\u0670]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/\s+/g, ' ').trim();

function webUrl(text: string | undefined): URL | null {
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function identityProvider(url: URL): boolean {
  return IDENTITY_PROVIDER.test(url.hostname) || (AUTH_PATH.test(url.pathname)
    && [...url.searchParams.keys()].some(key => /^(?:redirect_uri|samlrequest|client_id)$/i.test(key)));
}

export function browserHumanStep(reason: BrowserHumanReason, url: string): BrowserHumanStep {
  const site = webUrl(url)?.host ?? '';
  const destination = site || 'هذا الموقع';
  const prompts: Record<BrowserHumanReason, string> = {
    login: `يتطلب ${destination} تسجيل الدخول يدويًا. سجّل الدخول في المتصفح وسأتابع عند اكتمال الخطوة.`,
    code: `يطلب ${destination} رمز تحقق أو موافقة على تسجيل الدخول. أكمل التحقق بنفسك وسأتابع بعده.`,
    bot_check: `يطلب ${destination} التحقق من أنك إنسان. أكمل التحقق في المتصفح وسأتابع بعده.`,
    payment: `يتطلب ${destination} إتمام الدفع يدويًا. راجع المبلغ وأكمل الدفع في المتصفح وسأتابع بعده.`,
    identity: `يطلب ${destination} رقم هوية. أدخله بنفسك في المتصفح وأكمل هذه الخطوة هناك.`,
  };
  return { kind: reason === 'login' || reason === 'code' ? reason : 'hands_on', reason, site, prompt: prompts[reason] };
}

export class BrowserHumanStepError extends BrowserError {
  constructor(public readonly step: BrowserHumanStep) {
    super('AGENT_HUMAN_STEP', step.prompt, 409);
  }
}

/** Match a payment commitment on the target control, independently of nearby page copy. */
export function isBrowserPaymentConfirmation(label: string): boolean {
  const text = normalized(label).replace(/[.!؟]+$/u, '');
  const pay = /^(?:pay(?: now| securely| (?:the |your )?(?:invoice|balance)| with .+| and (?:submit|confirm|continue)|\s+(?:\p{Sc}|(?:\d+\s*)?(?:usd|gbp|eur|aed|sar)|\d).*)?|buy now|(?:confirm|order) and pay)$/u;
  const confirm = /^(?:(?:confirm|submit|complete|authorize|make) (?:the |your )?payment|place (?:the |your )?order|(?:confirm|complete|authorize) (?:the |your )?purchase)$/u;
  const arabic = /^(?:(?:ادفع|دفع|الدفع)(?: الان| المبلغ| باستخدام .+|\s+(?:\p{Sc}|\p{N}).*)?|(?:اكد|تاكيد|اتمام|اكمل) (?:الدفع|الشراء|الطلب))$/u;
  return pay.test(text) || confirm.test(text) || arabic.test(text);
}

function fieldReason(element: HumanPageElement): SensitiveFieldReason | null {
  if (element.match?.humanOnly !== undefined) return element.match.humanOnly;
  if (!element.field && !['textbox', 'combobox', 'select', 'spinbutton', 'searchbox'].includes(element.role)) return null;
  const labelled = sensitiveBrowserField({ label: element.label });
  if (labelled) return labelled;
  if (element.field === 'password') return 'login';
  if (element.field === 'card') return 'payment';
  // The legacy classifier marks many Arabic fields containing “code” as OTPs.
  if (element.field === 'otp' && !/\b(?:postal|zip|discount|promo|coupon|product|country|item|referral)\b|(?:بريد|بريدي|خصم|قسيمة|منتج|دولة|بلد|احالة)/u.test(normalized(element.label))) return 'code';
  return null;
}

/** Reads available browser observations and returns only the category and sanitized site. */
export function detectBrowserHumanStep(page: BrowserHumanPage): BrowserHumanStep | null {
  const url = webUrl(page.url);
  if (!url) return null;
  const title = normalized(page.title);
  const start = normalized(page.text.slice(0, 2500));
  const controls = page.elements.filter(element => !element.disabled);
  const hasField = (kind: SensitiveFieldReason) => controls.some(element => fieldReason(element) === kind);
  const step = (reason: BrowserHumanReason) => browserHumanStep(reason, page.url);
  const textChallenge = HUMAN_CHECK.exec(start);
  const challengeControl = controls.some(element => ['button', 'checkbox'].includes(element.role) && HUMAN_CHECK.test(normalized(element.label)));
  if (challengeControl || CHALLENGE_PLACEHOLDER.test(title) || CHALLENGE_PLACEHOLDER.test(start)
    || textChallenge && (textChallenge.index < 70 || CHECK_TITLE.test(title)) || page.signals.captcha && !textChallenge) return step('bot_check');
  if (hasField('code') || CODE_PROMPT.test(start.slice(0, 750))) return step('code');
  if (hasField('payment') || PAYMENT_REQUIRED.test(start) || (PAYMENT_HEADING.test(title) || PAYMENT_HEADING.test(start) || PAYMENT_PATH.test(url.pathname))
    && controls.some(element => ['button', 'link'].includes(element.role) && isBrowserPaymentConfirmation(element.label))) return step('payment');
  if (page.documentStatus === 401 || page.documentStatus === 403 || hasField('login') || identityProvider(url)
    || AUTH_CONTINUE.test(start.slice(0, 950)) || AUTH_TITLE.test(title) && controls.some(element => element.field === 'identifier')) return step('login');
  return null;
}

export function browserHumanStepTimeout(step: BrowserHumanStep): string {
  const labels: Record<BrowserHumanReason, string> = {
    login: 'تسجيل الدخول', code: 'التحقق بالرمز', bot_check: 'التحقق البشري', payment: 'الدفع', identity: 'إدخال رقم الهوية',
  };
  return `توقفت المهمة عند ${labels[step.reason]} في ${step.site || 'الموقع'} بسبب انتهاء وقت الانتظار. أكمل الخطوة في المتصفح ثم اطلب المتابعة.`;
}

export type BrowserHumanProgress<T extends BrowserHumanPage> =
  | { status: 'clear'; page: T }
  | { status: 'next'; page: T; step: BrowserHumanStep }
  | { status: 'timeout'; message: string };

interface BrowserHumanWait<T extends BrowserHumanPage> {
  step: BrowserHumanStep;
  originalUrl: string;
  targetUrl?: string;
  observe(signal: AbortSignal): Promise<T | null>;
  /** A task-specific control that remains blocked even without a page-wide wall. */
  isStillBlocked?(page: T): boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}

const TRANSIENT_OBSERVATIONS = new Set(['AGENT_ACTION_BUSY', 'AGENT_CAPTURE_BUSY', 'AGENT_NO_PAGE', 'AGENT_PAGE_CLOSED', 'AGENT_PAGE_UNREADABLE']);

function boundedObservation<T>(observe: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return observe(signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The user may cross from one wall to another. Resume only after two usable observations on a known origin. */
export async function waitForBrowserHumanProgress<T extends BrowserHumanPage>(options: BrowserHumanWait<T>): Promise<BrowserHumanProgress<T>> {
  const original = webUrl(options.originalUrl);
  const target = webUrl(options.targetUrl);
  const returnToTarget = original && target && target.origin !== original.origin
    && (identityProvider(original) || options.step.kind === 'login' || options.step.kind === 'code');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 5 * 60_000);
  const signal = AbortSignal.any(options.signal ? [options.signal, timeout.signal] : [timeout.signal]);
  let clearLocation: string | null = null;
  try {
    while (!signal.aborted) {
      const page = await boundedObservation(options.observe, signal).catch(error => {
        if (error instanceof BrowserError && TRANSIENT_OBSERVATIONS.has(error.code)) return null;
        throw error;
      });
      const url = webUrl(page?.url);
      const knownOrigin = url && (url.origin === original?.origin || url.origin === target?.origin);
      const usable = page && url && (knownOrigin || identityProvider(url));
      const remaining = usable ? detectBrowserHumanStep(page) : null;
      if (page && remaining && (remaining.reason !== options.step.reason || remaining.site !== options.step.site)) return { status: 'next', page, step: remaining };
      const targetStillBlocked = page && (options.isStillBlocked?.(page) || options.step.reason === 'identity'
        && page.elements.some(element => !element.disabled && fieldReason(element) === 'identity'));
      const readyDocument = page && (page.documentStatus === undefined || (page.documentStatus >= 200 && page.documentStatus < 300))
        && (page.text.trim() || page.elements.length || normalized(page.title).replace(/^(?:loading|checking your browser|just a moment|جار التحميل|جاري التحميل)[. …]*$/u, ''));
      const canResume = knownOrigin && (!returnToTarget || url.origin === target?.origin);
      const location = canResume && readyDocument && !remaining && !targetStillBlocked ? url.origin + url.pathname : null;
      if (page && location && location === clearLocation) return { status: 'clear', page };
      clearLocation = location;
      await delay(options.intervalMs ?? 1_000, undefined, { signal });
    }
    signal.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!timeout.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  return { status: 'timeout', message: browserHumanStepTimeout(options.step) };
}
