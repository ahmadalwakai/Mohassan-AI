import { publicSearchScan } from '@mohassan/browser';
import { redactCredentialText } from '@mohassan/cognitive';
import type { BrainState } from '../brain.js';
import type { HandsStep } from '../hands.js';
import { normalizeRefusalText } from './patterns.js';
import type { RefusalDecision } from './types.js';

const SECRETS = { code: 'secrets', alternative: 'secure_entry' } as const;
const PAYMENT = { code: 'payment', alternative: 'review_payment' } as const;
const HUMAN = { code: 'human_step', alternative: 'manual_step' } as const;
const DRAFT = { code: 'human_step', alternative: 'draft' } as const;

// These patterns apply to controls and argument keys. A mention in a query,
// page title or document body is data and carries no action authority.
const SECRET_FIELD = /^(?:(?:your|current|new|confirm) )?(?:password|passcode|card number|(?:credit|debit) card number|security code|security pin|card pin|cvc|cvv|otp|one[ -]time (?:code|password)|(?:login|verification|2fa) code)(?: field)?$|^(?:خانه )?(?:(?:ال)?(?:كلمه المرور|كلمه السر|رقم البطاقه|رقم بطاقه الائتمان|رمز التحقق|رمز الامان|رمز الدخول|الرمز السري)|كلمه المرور الحاليه)(?: الخاص بك)?$/u;
const PAYMENT_BUTTON = /^(?:pay(?: now| securely| [$€£]?\d[\d., ]*(?: [a-z]{3})?(?: now)?)?|buy now|purchase now|place (?:the |your )?order|(?:complete|confirm|submit) (?:the |your )?(?:payment|purchase|order|transfer)|send money|transfer funds|withdraw funds|ادفع(?: الان)?|اشتر(?:ي)? الان|(?:اكد|تاكيد|اتمام) (?:الدفع|الشراء|الطلب|التحويل)|(?:حول|ارسل) (?:المال|الاموال|المبلغ))$/u;
const HUMAN_BUTTON = /^(?:captcha|recaptcha|human verification|(?:i am|i'm) not a robot|verify (?:that )?(?:you are human|your identity)|(?:accept|agree to) (?:the )?(?:terms of service|terms and conditions)|كابتشا|التحقق البشري|انا لست روبوت(?:ا)?|تحقق من هويتك|اثبت انك بشر|وافق علي الشروط والاحكام)$/u;
const OUTREACH_BUTTON = /^(?:send (?:e ?mail|message)|(?:ارسال|ارسل) (?:الرساله|البريد))$/u;
const SECRET_PARAM = /^(?:password|passwd|passcode|cardnumber|ccnumber|cvv|cvc|otp|onetimecode|verificationcode|apikey|accesstoken|refreshtoken)$/u;
const PAYMENT_PATH = /\/(?:pay(?:ment)?|purchase|transfer|checkout|orders?)\/(?:confirm|submit|complete|execute|charge|place|capture|pay)(?:\/|$)|\/(?:pay|purchase|send-money|(?:bank|money)\/transfer)\/?$/u;

const knownCredential = (text: string) => {
  const decoded = publicSearchScan(text);
  return redactCredentialText(decoded) !== decoded;
};
const labelText = (label: string) => normalizeRefusalText(label).replace(/^[«”"'‘“]+|[»”"'’*!.]+$/gu, '').trim();

export function reviewRefusalControl(label: string): RefusalDecision | null {
  const target = labelText(label);
  if (PAYMENT_BUTTON.test(target)) return PAYMENT;
  if (HUMAN_BUTTON.test(target)) return HUMAN;
  if (OUTREACH_BUTTON.test(target)) return DRAFT;
  return null;
}

export function reviewRefusalField(field: string, text = ''): RefusalDecision | null {
  const label = labelText(field);
  if (SECRET_FIELD.test(label) || knownCredential(text)) return SECRETS;
  if (HUMAN_BUTTON.test(label)) return HUMAN;
  return null;
}

/** An ordinary GET can navigate to a checkout or sign-in page for the user. */
export function reviewRefusalDestination(raw: string, method = 'GET'): RefusalDecision | null {
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  if (url.password || [...url.searchParams].some(([key, value]) => value.trim()
    && SECRET_PARAM.test(publicSearchScan(key).toLowerCase().replace(/[\s_-]+/gu, '')))) return SECRETS;
  if (method.toUpperCase() !== 'GET' && PAYMENT_PATH.test(publicSearchScan(url.pathname).toLowerCase())) return PAYMENT;
  return null;
}

/** Inspect every step before step one, including the untouched tail of a saved plan. */
export function reviewHandsRefusal(steps: readonly HandsStep[]): RefusalDecision | null {
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    let refusal: RefusalDecision | null = null;
    switch (step?.kind) {
      case 'click': refusal = reviewRefusalControl(step.target); break;
      case 'type': refusal = reviewRefusalField(step.field, step.text); break;
      case 'open': refusal = reviewRefusalDestination(step.url); break;
      case 'search': if (step.site) refusal = reviewRefusalDestination(step.site.url); break;
    }
    if (refusal) return refusal;
  }
  return null;
}

interface RefusalActionMaterial {
  capability: string;
  action: string;
  target: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
}

/** The recorded approval covers one exact action. It cannot authorize a refused effect. */
export function reviewActionMaterialRefusal(material: RefusalActionMaterial): RefusalDecision | null {
  if (material.capability === 'browser.submit') {
    const destination = /^(\S+)\s+(https?:\/\/\S+)$/iu.exec(material.target);
    return reviewRefusalControl(material.action) || (destination ? reviewRefusalDestination(destination[2], destination[1]) : null);
  }
  if (material.capability === 'computer.input') {
    if (material.details.kind === 'click') return reviewRefusalControl(material.target.slice('click:'.length));
    if (material.details.kind === 'text') return reviewRefusalField('', material.target.slice('text:'.length));
  }
  if (material.capability === 'desktop.run' && material.details.kind === 'click_element') return reviewRefusalControl(material.target);
  return null;
}

type PendingRefusalState = Partial<Pick<BrainState, 'pendingAction' | 'pendingHeld' | 'pendingComputer' | 'pendingDesktop'>>;

/** Recheck the persisted operand itself before a resumed run can use a tool. */
export function reviewPendingRefusal(state: PendingRefusalState): RefusalDecision | null {
  const browser = state.pendingAction;
  const computer = state.pendingComputer?.step;
  const desktop = state.pendingDesktop?.command;
  return (browser && (reviewRefusalControl(browser.label) || reviewRefusalDestination(browser.permit.url, browser.permit.method)
    || (browser.action.kind === 'type' && reviewRefusalField(browser.label, browser.action.text))))
    || (state.pendingHeld && reviewRefusalControl(state.pendingHeld.label))
    || (computer?.kind === 'click' && reviewRefusalControl(computer.name))
    || (computer?.kind === 'text' && reviewRefusalField('', computer.text))
    || (desktop?.kind === 'click_element' && reviewRefusalControl(desktop.name))
    || ((desktop?.kind === 'type' || desktop?.kind === 'clipboard_write') && reviewRefusalField('', desktop.text))
    || null;
}
