import { gunzipSync } from 'node:zlib';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { SearchProviderFailure, searchRetryAfter } from '../providers.js';
import { RobotsPolicy } from '../robots.js';
import type { HealthRequester } from './health-utils.js';

type Retry = { until: number; kind: 'rate_limited' | 'unavailable' };
interface HostGate {
  waiting: number;
  tail: Promise<void>;
  next: number;
  retry?: Retry;
}

const hostGates = new WeakMap<() => number, Map<string, HostGate>>();
const defaultMaxBytes = 512_000;

// NLM allows 85 requests/minute/IP. One request per second leaves headroom
// for the robots check. https://medlineplus.gov/about/developers/webservices/ (2026-11-27)
const medlinePlusIntervalMs = 1000;
const medlinePlusHost = 'wsearch.nlm.nih.gov';

export function createHealthRequester(network: SafeNetwork, now: () => number): HealthRequester {
  const gates = hostGates.get(now) ?? new Map<string, HostGate>();
  hostGates.set(now, gates);
  const policyNetwork = new class extends SafeNetwork {
    override validate(...args: Parameters<SafeNetwork['validate']>) {
      return network.validate(...args);
    }

    override async request(input: string, options?: Parameters<SafeNetwork['request']>[1]) {
      const response = await network.request(input, options);
      const gate = gates.get(new URL(input).origin);
      if (gate) recordBackoff(response, gate);
      return response;
    }
  }();
  const robots = new RobotsPolicy(policyNetwork, now);

  function recordBackoff(response: SafeResponse, gate: HostGate): Retry | undefined {
    const retryAfter = response.headers['retry-after'];
    if (response.status !== 429 && !(response.status === 503 && retryAfter !== undefined)) return;
    const retry = {
      kind: response.status === 429 ? 'rate_limited' : 'unavailable',
      until: now() + searchRetryAfter(retryAfter, now()),
    } satisfies Retry;
    gate.retry = retry;
    return retry;
  }

  function retryFailure(retry: Retry): SearchProviderFailure {
    return new SearchProviderFailure(retry.kind, Math.max(0, retry.until - now()));
  }

  return async (url, signal, options = {}) => {
    signal.throwIfAborted();
    const gate = gates.get(url.origin) ?? { waiting: 0, next: 0, tail: Promise.resolve() };
    gates.set(url.origin, gate);
    if (gate.waiting >= 8) throw new SearchProviderFailure('rate_limited', 1000);
    gate.waiting++;
    const request = gate.tail.then(async () => {
      signal.throwIfAborted();
      if (gate.retry && gate.retry.until > now()) throw retryFailure(gate.retry);
      if (gate.next > now()) throw new SearchProviderFailure('rate_limited', gate.next - now());
      const previousRetry = gate.retry;
      try {
        await robots.assertAllowed(url.href, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (gate.retry && gate.retry !== previousRetry) throw retryFailure(gate.retry);
        throw error;
      }
      if (url.hostname === medlinePlusHost) gate.next = now() + medlinePlusIntervalMs;
      const maxBytes = options.maxBytes ?? defaultMaxBytes;
      let response: SafeResponse;
      try {
        response = await network.request(url.href, {
          allowedOrigins: [url.origin], signal, maxBytes, allowAttachment: options.allowAttachment,
          headers: options.accept ? { accept: options.accept } : undefined,
        });
      } catch {
        signal.throwIfAborted();
        throw new SearchProviderFailure('unavailable');
      }
      signal.throwIfAborted();
      const retry = recordBackoff(response, gate);
      if (retry) throw retryFailure(retry);
      if (response.status !== 200) throw new SearchProviderFailure('unavailable');
      if (response.body.length > maxBytes) throw new SearchProviderFailure('invalid_response');
      try {
        const body = options.gzip && response.body[0] === 0x1f && response.body[1] === 0x8b
          ? gunzipSync(response.body, { maxOutputLength: maxBytes })
          : response.body;
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        throw new SearchProviderFailure('invalid_response');
      }
    }).finally(() => { gate.waiting--; });
    gate.tail = request.then(() => {}, () => {});
    return request;
  };
}
