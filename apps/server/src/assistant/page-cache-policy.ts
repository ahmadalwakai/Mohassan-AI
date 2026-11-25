import { safeResumeUrl } from '@mohassan/browser';

export function pageCacheKey(url: string): string | null {
  if (url.length > 2500) return null;
  const parsed = URL.parse(url);
  if (!parsed) return null;
  parsed.hash = '';
  return safeResumeUrl(parsed.href);
}

/** An origin can opt its response out of shared storage, including a response that establishes a session. */
export function mayShareCachedPage(headers: Readonly<Record<string, string>> = {}): boolean {
  return !headers['set-cookie']
    && !headers.vary?.split(',').some(field => field.trim() === '*')
    && !headers['cache-control']?.split(',').some(value => /^(?:(?:private|no-store|no-cache)(?:\s*=|$)|(?:s-maxage|max-age)\s*=\s*"?0"?$)/i.test(value.trim()));
}
