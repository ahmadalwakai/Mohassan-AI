import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { chromium, type BrowserContext, type ElementHandle, type Frame, type JSHandle, type Page, type Route } from 'playwright';
import { decideEffect, type EffectActor } from './effect-policy.js';
import { BrowserError, SafeNetwork } from './network.js';
import { AgentSessionCheckpointSchema, AgentPostconditionSchema, evidenceHash, safeResumeUrl, pagePostcondition, type AgentSessionCheckpoint, type AgentPostcondition, type AgentVerificationReport, type AgentVerificationCheck } from './session-state.js';

export type AgentFieldKind = 'password' | 'otp' | 'card' | 'identifier' | 'text';

export interface AgentElement {
  ref: string;
  role: string;
  label: string;
  field?: AgentFieldKind;
  value?: string;
  href?: string;
  disabled?: boolean;
  inViewport: boolean;
}

export interface AgentPage {
  id: string;
  url: string;
  title: string;
  text: string;
  elements: AgentElement[];
  signals: { captcha: boolean; password: boolean; otp: boolean; card: boolean };
  scroll: { top: number; height: number; viewport: number };
  hash: string;
  observedAt: string;
  documentStatus?: number;
}

export interface AgentActionResult {
  page: AgentPage;
  changed: boolean;
  verification?: AgentVerificationReport;
}

/** Owner-only transfer descriptor. No local path, cookie or hidden form value is exposed. */
export interface AgentFileTarget {
  direction: 'upload' | 'download'; ref: string; label: string; url: string;
  pageHash: string; accountId: string | null; formHash: string | null;
  fieldName: string | null; fieldNames: string[]; cookieHash: string;
}
const sameFileTarget = (left: AgentFileTarget, right: AgentFileTarget) => (['direction', 'ref', 'label', 'url', 'pageHash', 'accountId', 'formHash', 'fieldName', 'cookieHash'] as const).every(key => left[key] === right[key]) && JSON.stringify(left.fieldNames) === JSON.stringify(right.fieldNames);

/** A single native request, bound to the observed document and its exact values. */
export interface AgentRequestPermit {
  id: string;
  url: string;
  method: 'GET' | 'POST';
  bodyHash: string;
  pageHash: string;
  actionHash: string;
  expiresAt: number;
}
/** A request stopped at the boundary, shown to the owner with its exact destination and values. */
export interface AgentHeldEffect {
  id: string;
  url: string;
  method: string;
  bodyHash: string;
  bodyPreview: string;
  expiresAt: number;
}
/** Same code as a refusal: nothing was sent. Callers that can ask the owner use `held`. */
export class AgentEffectHeld extends BrowserError {
  constructor(public readonly held: AgentHeldEffect) {
    super('AGENT_EFFECT_DENIED', 'عُلّق طلب إرسال حتى موافقتك. لم يُرسل الطلب.', 403);
  }
}
export interface AgentAction {
  kind: 'open' | 'click' | 'type' | 'select' | 'press' | 'form' | 'back' | 'scroll' | 'wait';
  ref?: string;
  text?: string;
  submit?: boolean;
}
export interface AgentAuthority {
  signal: AbortSignal;
  assertActive(): Promise<void>;
  dispatched(permit: AgentRequestPermit): Promise<string>;
  completed(receiptId: string, status: number | null): Promise<void>;
  /** Runtime closure bound to this exact execution/lease, including Playwright route callbacks. */
  saveCheckpoint?(checkpoint: AgentSessionCheckpoint): Promise<void>;
}

export interface AgentBrowserOptions {
  profileDir: string;
  /** Hosts allowed for local fixtures only. Everything else must be a public address. */
  testOrigins?: string[];
  /** When set, every navigation, subresource and redirect must stay in this scope. */
  allowedOrigins?: readonly string[];
  /** Real Chrome is preferred; null uses the bundled Chromium. */
  channel?: 'chrome' | null;
  headless?: boolean;
  /** Trusted runtime persists under its existing owner/lease fence. Throwing blocks dispatch. */
  onCheckpoint?: (checkpoint: AgentSessionCheckpoint) => Promise<void>;
}

interface ConversationPage {
  ownerId: string;
  conversationId: string;
  page: Page;
  pages: Set<Page>;
  readers: number;
  shot: Buffer | null;
  lastHash: string | null;
  lastUsed: number;
  navigationUrl?: string;
  popupIntent?: { url: string; operation: ConversationPage['operation'] };
  documentResponse?: { url: string; status: number };
  redirectTarget?: string;
  operation?: { kind: AgentAction['kind']; authority: AgentAuthority; permit?: AgentRequestPermit; used: boolean; responded?: boolean; receiptId?: string; navigated?: boolean; pending:AbortController; denial?: BrowserError };
  held?: { effect: AgentHeldEffect; route: Route; timer: ReturnType<typeof setTimeout> };
  ownerInputUntil?: number;
  ownerInputLimit?: number;
  redactions: Map<string, number>;
  history:string[];
  historyIndex:number;
  targets: Map<string, ObservedTarget>;
  lastObservation?: Pick<AgentPage, 'url' | 'hash' | 'observedAt' | 'documentStatus'>;
  recovery: { status: AgentSessionCheckpoint['status']; actionKind: AgentAction['kind'] | null; effect: AgentSessionCheckpoint['effect']; reviewRequired: boolean };
  checkpointWrite: Promise<void>;
  closed?: boolean;
}

interface FrameSnapshot {
  url: string;
  title: string;
  text: string;
  elements: AgentElement[];
  challenge: boolean;
  integrity: string;
  scroll: AgentPage['scroll'];
}

interface FrameModel {
  read(firstRef: number, limit: number): FrameSnapshot;
  resolve(ref: string): Element | null;
  prepareForm(action: AgentAction): { url: string; method: 'GET' | 'POST'; body: string; multipart: boolean } | null;
  canWrite(ref: string, value: string, approved: boolean): boolean;
  recordWrite(ref: string): void;
}

interface ObservedTarget {
  frame: Frame;
  model: JSHandle<FrameModel>;
  href?: string;
}

interface OwnerBrowser {
  context: BrowserContext;
  conversations: Map<string, ConversationPage>;
  proxy: Server;
  allocation: Promise<void>;
}

const VIEWPORT = { width: 1280, height: 800 };
const MAX_CONVERSATION_PAGES = 4;
const MAX_FRAME_ELEMENTS = 220;
const REF_PATTERN = /^(?:f\d+)?e\d+$/;
const GESTURES = new Set<AgentAction['kind']>(['click', 'type', 'press', 'form']);
const OWNER_FOLLOW_MS = 8000;
const OWNER_LIMIT_MS = 120000;
const HELD_MS = 5 * 60000;

/**
 * Held by Playwright in each document. Refs bind to DOM nodes and their
 * observed identity without writing selectors into the page's markup.
 */
