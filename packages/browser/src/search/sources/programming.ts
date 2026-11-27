import { BrowserError, type SafeNetwork, type SafeResponse } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { safeResumeUrl } from '../../session-state.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';

const NPM = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org';
const GITHUB = 'https://api.github.com';
const MDN = 'https://developer.mozilla.org';
const CHECKED = '2026-11-27';
const JSON_LIMIT = 512_000;
const METADATA_LIMIT = 8_000_000;
// Anonymous repository searches are limited to 10/minute.
// https://docs.github.com/en/rest/search/search#rate-limit (2026-11-27)
const GITHUB_INTERVAL = 60_000 / 10;

const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
// https://packaging.python.org/en/latest/specifications/name-normalization/ (2026-11-27)
const pythonName = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const repositoryName = /^[a-z0-9][a-z0-9-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i;
const npmContext = /(?<![a-z0-9._-])(?:npm|node(?:\.?js)?|javascript|typescript)(?![a-z0-9._-])/i;
const pypiContext = /(?<![a-z0-9._-])(?:pypi|pip3?|python3?)(?![a-z0-9._-])/i;
const packageRequest = /\b(?:install(?:ing)?|packages?|librar(?:y|ies)|dependencies|dependency|licen[cs]e|downloads?|(?:latest|current|newest)\s+(?:stable\s+)?(?:version|release))\b|(?:اثبت|تثبيت|تركيب|حزم[هة]|مكتب[هة]|اصدار|ترخيص|تحميل)/iu;
const repositoryRequest = /\b(?:github|repositor(?:y|ies)|repo)\b|مستودع/iu;
const discovery = /\b(?:best|recommend(?:ed)?|find|search)\b|افضل|اقترح|ابحث/iu;
const downloadRequest = /\bdownloads?\b|(?:عدد|مرات)\s+(?:ال)?تحميل/iu;

const sourceSuffix = /(?:\s+(?:on|from|in|في|من|على)\s+(?:npm|pypi|pip3?|python|github))$/i;
const installPrefix = /^(?:(?:how (?:do i|to)\s+)?(?:npm\s+(?:i|add|install)|(?:python3?\s+-m\s+)?pip3?\s+install|install(?:ing)?)|(?:كيف\s+)?(?:اثبت|ثبت|تثبيت|انصب))\s+/iu;
const factPrefix = /^(?:(?:(?:what is|what's|where is|where can i find|find|show me)\s+)?(?:the\s+)?(?:(?:latest|newest|current)\s+(?:stable\s+)?(?:version|release)|licen[cs]e|repository|(?:weekly |monthly )?downloads?)(?:\s+(?:of|for))?\s+|(?:ما\s+)?(?:(?:احدث|اخر)\s+(?:اصدار|نسخة)|(?:ال)?ترخيص|مستودع|(?:عدد|مرات)\s+(?:ال)?تحميل)\s+(?:من\s+|ل\s*)?)/iu;
const packagePrefix = /^(?:(?:the|npm|pypi|python|javascript|package|library)\s+|(?:حزم[هة]|مكتب[هة])\s+)*/iu;
const discoveryPrefix = /^(?:(?:what is|what's)\s+)?(?:the\s+)?(?:(?:best|recommended|recommend|find|search for)\s+)?(?:(?:an?|npm|python|javascript|typescript|node(?:\.?js)?)\s+)*(?:librar(?:y|ies)|packages?|repositor(?:y|ies)|repo)(?:\s+(?:for|to|of))?\s+|^(?:ما\s+)?(?:افضل\s+|اقترح\s+|ابحث\s+عن\s+)?(?:مكتب[هة]|حزم[هة]|مستودع)\s+(?:ل\s*|عن\s+)?/iu;

function normalizedQuestion(question: string): string {
  return question.replace(/\p{Cf}/gu, '').replace(/[\u0610-\u061a\u064b-\u065f\u0670\u0640]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').trim().replace(/[?؟!]+$/u, '').trim();
}

function exactPackage(question: string, pattern: RegExp): string | undefined {
  const codeNames = [...question.matchAll(/\x60([^\x60]+)\x60/gu)].map(match => match[1].trim());
  if (codeNames.length) return codeNames.length === 1 && pattern.test(codeNames[0]) ? codeNames[0] : undefined;
  const subject = question.replace(sourceSuffix, '').replace(installPrefix, '').replace(factPrefix, '')
    .replace(packagePrefix, '').trim().replace(/^"([^"]+)"$/, '$1');
  return pattern.test(subject) ? subject : undefined;
}

function topic(question: string): string {
  return question.replace(sourceSuffix, '').replace(installPrefix, '').replace(factPrefix, '').replace(discoveryPrefix, '')
    .replace(/^(?:npm|github)\s+/i, '').trim().slice(0, 240);
}

function githubSearch(question: string): { text: string; exact?: string } {
  const text = topic(question).replace(packagePrefix, '').replace(/\s+project$/i, '');
  const subject = text.replace(/^(?:repo:|(?:https:\/\/)?github\.com\/)/i, '').replace(/\/$/, '');
  return repositoryName.test(subject) ? { text: 'repo:' + subject, exact: subject } : { text };
}

function publicQuestion(query: SearchQuery, signal: AbortSignal): string {
  signal.throwIfAborted();
  const text = query.question.normalize('NFKC').replace(/\p{Cf}/gu, '');
  const decoded = publicSearchScan(text);
  if (publicSearchText(text) !== text || publicSearchText(decoded) !== decoded ||
      (decoded.match(/https?:\/\/\S+/gi) ?? []).some(url => !safeResumeUrl(url))) {
    throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
  }
  return normalizedQuestion(text);
}

function withSites(query: SearchQuery, hosts: string[], matches: (question: string, scoped: boolean) => boolean): boolean {
  const scoped = query.sites.some(site => hosts.some(host => host === site || host.endsWith('.' + site)));
  return (!query.sites.length || scoped) && matches(normalizedQuestion(query.question), scoped);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clean(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? publicSearchText(value).replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit)
    : '';
}

function versionDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().slice(0, 10)
    : '';
}

function safeLink(value: unknown): string {
  if (typeof value !== 'string') return '';
  const decoded = publicSearchScan(value);
  if (publicSearchText(decoded) !== decoded) return '';
  const link = value.startsWith('git+https:') ? value.slice(4) : value;
  return safeResumeUrl(link) ?? '';
}

function npmRepository(value: unknown): string {
  const url = record(value)?.url ?? value;
  return safeLink(url) || (typeof url === 'string' && /^(?:github|gitlab|bitbucket):[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(url) ? url : '');
}

const labels = {
  en: {
    latest: 'Latest version', version: 'Version', license: 'License', repository: 'Repository',
    published: 'Published', urls: 'Project URLs', weekly: 'Downloads (weekly)', monthly: 'Downloads (monthly)',
    language: 'Language', stars: 'Stars', pushed: 'Last push', read: 'Read on',
  },
  ar: {
    latest: 'أحدث إصدار', version: 'الإصدار', license: 'الترخيص', repository: 'المستودع',
    published: 'تاريخ النشر', urls: 'روابط المشروع', weekly: 'التنزيلات الأسبوعية', monthly: 'التنزيلات الشهرية',
    language: 'اللغة', stars: 'النجوم', pushed: 'آخر تحديث للكود', read: 'تاريخ الاطلاع',
  },
};
type Fact = Exclude<keyof typeof labels.en, 'read'>;
type Facts = Partial<Record<Fact, string>>;

function snippet(source: string, query: SearchQuery, now: () => number, description: unknown, facts: Facts): string {
  const strings = labels[query.language];
  const fields = (Object.keys(facts) as Fact[]).flatMap(field => facts[field] ? [strings[field] + ': ' + facts[field]] : []);
  return [clean(description, 400), ...fields, source + ' · ' + strings.read + ': ' + new Date(now()).toISOString().slice(0, 10)].filter(Boolean).join(' · ');
}

function integer(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
}

function invalid(): never {
  throw new SearchProviderFailure('invalid_response');
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}

interface RateGate { next: number; active: boolean }
const githubGates = new WeakMap<() => number, RateGate>();

function resetDelay(value: string | undefined, now: number): number | undefined {
  const epoch = value?.trim();
  if (!epoch || !/^\d+$/.test(epoch)) return undefined;
  const unixMs = Number(epoch) * 1000;
  return Number.isSafeInteger(unixMs) ? Math.max(0, unixMs - now) : undefined;
}

function backoff(response: SafeResponse, gate: RateGate, now: number, github: boolean): void {
  const retry = response.headers['retry-after'];
  const resetHeader = github ? response.headers['x-ratelimit-reset'] : undefined;
  const reset = resetDelay(resetHeader, now);
  const rateLimited = response.status === 429 || github && response.status === 403 &&
    (resetHeader !== undefined || retry !== undefined || /\b(?:secondary rate limit|rate limit exceeded)\b/i.test(response.body.toString('utf8', 0, 1024)));
  if (rateLimited || response.status === 503 && retry !== undefined) {
    const delay = Math.max(retry !== undefined || reset === undefined ? searchRetryAfter(retry, now) : 0, reset ?? 0);
    gate.next = Math.max(gate.next, now + delay);
    throw new SearchProviderFailure(rateLimited ? 'rate_limited' : 'unavailable', gate.next - now);
  }
  if (github && response.headers['x-ratelimit-remaining'] === '0') {
    gate.next = Math.max(gate.next, now + (reset ?? searchRetryAfter(retry, now)));
  }
}

function registryClient(network: SafeNetwork, robots: RobotsPolicy, now: () => number, origin: string) {
  const github = origin === GITHUB;
  const gate = (github ? githubGates.get(now) : undefined) ?? { next: -Infinity, active: false };
  if (github) githubGates.set(now, gate);
  const cooldownMs = () => Math.max(0, gate.next - now());

  type ReadOptions = { maxBytes?: number; fallbackOnSize?: boolean };
  async function json<T>(path: string, signal: AbortSignal, decode: (value: unknown) => T | undefined, options: ReadOptions = {}): Promise<T | null | undefined> {
    signal.throwIfAborted();
    if (gate.active || cooldownMs()) throw new SearchProviderFailure('rate_limited', cooldownMs() || GITHUB_INTERVAL);
    if (github) gate.active = true;
    try {
      const url = new URL(path, origin).href;
      await robots.assertAllowed(url, signal);
      if (github) gate.next = now() + GITHUB_INTERVAL;
      const response = await network.request(url, {
        allowedOrigins: [origin], signal, maxBytes: options.maxBytes ?? JSON_LIMIT,
        // https://docs.github.com/en/rest/search/search#search-repositories (2026-11-27)
        headers: github ? { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' } : { accept: 'application/json' },
      });
      signal.throwIfAborted();
      backoff(response, gate, now(), github);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new SearchProviderFailure('unavailable');
      const contentType = response.headers['content-type'] ?? '';
      if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(contentType)) return invalid();
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
      if (charset && !/^utf-?8$/i.test(charset)) return invalid();
      try {
        return decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body))) ?? invalid();
      } catch {
        return invalid();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SearchProviderFailure) throw error;
      if (options.fallbackOnSize && error instanceof BrowserError && error.code === 'BROWSER_RESPONSE_TOO_LARGE') return undefined;
      throw new SearchProviderFailure('unavailable');
    } finally {
      if (github) gate.active = false;
    }
  }
  return {
    json: (path: string, signal: AbortSignal, options?: ReadOptions) => json(path, signal, record, options),
    jsonList: (path: string, signal: AbortSignal, options?: ReadOptions) => json(path, signal, list, options),
    cooldownMs,
  };
}

function planned(name: string, url: string, hosts: string[]): Pick<PlannedProvider, 'name' | 'coverage' | 'accessBasis' | 'planned'> {
  return {
    name, coverage: 'programming', accessBasis: 'documented_api',
    planned: { domains: ['programming'], languages: ['ar', 'en'], access: 'documented_api', hosts, contract: { url, checked: CHECKED } },
  };
}

export function programmingProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const robots = new RobotsPolicy(network, now);
  const npm = registryClient(network, robots, now, NPM);
  const pypi = registryClient(network, robots, now, PYPI);
  const github = registryClient(network, robots, now, GITHUB);
  const npmHosts = ['npmjs.com', 'registry.npmjs.org'];
  const pypiHosts = ['pypi.org'];
  const githubHosts = ['github.com', 'api.github.com'];
  async function npmSearch(text: string, count: number, signal: AbortSignal) {
    // https://api-docs.npmjs.com/#tag/Search/operation/getsearch (2026-11-27)
    const data = await npm.json('/-/v1/search?' + new URLSearchParams({ text, size: String(count) }), signal);
    if (!data) return invalid();
    return list(data.objects).slice(0, count).flatMap(value => {
      const result = record(value);
      const pkg = record(result?.package);
      const name = clean(pkg?.name, 214);
      const version = clean(pkg?.version, 80);
      if (!pkg || !npmName.test(name) || !version) return [];
      const downloads = record(result?.downloads);
      return [{
        name, version, description: pkg.description, license: clean(pkg.license, 200),
        repository: npmRepository(record(pkg.links)?.repository), published: versionDate(pkg.date),
        weekly: integer(downloads?.weekly), monthly: integer(downloads?.monthly),
      }];
    });
  }

  const npmHit = (query: SearchQuery, name: string, description: unknown, facts: Facts): SearchHit => ({
    title: name, url: 'https://www.npmjs.com/package/' + name, snippet: snippet('npm', query, now, description, facts),
  });

  return [
    {
      ...planned('npm', 'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#package-endpoints', npmHosts),
      supports: query => withSites(query, npmHosts, (text, scoped) => scoped || !pypiContext.test(text) &&
        (npmContext.test(text) || packageRequest.test(text) && !repositoryRequest.test(text))),
      cooldownMs: npm.cooldownMs,
      async search(query, limit, signal) {
        const text = publicQuestion(query, signal);
        const count = Math.max(0, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
        if (!count) return [];
        const name = exactPackage(text, npmName)?.toLowerCase();
        if (!name) {
          const subject = topic(text);
          if (!subject) return [];
          return (await npmSearch(subject, count, signal)).map(pkg => npmHit(query, pkg.name, pkg.description, {
            version: pkg.version, license: pkg.license, repository: pkg.repository, published: pkg.published, weekly: pkg.weekly, monthly: pkg.monthly,
          }));
        }
        // Full metadata carries the version-specific publish time. The documented
        // tag endpoint bounds the cost for packages with very large histories.
        const path = '/' + encodeURIComponent(name).replace(/^%40/, '@');
        const packument = await npm.json(path, signal, { maxBytes: METADATA_LIMIT, fallbackOnSize: true });
        if (packument === null) return [];
        const latest = packument ? clean(record(packument['dist-tags'])?.latest, 80) : '';
        const manifest = packument ? record(record(packument.versions)?.[latest]) : await npm.json(path + '/latest', signal);
        if (manifest === null) return [];
        const version = clean(manifest?.version, 80);
        if (!manifest || clean(manifest.name, 214).toLowerCase() !== name || !version || packument && version !== latest) return invalid();
        const published = versionDate(record(packument?.time)?.[version]);
        const indexed = !published || downloadRequest.test(text) ? (await npmSearch(name, 20, signal).catch(error => {
          signal.throwIfAborted();
          if (!(error instanceof SearchProviderFailure)) throw error;
          // Keep the exact tag metadata when supplementary search facts are unavailable.
          return [];
        })).find(row => row.name.toLowerCase() === name) : undefined;
        return [npmHit(query, name, manifest.description, {
          latest: version, license: clean(manifest.license, 200), repository: npmRepository(manifest.repository),
          published: published || (indexed?.version === version ? indexed.published : ''),
          weekly: indexed?.weekly, monthly: indexed?.monthly,
        })];
      },
    },
    {
      ...planned('PyPI', 'https://docs.pypi.org/api/json/#get-a-project', pypiHosts),
      supports: query => withSites(query, pypiHosts, (text, scoped) =>
        Boolean(exactPackage(text, pythonName)) && (scoped || !npmContext.test(text) &&
          (pypiContext.test(text) || packageRequest.test(text) || /\x60/.test(text)))),
      cooldownMs: pypi.cooldownMs,
      async search(query, limit, signal) {
        const text = publicQuestion(query, signal);
        const name = exactPackage(text, pythonName)?.toLowerCase().replace(/[-_.]+/g, '-');
        if (!name || limit <= 0) return [];
        // As checked on 2026-11-27, https://pypi.org/robots.txt disallows this
        // route. The live RobotsPolicy check must pass before any request.
        const data = await pypi.json('/pypi/' + encodeURIComponent(name) + '/json', signal, { maxBytes: METADATA_LIMIT });
        if (data === null) return [];
        const info = record(data?.info);
        const title = clean(info?.name, 214);
        const version = clean(info?.version, 80);
        if (!info || !pythonName.test(title) || title.toLowerCase().replace(/[-_.]+/g, '-') !== name || !version) return invalid();
        const published = list(data?.urls).map(file => versionDate(record(file)?.upload_time_iso_8601)).filter(Boolean).sort()[0];
        const urls = Object.entries(record(info.project_urls) ?? {}).flatMap(([label, url]) => {
          const link = safeLink(url);
          return link && link.length <= 220 ? [clean(label, 40) + ' ' + link] : [];
        }).slice(0, 5).join(', ');
        const license = clean(info.license_expression, 200) || clean(info.license, 200).replace(/^(?:\.{3}|UNKNOWN)$/i, '') ||
          (Array.isArray(info.classifiers) ? info.classifiers : []).flatMap(classifier => {
            const parts = clean(classifier, 240).split(' :: ');
            return parts.length >= 3 && parts[0] === 'License' ? [parts.at(-1)] : [];
          }).join(', ');
        return [{
          title, url: PYPI + '/project/' + name + '/',
          snippet: snippet('PyPI', query, now, info.summary, { latest: version, license, published, urls }),
        }];
      },
    },
    {
      ...planned('GitHub', 'https://docs.github.com/en/rest/search/search#search-repositories', githubHosts),
      supports: query => withSites(query, githubHosts, (text, scoped) =>
        scoped || repositoryRequest.test(text) || packageRequest.test(text) && discovery.test(text) || Boolean(githubSearch(text).exact)),
      cooldownMs: github.cooldownMs,
      async search(query, limit, signal) {
        const search = githubSearch(publicQuestion(query, signal));
        const count = Math.max(0, Math.min(search.exact ? 1 : 20, Number.isFinite(limit) ? Math.floor(limit) : 5));
        if (!search.text || !count) return [];
        const data = await github.json('/search/repositories?' + new URLSearchParams({ q: search.text, per_page: String(count) }), signal);
        if (!data) return invalid();
        return list(data.items).slice(0, count).flatMap(value => {
          const item = record(value);
          const name = clean(item?.full_name, 240);
          if (!item || !repositoryName.test(name) || search.exact && name.toLowerCase() !== search.exact.toLowerCase()) return [];
          const url = safeLink(item.html_url);
          if (url.toLowerCase() !== ('https://github.com/' + name).toLowerCase()) return [];
          const license = record(item.license);
          return [{
            title: name, url,
            snippet: snippet('GitHub', query, now, item.description, {
              license: clean(license?.spdx_id, 200).replace(/^NOASSERTION$/, '') || clean(license?.name, 200),
              language: clean(item.language, 80), stars: integer(item.stargazers_count), pushed: versionDate(item.pushed_at),
            }),
          }];
        });
      },
    },
    mdnProvider(registryClient(network, robots, now, MDN), now),
  ];
}

function mdnProvider(client: ReturnType<typeof registryClient>, now: () => number): PlannedProvider {
  const hosts = ['developer.mozilla.org'];
  const mdnMention = /\b(?:mdn|mozilla developer network)\b|موزيلا/iu;
  const webTopic = /\b(?:javascript|css|html|dom|svg|web\s+apis?|webassembly|http|webgl|webgpu|webauthn)\b/i;
  const queryWords = new Set('mdn mozilla developer network web docs documentation reference examples guide use using work explain شرح توثيق استخدام استخدم موزيلا'.split(' '));
  const tokenize = (value: string) => new Set(value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

  return {
    ...planned('MDN Web Docs', 'https://github.com/mdn/rari/blob/main/crates/rari-doc/src/search_index.rs', hosts),
    supports: query => withSites(query, hosts, (text, scoped) =>
      scoped || mdnMention.test(text) || webTopic.test(text) && !packageRequest.test(text) && !repositoryRequest.test(text)),
    cooldownMs: client.cooldownMs,
    async search(query, limit, signal) {
      publicQuestion(query, signal);
      const count = Math.max(0, Math.min(5, Number.isFinite(limit) ? Math.floor(limit) : 5));
      const terms = query.tokens.filter(word => !queryWords.has(word));
      if (!count || !terms.length) return [];

      // Rari publishes this locale index as title and URL pairs. The English
      // response was about 1.5 MB on 2026-11-27.
      const index = await client.jsonList('/en-US/search-index.json', signal, { maxBytes: 2_000_000 });
      if (!index) return invalid();
      const candidates = index.flatMap(value => {
        const item = record(value);
        const title = clean(item?.title, 240);
        const path = item?.url;
        if (!title || typeof path !== 'string' || !/^\/en-US\/docs\/[^\s?#\\]+$/.test(path) || /%(?:2f|5c)/i.test(path)) return [];
        const url = safeLink(MDN + path);
        if (!url || new URL(url).pathname !== path) return [];
        const titleWords = tokenize(title);
        const pathWords = tokenize(path);
        const titleMatches = terms.filter(word => titleWords.has(word)).length;
        const matches = terms.filter(word => titleWords.has(word) || pathWords.has(word)).length;
        return titleMatches && matches >= Math.ceil(terms.length / 2) ? [{ url, path, score: titleMatches * 2 + matches }] : [];
      }).sort((a, b) => b.score - a.score).slice(0, count);

      const hits: SearchHit[] = [];
      for (const { url, path } of candidates) {
        // Rari publishes the summary next to each page, as used by MDN tooling.
        // https://github.com/mdn/rari/blob/main/crates/rari-doc/src/build.rs (2026-11-27)
        // https://github.com/mdn/mcp/blob/main/tools/search.js (2026-11-27)
        const page = await client.json(path + '/metadata.json', signal);
        const title = clean(page?.title, 240);
        const summary = clean(page?.summary, 400);
        if (page?.mdn_url !== path || !title || !summary) continue;
        // https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Attrib_copyright_license (2026-11-27)
        const attribution = 'MDN Web Docs · Mozilla Contributors · CC BY-SA 2.5 (https://creativecommons.org/licenses/by-sa/2.5/)';
        const edited = summary !== page.summary || title !== page.title;
        const source = edited ? attribution + (query.language === 'ar' ? ' · مقتطف محرّر' : ' · Edited excerpt') : attribution;
        hits.push({ title, url, snippet: snippet(source, query, now, summary, {}) });
      }
      return hits;
    },
  };
}
