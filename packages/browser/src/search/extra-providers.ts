import { parseFragment } from 'parse5';
import { BrowserError, type SafeNetwork, type SafeResponse } from '../network.js';
import { safeResumeUrl } from '../session-state.js';
import type { SearchHit } from '../research.js';
import { publicSearchScan, publicSearchText } from './local-index.js';
import { searchTokens } from './ranking.js';
import { InvalidSearchXml, readSearchXml, type SearchXmlNode } from './xml.js';
import { SearchProviderFailure, searchRetryAfter, type DocumentedProvider, type SearchQuery } from './providers.js';

const MAX_BYTES = 512_000;
const ATOM = 'http://www.w3.org/2005/Atom';
const OPEN_SEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const invalid = (): never => { throw new SearchProviderFailure('invalid_response'); };
type Gate = { active: boolean; next: number };
// Shared by factory instances in this process. Multiple server processes need a shared admission gate.
const gates = new WeakMap<() => number, { hn: Gate; arxiv: Gate }>();

function plain(value: string, limit: number): string {
  function text(node: any): string { return node.nodeName === '#text' ? node.value : ['script', 'style'].includes(node.tagName) ? '' : (node.childNodes ?? []).map(text).join(' '); }
  return publicSearchText(text(parseFragment(value.slice(0, 24_000))))
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function publicQuery(query: SearchQuery, signal: AbortSignal): string {
  signal.throwIfAborted();
  const text = query.question.normalize('NFKC').replace(/\p{Cf}/gu, '');
  const decoded = publicSearchScan(text);
  const unsafeUrl = (decoded.match(/https?:\/\/\S+/gi) ?? []).some(url => safeResumeUrl(url) === null);
  if (publicSearchText(text) !== text || publicSearchText(decoded) !== decoded || unsafeUrl) throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
  if (!text.trim() || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) throw new BrowserError('RESEARCH_QUERY_INVALID', 'استعلام البحث غير صالح.', 400);
  return query.retrievalQuestion;
}
const count = (limit: number) => Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
function utf8(response: SafeResponse, kind: 'json' | 'atom'): string {
  if (!Buffer.isBuffer(response.body) || response.body.length > MAX_BYTES) return invalid();
  const type = response.headers['content-type'] ?? '';
  if (!(kind === 'json' ? /^application\/json(?:\s*;|$)/i : /^(?:application\/(?:atom\+xml|xml)|text\/xml)(?:\s*;|$)/i).test(type)) return invalid();
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1];
  if (charset && !/^utf-?8$/i.test(charset)) return invalid();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(response.body); } catch { return invalid(); }
}
async function retrieve(network: SafeNetwork, gate: Gate, spacing: number, now: () => number, url: string, signal: AbortSignal, kind: 'json' | 'atom'): Promise<string> {
  signal.throwIfAborted();
  if (gate.active || gate.next > now()) throw new SearchProviderFailure('rate_limited', Math.max(spacing, gate.next - now()));
  gate.active = true;
  gate.next = now() + spacing;
  try {
    const response = await network.request(url, { signal, maxBytes: MAX_BYTES, headers: { accept: kind === 'json' ? 'application/json' : 'application/atom+xml' } });
    signal.throwIfAborted();
    if (response.status === 429 || (response.status === 503 && response.headers['retry-after'] !== undefined)) {
      const retry = searchRetryAfter(response.headers['retry-after'], now());
      gate.next = Math.max(gate.next, now() + retry);
      throw new SearchProviderFailure(response.status === 429 ? 'rate_limited' : 'unavailable', Math.max(spacing, retry));
    }
    if (response.status !== 200) throw new SearchProviderFailure('unavailable');
    return utf8(response, kind);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SearchProviderFailure) throw error;
    // Do not expose provider bodies, transport messages or query-bearing URLs.
    throw new SearchProviderFailure('unavailable');
  } finally {
    gate.active = false;
    gate.next = Math.max(gate.next, now() + spacing);
  }
}

