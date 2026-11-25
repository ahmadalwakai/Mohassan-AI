import type { ElementHandle, Route } from 'playwright';
import type { AgentAction, AgentActionResult, AgentAuthority, AgentElement, AgentPage } from './agent-browser.js';
import { browserHandsConsent, readBrowserHandsControl, writeBrowserHandsControl, type BrowserHandsElementMatch } from './browser-hands-dom.js';
import type { EffectActor, EffectDecision } from './effect-policy.js';
import { BrowserHumanStepError, browserHumanStep, detectBrowserHumanStep, isBrowserPaymentConfirmation, sensitiveBrowserField } from './browser-hands-human.js';
import { BrowserError } from './network.js';

export interface BrowserHandsActionBinding {
  url: string;
  irreversible?: boolean;
  privacy?: boolean;
}

export interface BrowserHandsWriteReceipt {
  verified: true;
  masked: '••••';
}

export const BROWSER_HANDS_FORM_GUARD_SCRIPT = String.raw`
  const browserHandsAssociatedHumanField = (form) => {
    for (const field of Array.from(form.elements).slice(0, 250)) {
      const reason = !field.disabled && browserHandsHumanOnly(field);
      if (reason) return reason;
    }
    return null;
  };
`;

const privateEffects = new WeakMap<object, { navigation: boolean }>();

export function browserHandsActionHash(action: AgentAction, enabled = false): unknown[] {
  const hashInput = [action.kind, action.ref ?? null, action.text ?? null, action.submit ?? false];
  return enabled && action.browserHands ? [...hashInput, action.browserHands.url, Boolean(action.browserHands.irreversible), Boolean(action.browserHands.privacy)] : hashInput;
}

export function browserHandsGuardedAction(action: AgentAction): boolean {
  return ['click', 'type', 'select', 'press', 'form', 'scroll'].includes(action.kind);
}

export function assertBrowserHandsReady(page: AgentPage, action: AgentAction, approved?: boolean, operation?: object): void {
  const binding = action.browserHands;
  const target = action.ref && page.elements.find(element => element.ref === action.ref);
  if ((binding && page.url !== binding.url) || (action.ref && !target)) {
    throw new BrowserError('AGENT_REF_STALE', 'تغيرت الصفحة أو اختفى العنصر المحدد قبل تنفيذ الخطوة.', 409);
  }
  if (target && target.match?.humanOnly) throw new BrowserHumanStepError(browserHumanStep(target.match.humanOnly, target.frameOrigin ?? page.url));
  if (target && action.kind === 'click' && [target.label, target.match?.text].some(label => label && isBrowserPaymentConfirmation(label))) {
    throw new BrowserHumanStepError(browserHumanStep('payment', page.url));
  }
  if (binding?.privacy && (!target || browserHandsConsent(page.elements)?.ref !== target.ref)) {
    throw new BrowserError('AGENT_REF_STALE', 'تغير خيار الخصوصية في لافتة ملفات الارتباط؛ لم يُنقر أي زر.', 409);
  }
  if (!binding?.privacy) {
    const humanStep = detectBrowserHumanStep(page);
    if (humanStep) throw new BrowserHumanStepError(humanStep);
  }
  if (operation && page.elements.some(element => !element.disabled && element.match?.humanOnly === 'identity' && element.match.exposed !== false)) {
    privateEffects.set(operation, { navigation: action.kind === 'form' || action.kind === 'press'
      || action.kind === 'click' && !(target && target.href) || action.kind === 'type' && action.submit === true });
  }
  // During preparation approved is absent. A gesture begins only after a matching permit is available.
  if (binding?.irreversible && approved === false) {
    throw new BrowserError('AGENT_APPROVAL_REQUIRED', 'تتطلب هذه الخطوة موافقتك على طلب إرسال مطابق قبل تنفيذها.', 403);
  }
}

function effectFieldNames(route: Route): string[] {
  const request = route.request();
  const type = (request.headers()['content-type'] ?? '').toLowerCase();
  const data = request.postData()?.slice(0, 16_000) ?? '';
  if (!data) return [];
  if (type.startsWith('application/x-www-form-urlencoded')) return [...new URLSearchParams(data).keys()];
  if (type.startsWith('multipart/form-data')) return [...data.matchAll(/^content-disposition: form-data;[^\r\n]*?\bname="([^"]+)"/gim)].map(match => match[1]);
  if (!type.startsWith('application/json')) return [];
  return [...data.matchAll(/"([^"\\]{1,150})"\s*:/gu)].map(match => match[1]);
}

/** Credentials and identifying details stay out of auto sends and approval previews. */
export function assertBrowserHandsEffect(route: Route, url: string, actor: EffectActor, decision: EffectDecision, operation?: object): void {
  if (actor !== 'agent' || decision.kind === 'deny') return;
  const request = route.request();
  const privateEffect = operation ? privateEffects.get(operation) : undefined;
  const privateSend = privateEffect && (!['GET', 'HEAD'].includes(request.method()) || privateEffect.navigation && request.isNavigationRequest());
  const reason = privateSend ? 'identity'
    : [...new URL(url).searchParams.keys(), ...effectFieldNames(route)].map(name => sensitiveBrowserField({ name })).find(Boolean);
  if (reason) throw new BrowserHumanStepError(browserHumanStep(reason, url));
}

