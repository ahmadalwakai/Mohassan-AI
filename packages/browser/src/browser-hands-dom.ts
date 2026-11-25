import { setTimeout as delay } from 'node:timers/promises';
import type { ElementHandle, Frame } from 'playwright';
import type { AgentElement, AgentFieldKind } from './agent-browser.js';
import { BROWSER_HANDS_READ_TARGET_SCRIPT } from './browser-hands-frame.js';
import { BrowserHumanStepError, browserHumanStep } from './browser-hands-human.js';
import { BrowserError } from './network.js';

export { BROWSER_HANDS_FRAME_SCRIPT } from './browser-hands-frame.js';

export type BrowserHandsHumanField = 'login' | 'code' | 'payment' | 'identity';
type Control = 'action' | 'text' | 'editable' | 'date' | 'select' | 'checkbox' | 'radio' | 'file' | 'other';
type ControlValue = string | boolean | string[];

export interface BrowserHandsElementMatch {
  name: string;
  label: string;
  text: string;
  placeholder: string;
  nearby: string;
  role?: string;
  position?: number;
  control: Control;
  exposed: boolean;
  humanOnly: BrowserHandsHumanField | null;
  field?: AgentFieldKind;
  consent?: boolean;
  pagination?: 'next' | 'more';
  actionText?: string;
}

export interface BrowserHandsFrameContent {
  direction: 'ltr' | 'rtl';
  main: string;
  tables: Array<{ caption: string; rows: string[][] }>;
  lists: Array<{ ordered: boolean; items: string[] }>;
  forms: Array<{ label: string; fields: Array<{ label: string; role: string; value: ControlValue | null }> }>;
}

export interface BrowserHandsTarget {
  name: string;
  role?: string;
  nearby?: string;
  /** One-based position among matching elements in document order. */
  position?: number;
}

type TargetKind = 'find' | 'click' | 'fill' | 'select' | 'upload' | 'download';
export type BrowserHandsMatch = { status: 'matched'; element: AgentElement } | { status: 'missing' | 'ambiguous' };

const asciiDigits = (value: string) => value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));

