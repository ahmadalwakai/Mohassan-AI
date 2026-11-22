/**
 * Phase 0: time of each HTTP search provider, without a browser (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.1, P1).
 *
 * Usage: npx tsx scripts/perf/search-providers.ts [--out artifacts/perf/2026-11-22/search-providers]
 *
 * Calls the providers the search package already has (documented APIs and the two public search pages),
 * one request at a time, through SafeNetwork. Documented APIs are called under their published terms.
 * A public search page is called only if its robots.txt allows the exact URL for both `*` and the
 * project's agent name; otherwise the row records the refusal and no search request is sent.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SafeNetwork, compileQuery, documentedProviders, type DocumentedProvider } from '@mohassan/browser';
import { extraDocumentedProviders } from '../../packages/browser/src/search/extra-providers.js';
import { publicWebProviders } from '../../packages/browser/src/search/web-providers.js';
import { robotsAllows } from '../../packages/browser/src/search/robots.js';
import { stats } from './fixture.js';

const argument = (name: string, fallback: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback; };
const out = path.resolve(argument('out', path.join('artifacts', 'perf', '2026-11-22', 'search-providers')));
await mkdir(out, { recursive: true });

const QUERIES = ['ما عاصمة اليابان', 'capital of Japan', 'فوائد الشاي الأخضر', 'speed of light', 'python dataclasses', 'transformer attention mechanism paper'];
const SEARCH_PAGES: Record<string, (query: string) => string> = {
  'Bing RSS': query => `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
  'DuckDuckGo HTML': query => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
};
const network = new SafeNetwork();
// documentedProviders already includes the extra ones (Hacker News, arXiv); keep one of each name.
const providers: DocumentedProvider[] = [...documentedProviders(network), ...extraDocumentedProviders(network), ...publicWebProviders(network)]
  .filter((provider, index, all) => all.findIndex(other => other.name === provider.name) === index);

const robotsCache = new Map<string, string | null>();
async function robotsVerdict(url: string): Promise<{ allowed: boolean; detail: string }> {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    // Same reading rules as packages/browser/src/search/robots.ts: a 4xx other than 429 means no rules.
    let text: string | null = null, target = `${origin}/robots.txt`;
    try {
      for (let redirect = 0; redirect <= 5; redirect++) {
        const response = await network.request(target, { signal: AbortSignal.timeout(10_000), maxBytes: 512_000 });
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) { target = network.validate(new URL(String(response.headers.location), target).href).href; continue; }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) { text = ''; break; }
        if (response.status === 200) text = new TextDecoder('utf-8').decode(response.body);
        break;
      }
    } catch { text = null; }
    robotsCache.set(origin, text);
  }
  const text = robotsCache.get(origin);
  if (text === null || text === undefined) return { allowed: false, detail: 'robots.txt unavailable' };
  const star = robotsAllows(text, url, '*'), named = robotsAllows(text, url, 'MohassanAI-Research');
  return { allowed: star && named, detail: `robots.txt: * ${star ? 'allows' : 'disallows'}, MohassanAI-Research ${named ? 'allows' : 'disallows'}` };
}

const rows: Record<string, unknown>[] = [];
for (const text of QUERIES) {
  const query = compileQuery(text);
  for (const provider of providers) {
    const row: Record<string, unknown> = { query: text, intent: query.intent, provider: provider.name, accessBasis: provider.accessBasis };
    if (!provider.supports(query)) { rows.push({ ...row, applicable: false }); continue; }
    row.applicable = true;
    const page = SEARCH_PAGES[provider.name];
    if (page) {
      const verdict = await robotsVerdict(page(text));
      row.robots = verdict.detail;
      if (!verdict.allowed) { rows.push({ ...row, sent: false }); continue; }
    }
    const started = performance.now();
    try {
      const hits = await provider.search(query, 5, AbortSignal.timeout(12_000));
      rows.push({ ...row, sent: true, ms: Math.round(performance.now() - started), hits: hits.length, first: hits[0] ? { title: hits[0].title.slice(0, 120), url: hits[0].url } : null });
    } catch (error) {
      rows.push({ ...row, sent: true, ms: Math.round(performance.now() - started), hits: 0, error: error instanceof Error ? `${(error as { code?: string; kind?: string }).code ?? (error as { kind?: string }).kind ?? error.name}: ${error.message.slice(0, 160)}` : String(error) });
    }
    const last = rows.at(-1)!;
    console.log(`${String(last.provider).padEnd(16)} ${String(last.ms ?? '-').padStart(6)}ms hits=${last.hits ?? '-'} ${last.error ?? ''}  ${text}`);
    await delay(1200);
  }
}
const summary = Object.fromEntries(providers.map(provider => {
  const mine = rows.filter(row => row.provider === provider.name);
  const sent = mine.filter(row => row.sent);
  return [provider.name, { applicable: mine.filter(row => row.applicable).length, sent: sent.length, withHits: sent.filter(row => Number(row.hits) > 0).length,
    errors: sent.filter(row => row.error).length, ms: stats(sent.map(row => Number(row.ms))), robots: mine.find(row => row.robots)?.robots ?? null }];
}));
await writeFile(path.join(out, 'search-providers.json'), JSON.stringify({ at: new Date().toISOString(), queries: QUERIES, summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 1));