/** Keep manually entered values out of later page echoes, screenshots, and recovery URLs. */
export function rememberBrowserHandsInput(redactions: Map<string, number>, text: string | undefined): void {
  if (text && text.length >= 4) redactions.set(text, Date.now() + 10 * 60_000);
}

export function browserHandsActionResult(action: AgentAction, result: AgentActionResult): AgentActionResult {
  return action.kind === 'type' || action.kind === 'select' ? { ...result, browserHandsWrite: { verified: true, masked: '••••' } } : result;
}

export function browserHandsElementPositions(elements: AgentElement[], start: number, url: string): AgentElement[] {
  const frameOrigin = start && URL.canParse(url) && new URL(url).origin !== 'null' ? new URL(url).origin : undefined;
  return elements.map(element => element.match?.position === undefined ? element
    : { ...element, ...(frameOrigin ? { frameOrigin } : {}), match: { ...element.match, position: start + element.match.position } });
}

export async function performBrowserHandsWrite(target: ElementHandle<Element>, request: { kind: 'type' | 'select'; value: string; submit?: boolean },
  guard: (desired: string) => Promise<void>, record: () => Promise<void>): Promise<void> {
  await writeBrowserHandsControl(target, request, guard);
  await record();
  if (request.submit) await target.press('Enter');
}

export async function performBrowserHandsChoiceClick(target: ElementHandle<Element>,
  guard: (desired: string) => Promise<void>, record: () => Promise<void>): Promise<boolean> {
  const state = await readBrowserHandsControl(target);
  if (state.control !== 'checkbox' && state.control !== 'radio') return false;
  await performBrowserHandsWrite(target, { kind: 'select', value: String(state.control === 'radio' || !state.value) }, guard, record);
  return true;
}

export function blockBrowserHandsSecret(url: string, field?: BrowserHandsElementMatch['humanOnly']): never {
  throw new BrowserHumanStepError(browserHumanStep(field ?? 'login', url));
}

interface BrowserHandsHandoverPage {
  page: { isClosed(): boolean };
  readers: number;
  mutations: number;
  captureEpoch: number;
  captureReservation?: symbol;
  operation?: unknown;
  held?: unknown;
  redirectTarget?: string;
  closed?: boolean;
  recovery: { status: string; reviewRequired: boolean; actionKind: string | null };
  ownerInputUntil?: number;
  ownerInputLimit?: number;
}

const resuming = new WeakSet<BrowserHandsHandoverPage>();

function isInUse(entry: BrowserHandsHandoverPage): boolean {
  return Boolean(entry.mutations || entry.operation || entry.held || entry.captureReservation || entry.redirectTarget || entry.closed || entry.page.isClosed());
}

export function assertBrowserHandsOwnerFree(entry: BrowserHandsHandoverPage): void {
  if (resuming.has(entry)) throw new BrowserError('AGENT_ACTION_BUSY', 'يجري التحقق من اكتمال الخطوة اليدوية في المتصفح.', 409);
}

/** Poll the owned live page without checkpoint writes or screen capture. */
export async function observeBrowserHandsPage(entry: BrowserHandsHandoverPage, observe: () => Promise<AgentPage>): Promise<AgentPage | null> {
  if (isInUse(entry) || resuming.has(entry)) return null;
  const epoch = entry.captureEpoch;
  entry.readers++;
  try {
    const page = await observe();
    return epoch === entry.captureEpoch && !isInUse(entry) ? page : null;
  } finally { entry.readers--; }
}

/** A verified manual wait can clear its checkpoint, while pending or unknown agent effects stay fenced. */
export async function finishBrowserHandsHandover(entry: BrowserHandsHandoverPage, expected: Pick<AgentPage, 'url' | 'hash'>,
  authority: AgentAuthority, observe: () => Promise<AgentActionResult>, save: () => Promise<void>): Promise<AgentPage | null> {
  if (isInUse(entry) || resuming.has(entry) || entry.recovery.reviewRequired || entry.recovery.actionKind !== null
    || !['ready', 'review_required'].includes(entry.recovery.status)) return null;
  resuming.add(entry);
  entry.readers++;
  const epoch = entry.captureEpoch;
  try {
    authority.signal.throwIfAborted();
    await authority.assertActive();
    const { page } = await observe();
    if (isInUse(entry) || epoch !== entry.captureEpoch || page.url !== expected.url || page.hash !== expected.hash) return null;
    await authority.assertActive();
    authority.signal.throwIfAborted();
    if (isInUse(entry) || epoch !== entry.captureEpoch) return null;
    const previous = entry.recovery.status;
    entry.recovery.status = 'ready';
    try { await save(); }
    catch (error) { entry.recovery.status = previous; throw error; }
    entry.ownerInputUntil = undefined;
    entry.ownerInputLimit = undefined;
    return page;
  } finally {
    entry.readers--;
    resuming.delete(entry);
  }
}