const FRAME_MODEL_SCRIPT = String.raw`(() => {
  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const identities = new WeakMap();
  const agentValues = new WeakMap();
  let targets = new Map();
  const interactive = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable="true"],[contenteditable=""]';
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const labelOf = (node) => {
    const labelledBy = node.getAttribute('aria-labelledby');
    const root = node.getRootNode();
    const referenced = labelledBy && root.getElementById ? labelledBy.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? '').join(' ') : '';
    const buttonValue = node.tagName === 'INPUT' && ['submit', 'button'].includes(node.type) ? node.value : '';
    return clean(node.getAttribute('aria-label') || referenced || node.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.getAttribute('title') || buttonValue || node.innerText || node.querySelector?.('img[alt]')?.alt || node.getAttribute('name') || node.id);
  };
  const fieldText = (node) => [node.name, node.id, node.autocomplete, node.getAttribute('aria-label'), node.placeholder, node.labels?.[0]?.textContent].join(' ').toLowerCase();
  const fieldKind = (node, singleDigitBoxes) => {
    if (!['INPUT', 'TEXTAREA'].includes(node.tagName)) return undefined;
    const text = fieldText(node), type = String(node.type).toLowerCase();
    if (type === 'password') return 'password';
    if (/\bcc-|card.?number|cardnumber|\bcvv\b|\bcvc\b|رقم.?البطاقة/.test(text)) return 'card';
    if (/one.?time|\botp\b|verification.?code|verify.?code|auth.?code|security.?code|\b2fa\b|\bmfa\b|\btotp\b|sms.?code|pin.?code|رمز|كود|التحقق/.test(text)) return 'otp';
    if (singleDigitBoxes && node.maxLength === 1) return 'otp';
    if (type === 'email' || /username|\bemail\b|e-mail|identifier|\blogin\b|user.?id|phone|البريد|اسم.?المستخدم|الهاتف/.test(text)) return 'identifier';
    return 'text';
  };
  const roleOf = (node) => {
    const role = node.getAttribute('role');
    if (role) return role;
    if (node.tagName === 'A') return 'link';
    if (node.tagName === 'SELECT') return 'select';
    if (node.tagName === 'TEXTAREA' || node.isContentEditable) return 'textbox';
    if (node.tagName === 'INPUT') return node.type === 'file' ? 'file' : ['submit', 'button', 'image', 'reset'].includes(node.type) ? 'button' : ['checkbox', 'radio'].includes(node.type) ? node.type : 'textbox';
    return 'button';
  };
  const identityOf = (node) => JSON.stringify([
    location.href, node.tagName, roleOf(node), labelOf(node), node.id, node.name, node.type,
    node.href, node.getAttribute('target'), node.getAttribute('onclick'), node.disabled, node.getAttribute('aria-disabled'),
    node.form?.action, node.form?.method, node.form?.enctype, node.form?.target,
    node.getAttribute('formaction'), node.getAttribute('formmethod'), node.getAttribute('formenctype'), node.getAttribute('formtarget'),
  ]);
  const resolve = (ref) => {
    const node = targets.get(ref);
    if (!node?.isConnected || !node.matches(interactive) || !visible(node)) return null;
    return identities.get(node)?.identity === identityOf(node) ? node : null;
  };
  const read = (firstRef, limit) => {
    const nodes = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        if (nodes.length > 9000) return;
        nodes.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(document);
    const nextTargets = new Map();
    const candidates = nodes.filter((node) => node.matches(interactive) && !(node.tagName === 'INPUT' && node.type === 'hidden') && visible(node));
    const singleDigitBoxes = candidates.filter((node) => node.tagName === 'INPUT' && node.maxLength === 1).length >= 4;
    const elements = candidates.slice(0, limit).map((node, index) => {
      const identity = identityOf(node), previous = identities.get(node);
      const ref = previous?.identity === identity ? previous.ref : 'e' + (firstRef + index);
      identities.set(node, { ref, identity });
      nextTargets.set(ref, node);
      const rect = node.getBoundingClientRect(), field = fieldKind(node, singleDigitBoxes);
      const sensitive = field && field !== 'text' && field !== 'identifier';
      const value = !sensitive && 'value' in node && node.tagName !== 'BUTTON' && !['submit', 'button'].includes(node.type) ? clean(node.value).slice(0, 60) : '';
      return {
        ref, role: roleOf(node), label: labelOf(node).slice(0, 90), field,
        ...(value ? { value } : {}),
        // Preserve every accepted URL; the extra character keeps oversized URLs rejectable.
        ...(node.tagName === 'A' && node.href ? { href: node.href.slice(0, 2501) } : {}),
        ...(node.disabled || node.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      };
    });
    targets = nextTargets;
    const challengeFrames = Array.from(document.querySelectorAll('iframe')).filter((frame) => {
      const rect = frame.getBoundingClientRect(), source = String(frame.src) + ' ' + String(frame.title);
      return /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha|captcha/i.test(source) && !/size=invisible/.test(source) && !frame.closest('.grecaptcha-badge') && rect.width >= 60 && rect.height >= 40 && visible(frame);
    });
    const main = document.querySelector('main,[role=main],article');
    const mainText = clean(main?.innerText), bodyText = clean(document.body?.innerText);
    return {
      url: location.href, title: clean(document.title).slice(0, 200),
      text: (mainText.length > 400 ? mainText : bodyText).slice(0, 24000),
      elements, challenge: challengeFrames.length > 0,
      // Kept on the host only as a hash; hidden values and passwords never enter the model snapshot.
      integrity: JSON.stringify(nodes.filter(node => node.matches('form,input,button,textarea,select,a[href]')).slice(0,1000).map(node => [node.tagName,node.id,node.name,node.type,node.form?.action,node.form?.method,node.getAttribute('formaction'),node.getAttribute('formmethod'),node.getAttribute('target'),node.href,node.value,node.checked,node.disabled])),
      scroll: { top: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
    };
  };
  const prepareForm = (input) => {
    const node = input.ref ? resolve(input.ref) : document.activeElement;
    if (!node) return null;
    if (input.kind === 'click' && node.tagName === 'A') return null;
    const submitter = input.kind === 'click' && ['BUTTON','INPUT'].includes(node.tagName) && node.type === 'submit' ? node : null;
    if (input.kind === 'click' && !submitter) return null;
    const form = node.form;
    if (!form) return null;
    const button = submitter || Array.from(form.elements).find(item => ['BUTTON','INPUT'].includes(item.tagName) && item.type === 'submit' && !item.disabled);
    const method = (button?.hasAttribute('formmethod') ? button.formMethod : form.method).toUpperCase();
    const action = button?.hasAttribute('formaction') ? button.formAction : form.action;
    const encoding = button?.hasAttribute('formenctype') ? button.formEnctype : form.enctype;
    const target = button?.hasAttribute('formtarget') ? button.formTarget : form.target;
    if (!['GET','POST'].includes(method) || !['application/x-www-form-urlencoded','multipart/form-data'].includes(encoding) || target && target !== '_self') throw new Error('Unsupported native form');
    const data = new FormData(form, button || undefined);
    if (input.kind === 'type' && node.name) data.set(node.name, input.text || '');
    const fields = [];
    for (const [key,value] of data) { if (typeof value !== 'string') throw new Error('File upload denied'); fields.push([key,value.replace(/\r?\n/g,'\r\n')]); }
    const body = new URLSearchParams(fields).toString();
    if (body.length > 16000) throw new Error('Form too large');
    const url = new URL(action || location.href, location.href); url.hash = '';
    if (method === 'GET') url.search = body;
    return {url:url.href,method,body:method === 'POST' ? body : '',multipart:method === 'POST' && encoding === 'multipart/form-data'};
  };
  const valueOf = node => 'value' in node ? String(node.value) : String(node.textContent || '');
  const canWrite = (ref, value, approved) => {
    const node = resolve(ref);
    if (!node) return false;
    const current = valueOf(node);
    if (approved || current === value || !current || agentValues.get(node) === current) return true;
    // A select's original default is page state, not a choice the owner made.
    return node.tagName === 'SELECT' && Array.from(node.options).every((option, index) => option.selected === (option.defaultSelected || !Array.from(node.options).some(item => item.defaultSelected) && index === 0));
  };
  const recordWrite = ref => { const node = resolve(ref); if (node) agentValues.set(node, valueOf(node)); };
  return { read, resolve, prepareForm, canWrite, recordWrite };
})()`;

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function requestBodyHash(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n?/g, '\n')).digest('hex');
}

/** Boundaries are random; a text multipart permit binds the ordered names and values. */
async function incomingBodyHash(route: Route): Promise<string> {
  const request = route.request(), contentType = request.headers()['content-type'] ?? '';
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) return requestBodyHash(request.postData() ?? '');
  const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
  if (bytes.length > 16000) throw new BrowserError('AGENT_FORM_UNSUPPORTED', 'تجاوز النموذج النصي حد الحجم المسموح.', 403);
  try {
    const data = await new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData();
    const fields: [string, string][] = [];
    for (const [key, value] of data) {
      if (typeof value !== 'string' || fields.length >= 200) throw new Error('Files are not approved');
      fields.push([key, value.replace(/\r?\n/g, '\r\n')]);
    }
    return requestBodyHash('multipart-text:' + new URLSearchParams(fields).toString());
  } catch {
    throw new BrowserError('AGENT_FORM_UNSUPPORTED', 'هذا النموذج يتضمن ملفًا أو بيانات لا يمكن تفويضها كنص.', 403);
  }
}

