import { SafeNetwork } from '../../../../packages/browser/src/network.js';

const SOURCE_PATHS = new Map([
  ['https://geocoding-api.open-meteo.com', '/v1/search'],
  ['https://api.open-meteo.com', '/v1/forecast'],
  ['https://www.ecb.europa.eu', '/stats/eurofxref/eurofxref-daily.xml'],
]);

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_CACHE_ENTRIES = 512;
const network = new SafeNetwork();

export class LiveDataTimeout extends Error {
  constructor() {
    super('The live data request timed out.');
    this.name = 'LiveDataTimeout';
  }
}

type SourceFetch = (url: URL | string, init?: RequestInit) => Promise<Response>;

export interface RequestScope {
  signal: AbortSignal;
  fetch: SourceFetch;
  withCache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
}

async function fetchPublicData(input: URL | string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (SOURCE_PATHS.get(url.origin) !== url.pathname || url.username || url.password || url.hash) {
    throw new Error('Unrecognized live data endpoint.');
  }
  const accept = new Headers(init?.headers).get('accept') ?? 'application/json, application/xml';
  const response = await network.request(url.href, {
    allowedOrigins: [url.origin], signal: init?.signal ?? undefined, maxBytes: 256_000,
    allowAttachment: url.origin === 'https://www.ecb.europa.eu',
    headers: { accept },
  });
  return new Response(response.status === 204 || response.status === 304 ? null : Uint8Array.from(response.body), {
    status: response.status, headers: response.headers,
  });
}

export function createLiveRequestClient({ fetch = fetchPublicData, clock = Date.now }: {
  fetch?: SourceFetch;
  clock?: () => number;
} = {}) {
  const cache = new Map<string, { expiresAt: number; value: unknown }>();

  return {
    async run<T>(operation: (scope: RequestScope) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
      parentSignal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new LiveDataTimeout()), REQUEST_TIMEOUT_MS);
      const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
      const onAbort = () => rejectAborted(signal.reason);
      let rejectAborted!: (reason: unknown) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await Promise.race([aborted, operation({
          signal,
          fetch: (url, init) => {
            signal.throwIfAborted();
            return fetch(url, { ...init, signal });
          },
          async withCache<V>(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
            signal.throwIfAborted();
            const entry = cache.get(key);
            if (entry && entry.expiresAt > clock()) return entry.value as V;
            cache.delete(key);
            const value = await load();
            signal.throwIfAborted();
            if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value!);
            cache.set(key, { value, expiresAt: clock() + ttlMs });
            return value;
          },
        })]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

export const liveRequestClient = createLiveRequestClient();
