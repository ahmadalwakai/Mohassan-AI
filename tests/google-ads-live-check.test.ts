import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ADS_API_VERSION, GoogleAdsClient, seal } from '@mohassan/google-ads';
import { adsReadOnlyPoolOptions, readStoredAdsConnection, adsInspectionContext, createAdsReadOnlyFetch, adsCheckFailureCode, type StoredAdsConnection } from '../scripts/lib/google-ads-live-check.ts';

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });
const key = Buffer.alloc(32, 9), owner = 'selected-owner', customerId = '1234567890';
const row: StoredAdsConnection = { owner_id: owner, customer_id: customerId, login_customer_id: null, status: 'connected', sealed_refresh_token: seal('private-refresh-fixture', key, `google-ads:refresh:${owner}`), currency: 'GBP', time_zone: 'Europe/London', test_account: false, booking_rules: [], rate_limited_until: null };
async function database(withSchema = true) {
  const db = new PGlite(); databases.push(db);
  if (withSchema) {
    await db.exec('CREATE TABLE google_ads_connections(owner_id text PRIMARY KEY, customer_id text, login_customer_id text, status text, sealed_refresh_token text, currency text, time_zone text, test_account boolean, booking_rules jsonb, rate_limited_until timestamptz)');
    await db.query('INSERT INTO google_ads_connections VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', Object.values(row).map((value, index) => index === 8 ? JSON.stringify(value) : value));
  }
  const queries: string[] = [], release = vi.fn();
  const pool = { connect: async () => ({ release, query: async (text: string, values?: unknown[]) => { queries.push(text); return db.query(text, values); } }) };
  return { db, pool, queries, release };
}