export function normalizeBrowserHandsText(value: string): string {
  return asciiDigits(value.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه'))
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const synonyms = [
  ['next', 'next page', 'continue', 'التالي', 'التالية', 'الصفحة التالية', 'تابع', 'استمرار', 'كمل'],
  ['previous', 'previous page', 'back', 'السابق', 'السابقة', 'الصفحة السابقة', 'رجوع', 'ارجع'],
  ['load more', 'show more', 'view more', 'تحميل المزيد', 'عرض المزيد', 'المزيد', 'اعرض المزيد', 'شوف المزيد'],
  ['search', 'find', 'site search', 'بحث', 'البحث', 'ابحث', 'دور'],
  ['name', 'full name', 'الاسم', 'الاسم الكامل', 'اسمك', 'اسم'],
  ['email', 'email address', 'البريد الإلكتروني', 'بريد إلكتروني', 'ايميل', 'الإيميل'],
  ['phone', 'phone number', 'mobile number', 'رقم الهاتف', 'الهاتف', 'رقم الموبايل', 'رقم الجوال'],
  ['country', 'الدولة', 'بلد', 'البلد'],
  ['address', 'street address', 'عنوان', 'العنوان'],
  ['postal code', 'zip code', 'postcode', 'الرمز البريدي', 'الكود البريدي'],
  ['description', 'الوصف', 'وصف'],
  ['save', 'save changes', 'حفظ', 'احفظ', 'حفظ التغييرات'],
  ['submit', 'send', 'إرسال', 'أرسل', 'ابعث'],
  ['sign in', 'log in', 'login', 'تسجيل الدخول', 'سجل الدخول'],
  ['download', 'تنزيل', 'تحميل', 'نزّل', 'حمّل'],
  ['upload', 'رفع', 'ارفع', 'إرفاق', 'أرفق'],
].map(group => new Set(group.map(normalizeBrowserHandsText)));

const roleNames: Record<string, string[]> = {
  button: ['button', 'زر'], link: ['link', 'رابط'], textbox: ['textbox', 'text field', 'input', 'حقل', 'مربع نص'],
  select: ['select', 'dropdown', 'قائمة', 'قائمة منسدلة'], checkbox: ['checkbox', 'مربع اختيار'], radio: ['radio', 'خيار'],
};
const roles = new Map(Object.entries(roleNames).flatMap(([role, names]) => names.map(name => [normalizeBrowserHandsText(name), role] as const)));
const roleOf = (value: string) => roles.get(normalizeBrowserHandsText(value)) ?? normalizeBrowserHandsText(value);
const containsWords = (text: string, query: string) => ` ${text} `.includes(` ${query} `);

function textMatch(value: string, query: string, alternative: boolean): number {
  const text = normalizeBrowserHandsText(value);
  if (!text) return 0;
  if (text === query) return 4;
  if (synonyms.some(group => group.has(text) && group.has(query))) return 3;
  return alternative && containsWords(text, query) ? 2 : 0;
}

function suitable(element: AgentElement, kind?: TargetKind): boolean {
  const control = element.match?.control;
  if (element.match?.exposed === false) return false;
  if (kind === 'find') return true;
  if (element.disabled) return false;
  if (kind === 'fill') return control ? ['text', 'editable', 'date', 'checkbox', 'radio'].includes(control) || Boolean(element.match?.humanOnly) : element.role === 'textbox';
  if (kind === 'select') return control ? ['select', 'checkbox', 'radio'].includes(control) || Boolean(element.match?.humanOnly) : ['select', 'checkbox', 'radio'].includes(element.role);
  if (kind === 'upload') return element.role === 'file';
  if (kind === 'download') return element.role === 'link' && Boolean(element.href);
  return kind !== 'click' || !control || ['action', 'checkbox', 'radio', 'other'].includes(control);
}

/** Restrict the alternate search to bounded text matching on observed controls. */
export function findBrowserHandsElement(elements: readonly AgentElement[], target: BrowserHandsTarget,
  options: { kind?: TargetKind; alternative?: boolean } = {}): BrowserHandsMatch {
  const query = normalizeBrowserHandsText(target.name);
  const nearby = target.nearby ? normalizeBrowserHandsText(target.nearby) : '';
  const role = target.role ? roleOf(target.role) : '';
  if (!query && !target.position) return { status: 'missing' };
  if (target.position !== undefined && (!Number.isSafeInteger(target.position) || target.position < 1)) return { status: 'missing' };
  const candidates = elements.flatMap((element, index) => {
    if (!suitable(element, options.kind) || role && roleOf(element.role) !== role && roleOf(element.match?.role ?? '') !== role) return [];
    const match = element.match;
    if (nearby && !containsWords(normalizeBrowserHandsText(match?.nearby ?? ''), nearby)) return [];
    const values = [element.label, match?.name, match?.label, match?.text, match?.placeholder];
    const score = query ? Math.max(...values.map(value => value ? textMatch(value, query, options.alternative === true) : 0)) : 1;
    return score ? [{ element, index, score }] : [];
  });
  const best = Math.max(...candidates.map(item => item.score));
  const matches = candidates.filter(item => item.score === best);
  if (target.position !== undefined) {
    const item = matches.sort((a, b) => (a.element.match?.position ?? a.index) - (b.element.match?.position ?? b.index))[target.position - 1];
    return item ? { status: 'matched', element: item.element } : { status: 'missing' };
  }
  if (matches.length === 1) return { status: 'matched', element: matches[0].element };
  return { status: matches.length > 1 ? 'ambiguous' : 'missing' };
}

const rejection = new Set(['reject all', 'reject all cookies', 'decline all', 'refuse all', 'رفض الكل', 'ارفض الكل', 'رفض جميع ملفات تعريف الارتباط'].map(normalizeBrowserHandsText));
const necessary = new Set(['necessary only', 'essential only', 'use necessary cookies only', 'only necessary cookies', 'reject optional cookies', 'decline optional cookies', 'continue without accepting', 'رفض الاختياري', 'الضرورية فقط', 'الأساسية فقط', 'المتابعة دون قبول'].map(normalizeBrowserHandsText));

function hasName(element: AgentElement, values: Set<string>): boolean {
  return [element.label, element.match?.name, element.match?.text].some(value => value && values.has(normalizeBrowserHandsText(value)));
}

export function browserHandsConsent(elements: readonly AgentElement[]): AgentElement | undefined {
  const controls = elements.filter(element => element.match?.consent && element.match.exposed && element.inViewport && !element.disabled);
  const rejects = controls.filter(element => hasName(element, rejection));
  if (rejects.length) return rejects.length === 1 ? rejects[0] : undefined;
  const essentials = controls.filter(element => hasName(element, necessary));
  return essentials.length === 1 ? essentials[0] : undefined;
}

export function browserHandsPagination(elements: readonly AgentElement[]): AgentElement | undefined {
  const controls = elements.filter(element => element.match?.pagination && element.match.exposed && !element.disabled);
  const more = controls.filter(element => element.match?.pagination === 'more');
  if (more.length) return more.length === 1 ? more[0] : undefined;
  return controls.length === 1 ? controls[0] : undefined;
}

export function browserHandsPageContent(frames: readonly (BrowserHandsFrameContent | undefined)[]): { content?: BrowserHandsFrameContent[] } {
  const content = frames.filter((frame): frame is BrowserHandsFrameContent => frame !== undefined);
  return content.length ? { content } : {};
}

interface NativeControlState {
  control: Control;
  connected: boolean;
  humanOnly: BrowserHandsHumanField | null;
  value: ControlValue | null;
  options: Array<{ label: string; value: string; disabled: boolean; selected: boolean }>;
}

// Playwright passes the attached node to a callable. Its string-evaluation path
// evaluates an expression without calling it, so compile this fixed source here.
let readNativeControl: ((node: Element) => NativeControlState) | undefined;

/** Sensitive values and file paths never leave the document through this reader. */
export async function readBrowserHandsControl(target: ElementHandle<Element>): Promise<NativeControlState> {
  readNativeControl ??= new Function(`return ${BROWSER_HANDS_READ_TARGET_SCRIPT}`)() as (node: Element) => NativeControlState;
  return target.evaluate(readNativeControl);
}

const yes = new Set(['true', 'on', 'yes', 'checked', 'check', '1', 'نعم', 'محدد', 'اختيار', 'تفعيل'].map(normalizeBrowserHandsText));
const no = new Set(['false', 'off', 'no', 'unchecked', 'uncheck', '0', 'لا', 'غير محدد', 'الغاء التحديد', 'تعطيل'].map(normalizeBrowserHandsText));

function booleanChoice(value: string): boolean {
  const text = normalizeBrowserHandsText(value);
  if (yes.has(text)) return true;
  if (no.has(text)) return false;
  throw new BrowserError('AGENT_SELECT_FAILED', 'حدد إن كنت تريد تفعيل هذا الخيار أو إلغاء تفعيله.', 409);
}

function expectedChoice(state: NativeControlState, value: string): string | string[] {
  const options = state.options.filter(option => !option.disabled);
  const label = normalizeBrowserHandsText(value);
  const exactLabel = options.filter(option => normalizeBrowserHandsText(option.label) === label);
  const exactValue = options.filter(option => option.value === value);
  const aliases = options.filter(option => textMatch(option.label, label, false) > 0);
  const matches = exactLabel.length ? exactLabel : exactValue.length ? exactValue : aliases;
  if (matches.length !== 1 || options.filter(option => option.value === matches[0].value).length !== 1) throw new BrowserError('AGENT_SELECT_FAILED', 'لم أجد خيارًا واحدًا مطابقًا في هذه القائمة.', 409);
  const option = matches[0];
  return Array.isArray(state.value) ? options.filter(item => item.selected || item === option).map(item => item.value) : option.value;
}

const controlValueKey = (value: ControlValue | null) => Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');

/** Use the engine's bound target, active authority, and overwrite guard for every native write. */
export async function writeBrowserHandsControl(target: ElementHandle<Element>, request: { kind: 'type' | 'select'; value: string },
  guard: (desired: string) => Promise<void>): Promise<void> {
  const state = await readBrowserHandsControl(target);
  if (state.humanOnly) throw new BrowserHumanStepError(browserHumanStep(state.humanOnly, (await target.ownerFrame())?.url() ?? ''));
  const { control } = state;
  const check = control === 'checkbox' || control === 'radio';
  const value = request.value.replace(/\r\n?/g, '\n');
  const expected = check ? booleanChoice(value) : control === 'select' ? expectedChoice(state, request.value) : control === 'date' ? asciiDigits(value) : value;
  if (control === 'select' && request.kind !== 'select' || !check && control !== 'select' && (request.kind !== 'type' || !['text', 'editable', 'date'].includes(control))) {
    throw new BrowserError('AGENT_CONTROL_UNSUPPORTED', 'لا يدعم هذا الحقل طريقة الإدخال المطلوبة.', 409);
  }
  const desired = controlValueKey(expected);
  await guard(desired);
  const changed = controlValueKey(state.value) !== desired;
  if (changed) {
    try {
      if (control === 'radio' && expected === false) throw new BrowserError('AGENT_SELECT_FAILED', 'اختر زرًا آخر في المجموعة لإلغاء هذا الاختيار.', 409);
      if (check) await target.setChecked(expected === true, { timeout: 3500 });
      else if (control === 'select') await target.selectOption((Array.isArray(expected) ? expected : [String(expected)]).map(value => ({ value })), { timeout: 3500 });
      else await target.fill(String(expected), { timeout: 3500 });
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('AGENT_WRITE_FAILED', 'تعذر إدخال القيمة في الحقل المحدد. لم تُكرر محاولة الكتابة تلقائيًا.', 409);
    }
  }
  const verify = async () => {
    const actual = await readBrowserHandsControl(target).catch(() => null);
    if (!actual?.connected || actual.humanOnly || actual.control !== control || controlValueKey(actual.value) !== desired) {
      throw new BrowserError('AGENT_FIELD_UNVERIFIED', 'لم يثبت أن الحقل احتفظ بالقيمة المطلوبة بعد الكتابة.', 409);
    }
  };
  await verify();
  if (!changed) return;
  // Give controlled forms one bounded chance to apply queued validation or rerender.
  // A mismatch ends the step without replaying the input.
  await delay(100);
  await verify();
}

/** Extra masks use field attributes and accessible labels without reading current values. */
export function browserHandsScreenshotMasks(frame: Frame) {
  const controls = frame.locator('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const attributes = ['name', 'id', 'placeholder', 'aria-label', 'autocomplete'];
  const words = ['password', 'passwd', 'otp', 'one-time', 'verification code', 'passcode', 'cc-', 'card number', 'cvv', 'cvc', 'national id', 'national_id', 'id_number', 'identity number', 'passport', 'ssn', 'كلمة المرور', 'رمز التحقق', 'رقم البطاقة', 'رقم الهوية', 'رقم الاقامة'];
  const names = frame.getByLabel(/password|passcode|verification code|one.?time code|card number|security code|\bOTP\b|\bCVV\b|\bCVC\b|identity number|national id|passport number|social security|كلمة المرور|رمز التحقق|كود التحقق|رقم البطاقة|رقم الهوي[ةه]|رقم (?:الإقامة|الاقامة)|رقم جواز السفر/i);
  const selector = [...attributes.flatMap(attribute => words.map(word => `[${attribute}*="${word}" i]`)), 'input[maxlength="1"]'].join(',');
  return [controls.and(frame.locator(selector)), controls.and(names)];
}
