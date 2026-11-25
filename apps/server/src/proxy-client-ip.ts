import { isIP, SocketAddress } from 'node:net';

/** This header is set by the authenticated service relay using its hosting ingress. */
export function verifiedProxyClientIp(headers: Record<string, unknown>, trusted: boolean): string | undefined {
  const value = trusted ? headers['x-mohassan-client-ip'] : undefined;
  if (typeof value !== 'string' || value.includes('%')) return undefined;
  const version = isIP(value);
  if (version === 4) return value;
  return version === 6 ? new SocketAddress({ address: value, family: 'ipv6' }).address : undefined;
}
