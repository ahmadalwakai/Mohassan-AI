import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { AccountSession } from '@mohassan/contracts';
import { verifiedProxyClientIp } from './proxy-client-ip.js';

// Device and product tokens follow the vendor UA examples (retrieved 2026-11-25).
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/User-Agent
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/User-Agent/Firefox
// https://developer.chrome.com/docs/privacy-security/user-agent-client-hints
// https://chromium.googlesource.com/chromium/src/+/main/docs/ios/user_agent.md
// https://learn.microsoft.com/en-us/microsoft-edge/web-platform/user-agent-guidance
const DEVICE_LABELS = [
  [/\biPad\b/i, 'iPad'],
  [/\biPhone\b/i, 'iPhone'],
  [/\bAndroid\b/i, 'Android'],
  [/\bWindows NT\b/i, 'Windows'],
  [/\bMacintosh\b/i, 'Mac'],
  [/\bLinux\b/i, 'Linux'],
] as const;
const BROWSER_LABELS = [
  [/\bEdg(?:A|iOS)?\//i, 'Edge'],
  [/\b(?:Firefox|FxiOS)\//i, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
] as const;

function deviceLabel(userAgent: string | null): string {
  const agent = userAgent ?? '';
  const device = DEVICE_LABELS.find(([pattern]) => pattern.test(agent))?.[1];
  const browser = BROWSER_LABELS.find(([pattern]) => pattern.test(agent))?.[1];
  return [device, browser].filter(Boolean).join(' · ') || 'جهاز غير معروف';
}

/** The caller has already checked the internal proxy secret. */
export function memberAuthClientIp(request: Pick<FastifyRequest, 'headers' | 'ip'>, production: boolean): string | undefined {
  const forwarded = verifiedProxyClientIp(request.headers, true);
  if (forwarded) return forwarded;
  return !production && isIP(request.ip) ? request.ip : undefined;
}

/** Internal setup and invite acceptance discard the sign-up cookie instead of delivering it. */
export async function discardUnusedSignupSession(db: Kysely<any>, userId: string, token: string | null) {
  if (token) await db.deleteFrom('session').where('userId', '=', userId).where('token', '=', token).execute();
}

// Keep the leading 24 IPv4 or 64 IPv6 bits and zero the rest. Prefix notation and
// IPv4-mapped IPv6 addresses follow these RFCs (retrieved 2026-11-25).
// https://www.rfc-editor.org/rfc/rfc4632.html#section-3.1
// https://www.rfc-editor.org/rfc/rfc4291.html#section-2.3
// https://www.rfc-editor.org/rfc/rfc4291.html#section-2.5.5.2
export function sessionIpPrefix(address: string | null): string | null {
  const ip = address?.split('%')[0] ?? '';
  const family = isIP(ip);
  if (family === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (family !== 6) return null;

  // The URL host parser normalizes case and embedded IPv4 before expansion.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.slice(0, 5).every(group => group === '0') && groups[5] === 'ffff') {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.0/24`;
  }
  const prefix = new URL(`http://[${groups.slice(0, 4).join(':')}::]/`).hostname.slice(1, -1);
  return `${prefix}/64`;
}

export async function listAccountSessions(db: Kysely<any>, userId: string, currentSessionId: string): Promise<AccountSession[]> {
  // Better Auth refreshes persisted updatedAt as an active session is renewed.
  const rows = await db.selectFrom('session').select(['id', 'ipAddress', 'userAgent', 'updatedAt'])
    .where('userId', '=', userId).where('expiresAt', '>', sql`now()`)
    .orderBy('updatedAt', 'desc').orderBy('id').execute();
  return rows.map(row => ({
    id: row.id,
    deviceLabel: deviceLabel(row.userAgent),
    ipPrefix: sessionIpPrefix(row.ipAddress),
    lastSeen: new Date(row.updatedAt).toISOString(),
    current: row.id === currentSessionId,
  }));
}

export async function endOtherAccountSessions(db: Kysely<any>, userId: string, currentSessionId: string): Promise<{ ended: number }> {
  return db.transaction().execute(async tx => {
    // Serialize requests from two devices so the first successful request keeps its session.
    await tx.selectFrom('user').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
    const current = await tx.selectFrom('session').select('id').where('userId', '=', userId)
      .where('id', '=', currentSessionId).where('expiresAt', '>', sql`clock_timestamp()`).executeTakeFirst();
    if (!current) throw Object.assign(new Error('سجّل الدخول للمتابعة.'), { statusCode: 401, code: 'UNAUTHORIZED' });
    const result = await tx.deleteFrom('session').where('userId', '=', userId).where('id', '<>', currentSessionId)
      .where('expiresAt', '>', sql`clock_timestamp()`).executeTakeFirstOrThrow();
    return { ended: Number(result.numDeletedRows) };
  });
}

export async function endMemberSessions(db: Kysely<any>, userId: string): Promise<{ ended: number }> {
  return db.transaction().execute(async tx => {
    await tx.selectFrom('user').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
    const member = await tx.selectFrom('workspace_members').select('user_id')
      .where('user_id', '=', userId).where('role', '=', 'member')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner').select('id').where('owner_id', '=', userId))))
      .forUpdate().executeTakeFirst();
    if (!member) throw Object.assign(new Error('العضو غير موجود.'), { statusCode: 404, code: 'MEMBER_NOT_FOUND' });
    const result = await tx.deleteFrom('session').where('userId', '=', userId)
      .where('expiresAt', '>', sql`clock_timestamp()`).executeTakeFirstOrThrow();
    return { ended: Number(result.numDeletedRows) };
  });
}