function atomHits(source: string, limit: number): SearchHit[] {
  let feed: SearchXmlNode;
  try { feed = readSearchXml(source); } catch (error) {
    if (error instanceof InvalidSearchXml) return invalid();
    throw error;
  }
  if (feed.name !== 'feed' || feed.namespace !== ATOM) return invalid();
  const entries = feed.children.filter(node => node.name === 'entry');
  const totals = feed.children.filter(node => node.name === 'totalResults' && node.namespace === OPEN_SEARCH);
  if (entries.length > 100 || totals.length !== 1 || totals[0].children.length || !/^\d{1,12}$/.test(totals[0].text.trim()) || Number(totals[0].text) < entries.length || !entries.length && Number(totals[0].text) !== 0) return invalid();
  return entries.slice(0, limit).map(entry => {
    if (entry.namespace !== ATOM) return invalid();
    const field = (name: string) => {
      const nodes = entry.children.filter(node => node.name === name && node.namespace === ATOM);
      if (nodes.length !== 1 || nodes[0].children.length) return invalid();
      return nodes[0].text.trim();
    };
    const id = field('id');
    let url: URL; try { url = new URL(id); } catch { return invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'arxiv.org' || url.username || url.password || url.port || url.search || url.hash
      || !/^\/abs\/(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]+)?\/\d{7})(?:v[1-9]\d*)?$/i.test(url.pathname)) return invalid();
    const title = plain(field('title'), 240), snippet = plain(field('summary'), 700);
    if (!title || !snippet) return invalid();
    return { title, url: `https://arxiv.org${url.pathname}`, snippet };
  });
}

/** Contracts: https://hn.algolia.com/api and https://info.arxiv.org/help/api/user-manual.html .
 * arXiv's mandatory >=3s/single-connection limit: https://info.arxiv.org/help/api/tou.html . */
export function extraDocumentedProviders(network: SafeNetwork, now = Date.now): DocumentedProvider[] {
  let admission = gates.get(now);
  if (!admission) { admission = { hn: { active: false, next: 0 }, arxiv: { active: false, next: 0 } }; gates.set(now, admission); }
  const { hn, arxiv } = admission;
  return [
    { name: 'Hacker News', coverage: 'programming', accessBasis: 'documented_api', supports: query => query.intent === 'technical',
      async search(query, limit, signal) {
        const text = publicQuery(query, signal), maximum = count(limit), url = new URL('https://hn.algolia.com/api/v1/search');
        url.search = new URLSearchParams({ query: text, tags: 'story', hitsPerPage: String(maximum), page: '0' }).toString();
        const body = await retrieve(network, hn, 1000, now, url.href, signal, 'json');
        let data: any; try { data = JSON.parse(body); } catch { return invalid(); }
        if (!data || !Array.isArray(data.hits) || data.hits.length > 100) return invalid();
        return data.hits.slice(0, maximum).flatMap((hit: any) => {
          if (!hit || typeof hit.title !== 'string' || typeof hit.objectID !== 'string' || !/^[1-9]\d{0,19}$/.test(hit.objectID) || hit.url !== null && hit.url !== undefined && typeof hit.url !== 'string' || hit.story_text !== null && hit.story_text !== undefined && typeof hit.story_text !== 'string') return invalid();
          const title = plain(hit.title, 240); if (!title) return [];
          let target = `https://news.ycombinator.com/item?id=${hit.objectID}`;
          if (hit.url) {
            try { const candidate = network.validate(hit.url); if (candidate.protocol === 'https:' && safeResumeUrl(candidate.href)) target = candidate.href; }
            catch { /* An unsafe external link is never fetched; retain the public HN discussion. */ }
          }
          return [{ title, url: target, snippet: plain(hit.story_text ?? '', 700) }];
        });
      } },
    { name: 'arXiv', coverage: 'scholarly', accessBasis: 'documented_api', supports: query => query.intent === 'scholarly',
      async search(query, limit, signal) {
        const text = publicQuery(query, signal), maximum = count(limit), terms = searchTokens(text).slice(0, 24);
        if (!terms.length) throw new BrowserError('RESEARCH_QUERY_INVALID', 'اكتب موضوعًا محددًا للبحث.', 400);
        const url = new URL('https://export.arxiv.org/api/query');
        url.search = new URLSearchParams({ search_query: terms.map(term => `all:"${term}"`).join(' AND '), start: '0', max_results: String(maximum), sortBy: 'relevance', sortOrder: 'descending' }).toString();
        return atomHits(await retrieve(network, arxiv, 3000, now, url.href, signal, 'atom'), maximum);
      } },
  ];
}
