import type { SearchEngine, SearchProvider } from '@mohassan/browser';
import { parseHands, webQuestion } from '../hands.js';

interface Lookup<T> {
  query: string;
  ordinaryQuery: string | undefined;
  limit: number;
  result: Promise<T>;
}

function reusable<T>(lookup: Lookup<T> | undefined, query: string, limit: number): Promise<T> | undefined {
  return lookup?.limit === limit && (lookup.query === query || lookup.ordinaryQuery === query) ? lookup.result : undefined;
}

export function ordinaryClarificationQuery(text: string, history: readonly { role: string; text: string }[]): string | undefined {
  const userTurns = history.filter(turn => turn.role === 'user').map(turn => turn.text).slice(-4);
  const plan = parseHands(text) ?? webQuestion(text, userTurns);
  const step = plan?.length === 1 ? plan[0] : undefined;
  return step?.kind === 'search' && !step.site && !step.here ? step.query : undefined;
}

/** Reuse the same guarded subject lookup in hands and keep provider failure details intact. */
export function createClarificationSearch(provider: SearchProvider, ownerId: string, signal: AbortSignal) {
  const engine = provider as Partial<Pick<SearchEngine, 'execute'>>;
  const execute = typeof engine.execute === 'function' ? engine.execute.bind(provider) : undefined;
  type Outcome = Awaited<ReturnType<SearchEngine['execute']>>;
  type Hits = Awaited<ReturnType<SearchProvider['search']>>;
  let prefetchedOutcome: Lookup<Outcome> | undefined;
  let prefetchedHits: Lookup<Hits> | undefined;
  return {
    async probe(query: string, limit: number, ordinaryQuery: string | undefined): Promise<Hits> {
      // The consumer's evidence deadline may arrive before the shared transport
      // returns. Hands can still await the same lookup under the run signal.
      if (execute) {
        prefetchedOutcome = { query, limit, ordinaryQuery, result: execute(query, limit, signal, { ownerId }) };
        return (await prefetchedOutcome.result).hits;
      }
      prefetchedHits = { query, limit, ordinaryQuery, result: provider.search(query, limit, signal, { ownerId }) };
      return prefetchedHits.result;
    },
    execute: execute && ((query: string, limit: number) => reusable(prefetchedOutcome, query, limit) ?? execute(query, limit, signal, { ownerId })),
    search: (query: string, limit: number) => reusable(prefetchedHits, query, limit) ?? provider.search(query, limit, signal, { ownerId }),
  };
}
