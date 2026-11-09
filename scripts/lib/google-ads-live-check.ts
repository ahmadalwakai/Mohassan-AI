import pg from 'pg';
import { GOOGLE_ADS_API_VERSION, GoogleAdsError, parseTokenKey, unseal, type CallContext } from '@mohassan/google-ads';
import { GoogleAdsBookingMapSchema } from '@mohassan/contracts';

export class AdsReadOnlyCheckError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** No embedded fallback; URL options cannot override the read-only session defaults. */
export function adsReadOnlyPoolOptions(connectionString: string): pg.PoolConfig {
  let target: URL;
  try { target = new URL(connectionString); } catch { throw new AdsReadOnlyCheckError('DATABASE_CONFIG_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) throw new AdsReadOnlyCheckError('DATABASE_CONFIG_INVALID');
  if (target.searchParams.get('sslmode') === 'require') target.searchParams.set('sslmode', 'verify-full');
  target.searchParams.delete('options');
  return { connectionString: target.toString(), enableChannelBinding: target.searchParams.get('channel_binding') === 'require', max: 1, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000, options: '-c default_transaction_read_only=on -c statement_timeout=15000' };
}

export interface AdsInspectionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}
export interface AdsInspectionPool { connect(): Promise<AdsInspectionClient>; }
export interface StoredAdsConnection {
  owner_id: string; customer_id: string; login_customer_id: string | null; status: string;
  sealed_refresh_token: string; currency: string | null; time_zone: string | null;
  test_account: boolean; booking_rules: unknown; rate_limited_until: Date | string | null;
}

/** The returned private row stays in memory. All SQL is in a read-only transaction. */
export async function readStoredAdsConnection(pool: AdsInspectionPool, ownerId?: string): Promise<
  { ok: true; row: StoredAdsConnection } | { ok: false; reason: string }
> {
  if (ownerId !== undefined && (!ownerId.trim() || ownerId.length > 200 || ownerId.startsWith('--') || /[\u0000-\u001f\u007f]/u.test(ownerId))) return { ok: false, reason: 'OWNER_ARGUMENT_INVALID' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    const schema = await client.query("SELECT to_regclass('public.google_ads_connections')::text AS table_name");
    if (!schema.rows[0]?.table_name) { await client.query('COMMIT'); return { ok: false, reason: 'ADS_SCHEMA_NOT_DEPLOYED' }; }
    const rows = (await client.query(`SELECT owner_id, customer_id, login_customer_id, status, sealed_refresh_token, currency, time_zone, test_account, booking_rules, rate_limited_until FROM public.google_ads_connections${ownerId === undefined ? '' : ' WHERE owner_id = $1'} ORDER BY owner_id LIMIT 2`, ownerId === undefined ? [] : [ownerId])).rows as StoredAdsConnection[];
    await client.query('COMMIT');
    if (rows.length > 1) return { ok: false, reason: 'OWNER_SELECTION_REQUIRED' };
    const row = rows[0];
    if (!row || row.status !== 'connected' || !row.customer_id || !row.sealed_refresh_token) return { ok: false, reason: 'NO_CONNECTED_ACCOUNT' };
    return { ok: true, row };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new AdsReadOnlyCheckError('DATABASE_READ_FAILED');
  } finally { client.release(); }
}

export function adsInspectionContext(row: StoredAdsConnection, tokenKey: string, now = Date.now()) {
  if (!/^\d{10}$/.test(row.customer_id) || row.login_customer_id !== null && !/^\d{10}$/.test(row.login_customer_id)) throw new AdsReadOnlyCheckError('STORED_CONNECTION_INVALID');
  if (row.rate_limited_until !== null) {
    const until = new Date(row.rate_limited_until).getTime();
    if (!Number.isFinite(until)) throw new AdsReadOnlyCheckError('STORED_CONNECTION_INVALID');
    if (until > now) throw new AdsReadOnlyCheckError('STORED_ACCOUNT_RATE_LIMITED');
  }
  let rules: unknown = row.booking_rules;
  if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { throw new AdsReadOnlyCheckError('STORED_CONNECTION_INVALID'); } }
  const parsed = GoogleAdsBookingMapSchema.safeParse({ rules });
  if (!parsed.success) throw new AdsReadOnlyCheckError('STORED_CONNECTION_INVALID');
  const context: CallContext & { customerId: string } = { refreshToken: unseal(row.sealed_refresh_token, parseTokenKey(tokenKey), `google-ads:refresh:${row.owner_id}`), customerId: row.customer_id, loginCustomerId: row.login_customer_id };
  return { context, bookingRules: parsed.data.rules };
}

/** Allow only refresh-token exchange and three read endpoints for the selected account. */
export function createAdsReadOnlyFetch(settings: { clientId: string; clientSecret: string; context: CallContext & { customerId: string } }, transport: typeof fetch = fetch): typeof fetch {
  const denied = () => { throw new AdsReadOnlyCheckError('READ_ONLY_TRANSPORT_DENIED'); };
  return async (input, init = {}) => {
    if (!(typeof input === 'string' || input instanceof URL)) return denied();
    let url: URL; try { url = new URL(input); } catch { return denied(); }
    if (url.username || url.password || url.search || url.hash) return denied();
    const method = (init.method ?? 'GET').toUpperCase(), headers = new Headers(init.headers);
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      if (method !== 'POST' || !(init.body instanceof URLSearchParams) || headers.get('content-type') !== 'application/x-www-form-urlencoded') return denied();
      const expected = { client_id: settings.clientId, client_secret: settings.clientSecret, refresh_token: settings.context.refreshToken, grant_type: 'refresh_token' };
      const body = init.body;
      if ([...body].length !== 4 || Object.entries(expected).some(([key, value]) => body.getAll(key).length !== 1 || body.get(key) !== value) || [...headers.keys()].some(key => key !== 'content-type')) return denied();
    } else {
      if (url.origin !== 'https://googleads.googleapis.com' || !/^Bearer [^\s]+$/.test(headers.get('authorization') ?? '') || headers.get('content-type') !== 'application/json') return denied();
      if ([...headers.keys()].some(key => !['authorization', 'content-type', 'login-customer-id'].includes(key)) || headers.get('login-customer-id') !== (settings.context.loginCustomerId ?? null)) return denied();
      const prefix = `/${GOOGLE_ADS_API_VERSION}/`, account = `${prefix}customers/${settings.context.customerId}/googleAds:`;
      if (url.pathname === `${prefix}customers:listAccessibleCustomers`) {
        if (method !== 'GET' || init.body != null) return denied();
      } else {
        if (method !== 'POST' || ![`${account}search`, `${account}searchStream`].includes(url.pathname) || typeof init.body !== 'string' || init.body.length > 100_000) return denied();
        let body: any; try { body = JSON.parse(init.body); } catch { return denied(); }
        if (!body || typeof body.query !== 'string' || !/^\s*SELECT\s/i.test(body.query) || Object.keys(body).some(key => key !== 'query')) return denied();
      }
    }
    // Native fetch rejects redirects before forwarding either OAuth or account credentials.
    const response = await transport(input, { ...init, method, redirect: 'error', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) return denied();
    return response;
  };
}

export function adsCheckFailureCode(error: unknown): string {
  return (error instanceof AdsReadOnlyCheckError || error instanceof GoogleAdsError) && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'READ_ONLY_CHECK_FAILED';
}
