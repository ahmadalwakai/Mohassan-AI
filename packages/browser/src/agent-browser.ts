import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { chromium, type BrowserContext, type Frame, type Locator, type Page, type Route } from 'playwright';
import { decideEffect, type EffectActor } from './effect-policy.js';
import { BrowserError, SafeNetwork } from './network.js';

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
}

export interface AgentActionResult {
  page: AgentPage;
  changed: boolean;
}

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
}

export interface AgentBrowserOptions {
  profileDir: string;
  /** Hosts allowed for local fixtures only. Everything else must be a public address. */
  testOrigins?: string[];
  /** Real Chrome is preferred; null uses the bundled Chromium. */
  channel?: 'chrome' | null;
  headless?: boolean;
}

interface ConversationPage {
  page: Page;
  shot: Buffer | null;
  lastHash: string | null;
  lastUsed: number;
  navigationUrl?: string;
  redirectTarget?: string;
  operation?: { kind: AgentAction['kind']; authority: AgentAuthority; permit?: AgentRequestPermit; used: boolean; receiptId?: string; navigated?: boolean; pending:AbortController; denial?: BrowserError };
  held?: { effect: AgentHeldEffect; route: Route; timer: ReturnType<typeof setTimeout> };
  ownerInputUntil?: number;
  ownerInputLimit?: number;
  redactions: Map<string, number>;
  history:string[];
  historyIndex:number;
}

interface OwnerBrowser {
  context: BrowserContext;
  conversations: Map<string, ConversationPage>;
  proxy: Server;
}

const VIEWPORT = { width: 1280, height: 800 };
const MAX_CONVERSATION_PAGES = 4;
const REF_PATTERN = /^(?:f(\d+))?e(\d+)$/;
const GESTURES = new Set<AgentAction['kind']>(['click', 'type', 'press', 'form']);
const OWNER_FOLLOW_MS = 8000;
const OWNER_LIMIT_MS = 120000;
const HELD_MS = 5 * 60000;

/**
 * Fixed page script. It labels what a person can see and interact with. It
 * reports whether a field holds text but never the content of a sensitive one.
 */
