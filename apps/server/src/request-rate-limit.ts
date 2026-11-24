import { isIP, SocketAddress } from 'node:net';

type RateLimitRequest = { ip: string; headers: Record<string, unknown> };

/** The trusted web proxy sets this from Vercel's edge, never a forwarded chain. */
export function verifiedClientIp(headers: Record<string, unknown>, trusted: boolean): string | null {
  const address = trusted ? headers['x-vercel-forwarded-for'] : undefined;
  if (typeof address !== 'string' || address.includes('%')) return null;
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) return new SocketAddress({ address, family: 'ipv6' }).address;
  return null;
}

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
    return `ip:${verifiedClientIp(request.headers, trusted) ?? request.ip}`;
  };
}