function frameOrigin(frame: Frame): string {
  for (let current: Frame | null = frame; current; current = current.parentFrame()) {
    const origin = URL.canParse(current.url()) ? new URL(current.url()).origin : 'null';
    if (origin !== 'null') return origin;
  }
  return 'null';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A normal browser for the assistant. Sites run as they do for a person, while
 * private network destinations stay unreachable and a saved profile keeps sign-ins.
 */
export class AgentBrowser {
  private owners = new Map<string, Promise<OwnerBrowser>>();
  private accounts = new Map<string, string>();
  private recoveryBindings = new Map<string, AgentSessionCheckpoint>();
  private readonly network: SafeNetwork;
  private readonly frameModels = new WeakMap<Frame, Promise<JSHandle<FrameModel>>>();
  private nextRef = 0;
  private checkpointStore?: AgentBrowserOptions['onCheckpoint'];

  constructor(private readonly options: AgentBrowserOptions) {
    this.network = new SafeNetwork({ testOrigins: options.testOrigins });
    this.checkpointStore = options.onCheckpoint;
  }

  /** Installed once by the trusted server; never exposed as a page/model capability. */
  setCheckpointStore(store: NonNullable<AgentBrowserOptions['onCheckpoint']>): void {
    if (this.checkpointStore && this.checkpointStore !== store && this.owners.size) throw new BrowserError('AGENT_CHECKPOINT_STORE_BOUND', 'مخزن استعادة المتصفح محدد بالفعل.', 409);
    this.checkpointStore = store;
  }

  normalizeUrl(input: string): string {
    const value = input.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new BrowserError('AGENT_URL_INVALID', 'الرابط غير صالح.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new BrowserError('AGENT_URL_INVALID', 'يدعم المتصفح روابط http و https فقط.');
    if (url.username || url.password) throw new BrowserError('AGENT_URL_DENIED', 'لا يُقبل رابط يحتوي على بيانات دخول.');
    return url.href;
  }

  /** Blocks loopback and private addresses, including public names that resolve to them. */
  async isAllowed(input: string): Promise<boolean> {
    try { await this.network.pin(input, this.options.allowedOrigins); return true; } catch { return false; }
  }

  private profileKey(ownerId: string, conversationId: string): string {
    const account = this.accounts.get(JSON.stringify([ownerId, conversationId]));
    return account ? `account:${JSON.stringify([ownerId, account])}` : `default:${ownerId}`;
  }

  /** Server-owned account selection, before opening a conversation. Never supplied by a page/model. */
  async bindAccount(ownerId: string, conversationId: string, accountId: string | null): Promise<void> {
    if (accountId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new BrowserError('AGENT_ACCOUNT_INVALID', 'معرّف الحساب غير صالح.');
    if ((this.accounts.get(JSON.stringify([ownerId, conversationId])) ?? null) === accountId) return;
    const existing = await this.owners.get(this.profileKey(ownerId, conversationId))?.catch(() => null);
    if (existing?.conversations.has(conversationId)) throw new BrowserError('AGENT_ACCOUNT_BUSY', 'أغلق جلسة المتصفح قبل تبديل الحساب.', 409);
    this.recoveryBindings.delete(JSON.stringify([ownerId, conversationId]));
    if (accountId === null) this.accounts.delete(JSON.stringify([ownerId, conversationId]));
    else this.accounts.set(JSON.stringify([ownerId, conversationId]), accountId);
  }

  /** Load the durable fence before ordinary work too; this never opens a page or repeats a request. */
  async bindRecoveryCheckpoint(ownerId: string, conversationId: string, raw: unknown): Promise<void> {
    if (raw === null || raw === undefined) return;
    const parsed = AgentSessionCheckpointSchema.safeParse(raw);
    const key = JSON.stringify([ownerId, conversationId]);
    if (!parsed.success || parsed.data.ownerId !== ownerId || parsed.data.conversationId !== conversationId || parsed.data.accountId !== (this.accounts.get(key) ?? null)) throw new BrowserError('AGENT_CHECKPOINT_INVALID', 'نقطة الاستعادة لا تخص المحادثة أو الحساب المحدد.', 403);
    this.recoveryBindings.set(key, parsed.data);
    // A live session already has more recent fences and may hold an exact approved request.
  }

  private checkpoint(entry: ConversationPage): AgentSessionCheckpoint {
    const observed = entry.lastObservation;
    return AgentSessionCheckpointSchema.parse({
      version: 1, ownerId: entry.ownerId, conversationId: entry.conversationId,
      accountId: this.accounts.get(JSON.stringify([entry.ownerId, entry.conversationId])) ?? null,
      savedAt: new Date().toISOString(), status: entry.recovery.status, actionKind: entry.recovery.actionKind,
      resumeUrl: observed ? safeResumeUrl(observed.url, this.redactions(entry)) : null,
      urlHash: observed ? evidenceHash(observed.url) : null,
      pageHash: observed?.hash ?? null, observedAt: observed?.observedAt ?? null,
      documentStatus: observed?.documentStatus ?? null, effect: entry.recovery.effect,
    });
  }

  private async persist(entry: ConversationPage, authority?: AgentAuthority): Promise<void> {
    const store = entry.operation?.authority.saveCheckpoint ?? authority?.saveCheckpoint ?? this.checkpointStore;
    const snapshot = this.checkpoint(entry);
    const remember = () => { this.recoveryBindings.set(JSON.stringify([entry.ownerId, entry.conversationId]), snapshot); };
    if (!store) { remember(); return; }
    // Preserve this write's rejection for its caller, but allow a later freshly fenced write.
    entry.checkpointWrite = entry.checkpointWrite.catch(() => {}).then(() => store(snapshot));
    await entry.checkpointWrite;
    remember();
  }

  /** Metadata only: no cookies, local storage, field values, titles, text, or screenshots. */
  async snapshotSession(ownerId: string, conversationId: string): Promise<AgentSessionCheckpoint | null> {
    const owner = await this.owners.get(this.profileKey(ownerId, conversationId))?.catch(() => null);
    const entry = owner?.conversations.get(conversationId);
    return entry ? this.checkpoint(entry) : null;
  }

  /** Explicit fresh readback only. An unresolved action/approval is never replayed. */
  async restoreSession(ownerId: string, conversationId: string, raw: unknown, authority: AgentAuthority): Promise<
    { status: 'review_required'; reason: string } |
    { status: 'readback'; result: AgentActionResult; sameUrl: boolean; sameContent: boolean; requiresReplan: true }
  > {
    const parsed = AgentSessionCheckpointSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerId !== ownerId || parsed.data.conversationId !== conversationId) throw new BrowserError('AGENT_CHECKPOINT_INVALID', 'نقطة الاستعادة لا تخص هذه المحادثة أو المالك.', 403);
    const checkpoint = parsed.data;
    authority.signal.throwIfAborted(); await authority.assertActive();
    if (await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_RESUME_LIVE_PAGE', 'للمحادثة صفحة حالية؛ اقرأها قبل طلب الاستعادة.', 409);
    const age = Date.now() - Date.parse(checkpoint.savedAt);
    if (age < -10000 || age > 24 * 60 * 60000) return { status: 'review_required', reason: 'checkpoint_expired' };
    const safePendingRead = checkpoint.status === 'action_pending' && ['open', 'back', 'scroll', 'wait'].includes(checkpoint.actionKind ?? '');
    if (checkpoint.status !== 'ready' && !safePendingRead) return { status: 'review_required', reason: 'unresolved_action_or_closed_session' };
    if (!checkpoint.resumeUrl || safeResumeUrl(checkpoint.resumeUrl) !== checkpoint.resumeUrl || evidenceHash(checkpoint.resumeUrl) !== checkpoint.urlHash) return { status: 'review_required', reason: 'resume_url_unavailable_or_sensitive' };
    if (checkpoint.effect?.method === 'GET' && checkpoint.effect.urlHash === checkpoint.urlHash) return { status: 'review_required', reason: 'readback_would_repeat_get_effect' };
    await this.bindAccount(ownerId, conversationId, checkpoint.accountId);
    await this.bindRecoveryCheckpoint(ownerId, conversationId, checkpoint);
    const result = await this.act(ownerId, conversationId, { kind: 'open', text: checkpoint.resumeUrl }, authority);
    return { status: 'readback', result, sameUrl: evidenceHash(result.page.url) === checkpoint.urlHash, sameContent: result.page.hash === checkpoint.pageHash, requiresReplan: true };
  }

  /** Only an explicit authenticated owner review may clear an unresolved effect. Not a model tool. */
  async acknowledgeRecovery(ownerId: string, conversationId: string, authority: AgentAuthority): Promise<void> {
    authority.signal.throwIfAborted(); await authority.assertActive();
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'يلزم اعتماد نقطة الاستعادة المحفوظة قبل فتح الصفحة.', 409);
    const entry = await this.conversation(ownerId, conversationId);
    if (entry.operation || entry.held) throw new BrowserError('AGENT_ACTION_BUSY', 'أنهِ الإجراء أو الموافقة المعلقة قبل مراجعة الاستعادة.', 409);
    entry.recovery = { status: 'ready', actionKind: null, effect: entry.recovery.effect, reviewRequired: false };
    await this.persist(entry, authority);
  }

  /** Authenticated owner acknowledgment permits fresh readback, never replay of the old action. */
  async acknowledgeCheckpoint(ownerId: string, conversationId: string, raw: unknown, authority: AgentAuthority, options: { readbackUrl?: string } = {}): Promise<AgentSessionCheckpoint> {
    authority.signal.throwIfAborted(); await authority.assertActive();
    const parsed = AgentSessionCheckpointSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerId !== ownerId || parsed.data.conversationId !== conversationId) throw new BrowserError('AGENT_CHECKPOINT_INVALID', 'نقطة الاستعادة لا تخص هذه المحادثة أو المالك.', 403);
    if (await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_RESUME_LIVE_PAGE', 'راجع حالة الصفحة الحالية قبل اعتماد نقطة استعادة محفوظة.', 409);
    const checkpoint: AgentSessionCheckpoint = { ...parsed.data, savedAt: new Date().toISOString(), status: 'ready', actionKind: null };
    if (options.readbackUrl !== undefined) {
      const url = safeResumeUrl(options.readbackUrl);
      if (!url) throw new BrowserError('AGENT_CHECKPOINT_URL_UNSAFE', 'اختر رابط قراءة لا يتضمن بيانات دخول.', 403);
      this.network.validate(url, this.options.allowedOrigins);
      Object.assign(checkpoint, { resumeUrl: url, urlHash: evidenceHash(url), pageHash: null, observedAt: null, documentStatus: null });
    }
    // Keep the last effect hashes: a GET effect must never be repeated by readback.
    await (authority.saveCheckpoint ?? this.checkpointStore)?.(checkpoint);
    this.recoveryBindings.set(JSON.stringify([ownerId, conversationId]), checkpoint);
    return checkpoint;
  }

  private async launch(ownerKey: string): Promise<OwnerBrowser> {
    const profileName = ownerKey.startsWith('default:') ? hashOf(ownerKey.slice('default:'.length)) : `account-${hashOf(ownerKey)}`;
    const userDataDir = `${this.options.profileDir}/${profileName}`;
    await mkdir(userDataDir, { recursive: true });
    // Match BrowserEngine: Chromium cannot bypass the pinned host transport,
    // including on redirects, WebRTC, popups or requests missed by a route.
    const proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
    proxy.on('connect', (_request, socket) => socket.destroy());
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Browser proxy unavailable');
    const launchOptions = {
      headless: this.options.headless ?? true,
      viewport: VIEWPORT,
      locale: 'ar',
      acceptDownloads: false,
      serviceWorkers: 'block' as const,
      proxy: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' },
      args: ['--disable-background-networking', '--disable-quic', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND'],
    };
    const channel = this.options.channel === undefined ? 'chrome' : this.options.channel;
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, { ...launchOptions, ...(channel ? { channel } : {}) });
    } catch {
      try {
        context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      } catch {
        proxy.close();
        throw new BrowserError('AGENT_BROWSER_UNAVAILABLE', 'تعذر تشغيل المتصفح. ثبّت Chromium بالأمر: npx playwright install chromium', 503);
      }
    }
    const owner: OwnerBrowser = { context, conversations: new Map(), proxy, allocation: Promise.resolve() };
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request();
      let entry: ConversationPage | undefined;
      let acting:ConversationPage['operation'];
      let optionalRead = false;
      let backgroundWriteScopeFailure = false;
      let initialPopup = false;
      try {
        const requestPage = request.frame().page();
        entry = [...owner.conversations.values()].find(candidate => candidate.pages.has(requestPage));
        // A popup's initial request is routed before Playwright emits `popup`.
        if (!entry) {
          const opener = await requestPage.opener();
          entry = [...owner.conversations.values()].find(candidate => opener && candidate.pages.has(opener));
          if (entry && opener) this.adoptPopup(entry, requestPage, opener);
          if (!entry?.pages.has(requestPage)) entry = undefined;
        }
      } catch { /* Chromium can route a popup before exposing its Frame/Page. */ }
      // Only one exact, observed link destination may claim a new-window request.
      if (!entry && request.isNavigationRequest() && request.method() === 'GET') {
        const candidates = [...owner.conversations.values()].filter(candidate => candidate.popupIntent?.url === request.url() && candidate.operation && candidate.operation === candidate.popupIntent.operation);
        if (candidates.length === 1) { entry = candidates[0]; initialPopup = true; }
      }
      try {
        if (!entry) throw new BrowserError('AGENT_NETWORK_DENIED', 'لا توجد جلسة مصرح بها لهذا الطلب.', 403);
        const operation = entry.operation;
        acting=operation;
        optionalRead = !request.isNavigationRequest() && ['GET', 'HEAD'].includes(request.method());
        // The document may still be read when its own background write is
        // blocked at the scope boundary. No agent gesture or navigation gets
        // this exception, and no transport is attempted for the denied write.
        backgroundWriteScopeFailure = operation?.kind === 'open' && !operation.permit && !operation.used && !entry.held && !request.isNavigationRequest() && !['GET', 'HEAD'].includes(request.method());
        const url = this.network.validate(request.url(), this.options.allowedOrigins).href, method = request.method(), bodyHash = await incomingBodyHash(route);
        optionalRead = false;
        backgroundWriteScopeFailure = false;
        if(operation){
          operation.authority.signal.throwIfAborted(); await operation.authority.assertActive();
          if(entry.operation!==operation)throw new BrowserError('AGENT_AUTHORITY_STALE','انتهى تفويض الإجراء قبل إرسال الطلب.',409);
        }
        const navigation = request.isNavigationRequest(), topLevel = initialPopup || navigation && request.frame() === entry.page.mainFrame();
        const permit = operation?.permit;
        if (!permit && method === 'GET' && entry.recovery.effect?.method === 'GET' && entry.recovery.effect.urlHash === evidenceHash(url)) throw new BrowserError('AGENT_RECOVERY_GET_REPLAY_DENIED', 'حُجبت إعادة وجهة إرسال GET السابقة دون موافقة جديدة مطابقة.', 409);
        const actor = this.actor(entry, operation, topLevel, url);
        const decision = decideEffect({ url, method, bodyHash, pageOrigin: frameOrigin(initialPopup ? entry.page.mainFrame() : request.frame()), topLevelNavigation: topLevel, actor, ...(entry.navigationUrl ? { expectedNavigation: entry.navigationUrl } : {}), ...(permit ? { permit: { url: permit.url, method: permit.method, bodyHash: permit.bodyHash, used: operation!.used, expiresAt: permit.expiresAt } } : {}), now: Date.now() });
        // A click may not steer a frame: a programmatic form submit into an
        // iframe is an effect that the read rule below must not excuse.
        if (navigation && !topLevel && actor === 'agent' && decision.kind === 'allow' && !decision.consumesPermit) throw new BrowserError('AGENT_EFFECT_DENIED', 'حُجب تنقل إطار تلقائي بلا موافقة مطابقة. لم يُرسل الطلب.', 403);
        if (decision.kind === 'deny') {
          if (operation && (decision.failsAction || topLevel)) throw new BrowserError(decision.code, 'حُجب إرسال أو تنقل تلقائي بلا موافقة مطابقة للوجهة والقيم. لم يُرسل الطلب.', decision.code === 'AGENT_EFFECT_UNKNOWN' ? 409 : 403);
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        if (decision.kind === 'hold') {
          if (!operation || entry.held) { await route.abort('blockedbyclient').catch(() => {}); return; }
          await this.hold(entry, operation, route, url, method, bodyHash);
          return;
        }
        if (actor === 'owner') this.ownerActive(entry);
        optionalRead = !navigation && !decision.consumesPermit && (method === 'GET' || method === 'HEAD');
        if (navigation && entry.navigationUrl === url) entry.navigationUrl = undefined;
        if (topLevel && operation) operation.navigated = true;
        if (decision.consumesPermit) {
          operation!.used = true;
          entry.recovery.status = 'effect_pending';
          entry.recovery.effect = { method, urlHash: evidenceHash(url), bodyHash };
          await this.persist(entry);
          operation!.receiptId = await operation!.authority.dispatched(permit!);
        }
        await this.forward(entry, route, url, method, decision.credentials, operation, decision.consumesPermit, initialPopup);
      } catch (error) {
        // A cancelled resource from a finished action must not fail the next observation.
        const optionalFailure = error instanceof BrowserError && (optionalRead || backgroundWriteScopeFailure && error.code === 'BROWSER_SCOPE_DENIED');
        if (!optionalFailure && acting && entry?.operation === acting) {
          acting.denial = acting.used ? new BrowserError('AGENT_EFFECT_UNKNOWN', 'أُرسل الطلب أو بدأت محاولته ولم تُحسم النتيجة. راجع أثره قبل إعادة التنفيذ.', 409)
            : error instanceof BrowserError ? error : new BrowserError('AGENT_NETWORK_DENIED', 'توقف الطلب لأن التفويض أو الاتصال لم يعد صالحًا.', 403);
        }
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    context.on('close', () => { this.owners.delete(ownerKey); proxy.close(); });
    return owner;
  }

  private actor(entry: ConversationPage, operation: ConversationPage['operation'], topLevel: boolean, url: string): EffectActor {
    if (!operation) return (entry.ownerInputUntil ?? 0) > Date.now() ? 'owner' : 'page';
    // Once its request left or its page changed, the action is over; what follows is the new page's own traffic.
    if ((operation.permit || GESTURES.has(operation.kind)) && !operation.used && !operation.navigated) return 'agent';
    return topLevel && entry.navigationUrl === url ? 'agent' : 'page';
  }

  /** Requests that follow a person's input stay theirs, up to a hard limit after that input. */
  private ownerActive(entry: ConversationPage): void {
    entry.ownerInputUntil = Math.min(Date.now() + OWNER_FOLLOW_MS, entry.ownerInputLimit ?? 0);
  }

  private ownerInput(entry: ConversationPage): void {
    entry.ownerInputLimit = Date.now() + OWNER_LIMIT_MS;
    this.ownerActive(entry);
  }

  /** Keeps the request unsent at the boundary. Only releaseHeld can send it, once. */
  private async hold(entry: ConversationPage, operation: NonNullable<ConversationPage['operation']>, route: Route, url: string, method: string, bodyHash: string): Promise<void> {
    const bytes = route.request().postDataBuffer();
    const printable = bytes && !bytes.subarray(0, 2000).includes(0) ? bytes.toString('utf8').slice(0, 1500) : '';
    const secrets = this.redactions(entry);
    const bodyPreview = secrets.reduce((text, secret) => text.split(secret).join('[محجوب]'), printable || (bytes ? `[بيانات ثنائية، ${bytes.length} بايت]` : ''));
    const expiresAt = Date.now() + HELD_MS;
    const held: AgentHeldEffect = { id: randomUUID(), url, method, bodyHash, bodyPreview, expiresAt };
    const timer = setTimeout(() => { if (entry.held?.effect === held) this.discard(entry); }, HELD_MS);
    timer.unref();
    entry.held = { effect: held, route, timer };
    operation.denial = new AgentEffectHeld(held);
    entry.recovery.status = 'approval_pending';
    entry.recovery.effect = { method, urlHash: evidenceHash(url), bodyHash };
    await this.persist(entry);
  }

  private discard(entry: ConversationPage): void {
    const held = entry.held;
    if (!held) return;
    entry.held = undefined;
    clearTimeout(held.timer);
    void held.route.abort('blockedbyclient').catch(() => {});
  }

  /** Sends the one request the owner reviewed. It never re-creates it from page state. */
  async releaseHeld(ownerId: string, conversationId: string, heldId: string, authority: AgentAuthority): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    const held = entry.held;
    if (!held || held.effect.id !== heldId || held.effect.expiresAt <= Date.now()) throw new BrowserError('AGENT_APPROVAL_STALE', 'انتهت صلاحية الطلب المعلّق قبل الموافقة. لم يُرسل الطلب.', 409);
    if (entry.operation) throw new BrowserError('AGENT_ACTION_BUSY', 'هناك إجراء جارٍ في هذه الصفحة.', 409);
    entry.held = undefined;
    clearTimeout(held.timer);
    const { effect, route } = held;
    const permit: AgentRequestPermit = { id: effect.id, url: effect.url, method: effect.method as AgentRequestPermit['method'], bodyHash: effect.bodyHash, pageHash: '', actionHash: '', expiresAt: effect.expiresAt };
    const operation: NonNullable<ConversationPage['operation']> = { kind: 'click', authority, permit, used: true, pending: new AbortController() };
    entry.operation = operation;
    try {
      authority.signal.throwIfAborted(); await authority.assertActive();
      entry.recovery.status = 'effect_pending';
      entry.recovery.actionKind = 'click';
      entry.recovery.effect = { method: effect.method, urlHash: evidenceHash(effect.url), bodyHash: effect.bodyHash };
      await this.persist(entry);
      operation.receiptId = await authority.dispatched(permit);
      await this.forward(entry, route, effect.url, effect.method, 'keep', operation, true).catch(async error => {
        await route.abort('blockedbyclient').catch(() => {});
        operation.denial = error instanceof BrowserError && error.code === 'AGENT_EFFECT_UNKNOWN' ? error : new BrowserError('AGENT_EFFECT_UNKNOWN', 'بدأ إرسال الطلب ولم تُحسم النتيجة. راجع أثره قبل إعادة التنفيذ.', 409);
      });
      const result = await this.result(entry);
      if (entry.closed) throw new BrowserError('AGENT_PAGE_CLOSED', 'أُغلقت صفحة المحادثة.', 409);
      entry.recovery.status = operation.responded ? 'ready' : 'review_required';
      entry.recovery.reviewRequired = !operation.responded;
      entry.recovery.actionKind = null;
      await this.persist(entry);
      return result;
    } catch (error) {
      if (entry.closed) throw error;
      entry.recovery.status = 'review_required'; entry.recovery.reviewRequired = true;
      await this.persist(entry);
      throw error;
    } finally {
      operation.pending.abort();
      if (entry.operation === operation) { entry.navigationUrl = undefined; entry.operation = undefined; }
    }
  }

  async dropHeld(ownerId: string, conversationId: string): Promise<void> {
    const entry = (await this.owners.get(this.profileKey(ownerId, conversationId))?.catch(() => null))?.conversations.get(conversationId);
    if (entry) {
      this.discard(entry);
      if (!entry.recovery.reviewRequired) entry.recovery = { status: 'ready', actionKind: null, effect: null, reviewRequired: false };
      await this.persist(entry);
    }
  }

  private async forward(entry: ConversationPage, route: Route, url: string, method: string, credentials: 'keep' | 'omit', operation: ConversationPage['operation'], consumed: boolean, initialPopup = false): Promise<void> {
    const request = route.request(), navigation = request.isNavigationRequest(), topLevel = initialPopup || navigation && request.frame() === entry.page.mainFrame();
    const read = method === 'GET' || method === 'HEAD', body = request.postDataBuffer() ?? undefined;
    const active = async () => {
      if (!operation) return;
      await operation.authority.assertActive();
      if (entry.operation !== operation) throw new BrowserError('AGENT_AUTHORITY_STALE', 'انتهى تفويض الإجراء قبل إرسال الطلب.', 409);
    };
    let target = url, headers = await request.allHeaders();
    if (credentials === 'omit') { headers = { ...headers }; delete headers.cookie; }
    for (let redirects = 0; redirects <= 5; redirects++) {
      await active();
      const response = await this.network.request(target, { method, headers, ...(body ? { body } : {}), ...(operation ? { signal: AbortSignal.any([operation.authority.signal, operation.pending.signal]) } : {}), browser: true, allowedOrigins: this.options.allowedOrigins });
      if (consumed && operation?.receiptId) {
        await operation.authority.completed(operation.receiptId, response.status);
        operation.responded = true;
      }
      await active();
      if (credentials === 'omit') delete response.headers['set-cookie'];
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        const next = this.network.validate(new URL(response.headers.location, target).href, this.options.allowedOrigins).href;
        if ((consumed || !read) && [307, 308].includes(response.status)) throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'وصل طلب الإرسال، وحُجب تكراره عبر التحويل. راجع الموقع قبل أي محاولة أخرى.', 409);
        // result() follows navigation redirects with a fresh GET. A POST
        // followed by 301/302/303 to the same URL is therefore a readback,
        // not a replay of the approved POST body (e.g. a rejected login).
        // A consumed GET permit must still never be requested twice.
        if (consumed && operation?.permit?.method === 'GET' && next === operation.permit.url) throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'حُجب تحويل يعيد الطلب نفسه. راجع أثر الإرسال.', 409);
        if (consumed && navigation && !topLevel) throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'تحويل الإطار يحتاج تنقلًا مستقلًا؛ لم يُكرر الطلب.', 409);
        if (topLevel) {
          if (operation) entry.redirectTarget = next;
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; sandbox", ...(response.headers['set-cookie'] ? { 'set-cookie': response.headers['set-cookie'] } : {}) }, body: '<!doctype html><title>Loading</title>' });
          // No action is reading this page, so the redirect continues for the person.
          if (!operation) void entry.page.goto(next, { waitUntil: 'domcontentloaded' }).catch(() => {});
          return;
        }
        if (!read || redirects === 5) throw new BrowserError('AGENT_EFFECT_UNKNOWN', 'حُجب تحويل طلب إرسال أو تجاوز حد التحويلات. راجع أثر الطلب.', 409);
        if (new URL(next).origin !== new URL(target).origin) { headers = { ...headers }; delete headers.cookie; }
        target = next;
        continue;
      }
      if (target !== url) delete response.headers['set-cookie'];
      if (topLevel) entry.documentResponse = { url: target, status: response.status };
      await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      return;
    }
  }

  private owner(ownerId: string, conversationId: string): Promise<OwnerBrowser> {
    const key = this.profileKey(ownerId, conversationId);
    let owner = this.owners.get(key);
    if (!owner) {
      owner = this.launch(key).catch((error) => {
        this.owners.delete(key);
        throw error;
      });
      this.owners.set(key, owner);
    }
    return owner;
  }

  private adoptPopup(entry: ConversationPage, popup: Page, previous: Page): void {
    if (entry.pages.has(popup)) return;
    if (!entry.operation && (entry.ownerInputUntil ?? 0) <= Date.now()) { void popup.close().catch(() => {}); return; }
    entry.page = popup;
    this.watch(entry, popup);
    popup.once('close', () => {
      if (entry.page === popup && !previous.isClosed()) entry.page = previous;
    });
  }

  private watch(entry: ConversationPage, page: Page): void {
    if (entry.pages.has(page)) return;
    entry.pages.add(page);
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(25000);
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    page.on('framenavigated',frame=>{
      if(frame!==entry.page.mainFrame()||!/^https?:/.test(frame.url()))return;
      const url=frame.url();
      if(entry.history[entry.historyIndex]===url)return;
      if(entry.history[entry.historyIndex-1]===url){entry.historyIndex--;return;}
      entry.history=entry.history.slice(0,entry.historyIndex+1);entry.history.push(url);entry.historyIndex=entry.history.length-1;
    });
    page.on('popup', popup => this.adoptPopup(entry, popup, page));
    page.once('close', () => entry.pages.delete(page));
  }

  private async conversation(ownerId: string, conversationId: string, reserve?: NonNullable<ConversationPage['operation']>): Promise<ConversationPage> {
    const owner = await this.owner(ownerId, conversationId);
    // Serialize creation and eviction; concurrent callers must get one page per conversation.
    const previousAllocation = owner.allocation;
    let release!: () => void;
    owner.allocation = new Promise<void>(resolve => { release = resolve; });
    await previousAllocation;
    try {
    let entry = owner.conversations.get(conversationId);
    if (entry && entry.page.isClosed()) {
      if (entry.operation || entry.held) throw new BrowserError('AGENT_PAGE_CLOSED', 'أُغلقت الصفحة أثناء الإجراء؛ راجع نتيجته قبل المتابعة.', 409);
      owner.conversations.delete(conversationId);
      entry = undefined;
    }
    if (!entry) {
      if (owner.conversations.size >= MAX_CONVERSATION_PAGES) {
        const candidate = [...owner.conversations.entries()].filter(([, item]) => !item.operation && !item.held && item.readers === 0 && (item.ownerInputUntil ?? 0) <= Date.now()).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!candidate) throw new BrowserError('AGENT_PAGE_LIMIT', 'جميع صفحات المتصفح مشغولة؛ انتظر انتهاء إجراء أو أغلق جلسة.', 409);
        const [oldestId, oldest] = candidate;
        owner.conversations.delete(oldestId);
        await Promise.allSettled([...oldest.pages].map(page => page.close()));
      }
      const blank = owner.conversations.size === 0 ? owner.context.pages().find((page) => page.url() === 'about:blank') : undefined;
      const page = blank ?? await owner.context.newPage();
      entry = { ownerId, conversationId, page, pages: new Set(), readers: 0, shot: null, lastHash: null, lastUsed: Date.now(), redactions:new Map(),history:[],historyIndex:-1,targets:new Map(), recovery: { status: 'ready', actionKind: null, effect: null, reviewRequired: false }, checkpointWrite: Promise.resolve() };
      const checkpoint = this.recoveryBindings.get(JSON.stringify([ownerId, conversationId]));
      if (checkpoint) {
        const safePendingRead = checkpoint.status === 'action_pending' && ['open', 'back', 'scroll', 'wait'].includes(checkpoint.actionKind ?? '');
        const reviewRequired = checkpoint.status !== 'ready' && !safePendingRead;
        entry.recovery = { status: reviewRequired ? 'review_required' : 'ready', actionKind: null, effect: checkpoint.effect, reviewRequired };
        if (checkpoint.resumeUrl && checkpoint.pageHash && checkpoint.observedAt) entry.lastObservation = { url: checkpoint.resumeUrl, hash: checkpoint.pageHash, observedAt: checkpoint.observedAt, ...(checkpoint.documentStatus ? { documentStatus: checkpoint.documentStatus } : {}) };
      }
      this.watch(entry, page);
      owner.conversations.set(conversationId, entry);
    }
    entry.lastUsed = Date.now();
    if (reserve) {
      if (entry.operation) throw new BrowserError('AGENT_ACTION_BUSY', 'هناك إجراء جارٍ في هذه الصفحة.', 409);
      entry.operation = reserve;
    }
    return entry;
    } finally { release(); }
  }

  /** True when this conversation already has a page; never starts a browser. */
  async hasPage(ownerId: string, conversationId: string): Promise<boolean> {
    const owner = this.owners.get(this.profileKey(ownerId, conversationId));
    if (!owner) return false;
    const entry = (await owner.catch(() => null))?.conversations.get(conversationId);
    return Boolean(entry && !entry.page.isClosed() && entry.page.url() !== 'about:blank');
  }

  private async settle(page: Page): Promise<void> {
    await delay(120);
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await Promise.race([page.waitForLoadState('networkidle', { timeout: 900 }).catch(() => {}), delay(900)]);
  }

  private frames(page: Page): Frame[] {
    const children = page.frames().filter((frame) => frame !== page.mainFrame() && !frame.isDetached() && frame.url() && frame.url() !== 'about:blank');
    return [page.mainFrame(), ...children.slice(0, 5)];
  }

  private async readFrame(frame: Frame) {
    // A full navigation destroys the old model even when the Frame object is reused.
    for (let attempt = 0; attempt < 2; attempt++) {
      let pending = this.frameModels.get(frame);
      if (!pending) {
        pending = frame.evaluateHandle<FrameModel>(FRAME_MODEL_SCRIPT);
        this.frameModels.set(frame, pending);
      }
      const firstRef = this.nextRef;
      this.nextRef += MAX_FRAME_ELEMENTS;
      try {
        const model = await pending;
        const snapshot = await model.evaluate((model, { firstRef, limit }) => model.read(firstRef, limit), { firstRef, limit: MAX_FRAME_ELEMENTS });
        return { frame, model, snapshot };
      } catch {
        if (this.frameModels.get(frame) === pending) {
          this.frameModels.delete(frame);
          void pending.then(model => model.dispose()).catch(() => {});
        }
        if (frame.isDetached()) break;
      }
    }
    return null;
  }

  private async capture(entry: ConversationPage): Promise<void> {
    const secrets=this.redactions(entry);
    const mask=entry.page.frames().filter(frame=>!frame.isDetached()).flatMap(frame=>[frame.locator('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]'),...secrets.map(secret=>frame.getByText(secret,{exact:false}))]);
    // Never reuse an old, possibly sensitive capture when masking fails.
    entry.shot = await entry.page.screenshot({ type: 'jpeg', quality: 62, timeout: 5000, mask }).catch(() => null);
  }

  private redactions(entry:ConversationPage):string[]{for(const [secret,expires]of entry.redactions)if(expires<=Date.now())entry.redactions.delete(secret);return [...entry.redactions.keys()];}

  private async read(entry: ConversationPage, screenshot: boolean): Promise<AgentPage> {
    const { page } = entry;
    const results = await Promise.all(this.frames(page).map(frame => this.readFrame(frame)));
    const main = results[0]?.snapshot;
    if (!main || page !== entry.page) throw new BrowserError('AGENT_PAGE_UNREADABLE', 'تعذرت قراءة الصفحة؛ ما زالت تتحمّل أو توقفت عن الاستجابة.', 502);
    const targets = new Map<string, ObservedTarget>();
    const elements = results.flatMap(result => {
      if (!result) return [];
      const { frame, model, snapshot } = result;
      for (const element of snapshot.elements) {
        targets.set(element.ref, { frame, model, href: element.href });
      }
      return snapshot.elements;
    });
    entry.targets = targets;
    elements.sort((first, second) => Number(second.inViewport) - Number(first.inViewport));
    const frameText = results.slice(1).map((result) => result?.snapshot.text ?? '').filter((text) => text.length > 30).join(' ').slice(0, 2000);
    const text = `${main.text} ${frameText}`.trim();
    const hasField = (field: AgentFieldKind) => elements.some((element) => element.field === field);
    const challenge = results.some((result) => result?.snapshot.challenge) || /verify you are human|i'?m not a robot|unusual traffic|أنا لست روبوت|تحقق من أنك إنسان/i.test(text.slice(0, 3000));
    const fingerprint = hashOf(JSON.stringify([main.url, main.title, text, results.map(result => result?.snapshot.integrity), elements]));
    if (screenshot) await this.capture(entry);
    const response = entry.documentResponse;
    const snapshot:AgentPage = {
      id: randomUUID(), url: main.url, title: main.title, text, elements,
      signals: { captcha: challenge, password: hasField('password'), otp: hasField('otp'), card: hasField('card') },
      scroll: main.scroll, hash: fingerprint, observedAt: new Date().toISOString(),
      ...(response && response.url.split('#')[0] === main.url.split('#')[0] ? { documentStatus: response.status } : {}),
    };
    const secrets=this.redactions(entry);
    const scrub=(value:unknown):unknown=>typeof value==='string'?secrets.reduce((text,secret)=>text.split(secret).join('[محجوب]'),value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value;
    return scrub(snapshot) as AgentPage;
  }

  private async result(entry: ConversationPage, screenshot = true): Promise<AgentActionResult> {
    entry.readers++;
    try {
    if (entry.page.isClosed()) throw new BrowserError('AGENT_PAGE_CLOSED', 'أُغلقت الصفحة؛ لم تُفترض نتيجة ناجحة.', 409);
    for (let count = 0; entry.redirectTarget; count++) {
      if (count >= 5) throw new BrowserError('AGENT_REDIRECT_LIMIT', 'تجاوزت الصفحة حد التحويلات.', 409);
      const next = entry.redirectTarget; entry.redirectTarget = undefined;
      entry.navigationUrl = next;
      await entry.page.goto(next, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = entry.page;
      await this.settle(current);
      if (current === entry.page) break;
    }
    if (entry.operation?.denial) throw entry.operation.denial;
    const page = await this.read(entry, screenshot);
    const changed = page.hash !== entry.lastHash;
    entry.lastHash = page.hash;
    entry.lastObservation = { url: page.url, hash: page.hash, observedAt: page.observedAt, ...(page.documentStatus ? { documentStatus: page.documentStatus } : {}) };
    return { page, changed };
    } finally { entry.readers--; }
  }

  private async fileTarget(entry: ConversationPage, ref: string, direction: AgentFileTarget['direction']) {
    const page = await this.read(entry, false);
    const element = page.elements.find(item => item.ref === ref);
    if (!element) throw new BrowserError('BROWSER_FILE_TARGET_STALE', 'تغير موضع الملف؛ حدّث الصفحة.', 409);
    let fields: [string, string][] = [], fieldName: string | null = null, url: string;
    if (direction === 'download') {
      if (element.role !== 'link' || !element.href) throw new BrowserError('BROWSER_FILE_LINK_REQUIRED', 'اختر رابطًا مرصودًا في الصفحة.');
      url = this.network.validate(element.href, this.options.allowedOrigins).href;
    } else {
      const form = await this.withTarget(entry, ref, target => target.evaluate(node => {
        const input = node as HTMLInputElement, form = input.form;
        if (input.tagName !== 'INPUT' || input.type !== 'file' || input.multiple || input.disabled || !input.name || !form || form.method.toLowerCase() !== 'post' || form.enctype !== 'multipart/form-data' || form.target && form.target !== '_self') return null;
        const elements = Array.from(form.elements) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement)[];
        if (elements.length > 30 || elements.filter(item => item instanceof HTMLInputElement && item.type === 'file').length !== 1) return null;
        // Sensitive entry remains in the existing secure-input flow. Submitter overrides
        // and scripted widgets are deliberately outside this native form transfer.
        if (elements.some(item => item instanceof HTMLInputElement && (item.type === 'password' || /one-time-code|cc-number|cc-csc|password|passwd|card.?number|cvc|cvv|\botp\b/i.test(`${item.autocomplete} ${item.name} ${item.id}`)) || item.hasAttribute('formaction') || item.hasAttribute('formmethod') || item.hasAttribute('formenctype') || item.hasAttribute('formtarget'))) return null;
        const fields: [string, string][] = [];
        for (const item of elements) {
          if (item === input || item.disabled || !item.name || item instanceof HTMLButtonElement || ['submit', 'button', 'reset', 'image'].includes(item.type)) continue;
          if (item instanceof HTMLInputElement && ['checkbox', 'radio'].includes(item.type) && !item.checked) continue;
          if (item instanceof HTMLSelectElement) for (const option of Array.from(item.selectedOptions)) fields.push([item.name, option.value]);
          else fields.push([item.name, item.value]);
        }
        if (fields.length > 30 || fields.some(([name, value]) => name.length > 100 || value.length > 2000 || /[\r\n"\\\u0000]/.test(name)) || /[\r\n"\\\u0000]/.test(input.name) || input.name.length > 100) return null;
        return { url: form.action, fieldName: input.name, fields };
      }));
      if (!form) throw new BrowserError('BROWSER_FILE_FORM_UNSUPPORTED', 'الرفع يدعم نموذج POST قياسيًا بملف واحد دون حقول دخول حساسة أو زر يغيّر الوجهة.');
      url = this.network.validate(form.url, this.options.allowedOrigins).href;
      if (new URL(url).origin !== new URL(page.url).origin) throw new BrowserError('BROWSER_FILE_CROSS_ORIGIN', 'الرفع مقيد بموقع الصفحة الحالية.', 403);
      fields = form.fields; fieldName = form.fieldName;
    }
    const owner = await this.owner(entry.ownerId, entry.conversationId);
    const cookies = new URL(url).origin === new URL(page.url).origin ? await owner.context.cookies(url) : [];
    const cookieHash = evidenceHash(JSON.stringify(cookies.map(cookie => [cookie.name, cookie.value, cookie.domain, cookie.path]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
    const target: AgentFileTarget = { direction, ref, label: element.label, url, pageHash: page.hash, accountId: this.accounts.get(JSON.stringify([entry.ownerId, entry.conversationId])) ?? null, fieldName, fieldNames: fields.map(([name]) => name), formHash: direction === 'upload' ? evidenceHash(JSON.stringify([url, fieldName, fields])) : null, cookieHash };
    return { target, fields };
  }

  async describeFileTarget(ownerId: string, conversationId: string, ref: string, direction: AgentFileTarget['direction']): Promise<AgentFileTarget> {
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('BROWSER_FILE_PAGE_REQUIRED', 'افتح الصفحة في المحادثة أولًا.', 409);
    const entry = await this.conversation(ownerId, conversationId);
    if (entry.operation || entry.held || entry.recovery.reviewRequired) throw new BrowserError('BROWSER_FILE_SESSION_BUSY', 'أكمل الإجراء أو مراجعة الجلسة قبل نقل ملف.', 409);
    entry.readers++;
    try { return (await this.fileTarget(entry, ref, direction)).target; } finally { entry.readers--; }
  }

  async fileTargets(ownerId: string, conversationId: string) {
    if (!await this.hasPage(ownerId, conversationId)) return { uploads: [], downloads: [] };
    const entry = await this.conversation(ownerId, conversationId);
    if (entry.operation || entry.held || entry.recovery.reviewRequired) throw new BrowserError('BROWSER_FILE_SESSION_BUSY', 'أكمل الإجراء أو مراجعة الجلسة قبل نقل ملف.', 409);
    entry.readers++;
    try {
      const page = await this.read(entry, false);
      return { uploads: page.elements.filter(item => item.role === 'file').slice(0, 10).map(({ ref, label }) => ({ ref, label })), downloads: page.elements.filter(item => item.role === 'link' && item.href).slice(0, 40).map(({ ref, label, href }) => ({ ref, label, url: href! })) };
    } finally { entry.readers--; }
  }

  /** Owner-approved transfer bypasses page JavaScript, never its network or session fences. */
  async transferFile(ownerId: string, conversationId: string, approved: AgentFileTarget, options: { file?: { name: string; type: string; bytes: Buffer }; signal: AbortSignal; assertActive: () => Promise<void>; dispatched: () => Promise<void>; maxBytes: number }) {
    const authority: AgentAuthority = { signal: options.signal, assertActive: options.assertActive, dispatched: async () => '', completed: async () => {} };
    const operation: NonNullable<ConversationPage['operation']> = { kind: approved.direction === 'upload' ? 'form' : 'open', authority, used: false, pending: new AbortController() };
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('BROWSER_FILE_PAGE_REQUIRED', 'انتهت الصفحة؛ أنشئ منحة جديدة بعد فتحها.', 409);
    const entry = await this.conversation(ownerId, conversationId, operation);
    let responseReceived = false;
    try {
      if (entry.held || entry.recovery.reviewRequired) throw new BrowserError('BROWSER_FILE_SESSION_BUSY', 'تحتاج الجلسة إلى مراجعة قبل نقل ملف.', 409);
      entry.ownerInputUntil = undefined;
      options.signal.throwIfAborted(); await options.assertActive();
      const current = await this.fileTarget(entry, approved.ref, approved.direction);
      if (!sameFileTarget(current.target, approved)) throw new BrowserError('BROWSER_FILE_TARGET_STALE', 'تغير الحساب أو الصفحة أو النموذج بعد منح الصلاحية.', 409);
      let body: Buffer | undefined;
      const headers: Record<string, string> = {};
      if (approved.direction === 'upload') {
        const file = options.file;
        if (!file || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}._ -]{0,99}$/u.test(file.name) || file.name.includes('..') || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(file.type)) throw new BrowserError('BROWSER_FILE_INVALID', 'بيانات الملف غير صالحة.');
        const boundary = `mohassan-${randomUUID()}`;
        const parts: Buffer[] = current.fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value.replace(/\r?\n/g, '\r\n')}\r\n`));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${approved.fieldName}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
        body = Buffer.concat(parts); headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      }
      const owner = await this.owner(ownerId, conversationId);
      let target = approved.url;
      const visited = new Set<string>();
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (visited.has(target)) throw new BrowserError('BROWSER_FILE_REDIRECT_REPEAT', 'حُجبت إعادة طلب تنزيل سبق إرساله ضمن المنحة نفسها.', 409);
        visited.add(target);
        const cookies = new URL(target).origin === new URL(entry.page.url()).origin ? await owner.context.cookies(target) : [];
        if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '); else delete headers.cookie;
        const response = await this.network.request(target, { method: approved.direction === 'upload' ? 'POST' : 'GET', body, headers, browser: true, allowAttachment: approved.direction === 'download', allowedOrigins: this.options.allowedOrigins, maxBytes: options.maxBytes, signal: AbortSignal.any([options.signal, operation.pending.signal]), beforeDispatch: async () => {
          await options.assertActive(); options.signal.throwIfAborted();
          if (entry.operation !== operation || entry.closed || !sameFileTarget((await this.fileTarget(entry, approved.ref, approved.direction)).target, approved)) throw new BrowserError('BROWSER_FILE_TARGET_STALE', 'تغيرت الصفحة قبل إرسال الملف.', 409);
          if (!operation.used) {
            entry.recovery.status = 'effect_pending'; entry.recovery.actionKind = operation.kind;
            entry.recovery.effect = { method: approved.direction === 'upload' ? 'POST' : 'GET', urlHash: evidenceHash(approved.url), bodyHash: createHash('sha256').update(body ?? '').digest('hex') };
            await this.persist(entry); await options.dispatched(); operation.used = true;
          }
        } });
        responseReceived = true;
        await options.assertActive();
        if (approved.direction === 'download' && [301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          const next = this.network.validate(new URL(response.headers.location, target).href, this.options.allowedOrigins).href;
          if (new URL(next).origin !== new URL(approved.url).origin) throw new BrowserError('BROWSER_FILE_REDIRECT_SCOPE', 'تحويل التنزيل خارج الموقع الموافق عليه؛ أنشئ منحة مستقلة.', 403);
          target = next; continue;
        }
        entry.recovery.status = 'ready'; entry.recovery.actionKind = null; await this.persist(entry);
        return response;
      }
      throw new BrowserError('BROWSER_REDIRECT_LIMIT', 'تجاوز الملف حد التحويلات.');
    } catch (error) {
      if (operation.used && !responseReceived) entry.recovery.reviewRequired = true;
      entry.recovery.status = entry.recovery.reviewRequired ? 'review_required' : 'ready'; entry.recovery.actionKind = null;
      await this.persist(entry);
      throw error;
    } finally { operation.pending.abort(); if (entry.operation === operation) entry.operation = undefined; }
  }

  async observe(ownerId: string, conversationId: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId), result = await this.result(entry);
    if (!entry.operation) await this.persist(entry);
    return result;
  }

  async open(ownerId: string, conversationId: string, input: string): Promise<AgentActionResult> {
    const url = this.normalizeUrl(input);
    if (!await this.isAllowed(url)) throw new BrowserError('AGENT_NETWORK_DENIED', 'هذا العنوان داخلي أو غير موجود، ولا يمكن فتحه.', 403);
    const entry = await this.conversation(ownerId, conversationId);
    entry.documentResponse = undefined;
    entry.navigationUrl = this.network.validate(url, this.options.allowedOrigins).href;
    try {
      await entry.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {
      if (entry.operation?.denial) throw entry.operation.denial;
      throw new BrowserError('AGENT_NAVIGATION_FAILED', `تعذر فتح ${new URL(url).hostname}؛ قد يكون الموقع متوقفًا أو الرابط خاطئًا.`, 502);
    }
    return this.result(entry);
  }

  /** No script from the model is evaluated. Only bounded native forms can be authorized. */
  async prepareAction(ownerId: string, conversationId: string, action: AgentAction): Promise<AgentRequestPermit | null> {
    if (!['click', 'type', 'press', 'form'].includes(action.kind) || action.kind === 'type' && !action.submit || action.kind === 'press' && action.text !== 'Enter') return null;
    const entry = await this.conversation(ownerId, conversationId);
    const observed = await this.read(entry, false);
    const model = action.kind === 'press'
      ? await this.frameModels.get(entry.page.mainFrame())
      : entry.targets.get(action.ref ?? '')?.model;
    if (!model) return null;
    const prepared = await model.evaluate((model, action) => model.prepareForm(action), action).catch(() => {
      throw new BrowserError('AGENT_FORM_UNSUPPORTED', 'هذا النموذج لا يملك إرسالًا محدودًا يمكن تفويضه بأمان.', 403);
    });
    if (!prepared) return null;
    this.network.validate(prepared.url, this.options.allowedOrigins);
    return { id:randomUUID(),url: prepared.url, method: prepared.method, bodyHash: requestBodyHash((prepared.multipart ? 'multipart-text:' : '') + prepared.body), pageHash: observed.hash, actionHash: hashOf(JSON.stringify([action.kind,action.ref??null,action.text??null,action.submit??false])), expiresAt: Date.now() + 5 * 60000 };
  }

  /** Re-check durable authority immediately before every request, not just before clicking. */
  async act(ownerId: string, conversationId: string, action: AgentAction, authority: AgentAuthority, approved?: AgentRequestPermit, expected?: readonly AgentPostcondition[]): Promise<AgentActionResult> {
    const conditions = expected ? this.postconditions(expected) : undefined;
    const operation:NonNullable<ConversationPage['operation']>={kind:action.kind,authority,used:false,pending:new AbortController()};
    // Reserve under the allocation lock, before another conversation can evict this page.
    const entry = await this.conversation(ownerId, conversationId, operation);
    entry.ownerInputUntil=undefined;
    this.discard(entry);
    try {
      authority.signal.throwIfAborted(); await authority.assertActive();
      if (entry.recovery.reviewRequired && !['open', 'back', 'scroll', 'wait'].includes(action.kind)) throw new BrowserError('AGENT_RECOVERY_REVIEW_REQUIRED', 'يوجد أثر غير محسوم؛ اقرأ نتيجته وراجعها قبل أي فعل جديد.', 409);
      if (approved) {
        const current = await this.prepareAction(ownerId, conversationId, action);
        if (!current || approved.expiresAt <= Date.now() || (['url','method','bodyHash','pageHash','actionHash'] as const).some(key => current[key] !== approved[key])) {
          throw new BrowserError('AGENT_APPROVAL_STALE', 'تغيرت الصفحة أو القيم أو الوجهة بعد الموافقة. لم يُرسل الطلب.', 409);
        }
      }
      operation.permit=approved;
      entry.recovery.status = entry.recovery.reviewRequired ? 'review_required' : 'action_pending';
      entry.recovery.actionKind = action.kind;
      await this.persist(entry);
      const perform = async (): Promise<AgentActionResult> => { switch (action.kind) {
        case 'open': return await this.open(ownerId, conversationId, action.text ?? '');
        case 'click': return await this.click(ownerId, conversationId, action.ref ?? '');
        case 'type': return await this.type(ownerId, conversationId, action.ref ?? '', action.text ?? '', action.submit === true);
        case 'select': return await this.select(ownerId, conversationId, action.ref ?? '', action.text ?? '');
        case 'press': return await this.press(ownerId, conversationId, action.text ?? 'Enter');
        case 'form': return await this.submitForm(ownerId, conversationId, action.ref ?? '');
        case 'back': return await this.back(ownerId, conversationId);
        case 'scroll': return await this.scroll(ownerId, conversationId, action.text === 'up' ? 'up' : 'down');
        case 'wait': return await this.wait(ownerId, conversationId, Number(action.text) || 2000);
        default: throw new BrowserError('AGENT_ACTION_INVALID','هذا الإجراء غير معروف.',400);
      } };
      let result = await perform();
      if (entry.closed) throw new BrowserError('AGENT_PAGE_CLOSED', 'أُغلقت صفحة المحادثة.', 409);
      if (conditions) result = await this.verifyPostconditions(ownerId, conversationId, conditions, authority);
      if (operation.used && !operation.responded) entry.recovery.reviewRequired = true;
      entry.recovery.status = entry.recovery.reviewRequired ? 'review_required' : 'ready';
      entry.recovery.actionKind = null;
      await this.persist(entry);
      return result;
    } catch (error) {
      if (entry.closed) throw error;
      if (operation.used || error instanceof BrowserError && error.code === 'AGENT_EFFECT_UNKNOWN') entry.recovery.reviewRequired = true;
      entry.recovery.status = entry.recovery.reviewRequired ? 'review_required' : entry.held ? 'approval_pending' : 'ready';
      await this.persist(entry);
      throw error;
    } finally {
      operation.pending.abort();
      if(entry.operation===operation){entry.navigationUrl = undefined;entry.popupIntent = undefined;entry.operation = undefined;}
    }
  }

  private postconditions(expected: readonly AgentPostcondition[]): AgentPostcondition[] {
    if (!Array.isArray(expected) || !expected.length || expected.length > 12) throw new BrowserError('AGENT_POSTCONDITIONS_INVALID', 'يلزم شرط تحقق واحد إلى اثني عشر شرطًا محددًا قبل التنفيذ.');
    try { return expected.map(condition => AgentPostconditionSchema.parse(condition)); }
    catch { throw new BrowserError('AGENT_POSTCONDITIONS_INVALID', 'شروط التحقق غير مطابقة للعقد المحدد.'); }
  }

  /** Fixed read-only checks, not an LLM verdict. Caller binds criteria to the owner's goal before acting. */
  async verifyPostconditions(ownerId: string, conversationId: string, expected: readonly AgentPostcondition[], authority: AgentAuthority, options: { timeoutMs?: number } = {}): Promise<AgentActionResult & { verification: AgentVerificationReport }> {
    const conditions = this.postconditions(expected);
    const timeoutMs = options.timeoutMs ?? 1500;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 5000) throw new BrowserError('AGENT_VERIFICATION_TIMEOUT_INVALID', 'مهلة التحقق يجب ألا تتجاوز خمس ثوان.');
    authority.signal.throwIfAborted(); await authority.assertActive();
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'لا توجد صفحة مستقلة للتحقق منها.', 409);
    const entry = await this.conversation(ownerId, conversationId), previousHash = entry.lastHash;
    entry.readers++;
    const deadline = Date.now() + timeoutMs;
    try {
      for (let samples = 1; ; samples++) {
        authority.signal.throwIfAborted(); await authority.assertActive();
        let page = await this.read(entry, false);
        const checks: AgentVerificationCheck[] = [];
        for (const condition of conditions) {
          if (condition.kind !== 'field') { checks.push(pagePostcondition(page, condition)); continue; }
          const element = page.elements.find(item => item.ref === condition.ref);
          const expectedHash = evidenceHash(JSON.stringify(condition));
          if (!element || element.field && !['text', 'identifier'].includes(element.field)) {
            checks.push({ kind: 'field', status: 'unavailable', expectedHash, actualHash: null }); continue;
          }
          try {
            const value = await this.withTarget(entry, condition.ref, target => target.evaluate(node => 'value' in node ? String((node as HTMLInputElement).value) : node.textContent ?? ''));
            checks.push({ kind: 'field', status: value === condition.equals ? 'passed' : 'failed', expectedHash, actualHash: evidenceHash(JSON.stringify(value)) });
          } catch { checks.push({ kind: 'field', status: 'unavailable', expectedHash, actualHash: null }); }
        }
        if (conditions.some(condition => condition.kind === 'field')) {
          // Bind direct field readback to the same unchanged document observation.
          const confirmed = await this.read(entry, false);
          if (confirmed.hash !== page.hash) for (const check of checks) { check.status = 'unavailable'; check.actualHash = null; }
          page = confirmed;
        }
        const status = checks.every(check => check.status === 'passed') ? 'passed' : checks.some(check => check.status === 'failed') ? 'failed' : 'unavailable';
        if (status === 'passed' || Date.now() >= deadline || samples >= 30) {
          authority.signal.throwIfAborted(); await authority.assertActive();
          entry.lastHash = page.hash;
          entry.lastObservation = { url: page.url, hash: page.hash, observedAt: page.observedAt, ...(page.documentStatus ? { documentStatus: page.documentStatus } : {}) };
          await this.capture(entry);
          authority.signal.throwIfAborted(); await authority.assertActive();
          if (!entry.operation) await this.persist(entry);
          return { page, changed: page.hash !== previousHash, verification: { scope: 'declared_postconditions', status, pageId: page.id, pageHash: page.hash, observedAt: page.observedAt, checks, samples } };
        }
        await delay(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    } finally { entry.readers--; }
  }

  private async withTarget<T>(entry: ConversationPage, ref: string, run: (target: ElementHandle<Element>, observed: ObservedTarget) => Promise<T>): Promise<T> {
    if (!REF_PATTERN.test(ref)) throw new BrowserError('AGENT_REF_INVALID', `المعرّف ${ref} غير صالح.`);
    const observed = entry.targets.get(ref);
    const stale = () => new BrowserError('AGENT_REF_STALE', 'تغيّر العنصر المرصود أو اختفى. حدّث قراءة الصفحة قبل المحاولة.', 409);
    if (!observed || observed.frame.page() !== entry.page) throw stale();
    const handle = await observed.model.evaluateHandle((model, ref) => model.resolve(ref), ref).catch(() => { throw stale(); });
    try {
      const target = handle.asElement();
      if (!target || observed.frame.page() !== entry.page) throw stale();
      return await run(target, observed);
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async click(ownerId: string, conversationId: string, ref: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.withTarget(entry, ref, async (target, observed) => {
      if (observed.href) {
        entry.navigationUrl = this.network.validate(observed.href, this.options.allowedOrigins).href;
        const targetName = await target.getAttribute('target');
        if (targetName && !['_self', '_parent', '_top'].includes(targetName.toLowerCase())) entry.popupIntent = { url: entry.navigationUrl, operation: entry.operation };
      }
      try {
        await target.click({ timeout: 5000 });
      } catch {
        if (entry.operation?.denial) throw entry.operation.denial;
        throw new BrowserError(entry.operation?.used ? 'AGENT_EFFECT_UNKNOWN' : 'AGENT_CLICK_FAILED', 'لم تُحسم نتيجة النقر؛ لم يُكرر الإجراء تلقائيًا.', 409);
      }
    });
    return this.result(entry);
  }

  async type(ownerId: string, conversationId: string, ref: string, text: string, submit: boolean): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.withTarget(entry, ref, async (target, observed) => {
      const canWrite = await observed.model.evaluate((model, input) => model.canWrite(input.ref, input.text, input.approved), { ref, text, approved: Boolean(entry.operation?.permit) });
      if (!canWrite) throw new BrowserError('AGENT_FIELD_VALUE_PROTECTED', 'الحقل يحتوي على قيمة من المالك أو الصفحة؛ يلزم تأكيده قبل استبدالها.', 409);
      try {
        await target.fill(text, { timeout: 5000 });
      } catch {
        try {
          await target.click({ timeout: 3000 });
          await entry.page.keyboard.press('Control+A');
          await entry.page.keyboard.insertText(text);
        } catch {
          throw new BrowserError('AGENT_TYPE_FAILED', 'تعذرت الكتابة في هذا الحقل؛ قد يكون غير قابل للتعديل.', 409);
        }
      }
      const value = await target.evaluate(node => 'value' in node ? String((node as HTMLInputElement).value) : node.textContent ?? '');
      if (value !== text) throw new BrowserError('AGENT_FIELD_UNVERIFIED', 'لم يثبت أن الحقل احتفظ بالقيمة المطلوبة؛ راجع الصفحة قبل المتابعة.', 409);
      await observed.model.evaluate((model, ref) => model.recordWrite(ref), ref);
      if (submit) await target.press('Enter');
    });
    return this.result(entry);
  }

  async select(ownerId: string, conversationId: string, ref: string, value: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.withTarget(entry, ref, async (target, observed) => {
      const canWrite = await observed.model.evaluate((model, input) => model.canWrite(input.ref, input.value, false), { ref, value });
      if (!canWrite) throw new BrowserError('AGENT_FIELD_VALUE_PROTECTED', 'تغيّر اختيار المالك؛ يلزم تأكيده قبل استبداله.', 409);
      await target.selectOption({ label: value }, { timeout: 4000 }).catch(() => target.selectOption(value, { timeout: 4000 })).catch(() => {
        throw new BrowserError('AGENT_SELECT_FAILED', 'هذا الخيار غير موجود في القائمة.', 409);
      });
      await observed.model.evaluate((model, ref) => model.recordWrite(ref), ref);
    });
    return this.result(entry);
  }

  async press(ownerId: string, conversationId: string, key: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await entry.page.keyboard.press(key).catch(() => {
      throw new BrowserError('AGENT_KEY_INVALID', 'هذا المفتاح غير معروف.');
    });
    return this.result(entry);
  }

  async scroll(ownerId: string, conversationId: string, direction: 'up' | 'down'): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await entry.page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await entry.page.mouse.wheel(0, direction === 'down' ? 650 : -650);
    await delay(350);
    return this.result(entry);
  }

  async back(ownerId: string, conversationId: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    const previous=entry.history[entry.historyIndex-1];
    if(!previous)return this.result(entry);
    entry.navigationUrl=this.network.validate(previous, this.options.allowedOrigins).href;
    await entry.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return this.result(entry);
  }

  async wait(ownerId: string, conversationId: string, milliseconds: number): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await delay(Math.min(Math.max(milliseconds, 200), 8000));
    return this.result(entry);
  }

  /**
   * Writes a credential into the page. No page state is read here and no
   * screenshot is taken, so the value cannot reach a saved image or the model.
   */
  async fillSecret(ownerId: string, conversationId: string, ref: string, value: string): Promise<void> {
    const entry = await this.conversation(ownerId, conversationId);
    if(value.length>=4)entry.redactions.set(value,Date.now()+10*60000);
    await this.withTarget(entry, ref, target => target.fill(value, { timeout: 5000 }).catch(() => {
      throw new BrowserError('AGENT_SECRET_FILL_FAILED', 'تعذرت تعبئة الحقل.', 409);
    }));
  }

  /** Code inputs split across single-digit boxes take keystrokes, not a fill. */
  async typeSecretKeys(ownerId: string, conversationId: string, ref: string, value: string): Promise<void> {
    const entry = await this.conversation(ownerId, conversationId);
    if(value.length>=4)entry.redactions.set(value,Date.now()+10*60000);
    await this.withTarget(entry, ref, target => target.click({ timeout: 4000 }));
    await entry.page.keyboard.type(value, { delay: 40 });
  }

  /** Submits a filled form with Enter and reads the page that follows. */
  async submitForm(ownerId: string, conversationId: string, ref: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.withTarget(entry, ref, target => target.press('Enter'));
    return this.result(entry);
  }

  /** Newest view of the page for the person following along. */
  async screen(ownerId: string, conversationId: string): Promise<Buffer | null> {
    if (!await this.hasPage(ownerId, conversationId)) return null;
    const entry = await this.conversation(ownerId, conversationId);
    await this.capture(entry);
    return entry.shot;
  }

  /** Direct control for the owner when a page needs a person, such as a CAPTCHA. */
  async pointer(ownerId: string, conversationId: string, x: number, y: number): Promise<void> {
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'لا توجد صفحة مفتوحة.', 409);
    const entry = await this.conversation(ownerId, conversationId);
    entry.recovery.status = 'review_required';
    await this.persist(entry);
    this.ownerInput(entry);
    await entry.page.mouse.click(x * VIEWPORT.width, y * VIEWPORT.height);
  }

  async keyboard(ownerId: string, conversationId: string, input: { text?: string; key?: string }): Promise<void> {
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'لا توجد صفحة مفتوحة.', 409);
    const entry = await this.conversation(ownerId, conversationId);
    entry.recovery.status = 'review_required';
    await this.persist(entry);
    this.ownerInput(entry);
    if (input.text) await entry.page.keyboard.insertText(input.text);
    if (input.key) await entry.page.keyboard.press(input.key).catch(() => {});
  }

  async closeConversation(ownerId: string, conversationId: string): Promise<void> {
    const owner = await this.owners.get(this.profileKey(ownerId, conversationId))?.catch(() => null);
    const entry = owner?.conversations.get(conversationId);
    if (!owner || !entry) return;
    entry.closed = true;
    entry.recovery.status = entry.operation?.used || entry.recovery.reviewRequired ? 'review_required' : 'closed';
    owner.conversations.delete(conversationId);
    this.discard(entry);
    entry.operation?.pending.abort();
    const results = await Promise.allSettled([this.persist(entry), ...[...entry.pages].map(page => page.close())]);
    if (results[0].status === 'rejected') throw results[0].reason;
  }

  async close(): Promise<void> {
    const owners = await Promise.allSettled(this.owners.values());
    // Shutdown preserves durable ready/pending evidence. It is not an owner request to forget a session.
    const entries = owners.flatMap(owner => owner.status === 'fulfilled' ? [...owner.value.conversations.values()] : []);
    for (const entry of entries) { entry.closed = true; this.discard(entry); entry.operation?.pending.abort(); }
    await Promise.allSettled(entries.map(entry => entry.checkpointWrite));
    this.owners.clear();
    this.accounts.clear();
    this.recoveryBindings.clear();
    await Promise.allSettled(owners.flatMap((owner) => owner.status === 'fulfilled' ? [owner.value.context.close()] : []));
  }
}
