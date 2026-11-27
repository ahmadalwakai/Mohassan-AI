import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { SafeNetwork } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { publicSearchText } from '../local-index.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { RobotsPolicy, RobotsPolicyBackoff } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { parseTravelQuery, travelSubject } from './travel-query.js';

// Contracts checked 2026-11-27. Action API returns wikitext and TOC offsets.
// https://www.mediawiki.org/wiki/API:Parsing_wikitext
// https://www.mediawiki.org/wiki/API:Parsing_wikitext/TOCData
// https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
// https://wikitech.wikimedia.org/wiki/Robot_policy
// https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
// https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content
// https://en.wikivoyage.org/wiki/Wikivoyage:Copyleft
// https://creativecommons.org/licenses/by-sa/4.0/
const license = 'CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)';
const spacing = 1_000;
const maxBytes = 512_000;
const maxSnippet = 2_000;
const gate = { active: false, next: 0 };

// Arabic Wikivoyage still lives under Wy/ar in Wikimedia Incubator (2026-11-27).
// https://ar.wikivoyage.org/ → https://incubator.wikimedia.org/wiki/Wy/ar/الصفحة_الرئيسة
const sites = [
  { language: 'en', host: 'en.wikivoyage.org', prefix: '', hosts: ['en.wikivoyage.org'] },
  { language: 'ar', host: 'incubator.wikimedia.org', prefix: 'Wy/ar/', hosts: ['incubator.wikimedia.org', 'ar.wikivoyage.org'] },
] as const;

// Section names and variants (2026-11-27):
// https://en.wikivoyage.org/wiki/Wikivoyage:Article_templates
// https://incubator.wikimedia.org/wiki/Wy/ar/ويكي_رحلات:نموذج_مقالة_دولة
// https://incubator.wikimedia.org/wiki/Wy/ar/مصر and https://incubator.wikimedia.org/wiki/Wy/ar/القاهرة
const headings = [
  { purpose: 'see_do', pattern: /^(?:see|شاهد|وجهات للزيارة)$/iu },
  { purpose: 'see_do', pattern: /^(?:do|افعل|الانشطة)$/iu },
  { purpose: 'get_in', pattern: /^(?:get in|الدخول|الوصول(?:(?: |ل).*)?)$/iu },
  { purpose: 'get_around', pattern: /^(?:get around|تنقل|التنقلات الداخلية)$/iu },
];