describe('Google Ads SQL inspection', () => {
  it('keeps session defaults read-only even when the URL tries to override options', () => {
    const options = adsReadOnlyPoolOptions('postgresql://fixture:private@localhost/ads?sslmode=require&channel_binding=require&options=-c%20default_transaction_read_only%3Doff');
    const client = new pg.Client(options);
    expect((client as any).connectionParameters.options).toBe('-c default_transaction_read_only=on -c statement_timeout=15000');
    expect(options).toMatchObject({ max: 1, connectionTimeoutMillis: 3000, enableChannelBinding: true });
    expect(new URL(options.connectionString!).searchParams.get('sslmode')).toBe('verify-full');
    expect(() => adsReadOnlyPoolOptions('file:///private')).toThrow('DATABASE_CONFIG_INVALID');
  });
  it('reads a single owner without changing rows or migrating the database', async () => {
    const { db, pool, queries, release } = await database();
    const before = await db.query('SELECT * FROM google_ads_connections');
    expect(await readStoredAdsConnection(pool)).toMatchObject({ ok: true, row });
    expect(await db.query('SELECT * FROM google_ads_connections')).toEqual(before);
    expect(queries.slice(0, 2)).toEqual(['BEGIN', 'SET TRANSACTION READ ONLY']);
    expect(queries.every(query => /^(BEGIN|SET TRANSACTION READ ONLY|SELECT|COMMIT)$|^SELECT /u.test(query))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
  it('PostgreSQL rejects an accidental write before the first inspection read and the transaction rolls back', async () => {
    const { db, pool, queries, release } = await database();
    const connected = await pool.connect(), original = connected.query;
    let writeFailureCode: string | undefined;
    connected.query = async (text, values) => {
      if (text.startsWith('SELECT to_regclass')) {
        try { await db.query("UPDATE google_ads_connections SET status='disconnected'"); }
        catch (error: any) { writeFailureCode = error.code; throw error; }
      }
      return original(text, values);
    };
    await expect(readStoredAdsConnection({ connect: async () => connected })).rejects.toMatchObject({ code: 'DATABASE_READ_FAILED' });
    expect(writeFailureCode).toBe('25006');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect((await db.query('SELECT status FROM google_ads_connections')).rows).toEqual([{ status: 'connected' }]);
    expect(release).toHaveBeenCalledOnce();
  });
  it('reports an absent schema without creating it', async () => {
    const { db, pool, queries } = await database(false);
    expect(await readStoredAdsConnection(pool)).toEqual({ ok: false, reason: 'ADS_SCHEMA_NOT_DEPLOYED' });
    expect((await db.query("SELECT to_regclass('public.google_ads_connections') AS name")).rows).toEqual([{ name: null }]);
    expect(queries).toHaveLength(4);
  });
  it('requires an explicit owner when multiple owners exist and parameterizes the selection', async () => {
    const { db, pool } = await database();
    await db.query("INSERT INTO google_ads_connections(owner_id,status) VALUES ('another-owner','disconnected')");
    expect(await readStoredAdsConnection(pool)).toEqual({ ok: false, reason: 'OWNER_SELECTION_REQUIRED' });
    expect(await readStoredAdsConnection(pool, owner)).toMatchObject({ ok: true, row });
    expect(await readStoredAdsConnection(pool, "' OR 1=1 --")).toEqual({ ok: false, reason: 'NO_CONNECTED_ACCOUNT' });
    expect(await readStoredAdsConnection(pool, '--live')).toEqual({ ok: false, reason: 'OWNER_ARGUMENT_INVALID' });
  });
  it('binds token decryption to the selected owner and respects stored cooldown before decryption', () => {
    expect(adsInspectionContext(row, key.toString('base64')).context).toEqual({ refreshToken: 'private-refresh-fixture', customerId, loginCustomerId: null });
    expect(() => adsInspectionContext({ ...row, owner_id: 'another-owner' }, key.toString('base64'))).toThrow('تعذرت قراءة تفويض Google المحفوظ');
    expect(() => adsInspectionContext({ ...row, sealed_refresh_token: 'broken', rate_limited_until: new Date(Date.now() + 60000) }, key.toString('base64'))).toThrow('STORED_ACCOUNT_RATE_LIMITED');
    expect(() => adsInspectionContext({ ...row, customer_id: '../evil' }, key.toString('base64'))).toThrow('STORED_CONNECTION_INVALID');
  });
});

const settings = { clientId: 'fixture-client', clientSecret: 'private-client-secret', context: { refreshToken: 'private-refresh-fixture', customerId, loginCustomerId: null } };
const adsHeaders = { authorization: 'Bearer private-access-fixture', 'content-type': 'application/json' };
const search = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;
const refreshBody = () => new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, refresh_token: settings.context.refreshToken, grant_type: 'refresh_token' });
describe('Google Ads read-only transport', () => {
  it('supports the real client refresh/list/search flow, with redirects disabled and no developer token', async () => {
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      if (String(input).includes('oauth2.')) return Response.json({ access_token: 'private-access-fixture', expires_in: 3600 });
      expect(new Headers(init?.headers).has('developer-token')).toBe(false);
      return String(input).endsWith('listAccessibleCustomers') ? Response.json({ resourceNames: [`customers/${customerId}`] }) : Response.json([{ results: [{ customer: { id: customerId } }] }]);
    });
    const client = new GoogleAdsClient({ clientId: settings.clientId, clientSecret: settings.clientSecret, fetch: createAdsReadOnlyFetch(settings, transport) });
    expect(await client.listAccessibleCustomers(settings.context)).toEqual([customerId]);
    expect(await client.search('SELECT customer.id FROM customer LIMIT 1', settings.context)).toEqual([{ customer: { id: customerId } }]);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each([
    [search.replace('searchStream', 'mutate'), { method: 'POST', headers: adsHeaders, body: JSON.stringify({ mutateOperations: [] }) }],
    [search.replace(customerId, '9999999999'), { method: 'POST', headers: adsHeaders, body: JSON.stringify({ query: 'SELECT customer.id FROM customer' }) }],
    [search.replace('googleads.googleapis.com', 'googleads.googleapis.com.evil.test'), { method: 'POST', headers: adsHeaders, body: '{}' }],
    [search, { method: 'DELETE', headers: adsHeaders }],
    [search, { method: 'POST', headers: { ...adsHeaders, cookie: 'private' }, body: JSON.stringify({ query: 'SELECT customer.id FROM customer' }) }],
    [search, { method: 'POST', headers: adsHeaders, body: JSON.stringify({ query: 'SELECT customer.id FROM customer', mutateOperations: [] }) }],
    [search, { method: 'POST', headers: adsHeaders, body: JSON.stringify({ query: 'DELETE FROM customer' }) }],
    [`${search}?token=private`, { method: 'POST', headers: adsHeaders, body: '{}' }],
    ['https://oauth2.googleapis.com/revoke', { method: 'POST', body: refreshBody() }],
    ['https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'private-code' }) }],
    ['https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(refreshBody()), refresh_token: 'different-owner-token' }) }],
  ] as [string, RequestInit][])('blocks a disallowed request before dispatch: %s', async (input, init) => {
    const transport = vi.fn<typeof fetch>();
    await expect(createAdsReadOnlyFetch(settings, transport)(input, init)).rejects.toMatchObject({ code: 'READ_ONLY_TRANSPORT_DENIED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a redirect response rather than forwarding secrets and never exposes raw errors', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
    await expect(createAdsReadOnlyFetch(settings, transport)(search, { method: 'POST', headers: adsHeaders, body: JSON.stringify({ query: 'SELECT customer.id FROM customer' }) })).rejects.toMatchObject({ code: 'READ_ONLY_TRANSPORT_DENIED' });
    expect(transport).toHaveBeenCalledOnce();
    expect(adsCheckFailureCode(new Error('postgresql://private-user:private-password@private-host/db'))).toBe('READ_ONLY_CHECK_FAILED');
  });
});
