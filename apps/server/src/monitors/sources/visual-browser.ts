import { createHash, randomUUID } from 'node:crypto';
import { BrowserEngine, BrowserError, safeResumeUrl, SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { observePageV2, type MonitorPageAnchor } from '../page-v2.js';
import { display, labelNeedles, matchMonitorText, phraseIndex } from '../page.js';
import type { MonitorReadResult } from '../sources.js';

const RENDER_TIMEOUT_MS = 12_000;
const MAX_REQUESTS = 20;
const MAX_RENDER_BYTES = 8_000_000;
const MAX_RESOURCE_BYTES = 2_000_000;
const MAX_ASSET_BYTES = 512_000;
const MAX_REGIONS = 4;
const MAX_REGION_WIDTH = 960;
const MAX_REGION_HEIGHT = 640;
const MAX_IMAGE_BYTES = 500_000;

export interface VisualRenderRequest {
  network: SafeNetwork;
  url: string;
  spec: MonitorSpec;
  signal: AbortSignal;
  previous?: MonitorPageAnchor;
  at: string;
}

export interface VisualRegion { key: string; label: string; image: Uint8Array }
export type VisualRenderResult = { kind: 'regions'; regions: VisualRegion[]; ambiguous?: boolean }
  | { kind: 'page'; result: MonitorReadResult }
  | { kind: 'missing' };

type RequestOptions = NonNullable<Parameters<SafeNetwork['request']>[1]>;

/** Chromium gets a fresh, same-origin, read-only session with no ambient identity. */
class VisualNetwork extends SafeNetwork {
  private requests = 0;
  private bytes = 0;
  private inFlight = 0;

  constructor(private readonly publicNetwork: SafeNetwork, private readonly signal: AbortSignal) {
    super(publicNetwork.policy);
  }

  override validate(input: string, allowedOrigins?: readonly string[]): URL {
    const url = this.publicNetwork.validate(input, allowedOrigins);
    if (!safeResumeUrl(url.href)) throw new BrowserError('MONITOR_URL_DENIED', 'The visual resource address contains private access material.');
    return url;
  }

  override async request(input: string, options: RequestOptions = {}) {
    const target = this.validate(input, options.allowedOrigins);
    const available = MAX_RENDER_BYTES - this.bytes - this.inFlight;
    if (options.method && options.method !== 'GET' || options.body || ++this.requests > MAX_REQUESTS || available <= 0) {
      throw new BrowserError('MONITOR_VISUAL_REQUEST_DENIED', 'The request is outside the visual read limits.');
    }
    const accept = options.headers?.accept;
    const maxBytes = Math.min(available, accept?.includes('text/html') ? MAX_RESOURCE_BYTES : MAX_ASSET_BYTES);
    this.inFlight += maxBytes;
    try {
      const response = await this.publicNetwork.request(target.href, {
        allowedOrigins: options.allowedOrigins, method: 'GET', signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
        maxBytes, browser: true,
        headers: {
          ...(accept && { accept }),
          'user-agent': this.policy.userAgent ?? 'MohassanAI-Research/1.0 (+https://www.mohassansy.com)',
        },
      });
      this.bytes += response.body.byteLength;
      const headers = { ...response.headers };
      delete headers['set-cookie'];
      delete headers['set-cookie2'];
      delete headers['www-authenticate'];
      const restrictions = "form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'";
      const originalPolicy = headers['content-security-policy'];
      headers['content-security-policy'] = originalPolicy ? `${originalPolicy}, ${restrictions}` : restrictions;
      return { ...response, headers };
    } catch (error) {
      // Even a failed response can have consumed its full wire allowance.
      this.bytes += maxBytes;
      throw error;
    } finally {
      this.inFlight -= maxBytes;
    }
  }
}

interface RegionDescription { tag: string; domId: string; name: string; context: string }
interface RegionCatalog { descriptions: RegionDescription[]; nodes: Element[] }

// Everything evaluated in Chromium is fixed. The page never gets a user or model selector.
const listRegions = String.raw`(() => {
  const root = document.querySelector('main,[role="main"]') ?? document.body;
  if (!root) return { descriptions: [], nodes: [] };
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const excluded = 'nav,aside,header,footer,form,[inert],[hidden],[aria-hidden="true"]';
  const nodes = Array.from(root.querySelectorAll('canvas,img,svg[role="img"]')).slice(0, 160).filter(node => {
    if (node.closest(excluded) || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (node instanceof HTMLImageElement && (!node.complete || !node.naturalWidth)) return false;
    return Boolean(node.getClientRects().length);
  });
  const descriptions = nodes.map(node => {
    const labelled = (node.getAttribute('aria-labelledby') ?? '').slice(0, 180).split(/\s+/).slice(0, 4)
      .map(id => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
    const name = labelled || clean(node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title'));
    const figure = node.closest('figure')?.querySelector(':scope > figcaption');
    const container = node.closest('section,article') ?? root;
    const heading = container.querySelector(':scope > :is(h1,h2,h3,h4,h5,h6)');
    const preceding = node.previousElementSibling;
    const context = clean(figure?.textContent || (preceding?.matches('h1,h2,h3,h4,h5,h6,label') && preceding.textContent) || heading?.textContent);
    return { tag: node.localName, domId: clean(node.id), name: clean(name), context };
  });
  return { descriptions, nodes };
})()`;

function identityText(text: string): string {
  return matchMonitorText(text).replace(/[\d.,٫٬]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function selectRegions(descriptions: RegionDescription[], request: VisualRenderRequest) {
  const source = request.spec.source;
  const anchor = (source.kind === 'page' || source.kind === 'visual') && source.anchor ||
    (request.spec.read.kind === 'number' ? request.spec.read.label : undefined);
  const needles = anchor ? labelNeedles(anchor) : [];
  const ranked = descriptions.map(({ tag, domId, name, context }, index) => {
    const names = [matchMonitorText(name), matchMonitorText(context)];
    const rank = (text: string, exact: number) => needles.some(needle => text === needle) ? exact
      : needles.some(needle => phraseIndex(text, needle) >= 0) ? exact - 1 : 0;
    const score = needles.length ? Math.max(rank(names[0], 4), rank(names[1], 2)) : 1;
    const stableName = identityText(name);
    const stableContext = identityText(context);
    const key = domId || stableName || stableContext ? createHash('sha256')
      .update(JSON.stringify([tag, domId, stableName, stableContext])).digest('hex') : undefined;
    const idLabel = display(domId.replace(/[-_]+/gu, ' '));
    const label = [...new Set([name, context].filter(Boolean))].map(display).filter(Boolean).join(' · ') || idLabel;
    return { index, score, key, label, idLabel };
  });
  const previous = request.previous?.origin === 'visual' ? request.previous : undefined;
  const best = Math.max(0, ...ranked.map(item => item.score));
  const matches = ranked.filter(item => previous ? item.key === previous.key : best > 0 && item.score === best);
  const stable = matches.filter(item => item.key && ranked.filter(other => other.key === item.key).length === 1);
  const selected = stable.slice(0, MAX_REGIONS).map(item => ({ ...item,
    label: item.idLabel && stable.some(other => other !== item && other.label === item.label)
      ? `${item.label} · ${item.idLabel}` : item.label,
  }));
  return { selected, ambiguous: stable.length !== matches.length || stable.length > MAX_REGIONS };
}

export async function renderMonitorRegions(request: VisualRenderRequest): Promise<VisualRenderResult> {
  const { network, url, signal, spec, at, previous } = request;
  if (spec.source.kind !== 'page' && spec.source.kind !== 'visual') return { kind: 'missing' };
  const transport = new VisualNetwork(network, signal);
  const target = transport.validate(url);
  const browser = new BrowserEngine(network.policy, transport);
  const id = randomUUID();
  const cancel = () => { void browser.closeSession(id); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await browser.open(id, [target.origin], Date.now() + RENDER_TIMEOUT_MS);
    signal.throwIfAborted();
    const pageSource = { ...spec.source, kind: 'page' as const };
    return await browser.inspect<VisualRenderResult>(id, target.href, async (page, status) => {
      if (status !== 200) return { kind: 'missing' };
      const body = await page.evaluate(() => {
        if (document.querySelector('input[type="password" i]') ||
            /^(?:just a moment|verify (?:you are|you're) human|access denied|robot check)\b/i.test(document.title.trim())) return null;
        const html = document.documentElement?.outerHTML;
        return html && html.length <= 2_000_000 ? html : null;
      });
      if (body === null) return { kind: 'missing' };
      const current = transport.validate(page.url(), [target.origin]).href;

      // Allow normal extraction of text rendered by JavaScript. Once a user
      // chooses a crop keep that identity, even if unrelated text appears.
      if (previous?.origin !== 'visual') {
        const textual = observePageV2(body, current, 'text/html', { ...spec, source: pageSource }, at, previous, undefined, true);
        if (textual.kind === 'value' || textual.kind === 'clarify') {
          return { kind: 'page', result: { ...textual, cache: { url: current, ...('anchor' in textual && textual.anchor && { anchor: textual.anchor }) } } };
        }
        if (textual.kind === 'unsafe-target') return { kind: 'page', result: textual };
      }

      const catalog = await page.evaluateHandle<RegionCatalog>(listRegions);
      const descriptions = await (await catalog.getProperty('descriptions')).jsonValue();
      const { selected, ambiguous } = selectRegions(descriptions, request);
      if (!selected.length) return { kind: 'missing' };
      const handles = await (await catalog.getProperty('nodes')).getProperties();
      const regions: VisualRegion[] = [];
      for (const { index, key, label } of selected) {
        signal.throwIfAborted();
        const node = handles.get(String(index))?.asElement();
        if (!node || !key) continue;
        try {
          await node.scrollIntoViewIfNeeded({ timeout: 2_000 });
          const clip = await node.boundingBox();
          const viewport = page.viewportSize();
          // Keep the entire crop in the viewport and allow for subpixel rounding.
          if (!clip || !viewport || Math.ceil(clip.width) + 1 > MAX_REGION_WIDTH ||
              Math.ceil(clip.height) + 1 > MAX_REGION_HEIGHT || clip.x < 0 || clip.y < 0 ||
              clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height) continue;
          const uncovered = await node.evaluate(element => {
            const { left, top, width, height } = element.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every(x => [0.1, 0.5, 0.9].every(y =>
              element.contains(document.elementFromPoint(left + width * x, top + height * y))));
          });
          if (!uncovered) continue;
          const image = await page.screenshot({ clip, type: 'png', timeout: 2_000, scale: 'css' });
          if (image.byteLength <= MAX_IMAGE_BYTES) regions.push({ key, label, image });
        } catch { signal.throwIfAborted(); }
      }
      return { kind: 'regions', regions, ambiguous: ambiguous || regions.length !== selected.length };
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await browser.close();
  }
}
