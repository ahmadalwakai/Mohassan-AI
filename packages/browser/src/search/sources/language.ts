import { setTimeout as wait } from 'node:timers/promises';
import type { SafeNetwork } from '../../network.js';
import type { SearchHit } from '../../research.js';
import { publicSearchScan, publicSearchText } from '../local-index.js';
import { SearchProviderFailure, searchRetryAfter, type SearchQuery } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { PlannedProvider } from '../source-plan.js';
import { readEntry, stripArabicMarks, validTitle, type Edition, type EntryRequest } from './language-entry.js';

const CONTRACT = { url: 'https://www.mediawiki.org/wiki/API:Parsing_wikitext', checked: '2026-11-27' };
// Entry links credit contributors under Wikimedia's Terms of Use, §7 (checked 2026-11-27).
// https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content
const LICENSE = 'Wiktionary contributors · CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) · plain-text excerpts';
const EDITIONS = [
  { code: 'ar', name: 'Arabic Wiktionary', host: 'ar.wiktionary.org' },
  { code: 'en', name: 'English Wiktionary', host: 'en.wiktionary.org' },
] as const;
// Wikimedia Robot policy, Action API rules, and Wikimedia API rate limits (checked 2026-11-27):
// https://wikitech.wikimedia.org/wiki/Robot_policy#Action_API_rules
// https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
const SPACING = 500;
const SLOW_REQUEST_PAUSE = 5_000;
const MAX_LOOKUPS = 12;
const MAX_BYTES = 2_000_000;

type Intent = EntryRequest['intent'];
const englishRequests: [Intent, RegExp][] = [
  ['translation', /^translate\s+(.+?)\s+(?:to|into)\s+(.+)$/iu],
  ['definition', /^what\s+does\s+(?:the\s+word\s+)?(.+?)\s+mean$/iu],
  ['definition', /^(?:define|(?:what\s+is\s+the\s+)?meaning\s+of)\s+(.+)$/iu],
  ['plural', /^(?:what\s+is\s+the\s+)?plural\s+of\s+(.+)$/iu],
  ['root', /^(?:what\s+is\s+the\s+)?root\s+of\s+(.+)$/iu],
  ['pattern', /^(?:what\s+is\s+the\s+)?pattern\s+of\s+(.+)$/iu],
  ['spelling', /^(?:how\s+do\s+you\s+spell|spelling\s+of)\s+(.+)$/iu],
  ['synonyms', /^synonyms?\s+(?:of|for)\s+(.+)$/iu],
  ['etymology', /^etymology\s+of\s+(.+)$/iu],
  ['partOfSpeech', /^part\s+of\s+speech\s+of\s+(.+)$/iu],
];

function arabicRequest(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\p{Script=Arabic}/gu, '$&[\\p{M}ـ]*'), 'u');
}

const arabicRequests: [Intent, RegExp][] = [
  ['translation', arabicRequest(String.raw`^(?:ترجم|ما\s+ترجمة)\s+(.+?)\s+(?:إلى|الى|ل)\s+(.+)$`)],
  ['definition', arabicRequest(String.raw`^(?:ما\s+(?:هو\s+)?معنى|ماذا\s+تعني)\s+(?:كلمة\s+)?(.+)$`)],
  ['plural', arabicRequest(String.raw`^ما\s+(?:هو\s+)?جمع\s+(?:كلمة\s+)?(.+)$`)],
  ['root', arabicRequest(String.raw`^ما\s+(?:هو\s+)?جذر\s+(?:كلمة\s+)?(.+)$`)],
  ['pattern', arabicRequest(String.raw`^ما\s+(?:هو\s+)?وزن\s+(?:كلمة\s+)?(.+)$`)],
  ['spelling', arabicRequest(String.raw`^كيف\s+(?:تكتب|يكتب|أكتب)\s+(?:كلمة\s+)?(.+)$`)],
  ['synonyms', arabicRequest(String.raw`^(?:ما\s+)?(?:مرادفات|مرادف)\s+(?:كلمة\s+)?(.+)$`)],
  ['etymology', arabicRequest(String.raw`^ما\s+(?:هو\s+)?(?:أصل|اصل|اشتقاق)\s+(?:كلمة\s+)?(.+)$`)],
  ['partOfSpeech', arabicRequest(String.raw`^ما\s+نوع\s+(?:كلمة\s+)?(.+)$`)],
];

