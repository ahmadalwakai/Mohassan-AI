import { parseFragment } from 'parse5';
import { createHash } from 'node:crypto';
import { SafeNetwork } from '../network.js';
import type { SearchHit } from '../research.js';
import type { compileQuery } from './ranking.js';
import { extraDocumentedProviders } from './extra-providers.js';

export type SearchQuery = ReturnType<typeof compileQuery>;
export interface DocumentedProvider {
  name: string;
  coverage: 'encyclopedia' | 'programming' | 'scholarly';
  accessBasis: 'documented_api';
  supports(query: SearchQuery): boolean;
  search(query: SearchQuery, limit: number, signal: AbortSignal): Promise<SearchHit[]>;
  /** Carries successful-response backoff/quota instructions to the shared gate. */
  cooldownMs?(): number;
}
export class SearchProviderFailure extends Error {
  constructor(readonly kind: 'rate_limited' | 'unavailable' | 'invalid_response', readonly retryAfterMs = 0) { super(kind); }
}
function plain(input: unknown, max = 700): string {
  if (typeof input !== 'string') return '';
  function text(node: any): string { return node.nodeName === '#text' ? node.value : ['script','style'].includes(node.tagName) ? '' : (node.childNodes ?? []).map(text).join(' '); }
  return text(parseFragment(input)).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const HTTP_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HTTP_LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HTTP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** RFC 9110 §5.6.7 requires all three HTTP-date forms, not arbitrary Date.parse input. */
function httpDate(value: string, now: number): number | undefined {
  const imf = /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const obsolete = /^([A-Z][a-z]+), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  const parts = imf?.slice(1) ?? (obsolete ? [HTTP_WEEKDAYS[HTTP_LONG_WEEKDAYS.indexOf(obsolete[1])] ?? '', ...obsolete.slice(2)]
    : asctime ? [asctime[1], asctime[3], asctime[2], asctime[7], asctime[4], asctime[5], asctime[6]] : undefined);
  if (!parts || !Number.isFinite(now)) return undefined;
  const [weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = parts;
  const day = Number(dayText), month = HTTP_MONTHS.indexOf(monthText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  let year = Number(yearText);
  if (obsolete) {
    // Resolve the two-digit year relative to this receipt time, including the
    // exact 50-year boundary, rather than Date.parse's fixed century pivot.
    const futureLimit = new Date(now); futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 50);
    year += Math.floor(futureLimit.getUTCFullYear() / 100) * 100;
    if (Date.UTC(year, month, day, hour, minute, second) > futureLimit.getTime()) year -= 100;
  }
  if (year < 1900 || month < 0 || day < 1 || hour > 23 || minute > 59 || second > 60 ||
      (second === 60 && (hour !== 23 || minute !== 59))) return undefined;
  // Check the calendar before adding a leap second: Date.UTC normally rolls an
  // invalid 31 April or 29 February into the following month.
  const date = new Date(Date.UTC(year, month, day, hour, minute, Math.min(second, 59)));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day ||
      HTTP_WEEKDAYS[date.getUTCDay()] !== weekday) return undefined;
  return date.getTime() + (second === 60 ? 1000 : 0);
}
export function searchRetryAfter(value: string | undefined, now: number): number {
  const field = value?.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!field) return 60_000;
  if (/^\d+$/.test(field)) return Math.min(Number(field) * 1000, 86_400_000);
  const date = httpDate(field, now);
  return date === undefined ? 60_000 : Math.min(Math.max(date - now, 0), 86_400_000);
}
async function json(network: SafeNetwork, url: string, signal: AbortSignal, now = Date.now()): Promise<any> {
  const response = await network.request(url, { signal, headers: { accept: 'application/json' } });
  const retry = response.headers['retry-after'];
  const retryAfterMs = searchRetryAfter(retry, now);
  if (response.status === 429) throw new SearchProviderFailure('rate_limited', retryAfterMs);
  if (response.status === 503 && retry !== undefined) throw new SearchProviderFailure('unavailable', retryAfterMs);
  if (response.status !== 200) throw new SearchProviderFailure('unavailable');
  try { const data = JSON.parse(response.body.toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid'); return data; } catch { throw new SearchProviderFailure('invalid_response'); }
}
/** Official API contracts are linked in docs/SEARCH-ENGINE-IMPLEMENTATION.md. */
export function documentedProviders(network: SafeNetwork, now = Date.now): DocumentedProvider[] {
  let stackBackoff = 0;
  const stackQueries = new Map<string,number>();
  return [
    { name: 'Wikipedia', coverage: 'encyclopedia', accessBasis: 'documented_api', supports: () => true,
      async search(query, limit, signal) {
        const url = new URL(`https://${query.language}.wikipedia.org/w/api.php`);
        url.search = new URLSearchParams({ action:'query', list:'search', srsearch:query.retrievalQuestion, srlimit:String(limit), format:'json', utf8:'1' }).toString();
        const data = await json(network, url.href, signal, now());
        if (!Array.isArray(data.query?.search)) throw new SearchProviderFailure('invalid_response');
        return data.query.search.slice(0, limit).flatMap((item: any) => typeof item.title === 'string' ? [{
          title:plain(item.title,240), url:`https://${query.language}.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(' ','_'))}`, snippet:plain(item.snippet),
        }] : []);
      } },
    { name: 'Stack Exchange', coverage:'programming', accessBasis:'documented_api', supports: query => query.intent === 'technical', cooldownMs: () => Math.max(0,stackBackoff-now()),
      async search(query, limit, signal) {
        if (now() < stackBackoff) throw new SearchProviderFailure('rate_limited', stackBackoff - now());
        const queryKey=createHash('sha256').update(query.retrievalQuestion.toLowerCase().trim()).digest('hex');
        const last=stackQueries.get(queryKey);
        if(last!==undefined&&now()-last<60000)throw new SearchProviderFailure('rate_limited',60000-(now()-last));
        if(stackQueries.size>=200)stackQueries.delete(stackQueries.keys().next().value!);
        stackQueries.set(queryKey,now());
        const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
        url.search = new URLSearchParams({ site:'stackoverflow', q:query.retrievalQuestion, pagesize:String(limit), sort:'relevance', order:'desc' }).toString();
        const data = await json(network,url.href,signal,now());
        if (data.backoff !== undefined && (typeof data.backoff !== 'number' || !Number.isFinite(data.backoff) || data.backoff < 0)) throw new SearchProviderFailure('invalid_response');
        if (typeof data.backoff === 'number') stackBackoff = now() + Math.min(data.backoff,86_400)*1000;
        if (data.quota_remaining === 0) stackBackoff = Math.max(stackBackoff, now()+86_400_000);
        if (!Array.isArray(data.items) || data.error_id) throw new SearchProviderFailure('invalid_response');
        return data.items.slice(0,limit).flatMap((item:any) => typeof item.link === 'string' ? [{title:plain(item.title,240),url:item.link,snippet:plain((item.tags??[]).join(' '))}] : []);
      } },
    { name:'Crossref', coverage:'scholarly', accessBasis:'documented_api', supports:query => query.intent === 'scholarly',
      async search(query,limit,signal) {
        const url = new URL('https://api.crossref.org/works');
        url.search = new URLSearchParams({ query:query.retrievalQuestion, rows:String(limit), select:'DOI,title,abstract,URL' }).toString();
        const data = await json(network,url.href,signal,now());
        if (!Array.isArray(data.message?.items)) throw new SearchProviderFailure('invalid_response');
        return data.message.items.slice(0,limit).flatMap((item:any) => typeof item.URL === 'string' ? [{title:plain(item.title?.[0],240),url:item.URL,snippet:plain(item.abstract)}] : []);
      } },
    ...extraDocumentedProviders(network,now),
  ];
}
