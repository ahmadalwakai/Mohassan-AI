import type { SafeNetwork } from '../network.js';
import { BingRssSearch, DuckDuckGoSearch } from '../research.js';
import type { DocumentedProvider, SearchQuery } from './providers.js';

/** Keep the caller's site scope in retrieval as well as in the final result filter. */
function webQuestion(query: SearchQuery): string {
  const sites=query.sites.map(site => `site:${site}`);
  return [query.retrievalQuestion, ...(sites.length>1?[`(${sites.join(' OR ')})`]:sites)].join(' ');
}

/** Search the public web for every subject; the specialized APIs only supplement it. */
export function publicWebProviders(network: SafeNetwork): DocumentedProvider[] {
  return [new BingRssSearch(network), new DuckDuckGoSearch(network)].map(engine => ({
    name: engine.name,
    coverage: 'web',
    accessBasis: 'public_search',
    supports: () => true,
    search: (query, limit, signal) => engine.search(webQuestion(query), limit, signal),
  }));
}