const SNAPSHOT_SCRIPT = String.raw`((prefix) => {
  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const nodes = [];
  const walk = (root) => {
    for (const node of root.querySelectorAll('*')) {
      if (nodes.length > 9000) return;
      nodes.push(node);
      if (node.shadowRoot) walk(node.shadowRoot);
    }
  };
  walk(document);
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
    return clean(node.getAttribute('aria-label') || referenced || node.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.getAttribute('title') || buttonValue || node.innerText || node.querySelector?.('img[alt]')?.alt || node.getAttribute('name') || node.id).slice(0, 90);
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
    if (node.tagName === 'INPUT') return ['submit', 'button', 'image', 'reset'].includes(node.type) ? 'button' : ['checkbox', 'radio'].includes(node.type) ? node.type : 'textbox';
    return 'button';
  };
  for (const node of nodes) if (node.hasAttribute('data-mh-ref')) node.removeAttribute('data-mh-ref');
  const candidates = nodes.filter((node) => node.matches(interactive) && !(node.tagName === 'INPUT' && node.type === 'hidden') && visible(node));
  const singleDigitBoxes = candidates.filter((node) => node.tagName === 'INPUT' && node.maxLength === 1).length >= 4;
  const elements = candidates.slice(0, 220).map((node, index) => {
    const ref = prefix + 'e' + index, rect = node.getBoundingClientRect(), field = fieldKind(node, singleDigitBoxes);
    node.setAttribute('data-mh-ref', ref);
    const sensitive = field && field !== 'text' && field !== 'identifier';
    const value = !sensitive && 'value' in node && node.tagName !== 'BUTTON' && !['submit', 'button'].includes(node.type) ? clean(node.value).slice(0, 60) : '';
    return {
      ref, role: roleOf(node), label: labelOf(node), field,
      ...(value ? { value } : {}),
      ...(node.tagName === 'A' && node.href ? { href: node.href.slice(0, 200) } : {}),
      ...(node.disabled || node.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    };
  });
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
})`;

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function requestBodyHash(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n?/g, '\n')).digest('hex');
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
  private readonly network: SafeNetwork;

  constructor(private readonly options: AgentBrowserOptions) {
    this.network = new SafeNetwork({ testOrigins: options.testOrigins });
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
    try { await this.network.pin(input); return true; } catch { return false; }
  }

  private async launch(ownerId: string): Promise<OwnerBrowser> {
    const userDataDir = `${this.options.profileDir}/${hashOf(ownerId)}`;
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
    const owner: OwnerBrowser = { context, conversations: new Map(), proxy };
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request();
      let entry: ConversationPage | undefined;
      let acting:ConversationPage['operation'];
      let optionalRead = false;
      try { entry = [...owner.conversations.values()].find(candidate => candidate.page === request.frame().page()); } catch { /* detached worker */ }
      try {
        if (!entry) throw new BrowserError('AGENT_NETWORK_DENIED', 'لا توجد جلسة مصرح بها لهذا الطلب.', 403);
        const url = this.network.validate(request.url()).href, method = request.method(), bodyHash = requestBodyHash(request.postData() ?? '');
        const operation = entry.operation;
        acting=operation;
        if(operation){
          operation.authority.signal.throwIfAborted(); await operation.authority.assertActive();
          if(entry.operation!==operation)throw new BrowserError('AGENT_AUTHORITY_STALE','انتهى تفويض الإجراء قبل إرسال الطلب.',409);
        }
        const navigation = request.isNavigationRequest(), topLevel = navigation && request.frame() === entry.page.mainFrame();
        const permit = operation?.permit;
        const actor = this.actor(entry, operation, topLevel, url);
        const decision = decideEffect({ url, method, bodyHash, pageOrigin: frameOrigin(request.frame()), topLevelNavigation: topLevel, actor, ...(entry.navigationUrl ? { expectedNavigation: entry.navigationUrl } : {}), ...(permit ? { permit: { url: permit.url, method: permit.method, bodyHash: permit.bodyHash, used: operation!.used, expiresAt: permit.expiresAt } } : {}), now: Date.now() });
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
          this.hold(entry, operation, route, url, method, bodyHash);
          return;
        }
        if (actor === 'owner') this.ownerActive(entry);
        optionalRead = !navigation && !decision.consumesPermit && (method === 'GET' || method === 'HEAD');
        if (navigation && entry.navigationUrl === url) entry.navigationUrl = undefined;
        if (topLevel && operation) operation.navigated = true;
        if (decision.consumesPermit) {
          operation!.used = true;
          operation!.receiptId = await operation!.authority.dispatched(permit!);
        }
        await this.forward(entry, route, url, method, decision.credentials, operation, decision.consumesPermit);
      } catch (error) {
        // A cancelled resource from a finished action must not fail the next observation.
        const optionalFailure = optionalRead && error instanceof BrowserError;
        if (!optionalFailure && acting && entry?.operation === acting) {
          acting.denial = acting.used ? new BrowserError('AGENT_EFFECT_UNKNOWN', 'أُرسل الطلب أو بدأت محاولته ولم تُحسم النتيجة. راجع أثره قبل إعادة التنفيذ.', 409)
            : error instanceof BrowserError ? error : new BrowserError('AGENT_NETWORK_DENIED', 'توقف الطلب لأن التفويض أو الاتصال لم يعد صالحًا.', 403);
        }
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    context.on('close', () => { this.owners.delete(ownerId); proxy.close(); });
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
  private hold(entry: ConversationPage, operation: NonNullable<ConversationPage['operation']>, route: Route, url: string, method: string, bodyHash: string): void {
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
      operation.receiptId = await authority.dispatched(permit);
      await this.forward(entry, route, effect.url, effect.method, 'keep', operation, true).catch(async error => {
        await route.abort('blockedbyclient').catch(() => {});
        operation.denial = error instanceof BrowserError && error.code === 'AGENT_EFFECT_UNKNOWN' ? error : new BrowserError('AGENT_EFFECT_UNKNOWN', 'بدأ إرسال الطلب ولم تُحسم النتيجة. راجع أثره قبل إعادة التنفيذ.', 409);
      });
      return await this.result(entry);
    } finally {
      operation.pending.abort();
      if (entry.operation === operation) { entry.navigationUrl = undefined; entry.operation = undefined; }
    }
  }

  async dropHeld(ownerId: string, conversationId: string): Promise<void> {
    const entry = (await this.owners.get(ownerId)?.catch(() => null))?.conversations.get(conversationId);
    if (entry) this.discard(entry);
  }

  private async forward(entry: ConversationPage, route: Route, url: string, method: string, credentials: 'keep' | 'omit', operation: ConversationPage['operation'], consumed: boolean): Promise<void> {
    const request = route.request(), navigation = request.isNavigationRequest(), topLevel = navigation && request.frame() === entry.page.mainFrame();
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
      const response = await this.network.request(target, { method, headers, ...(body ? { body } : {}), ...(operation ? { signal: AbortSignal.any([operation.authority.signal, operation.pending.signal]) } : {}), browser: true });
      if (consumed && operation?.receiptId) await operation.authority.completed(operation.receiptId, response.status);
      await active();
      if (credentials === 'omit') delete response.headers['set-cookie'];
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        const next = this.network.validate(new URL(response.headers.location, target).href).href;
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
      await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      return;
    }
  }

  private owner(ownerId: string): Promise<OwnerBrowser> {
    let owner = this.owners.get(ownerId);
    if (!owner) {
      owner = this.launch(ownerId).catch((error) => {
        this.owners.delete(ownerId);
        throw error;
      });
      this.owners.set(ownerId, owner);
    }
    return owner;
  }

  private watch(entry: ConversationPage, page: Page): void {
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
    page.on('popup', (popup) => {
      const previous = entry.page;
      entry.page = popup;
      this.watch(entry, popup);
      popup.once('close', () => {
        if (entry.page === popup) entry.page = previous;
      });
    });
  }

  private async conversation(ownerId: string, conversationId: string): Promise<ConversationPage> {
    const owner = await this.owner(ownerId);
    let entry = owner.conversations.get(conversationId);
    if (entry && entry.page.isClosed()) {
      owner.conversations.delete(conversationId);
      entry = undefined;
    }
    if (!entry) {
      if (owner.conversations.size >= MAX_CONVERSATION_PAGES) {
        const [oldestId, oldest] = [...owner.conversations.entries()].sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        owner.conversations.delete(oldestId);
        await oldest.page.close().catch(() => {});
      }
      const blank = owner.conversations.size === 0 ? owner.context.pages().find((page) => page.url() === 'about:blank') : undefined;
      const page = blank ?? await owner.context.newPage();
      entry = { page, shot: null, lastHash: null, lastUsed: Date.now(), redactions:new Map(),history:[],historyIndex:-1 };
      this.watch(entry, page);
      owner.conversations.set(conversationId, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  /** True when this conversation already has a page; never starts a browser. */
  async hasPage(ownerId: string, conversationId: string): Promise<boolean> {
    const owner = this.owners.get(ownerId);
    if (!owner) return false;
    const entry = (await owner.catch(() => null))?.conversations.get(conversationId);
    return Boolean(entry && !entry.page.isClosed() && entry.page.url() !== 'about:blank');
  }

  private async settle(page: Page): Promise<void> {
    await delay(120);
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await Promise.race([page.waitForLoadState('networkidle', { timeout: 900 }).catch(() => {}), delay(900)]);
  }

  private frames(page: Page): { frame: Frame; prefix: string }[] {
    const children = page.frames().filter((frame) => frame !== page.mainFrame() && !frame.isDetached() && frame.url() && frame.url() !== 'about:blank');
    return [{ frame: page.mainFrame(), prefix: '' }, ...children.slice(0, 5).map((frame, index) => ({ frame, prefix: `f${index + 1}` }))];
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
    const results = await Promise.all(this.frames(page).map(async ({ frame, prefix }) => {
      try {
        return await frame.evaluate<any>(`${SNAPSHOT_SCRIPT}(${JSON.stringify(prefix)})`);
      } catch {
        return null;
      }
    }));
    const main = results[0];
    if (!main) throw new BrowserError('AGENT_PAGE_UNREADABLE', 'تعذرت قراءة الصفحة؛ ما زالت تتحمّل أو توقفت عن الاستجابة.', 502);
    const elements: AgentElement[] = results.flatMap((result) => result?.elements ?? []);
    elements.sort((first, second) => Number(second.inViewport) - Number(first.inViewport));
    const frameText = results.slice(1).map((result) => result?.text ?? '').filter((text: string) => text.length > 30).join(' ').slice(0, 2000);
    const text = `${main.text} ${frameText}`.trim();
    const hasField = (field: AgentFieldKind) => elements.some((element) => element.field === field);
    const challenge = results.some((result) => result?.challenge) || /verify you are human|i'?m not a robot|unusual traffic|أنا لست روبوت|تحقق من أنك إنسان/i.test(text.slice(0, 3000));
    const fingerprint = hashOf(JSON.stringify([main.url, main.title, text, results.map(result => result?.integrity), elements]));
    if (screenshot) await this.capture(entry);
    const snapshot:AgentPage = {
      id: randomUUID(), url: main.url, title: main.title, text, elements,
      signals: { captcha: challenge, password: hasField('password'), otp: hasField('otp'), card: hasField('card') },
      scroll: main.scroll, hash: fingerprint, observedAt: new Date().toISOString(),
    };
    const secrets=this.redactions(entry);
    const scrub=(value:unknown):unknown=>typeof value==='string'?secrets.reduce((text,secret)=>text.split(secret).join('[محجوب]'),value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value;
    return scrub(snapshot) as AgentPage;
  }

  private async result(entry: ConversationPage, screenshot = true): Promise<AgentActionResult> {
    for (let count = 0; entry.redirectTarget; count++) {
      if (count >= 5) throw new BrowserError('AGENT_REDIRECT_LIMIT', 'تجاوزت الصفحة حد التحويلات.', 409);
      const next = entry.redirectTarget; entry.redirectTarget = undefined;
      entry.navigationUrl = next;
      await entry.page.goto(next, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await this.settle(entry.page);
    if (entry.operation?.denial) throw entry.operation.denial;
    const page = await this.read(entry, screenshot);
    const changed = page.hash !== entry.lastHash;
    entry.lastHash = page.hash;
    return { page, changed };
  }

  async observe(ownerId: string, conversationId: string): Promise<AgentActionResult> {
    return this.result(await this.conversation(ownerId, conversationId));
  }

  async open(ownerId: string, conversationId: string, input: string): Promise<AgentActionResult> {
    const url = this.normalizeUrl(input);
    if (!await this.isAllowed(url)) throw new BrowserError('AGENT_NETWORK_DENIED', 'هذا العنوان داخلي أو غير موجود، ولا يمكن فتحه.', 403);
    const entry = await this.conversation(ownerId, conversationId);
    entry.navigationUrl = this.network.validate(url).href;
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
    const entry = await this.conversation(ownerId, conversationId);
    const observed = await this.read(entry, false);
    if (!['click', 'type', 'press', 'form'].includes(action.kind) || action.kind === 'type' && !action.submit || action.kind === 'press' && action.text !== 'Enter') return null;
    const match = action.ref ? REF_PATTERN.exec(action.ref) : null;
    const frame = match?.[1] ? this.frames(entry.page)[Number(match[1])]?.frame : entry.page.mainFrame();
    if (!frame) throw new BrowserError('AGENT_REF_STALE', 'اختفى العنصر المرصود.', 409);
    const prepared = await frame.evaluate<{ url: string; method: 'GET' | 'POST'; body: string } | null>(String.raw`((input) => {
      const node = input.ref ? document.querySelector('[data-mh-ref="' + input.ref + '"]') : document.activeElement;
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
      if (!['GET','POST'].includes(method) || encoding !== 'application/x-www-form-urlencoded' || target && target !== '_self') throw new Error('Unsupported native form');
      const data = new FormData(form, button || undefined);
      if (input.kind === 'type' && node.name) data.set(node.name, input.text || '');
      const fields = [];
      for (const [key,value] of data) { if (typeof value !== 'string') throw new Error('File upload denied'); fields.push([key,value.replace(/\r?\n/g,'\r\n')]); }
      const body = new URLSearchParams(fields).toString();
      if (body.length > 16000) throw new Error('Form too large');
      const url = new URL(action || location.href, location.href); url.hash = '';
      if (method === 'GET') url.search = body;
      return {url:url.href,method,body:method === 'POST' ? body : ''};
    })(${JSON.stringify(action)})`).catch(() => { throw new BrowserError('AGENT_FORM_UNSUPPORTED', 'هذا النموذج لا يملك إرسالًا محدودًا يمكن تفويضه بأمان.', 403); });
    if (!prepared) return null;
    this.network.validate(prepared.url);
    return { id:randomUUID(),url: prepared.url, method: prepared.method, bodyHash: requestBodyHash(prepared.body), pageHash: observed.hash, actionHash: hashOf(JSON.stringify([action.kind,action.ref??null,action.text??null,action.submit??false])), expiresAt: Date.now() + 5 * 60000 };
  }

  /** Re-check durable authority immediately before every request, not just before clicking. */
  async act(ownerId: string, conversationId: string, action: AgentAction, authority: AgentAuthority, approved?: AgentRequestPermit): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    if (entry.operation) throw new BrowserError('AGENT_ACTION_BUSY', 'هناك إجراء جارٍ في هذه الصفحة.', 409);
    // Reserve before the first await: a second action cannot replace this request authority.
    const operation:NonNullable<ConversationPage['operation']>={kind:action.kind,authority,used:false,pending:new AbortController()};
    entry.operation=operation;
    entry.ownerInputUntil=undefined;
    this.discard(entry);
    try {
      authority.signal.throwIfAborted(); await authority.assertActive();
      if (approved) {
        const current = await this.prepareAction(ownerId, conversationId, action);
        if (!current || approved.expiresAt <= Date.now() || (['url','method','bodyHash','pageHash','actionHash'] as const).some(key => current[key] !== approved[key])) {
          throw new BrowserError('AGENT_APPROVAL_STALE', 'تغيرت الصفحة أو القيم أو الوجهة بعد الموافقة. لم يُرسل الطلب.', 409);
        }
      }
      operation.permit=approved;
      if (action.kind === 'click') {
        const observed = await this.read(entry, false);
        const href = observed.elements.find(element => element.ref === action.ref)?.href;
        if (href) entry.navigationUrl = this.network.validate(href).href;
      }
      switch (action.kind) {
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
      }
    } finally {
      operation.pending.abort();
      if(entry.operation===operation){entry.navigationUrl = undefined;entry.operation = undefined;}
    }
  }

  private locate(entry: ConversationPage, ref: string): Locator {
    const match = REF_PATTERN.exec(ref);
    if (!match) throw new BrowserError('AGENT_REF_INVALID', `المعرّف ${ref} غير صالح.`);
    const frames = this.frames(entry.page);
    const frame = match[1] ? frames[Number(match[1])]?.frame : entry.page.mainFrame();
    if (!frame) throw new BrowserError('AGENT_REF_STALE', 'اختفى هذا الجزء من الصفحة.', 409);
    return frame.locator(`[data-mh-ref="${ref}"]`).first();
  }

  async click(ownerId: string, conversationId: string, ref: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    const target = this.locate(entry, ref);
    try {
      await target.click({ timeout: 5000 });
    } catch {
      if (entry.operation?.denial) throw entry.operation.denial;
      throw new BrowserError(entry.operation?.used ? 'AGENT_EFFECT_UNKNOWN' : 'AGENT_CLICK_FAILED', 'لم تُحسم نتيجة النقر؛ لم يُكرر الإجراء تلقائيًا.', 409);
    }
    return this.result(entry);
  }

  async type(ownerId: string, conversationId: string, ref: string, text: string, submit: boolean): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    const target = this.locate(entry, ref);
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
    if (submit) await target.press('Enter');
    return this.result(entry);
  }

  async select(ownerId: string, conversationId: string, ref: string, value: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    const target = this.locate(entry, ref);
    await target.selectOption({ label: value }, { timeout: 4000 }).catch(() => target.selectOption(value, { timeout: 4000 })).catch(() => {
      throw new BrowserError('AGENT_SELECT_FAILED', 'هذا الخيار غير موجود في القائمة.', 409);
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
    entry.navigationUrl=this.network.validate(previous).href;
    await entry.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    return this.result(entry);
  }

  async wait(ownerId: string, conversationId: string, milliseconds: number): Promise<AgentActionResult> {
    await delay(Math.min(Math.max(milliseconds, 200), 8000));
    return this.result(await this.conversation(ownerId, conversationId));
  }

  /**
   * Writes a credential into the page. No page state is read here and no
   * screenshot is taken, so the value cannot reach a saved image or the model.
   */
  async fillSecret(ownerId: string, conversationId: string, ref: string, value: string): Promise<void> {
    const entry = await this.conversation(ownerId, conversationId);
    if(value.length>=4)entry.redactions.set(value,Date.now()+10*60000);
    const target = this.locate(entry, ref);
    await target.fill(value, { timeout: 5000 }).catch(() => {
      throw new BrowserError('AGENT_SECRET_FILL_FAILED', 'تعذرت تعبئة الحقل.', 409);
    });
  }

  /** Code inputs split across single-digit boxes take keystrokes, not a fill. */
  async typeSecretKeys(ownerId: string, conversationId: string, ref: string, value: string): Promise<void> {
    const entry = await this.conversation(ownerId, conversationId);
    if(value.length>=4)entry.redactions.set(value,Date.now()+10*60000);
    await this.locate(entry, ref).click({ timeout: 4000 });
    await entry.page.keyboard.type(value, { delay: 40 });
  }

  /** Submits a filled form with Enter and reads the page that follows. */
  async submitForm(ownerId: string, conversationId: string, ref: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.locate(entry, ref).press('Enter');
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
    this.ownerInput(entry);
    await entry.page.mouse.click(x * VIEWPORT.width, y * VIEWPORT.height);
  }

  async keyboard(ownerId: string, conversationId: string, input: { text?: string; key?: string }): Promise<void> {
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'لا توجد صفحة مفتوحة.', 409);
    const entry = await this.conversation(ownerId, conversationId);
    this.ownerInput(entry);
    if (input.text) await entry.page.keyboard.insertText(input.text);
    if (input.key) await entry.page.keyboard.press(input.key).catch(() => {});
  }

  async closeConversation(ownerId: string, conversationId: string): Promise<void> {
    const owner = await this.owners.get(ownerId)?.catch(() => null);
    const entry = owner?.conversations.get(conversationId);
    if (!owner || !entry) return;
    owner.conversations.delete(conversationId);
    await entry.page.close().catch(() => {});
  }

  async close(): Promise<void> {
    const owners = await Promise.allSettled(this.owners.values());
    this.owners.clear();
    await Promise.allSettled(owners.flatMap((owner) => owner.status === 'fulfilled' ? [owner.value.context.close()] : []));
  }
}
