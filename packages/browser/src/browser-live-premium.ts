import type { Locator, Page } from 'playwright';
import type { AgentPage } from './agent-browser.js';

type Box = { x: number; y: number; width: number; height: number };
type LivePage = { page: Page; shot: Buffer | null; ownerInputLimit?: number; redactions: Map<string, number> };
type ObservedPage = LivePage & { operation?: unknown; mutations: number; readers: number; captureReservation?: symbol; closed?: boolean };

const privateFields = 'input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=image]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox]';

export async function capturePremiumBrowserFrame(entry: LivePage, mask: Locator[]): Promise<void> {
  // An ordinary input can contain a sign-in identifier, split code or owner text.
  // The editable surfaces stay masked for the lifetime of a page with manual input.
  if (entry.ownerInputLimit || entry.redactions.size) {
    mask.push(...entry.page.frames().filter(frame => !frame.isDetached()).map(frame => frame.locator(privateFields)));
  }
  entry.shot = await entry.page.screenshot({ type: 'jpeg', quality: 62, timeout: 5000, mask, maskColor: '#364052' }).catch(() => null);
}

function viewportBox(box: Box | null, viewport: { width: number; height: number } | null): Box | undefined {
  if (!box || !viewport) return undefined;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(box.x / viewport.width);
  const y = clamp(box.y / viewport.height);
  const right = clamp((box.x + box.width) / viewport.width);
  const bottom = clamp((box.y + box.height) / viewport.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

const faviconCache = new WeakMap<Page, { origin: string; until: number; value: Promise<string | undefined> }>();

function browserFavicon(page: Page): Promise<string | undefined> {
  const url = new URL(page.url());
  const now = Date.now();
  const cached = faviconCache.get(page);
  if (cached?.origin === url.origin && cached.until > now) return cached.value;
  const value = page.evaluate(async () => {
    const icon = new URL(document.querySelector<HTMLLinkElement>('link[rel~=icon]')?.href || '/favicon.ico', location.href);
    if (icon.origin !== location.origin) return undefined;
    const response = await fetch(icon, { redirect: 'error', signal: AbortSignal.timeout(500) });
    const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
    if (!response.ok || !mime || !/^image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon)$/.test(mime) || !response.body) return undefined;
    const reader = response.body.getReader();
    let bytes = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (bytes.length + chunk.value.length > 16_000) return undefined;
        bytes += String.fromCharCode(...chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return bytes ? `data:${mime};base64,${btoa(bytes)}` : undefined;
  }).catch(() => undefined);
  faviconCache.set(page, { origin: url.origin, until: now + 60_000, value });
  return value;
}

export async function readBrowserPremiumPage<T extends ObservedPage>(
  entry: T | undefined,
  read: (entry: T) => Promise<AgentPage>,
  boxFor: (entry: T, ref: string) => Promise<Box | null>,
  selectRef?: (page: AgentPage) => string | undefined,
  includeFavicon = false,
): Promise<{ page: AgentPage | null; target?: Box; favicon?: string } | null> {
  if (!entry || entry.closed || entry.captureReservation || entry.page.isClosed() || !/^https?:\/\//i.test(entry.page.url())) return null;
  const page = entry.page;
  const favicon = includeFavicon ? browserFavicon(page) : undefined;
  if (!selectRef || entry.mutations || entry.operation) return { page: null, favicon: await favicon };
  entry.readers++;
  try {
    const observed = await read(entry);
    const ref = selectRef(observed);
    const box = ref && await boxFor(entry, ref).catch(() => null);
    const target = viewportBox(box || null, page.viewportSize());
    if (entry.mutations || entry.page !== page || page.url() !== observed.url) return null;
    return { page: observed, target, favicon: await favicon };
  } finally {
    entry.readers--;
  }
}

const unfinishedOwnerValues = new WeakMap<Map<string, number>, string>();

/** Keep short values masked as well, and drop intermediate prefixes as a field is filled. */
export function rememberPremiumOwnerValue(redactions: Map<string, number>, value: string): void {
  const unfinished = unfinishedOwnerValues.get(redactions);
  if (unfinished && value.length > unfinished.length && value.startsWith(unfinished)) redactions.delete(unfinished);
  if (value.length < 4) unfinishedOwnerValues.set(redactions, value);
  else unfinishedOwnerValues.delete(redactions);
  redactions.set(value, Date.now() + 10 * 60_000);
}