function unquote(value: string): string {
  return value.trim().replace(/^["“«‘']|["”»’']$/gu, '').trim().normalize('NFC');
}

function entryRequest(query: SearchQuery): (EntryRequest & { term: string }) | undefined {
  const question = query.question.trim().replace(/[؟?!]+$/u, '').trim();
  for (const [intent, pattern] of [...englishRequests, ...arabicRequests]) {
    const match = pattern.exec(question);
    if (!match) continue;
    const term = unquote(match[1]);
    if (!validTitle(term)) return undefined;
    const language = /\p{Script=Arabic}/u.test(term) ? 'ar' : 'en';
    const target = match[2] && unquote(match[2]);
    if (intent === 'translation' && (!target || !validTitle(target))) return undefined;
    return { term, language, intent, target };
  }
}

function variants(term: string, language: Edition): string[] {
  if (language === 'en') return [...new Set([term, term.toLowerCase()])];
  const bare = stripArabicMarks(term);
  const titles = new Set([term, bare]);
  const endings = /[هة]$/u.test(bare) ? ['ة', 'ه'] : /[ىي]$/u.test(bare) ? ['ى', 'ي'] : [];
  const add = (stem: string) => {
    if (!endings.length) titles.add(stem);
    else for (const ending of endings) titles.add(stem.slice(0, -1) + ending);
  };
  add(bare);
  const letters = [...bare];
  for (const [index, character] of letters.entries()) {
    const seats = /[اأإآٱ]/u.test(character) ? 'اأإآٱ' : /[ءؤئ]/u.test(character) ? 'ءؤئ' : '';
    for (const seat of seats) {
      add(letters.with(index, seat).join(''));
    }
  }
  return [...titles].slice(0, MAX_LOOKUPS);
}

interface Gate { tail: Promise<void>; nextAt: number; retryAt: number }
const gates = new WeakMap<() => number, Gate>();

async function dispatch<T>(gate: Gate, now: () => number, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  const queued = gate.tail.then(async () => {
    signal.throwIfAborted();
    if (gate.retryAt > now()) throw new SearchProviderFailure('rate_limited', gate.retryAt - now());
    const delay = gate.nextAt - now();
    if (delay > 0) await wait(delay, undefined, { signal });
    const started = now();
    try {
      return await send();
    } finally {
      const ended = now();
      gate.nextAt = ended + (ended - started > 1000 ? SLOW_REQUEST_PAUSE : SPACING);
    }
  });
  gate.tail = queued.then(() => {}, () => {});
  return queued;
}

interface ParseResult { parse?: { title?: unknown; text?: unknown }; error?: { code?: unknown } }

/** The edition robots files are checked against the exact Action API URL before each request. */
export function languageProviders(network: SafeNetwork, now: () => number): PlannedProvider[] {
  const gate = gates.get(now) ?? { tail: Promise.resolve(), nextAt: 0, retryAt: 0 };
  gates.set(now, gate);
  const robots = new RobotsPolicy(network, now);
  const robotAgent = network.policy.userAgent?.split(/[\s/]/u, 1)[0] ?? 'MohassanAI-Research';

  return EDITIONS.map(({ code, name, host }) => {
    const origin = `https://${host}`;
    const matchesSite = (query: SearchQuery) => !query.sites.length || query.sites.some(site => site === host || site === 'wiktionary.org');

    const fetchEntry = (word: string, signal: AbortSignal) => dispatch(gate, now, signal, async () => {
      const url = new URL('/w/api.php', origin);
      // MediaWiki renders templates expanded by the entry itself, including labelled inflection and translation links.
      url.search = new URLSearchParams({ action: 'parse', page: word, prop: 'text', redirects: '1', disableeditsection: '1', format: 'json', formatversion: '2', maxlag: '5' }).toString();
      try {
        await robots.assertAllowed(url.href, signal, robotAgent);
      } catch {
        signal.throwIfAborted();
        throw new SearchProviderFailure('unavailable');
      }
      const response = await network.request(url.href, { allowedOrigins: [origin], signal, maxBytes: MAX_BYTES, headers: { accept: 'application/json' } });
      signal.throwIfAborted();
      const backoff = (kind: 'rate_limited' | 'unavailable') => {
        const retry = searchRetryAfter(response.headers['retry-after'], now());
        gate.retryAt = now() + retry;
        throw new SearchProviderFailure(kind, retry);
      };
      if (response.status === 429) return backoff('rate_limited');
      if (response.status === 503 && response.headers['retry-after'] !== undefined) return backoff('unavailable');
      if (response.status !== 200) throw new SearchProviderFailure('unavailable');
      let data: ParseResult;
      try {
        if (!/^application\/json(?:\s*;|$)/iu.test(response.headers['content-type'] ?? '')) throw new Error();
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
      } catch {
        throw new SearchProviderFailure('invalid_response');
      }
      if (data?.error?.code === 'missingtitle') return undefined;
      if (data?.error?.code === 'maxlag') return backoff('unavailable');
      if (data?.error?.code === 'ratelimited') return backoff('rate_limited');
      if (typeof data?.parse?.title !== 'string' || !validTitle(data.parse.title) || typeof data.parse.text !== 'string') {
        throw new SearchProviderFailure('invalid_response');
      }
      return { title: data.parse.title, html: data.parse.text };
    });

    return {
      name, coverage: 'web', accessBasis: 'documented_api',
      planned: { domains: ['language'], languages: [code, code === 'ar' ? 'en' : 'ar'], access: 'documented_api', contract: CONTRACT, hosts: [host] },
      supports: query => matchesSite(query) && entryRequest(query) !== undefined,
      cooldownMs: () => Math.max(0, gate.retryAt - now()),
      async search(query, limit, signal): Promise<SearchHit[]> {
        signal.throwIfAborted();
        const request = matchesSite(query) && entryRequest(query);
        if (!request || limit <= 0) return [];
        const decodedTerm = publicSearchScan(request.term);
        if (publicSearchText(request.term) !== request.term || publicSearchText(decodedTerm) !== decodedTerm) return [];

        const candidates = variants(request.term, request.language);
        const visited = new Set<string>();
        let inflected: SearchHit | undefined;
        while (candidates.length && visited.size < MAX_LOOKUPS) {
          const word = candidates.shift()!;
          if (visited.has(word)) continue;
          visited.add(word);
          const entry = await fetchEntry(word, signal);
          if (!entry) continue;
          const { lines, forms, lemmas } = readEntry(entry.html, origin, entry.title, request);
          const hit = {
            title: `${entry.title} — ${name}`,
            url: `${origin}/wiki/${encodeURIComponent(entry.title.replaceAll(' ', '_'))}`,
            snippet: [...lines, LICENSE].join('\n'),
          };
          if (lines.length && (!lemmas.length || request.intent !== 'definition')) {
            return inflected && limit > 1 ? [hit, inflected] : [hit];
          }
          if (lines.length) inflected ??= hit;
          candidates.unshift(...lemmas, ...forms);
        }
        return inflected ? [inflected] : [];
      },
    };
  });
}