interface WikiSection { hLevel: number; line: string; codepointOffset?: number; anchor: string; fromTitle?: string }
interface ParseResponse {
  error?: { code?: string };
  parse?: { title?: string; wikitext?: string; tocdata?: { sections?: WikiSection[] } };
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function headingText(html: string): string {
  function text(node: DefaultTreeAdapterTypes.Node): string {
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    if ('tagName' in node && (node.tagName === 'script' || node.tagName === 'style')) return '';
    return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  }
  return cleanText(text(parseFragment(html)));
}

/** Exclude uncertain markup without joining the prose on either side of it. */
function omitMarkup(source: string): string {
  const closers: string[] = [];
  let start = 0;
  let result = '';
  for (let cursor = 0; cursor < source.length - 1; cursor++) {
    const token = source.slice(cursor, cursor + 2);
    if (token === '{{' || token === '{|') {
      if (!closers.length) result += source.slice(start, cursor) + '\u0000';
      closers.push(token === '{{' ? '}}' : '|}');
      cursor++;
    } else if (token === closers.at(-1)) {
      closers.pop();
      if (!closers.length) start = cursor + 2;
      cursor++;
    }
  }
  return closers.length ? result : result + source.slice(start);
}

function excerpt(source: string): string {
  const body = omitMarkup(source.replace(/<!--[\s\S]*?-->|<ref\b[^>]*?(?:\/\s*>|>[\s\S]*?<\/ref>)/giu, ''));
  for (const line of body.split(/\r?\n/u).slice(1)) {
    const stripped = line.trim().replace(/^[*#:;]+\s*/u, '');
    if (!stripped || /^[=|!]/u.test(stripped) || stripped.includes('\u0000')) continue;
    const prose = stripped
      .replace(/\[\[([^\[\]\n]+)\]\]/gu, (_, link: string) => {
        if (/^(?:file|image|category|ملف|صورة|تصنيف):/iu.test(link)) return '\u0000';
        return link.split('|').at(-1) ?? '';
      })
      .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/gu, '$1')
      .replace(/'{2,5}/gu, '');
    if (/[\u0000<>{}\[\]|]|https?:\/\//u.test(prose)) continue;
    const text = headingText(prose);
    if (text.length < 20 || !/\p{L}/u.test(text) || publicSearchText(text) !== text) continue;
    return text;
  }
  return '';
}

function articlePath(title: string): string {
  return title.replaceAll(' ', '_').split('/').map(encodeURIComponent).join('/');
}

function guideHit(data: ParseResponse, site: typeof sites[number], purpose: string): SearchHit[] {
  const page = data.parse;
  if (!page || typeof page.title !== 'string' || typeof page.wikitext !== 'string' || !Array.isArray(page.tocdata?.sections)) {
    throw new SearchProviderFailure('invalid_response');
  }
  const title = page.title.slice(site.prefix.length);
  if (!page.title.startsWith(site.prefix) || !title || /[:#<>\u0000-\u001f]/u.test(title) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(title)) return [];
  const sections = page.tocdata.sections;
  const source = Array.from(page.wikitext);
  const pageUrl = `https://${site.host}/wiki/${articlePath(page.title)}`;
  const attribution = site.language === 'ar' ? 'مقتطف من مساهمي ويكي رحلات' : 'Excerpt from Wikivoyage contributors';
  const passages: { heading: string; quote: string; link: string }[] = [];
  const included = new Set<RegExp>();
  for (const [index, section] of sections.entries()) {
    if (!section || typeof section.line !== 'string' || typeof section.anchor !== 'string' || !section.anchor || !Number.isInteger(section.hLevel)) continue;
    const heading = headingText(section.line);
    const normalized = heading.normalize('NFKC').replace(/[أإآ]/gu, 'ا').replace(/\p{M}/gu, '');
    const matching = headings.find(({ pattern }) => pattern.test(normalized));
    if (!matching || included.has(matching.pattern) || (purpose !== 'guide' && matching.purpose !== purpose)) continue;
    const start = section.codepointOffset;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start >= source.length) continue;
    if (typeof section.fromTitle === 'string' && section.fromTitle.replaceAll('_', ' ') !== page.title.replaceAll('_', ' ')) continue;
    const after = sections.slice(index + 1).find(next => next && next.hLevel <= section.hLevel && typeof next.codepointOffset === 'number');
    const end = after?.codepointOffset ?? source.length;
    if (!Number.isInteger(end) || end <= start || end > source.length) continue;
    const quote = excerpt(source.slice(start, end).join(''));
    if (!quote) continue;
    passages.push({ heading, quote, link: `${pageUrl}#${encodeURIComponent(section.anchor)}` });
    included.add(matching.pattern);
  }
  if (!passages.length) return [];

  // SearchEngine accepts only a canonical page URL. Carry the section URLs in
  // the snippet so all selected excerpts survive its page-level deduplication.
  const credit = `${attribution}, ${license}`;
  let available = maxSnippet - credit.length;
  const selected = passages.filter(({ heading, link }) => {
    const linkLength = `${heading} ““ (${link})\n`.length;
    if (available - linkLength < 24 * (passages.length + 1)) return false;
    available -= linkLength;
    return true;
  });
  if (!selected.length) return [];
  const quoteLimit = Math.min(380, Math.floor(available / selected.length));
  const quotes = selected.map(({ heading, quote, link }) => {
    const space = quote.lastIndexOf(' ', quoteLimit - 1);
    const text = quote.length <= quoteLimit ? quote : `${quote.slice(0, space > 0 ? space : quoteLimit - 1)}…`;
    return `${heading} “${text}” (${link})`;
  });
  return [{ title, url: pageUrl, snippet: [...quotes, credit].join('\n') }];
}

export function wikivoyageProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const robots = new RobotsPolicy(network, now, 'gzip');
  return sites.map(site => {
    const explicit = (query: SearchQuery) => query.sites.some(host => site.hosts.some(candidate => candidate === host || candidate.endsWith(`.${host}`)));
    return {
      name: site.language === 'ar' ? 'Wikivoyage (Arabic)' : 'Wikivoyage (English)',
      coverage: 'web',
      accessBasis: 'documented_api',
      planned: {
        domains: ['travel'], languages: [site.language], hosts: [...site.hosts], access: 'documented_api',
        contract: { url: 'https://www.mediawiki.org/wiki/API:Parsing_wikitext', checked: '2026-11-27' },
      },
      supports(query) {
        if (query.sites.length && !explicit(query)) return false;
        const parsed = parseTravelQuery(query);
        const subject = parsed?.subject ?? (explicit(query) ? travelSubject(query.question) : null);
        return Boolean(subject && parsed?.purpose !== 'place' && (query.language === site.language || (site.language === 'en' && !/\p{Script=Arabic}/u.test(subject))));
      },
      cooldownMs: () => Math.max(0, gate.next - now()),
      async search(query, limit, signal) {
        signal.throwIfAborted();
        if (query.sites.length && !explicit(query)) return [];
        const parsed = parseTravelQuery(query);
        const destination = parsed?.subject ?? (explicit(query) ? travelSubject(query.question) : null);
        if (!destination || /[#\[\]{}|]/u.test(destination) || parsed?.purpose === 'place' || !Number.isFinite(limit) || limit < 1) return [];
        const target = new URL(`https://${site.host}/w/api.php`);
        target.search = new URLSearchParams({ action: 'parse', page: site.prefix + destination,
          prop: 'wikitext|tocdata', redirects: '1', format: 'json', formatversion: '2' }).toString();
        const wait = gate.next - now();
        if (gate.active || wait > 0) throw new SearchProviderFailure('rate_limited', gate.active ? Math.max(spacing, wait) : wait);
        gate.active = true;
        let started: number | undefined;
        const backoff = (kind: 'rate_limited' | 'unavailable', retryAfter: string | undefined) => {
          const retry = searchRetryAfter(retryAfter, now());
          gate.next = Math.max(gate.next, now() + retry);
          return new SearchProviderFailure(kind, retry);
        };
        try {
          // Both projects' robots files currently disallow this route.
          // https://en.wikivoyage.org/robots.txt and https://incubator.wikimedia.org/robots.txt (2026-11-27).
          const userAgent = network.policy.userAgent?.trim().split(/[\s/]/u, 1)[0] || 'MohassanAI-Research';
          await robots.assertAllowed(target.href, signal, userAgent);
          const response = await network.request(target.href, {
            signal, allowedOrigins: [target.origin], maxBytes, headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
            beforeDispatch: async () => { started = now(); gate.next = started + spacing; },
          });
          signal.throwIfAborted();
          if (response.status === 429) throw backoff('rate_limited', response.headers['retry-after']);
          if (response.status === 503) throw backoff('unavailable', response.headers['retry-after']);
          if (response.status !== 200) throw new SearchProviderFailure('unavailable');
          let data: ParseResponse;
          try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
          catch { throw new SearchProviderFailure('invalid_response'); }
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SearchProviderFailure('invalid_response');
          if (data.error?.code === 'missingtitle') return [];
          if (data.error?.code === 'ratelimited' || data.error?.code === 'maxlag') throw backoff('rate_limited', response.headers['retry-after']);
          return guideHit(data, site, parsed?.purpose ?? 'guide');
        } catch (error) {
          if (error instanceof RobotsPolicyBackoff) throw backoff(error.responseStatus === 429 ? 'rate_limited' : 'unavailable', error.retryAfter);
          throw error;
        } finally {
          if (started !== undefined && now() - started > spacing) gate.next = Math.max(gate.next, now() + 5_000);
          gate.active = false;
        }
      },
    };
  });
}
