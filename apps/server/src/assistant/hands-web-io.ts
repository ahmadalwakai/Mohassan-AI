import { createHash } from 'node:crypto';
import { BrowserError, type AgentPage, type SearchEngine, type SearchHit, type SearchProvider } from '@mohassan/browser';
import type { BrainState } from './brain.js';
import type { HandsIO, HandsPublicIO, HandsRead } from './hands.js';
import { mergePublicQueryTerms } from './public-query-provenance.js';
import type { WritingPageReader } from './writing/host.js';

interface HandsWebPorts {
  ownerId: string;
  signal: AbortSignal;
  state: BrainState;
  active(): Promise<void>;
  step(label: string): Promise<void>;
  assertPublicSearch(query: string): void;
  search: SearchProvider;
  readPage?: WritingPageReader;
  observePage(page: AgentPage): void;
  live: boolean;
}

export function createHandsWebIO(ports: HandsWebPorts): Pick<HandsIO, 'publicWork' | 'read' | 'search'> {
  const { state, signal, readPage } = ports;
  const trail = (action: string, result: string, changed: boolean) => {
    state.trail.push({ step: ++state.steps, action: action.slice(0, 300), result: result.slice(0, 1100), changed });
  };

  async function publicWork<T>(work: (io: HandsPublicIO) => Promise<T>, label?: string): Promise<T> {
    if (label) await ports.step(label);
    else await ports.active();
    // The reads in a group already run concurrently. Check authority again after I/O,
    // then apply observations in completion order. No database locks span network I/O.
    const observations: (() => void)[] = [];
    const read = readPage ? async (url: string): Promise<HandsRead> => {
      signal.throwIfAborted();
      const result = await readPage(url, signal, { live: ports.live });
      const action = `read ${url}`;
      if (result === 'disallowed') {
        observations.push(() => trail(action, 'robots.txt disallows this page', false));
        return { kind: 'disallowed' };
      }
      if (!result || !result.text.trim()) {
        observations.push(() => trail(action, 'no readable text over HTTP', false));
        return { kind: 'unreadable' };
      }
      const page: AgentPage = {
        id: result.url, url: result.url, title: result.title, text: result.text, elements: [],
        signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 },
        hash: createHash('sha256').update(result.text).digest('hex'), observedAt: result.fetchedAt ?? new Date().toISOString(), documentStatus: result.status,
      };
      observations.push(() => {
        trail(action, `HTTP ${result.status} ${result.url} · ${result.text.length} chars`, true);
        ports.observePage(page);
      });
      return { kind: 'page', page };
    } : undefined;
    const search = async (query: string, limit: number): Promise<SearchHit[]> => {
      signal.throwIfAborted();
      ports.assertPublicSearch(query);
      const engine = ports.search as Partial<Pick<SearchEngine, 'execute'>>;
      let hits: SearchHit[];
      if (typeof engine.execute === 'function') {
        const outcome = await engine.execute.call(ports.search, query, limit, signal, { ownerId: ports.ownerId });
        if (!outcome.hits.length) {
          observations.push(() => trail(`search ${query}`, `no results; provider failures: ${outcome.failures.map(item => `${item.provider} ${item.kind}`).join(', ') || 'none'}`, false));
          if (outcome.failures.length) throw new BrowserError('RESEARCH_PROVIDERS_FAILED', outcome.failures.map(item => `${item.provider}: ${item.kind === 'rate_limited' ? 'rate limited' : item.kind === 'invalid_response' ? 'invalid response' : 'unavailable'}`).join(', '), 502);
          throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE', 'لم يُرجع البحث مصادر مرتبطة بالسؤال قابلة للقراءة.', 502);
        }
        hits = outcome.hits.map(hit => hit.coverage === 'local_only' ? { ...hit, snippet: `نسخة مفهرسة بتاريخ ${hit.fetchedAt}. ${hit.snippet}` } : hit);
      } else hits = await ports.search.search(query, limit, signal, { ownerId: ports.ownerId });
      observations.push(() => {
        state.publicQueryTerms = mergePublicQueryTerms(state.publicQueryTerms, hits.flatMap(hit => [hit.title, hit.snippet]));
        trail(`search ${query}`, `results: ${hits.map(hit => `${hit.title} | ${hit.url}`).join('\n')}`, hits.length > 0);
      });
      return hits;
    };
    try {
      return await work({ read, search });
    } finally {
      // If the search failed outright, a parallel read may still be in flight.
      // Its late observation does not belong to this finished batch.
      const completed = observations.slice();
      await ports.active();
      signal.throwIfAborted();
      for (const observe of completed) observe();
    }
  }

  return {
    publicWork,
    ...(readPage ? { read: (url: string) => publicWork(io => io.read!(url)) } : {}),
    search: (query, limit) => publicWork(io => io.search!(query, limit)),
  };
}
