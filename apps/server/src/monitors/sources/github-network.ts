import { publicSearchScan, publicSearchText, safeResumeUrl, type SafeNetwork, type SafeResponse } from '@mohassan/browser';
import type { z } from 'zod';
import type { MonitorReadOptions } from '../sources.js';

export const GITHUB_API_HOST = 'api.github.com';
const origin = `https://${GITHUB_API_HOST}`;
export const GITHUB_WINDOW_MS = 60 * 60_000;
// GitHub's unauthenticated REST limit is 60 requests per hour per originating IP.
// See docs/MONITORS.md for the source and retrieval checksum.
export const GITHUB_PRIMARY_LIMIT = 60;
export const GITHUB_BATCH_REQUEST_LIMIT = 5;
export const GITHUB_BATCH_TIMEOUT_MS = 25_000;
// Even if the last request leaves at the end of one batch and the first
// leaves immediately in the next, a rolling hour fits at most 12 batches.
export const GITHUB_BATCH_INTERVAL_MS = GITHUB_BATCH_REQUEST_LIMIT * GITHUB_WINDOW_MS / GITHUB_PRIMARY_LIMIT + GITHUB_BATCH_TIMEOUT_MS;
const headers = {
  'accept': 'application/vnd.github+json',
  'user-agent': 'MohassanAI-Monitors/1.0',
  'x-github-api-version': '2022-11-28',
};
const redirect = new Set([301, 302, 303, 307, 308]);
const publicPath = /^\/(?:repos\/[a-z0-9-]+\/[a-z0-9_.-]+|repositories\/\d+)\/(pulls\/\d+|branches\/[^/]+|commits\/[a-f0-9]{40}\/(?:status|check-runs)|releases(?:\/latest)?|tags)$/iu;
const validator = /^(?:W\/)?"[a-z0-9:._-]{1,128}"$/iu;

export type GithubResponseCache = { url: string; etag: string; body: unknown };
export type GithubMonitorCache = { responses: GithubResponseCache[] };

export class GithubReadFailure extends Error {
  constructor(readonly outcome: 'missing' | 'unreachable' | number) {
    super('GitHub monitor read did not yield a value.');
  }
}

export function githubPublicIdentifier(value: string): boolean {
  const scanned = publicSearchScan(value);
  return publicSearchText(scanned) === scanned;
}

function publicEndpoint(network: SafeNetwork, raw: URL, operation: string | undefined, search: string): string {
  const url = network.validate(raw.href, [origin]);
  if (raw.hash || url.search !== search || !operation || publicPath.exec(url.pathname)?.[1] !== operation
      || !safeResumeUrl(url.href) || !githubPublicIdentifier(url.pathname)) throw new GithubReadFailure('unreachable');
  return url.href;
}

function unsignedHeader(value: string | undefined) {
  if (!value || !/^\d+$/u.test(value.trim())) return;
  const millis = Number(value) * 1000;
  return Number.isSafeInteger(millis) && millis < 8.64e15 ? millis : undefined;
}

async function limitResponse(response: SafeResponse, now: number, extendHost: NonNullable<MonitorReadOptions['extendHost']>) {
  const { status, headers: limits } = response;
  const limited = status === 403 || status === 429;
  const exhausted = limits['x-ratelimit-remaining']?.trim() === '0';
  if (!limited && !exhausted) return;
  const retry = unsignedHeader(limits['retry-after']);
  const reset = exhausted ? unsignedHeader(limits['x-ratelimit-reset']) : undefined;
  const delay = Math.max(60_000, retry ?? 0, reset === undefined ? 0 : reset - now);
  await extendHost(GITHUB_API_HOST, delay);
  return now + delay;
}

/** One serial batch uses one atomic host reservation shared by all accounts and workers. */
export async function openGithubBatch(network: SafeNetwork, options: MonitorReadOptions, clock: () => number) {
  if (!options.reserveHost || !options.extendHost) throw new GithubReadFailure('unreachable');
  const deadline = AbortSignal.timeout(GITHUB_BATCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const start = clock();
  const deferred = await options.reserveHost(GITHUB_API_HOST, GITHUB_BATCH_INTERVAL_MS);
  if (deferred !== null) throw new GithubReadFailure(deferred);
  const responses: GithubResponseCache[] = [];
  let requests = 0;
  let revalidations = 0;
  let resolved = 0;
  let resumeAt: number | undefined;

  async function json<Shape extends z.ZodType>(path: string, shape: Shape): Promise<z.output<Shape>> {
    let target = new URL(path, origin);
    const search = target.search;
    const operation = publicPath.exec(target.pathname)?.[1];
    while (requests < GITHUB_BATCH_REQUEST_LIMIT) {
      if (resumeAt !== undefined) throw new GithubReadFailure(resumeAt);
      signal.throwIfAborted();
      const url = publicEndpoint(network, target, operation, search);
      const prior = options.cache?.github?.responses.find(entry => entry.url === url && validator.test(entry.etag) && githubPublicIdentifier(entry.etag));
      requests++;
      // This SafeNetwork mode preserves the API-version request header and rate-limit response headers.
      // The fixed headers, method and origin remain under the monitor's control.
      const response = await network.request(url, { allowedOrigins: [origin], method: 'GET', browser: true, signal, maxBytes: 2_000_000,
        headers: { ...headers, ...(prior && { 'if-none-match': prior.etag }) } });
      const hold = await limitResponse(response, clock(), options.extendHost!);
      if (hold !== undefined) resumeAt = Math.max(hold, start + GITHUB_BATCH_INTERVAL_MS);
      if (response.status === 403 || response.status === 429) throw new GithubReadFailure(resumeAt!);
      if (redirect.has(response.status) && response.headers.location) {
        target = new URL(response.headers.location, url);
        continue;
      }
      resolved++;
      if (response.status === 404 || response.status === 410) throw new GithubReadFailure('missing');
      const revalidated = response.status === 304 && prior !== undefined;
      if (!revalidated && response.status !== 200) throw new GithubReadFailure('unreachable');
      revalidations += Number(revalidated);
      const body = shape.parse(revalidated ? prior.body : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)));
      const etag = response.headers.etag ?? (revalidated ? prior.etag : undefined);
      if (etag && validator.test(etag) && githubPublicIdentifier(etag)) responses.push({ url, etag, body });
      return body;
    }
    throw new GithubReadFailure('unreachable');
  }

  return { json, responses, get unchanged() { return resolved > 0 && resolved === revalidations; } };
}
