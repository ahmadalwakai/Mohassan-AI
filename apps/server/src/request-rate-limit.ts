import { verifiedProxyClientIp } from './proxy-client-ip.js';

type RateLimitRequest = { ip: string; headers: Record<string, unknown> };

/** Use verified accounts behind the service proxy; unauthenticated traffic keeps its IP bound. */
export function createRequestRateLimitKey(options: {
  trusted: (request: RateLimitRequest) => boolean;
  userId: (request: RateLimitRequest) => Promise<string | null>;
}) {
  return async (request: RateLimitRequest): Promise<string> => {
    // A cookie/header supplied by a caller is not an identity. Check the service
    // boundary before resolving the session, then use the authenticated account
    // so extra sessions cannot multiply its allowance.
    const trusted = options.trusted(request);
    if (trusted && typeof request.headers.cookie === 'string') {
      const userId = await options.userId(request);
      if (userId) return `account:${userId}`;
    }
    return `ip:${verifiedProxyClientIp(request.headers, trusted) ?? request.ip}`;
  };
}
