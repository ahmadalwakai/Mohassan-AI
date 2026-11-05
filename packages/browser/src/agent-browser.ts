import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright';
import { BrowserError, isPublicAddress } from './network.js';

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
}

interface OwnerBrowser {
  context: BrowserContext;
  conversations: Map<string, ConversationPage>;
}

const VIEWPORT = { width: 1280, height: 800 };
const MAX_CONVERSATION_PAGES = 4;
const REF_PATTERN = /^(?:f(\d+))?e(\d+)$/;

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
    scroll: { top: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
  };
})`;

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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
  private testOrigins: Set<string>;
  private resolved = new Map<string, { allowed: boolean; expires: number }>();

  constructor(private readonly options: AgentBrowserOptions) {
    this.testOrigins = new Set((options.testOrigins ?? []).map((origin) => new URL(origin).origin));
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
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return false;
    }
    if (['about:', 'data:', 'blob:'].includes(url.protocol)) return true;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (this.testOrigins.has(url.origin)) return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (/(?:^|\.)(?:localhost|local|internal|intranet|home|lan|onion|invalid|test)$/.test(hostname)) return false;
    if (isIP(hostname)) return isPublicAddress(hostname);
    const cached = this.resolved.get(hostname);
    if (cached && cached.expires > Date.now()) return cached.allowed;
    let allowed = false;
    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      allowed = addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
    } catch {
      return false;
    }
    this.resolved.set(hostname, { allowed, expires: Date.now() + 60000 });
    return allowed;
  }

  private async launch(ownerId: string): Promise<OwnerBrowser> {
    const userDataDir = `${this.options.profileDir}/${hashOf(ownerId)}`;
    await mkdir(userDataDir, { recursive: true });
    const launchOptions = {
      headless: this.options.headless ?? true,
      viewport: VIEWPORT,
      locale: 'ar',
      acceptDownloads: false,
      serviceWorkers: 'block' as const,
    };
    const channel = this.options.channel === undefined ? 'chrome' : this.options.channel;
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, { ...launchOptions, ...(channel ? { channel } : {}) });
    } catch {
      try {
        context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      } catch {
        throw new BrowserError('AGENT_BROWSER_UNAVAILABLE', 'تعذر تشغيل المتصفح. ثبّت Chromium بالأمر: npx playwright install chromium', 503);
      }
    }
    await context.route('**/*', async (route) => {
      if (await this.isAllowed(route.request().url())) await route.fallback();
      else await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', async (socket) => {
      if (await this.isAllowed(socket.url().replace(/^ws/, 'http'))) socket.connectToServer();
      else await socket.close();
    });
    const owner: OwnerBrowser = { context, conversations: new Map() };
    context.on('close', () => this.owners.delete(ownerId));
    return owner;
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
      entry = { page, shot: null, lastHash: null, lastUsed: Date.now() };
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
    entry.shot = await entry.page.screenshot({ type: 'jpeg', quality: 62, timeout: 5000 }).catch(() => entry.shot);
  }

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
    const fingerprint = hashOf(JSON.stringify([main.url, main.title, text, elements.map((element) => [element.label, element.value])]));
    if (screenshot) await this.capture(entry);
    return {
      id: randomUUID(), url: main.url, title: main.title, text, elements,
      signals: { captcha: challenge, password: hasField('password'), otp: hasField('otp'), card: hasField('card') },
      scroll: main.scroll, hash: fingerprint, observedAt: new Date().toISOString(),
    };
  }

  private async result(entry: ConversationPage, screenshot = true): Promise<AgentActionResult> {
    await this.settle(entry.page);
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
    try {
      await entry.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {
      throw new BrowserError('AGENT_NAVIGATION_FAILED', `تعذر فتح ${new URL(url).hostname}؛ قد يكون الموقع متوقفًا أو الرابط خاطئًا.`, 502);
    }
    return this.result(entry);
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
      try {
        await target.scrollIntoViewIfNeeded({ timeout: 2000 });
        await target.click({ timeout: 3000, force: true });
      } catch {
        throw new BrowserError('AGENT_CLICK_FAILED', 'تعذر النقر: العنصر مخفي أو تغيّر. اقرأ الصفحة من جديد وجرّب عنصرًا آخر.', 409);
      }
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
    if (submit) await target.press('Enter').catch(() => entry.page.keyboard.press('Enter'));
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
    const target = this.locate(entry, ref);
    await target.fill(value, { timeout: 5000 }).catch(() => {
      throw new BrowserError('AGENT_SECRET_FILL_FAILED', 'تعذرت تعبئة الحقل.', 409);
    });
  }

  /** Code inputs split across single-digit boxes take keystrokes, not a fill. */
  async typeSecretKeys(ownerId: string, conversationId: string, ref: string, value: string): Promise<void> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.locate(entry, ref).click({ timeout: 4000 });
    await entry.page.keyboard.type(value, { delay: 40 });
  }

  /** Submits a filled form with Enter and reads the page that follows. */
  async submitForm(ownerId: string, conversationId: string, ref: string): Promise<AgentActionResult> {
    const entry = await this.conversation(ownerId, conversationId);
    await this.locate(entry, ref).press('Enter').catch(() => entry.page.keyboard.press('Enter'));
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
    await entry.page.mouse.click(x * VIEWPORT.width, y * VIEWPORT.height);
  }

  async keyboard(ownerId: string, conversationId: string, input: { text?: string; key?: string }): Promise<void> {
    if (!await this.hasPage(ownerId, conversationId)) throw new BrowserError('AGENT_NO_PAGE', 'لا توجد صفحة مفتوحة.', 409);
    const entry = await this.conversation(ownerId, conversationId);
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
