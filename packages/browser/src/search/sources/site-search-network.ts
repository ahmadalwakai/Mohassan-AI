import { setTimeout as wait } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import type { SafeNetwork, SafeResponse } from '../../network.js';
import { safeResumeUrl } from '../../session-state.js';
import { SearchProviderFailure, searchRetryAfter } from '../providers.js';
import { robotsAllows, type RobotsPolicy } from '../robots.js';

// Count every dispatch, including discovery, robots and redirect hops.
const MAX_FETCHES = 8;
const MAX_BYTES = 4_000_000;
const MIN_INTERVAL_MS = 250;
// HTTP redirect statuses and Retry-After: https://www.rfc-editor.org/rfc/rfc9110.html (checked 2026-11-27).
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

type FailureKind = SearchProviderFailure['kind'];
export interface SiteAdmission {
  lastRequest: number;
  nextRequest: number;
  blockedUntil: number;
  blockedKind: FailureKind;
}

function robotsDelay(text: string, agent: string): number {
  // https://blogs.bing.com/webmaster/2012/5/To-crawl-or-not-to-crawl%2C-that-is-BingBot-s-questi/ (checked 2026-11-27).
  const groups: { agents: string[]; delay: number; hasRules: boolean }[] = [];
  let group: typeof groups[number] | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const directive = /^\s*([^:]+):\s*([^#]*?)\s*(?:#.*)?$/u.exec(line);
    if (!directive) continue;
    const [, field, value] = directive;
    switch (field.trim().toLowerCase()) {
      case 'user-agent':
        if (!group || group.hasRules) {
          group = { agents: [], delay: 0, hasRules: false };
          groups.push(group);
        }
        group.agents.push(value.toLowerCase());
        break;
      case 'crawl-delay':
        if (group && /^\d+(?:\.\d+)?$/u.test(value)) {
          group.delay = Math.max(group.delay, Number(value) * 1000);
          group.hasRules = true;
        }
        break;
      case 'allow':
      case 'disallow':
        if (group) group.hasRules = true;
    }
  }
  const named = groups.filter(candidate => candidate.agents.includes(agent.toLowerCase()));
  const applicable = named.length ? named : groups.filter(candidate => candidate.agents.includes('*'));
  return Math.max(MIN_INTERVAL_MS, ...applicable.map(candidate => candidate.delay));
}

function refusesSearch(text: string): boolean {
  // https://contentsignals.org/ (checked 2026-11-27).
  return /^\s*content-signal\s*:\s*[^#\r\n]*?\b(?:search|ai-input)\s*=\s*no(?=\s*(?:[,#]|$))/imu.test(text);
}

function signInLocation(url: URL): boolean {
  // OAuth authorization parameters: https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.1 (checked 2026-11-27).
  return /(?:^|\/)(?:log-?in|sign-?in|logon)(?:[/.]|$)/iu.test(url.pathname)
    || url.searchParams.has('client_id') && url.searchParams.has('response_type') && url.searchParams.has('redirect_uri');
}

export class SiteVisit {
  private fetches = 0;
  private bytes = 0;
  private delay = MIN_INTERVAL_MS;
  private readonly agent: string;
  private readonly policies = new Map<string, Promise<string>>();
  private readonly origins: string[];

  constructor(
    private network: SafeNetwork,
    private robots: RobotsPolicy,
    private admission: SiteAdmission,
    private now: () => number,
    private signal: AbortSignal,
    host: string,
  ) {
    this.agent = network.policy?.userAgent?.match(/^[a-z_-]+(?=\/|\s|$)/i)?.[0] ?? 'MohassanAI-Research';
    const alternate = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
    this.origins = [`https://${host}`, `https://${alternate}`];
  }

  get canFetch(): boolean {
    return this.fetches < MAX_FETCHES && this.bytes < MAX_BYTES;
  }

  resolve(input: string, base: string): string | undefined {
    try {
      const url = this.network.validate(new URL(input, base).href, this.origins);
      if (this.origins.includes(url.origin) && safeResumeUrl(url.href)) return url.href;
    } catch { /* A published link may be malformed, unsafe or outside the named site. */ }
    return undefined;
  }

  private async dispatch(url: string, accept: string, ceiling = MAX_BYTES): Promise<SafeResponse> {
    this.signal.throwIfAborted();
    if (!this.canFetch) throw new SearchProviderFailure('unavailable');
    const pause = Math.max(this.admission.blockedUntil, this.admission.nextRequest) - this.now();
    if (pause > 0) await wait(Math.min(pause, 2_147_483_647), undefined, { signal: this.signal });
    this.signal.throwIfAborted();

    const maxBytes = Math.min(MAX_BYTES - this.bytes, ceiling);
    this.fetches++;
    this.admission.lastRequest = this.now();
    this.admission.nextRequest = this.admission.lastRequest + this.delay;
    let response: SafeResponse;
    try {
      response = await this.network.request(url, { signal: this.signal, allowedOrigins: this.origins, maxBytes, headers: { accept } });
    } catch (error) {
      // A failed transfer can have consumed the full allowance before the transport noticed.
      this.bytes += maxBytes;
      throw error;
    }
    const used = Math.max(response.body.byteLength, response.wireBytes ?? 0);
    this.bytes += used;
    this.signal.throwIfAborted();
    if (used > maxBytes) throw new SearchProviderFailure('unavailable');

    const retry = response.headers['retry-after'];
    if (response.status === 429 || response.status === 503 || retry !== undefined) {
      const kind = response.status === 429 ? 'rate_limited' : 'unavailable';
      const received = this.now(), delay = searchRetryAfter(retry, received);
      this.admission.blockedUntil = received + Math.max(MIN_INTERVAL_MS, delay);
      this.admission.blockedKind = kind;
      if (response.status === 429 || response.status === 503) throw new SearchProviderFailure(kind, delay);
    }
    if (response.status === 401) throw new SearchProviderFailure('needs_account');
    return response;
  }

  async robotsSitemaps(url: string): Promise<string[]> {
    const rules = await this.rules(url);
    // https://www.sitemaps.org/protocol.html#submit_robots (checked 2026-11-27).
    return [...rules.matchAll(/^\s*sitemap[ \t]*:[ \t]*([^#\s]+)/gim)].map(match => match[1]);
  }

  private rules(url: string): Promise<string> {
    const { origin } = new URL(url);
    const cached = this.policies.get(origin);
    if (cached) return cached;
    const pending = this.robots.rulesFor(url, this.signal, async (target, maximum) => {
      const checked = this.resolve(target, url);
      if (!checked) throw new SearchProviderFailure('unavailable');
      const response = await this.dispatch(checked, 'text/plain', maximum);
      // A denied robots request supplies no usable access policy. A missing file does.
      if (response.status < 500 && response.status >= 400 && response.status !== 404 && response.status !== 410) {
        throw new SearchProviderFailure('unavailable');
      }
      if (response.status === 200 && (
        /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers['content-type'] ?? '') ||
        /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(response.body.toString('utf8', 0, 200))
      )) throw new SearchProviderFailure('unavailable');
      return response;
    }).then(rules => {
      this.delay = Math.max(this.delay, robotsDelay(rules, this.agent));
      this.admission.nextRequest = Math.max(this.admission.nextRequest, this.admission.lastRequest + this.delay);
      return rules;
    });
    this.policies.set(origin, pending);
    return pending;
  }

  async assertAllowed(url: string): Promise<void> {
    this.signal.throwIfAborted();
    const text = await this.rules(url);
    if (refusesSearch(text) || !robotsAllows(text, url, this.agent)) throw new SearchProviderFailure('forbidden_by_robots');
  }

  async get(url: string, accept: string): Promise<SafeResponse | undefined> {
    for (let attempt = 0; attempt < MAX_FETCHES; attempt++) {
      await this.assertAllowed(url);
      const response = await this.dispatch(url, accept);
      if (REDIRECTS.has(response.status) && response.headers.location) {
        let redirected: URL;
        try { redirected = new URL(response.headers.location, url); }
        catch { throw new SearchProviderFailure('unavailable'); }
        if (signInLocation(redirected)) throw new SearchProviderFailure('needs_account');
        const next = this.resolve(redirected.href, url);
        if (!next) throw new SearchProviderFailure('unavailable');
        url = next;
        continue;
      }
      if (response.status === 404 || response.status === 410) return undefined;
      if (response.status !== 200) throw new SearchProviderFailure('unavailable');
      return { ...response, url };
    }
    throw new SearchProviderFailure('unavailable');
  }

  unpackSitemap(response: SafeResponse): SafeResponse {
    // https://www.rfc-editor.org/rfc/rfc1952.html#section-2.3.1 (checked 2026-11-27).
    if (response.body[0] !== 0x1f || response.body[1] !== 0x8b) return response;
    const remaining = MAX_BYTES - this.bytes;
    if (remaining <= 0) throw new SearchProviderFailure('unavailable');
    try {
      const body = gunzipSync(response.body, { maxOutputLength: remaining });
      this.bytes += body.byteLength;
      return { ...response, body };
    } catch {
      this.bytes = MAX_BYTES;
      throw new SearchProviderFailure('unavailable');
    }
  }
}
