import { createHash, randomBytes } from 'node:crypto';
import type { GoogleAdsAccountOption, GoogleAdsBookingRule } from '@mohassan/contracts';
import { GOOGLE_ADS_SCOPE, type CallContext, type GoogleAdsClient } from './client.ts';
import { seal, sha256, unseal } from './crypto.ts';
import { GoogleAdsError, notConnected, unauthorized } from './errors.ts';
import { audit, iso, json, parsed, type Db } from './store.ts';

const STATE_TTL_MS = 10 * 60000;
const ACCOUNT_QUERY = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status FROM customer LIMIT 1';
const CLIENTS_QUERY = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.test_account, customer_client.status FROM customer_client WHERE customer_client.level <= 1';

export interface ConnectionRow {
  status: 'disconnected' | 'needs_account' | 'connected' | 'unauthorized'; customerId: string | null; loginCustomerId: string | null;
  name: string | null; currency: string | null; timeZone: string | null; testAccount: boolean; connectedAt: string | null; lastCheckedAt: string | null;
  rateLimitedUntil: string | null; bookingRules: GoogleAdsBookingRule[];
}

/** GoogleAdsConnectionManager. OAuth with PKCE; the refresh token is sealed at rest and never leaves the server. */
export class GoogleAdsConnectionManager {
  constructor(private readonly db: Db, private readonly client: GoogleAdsClient, private readonly options: { clientId: string; tokenKey: Buffer; redirectUri: string; authorizationUrl?: string }) {}

  private tokenContext = (ownerId: string) => `google-ads:refresh:${ownerId}`;
  private stateContext = (ownerId: string) => `google-ads:pkce:${ownerId}`;

  async authorizationUrl(ownerId: string): Promise<string> {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    await this.db.deleteFrom('google_ads_oauth_states').where('expires_at', '<', new Date()).execute();
    await this.db.insertInto('google_ads_oauth_states').values({ state_hash: sha256(state), owner_id: ownerId, sealed_verifier: seal(verifier, this.options.tokenKey, this.stateContext(ownerId)), expires_at: new Date(Date.now() + STATE_TTL_MS) }).execute();
    const url = new URL(this.options.authorizationUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: 'code', scope: GOOGLE_ADS_SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    await audit(this.db, ownerId, null, 'oauth_started');
    return url.href;
  }

  async completeAuthorization(ownerId: string, code: string, state: string): Promise<void> {
    // Consuming first makes a replayed callback fail even if the exchange below is slow.
    const row = await this.db.updateTable('google_ads_oauth_states').set({ consumed_at: new Date() }).where('state_hash', '=', sha256(state)).where('owner_id', '=', ownerId).where('consumed_at', 'is', null).where('expires_at', '>', new Date()).returning('sealed_verifier').executeTakeFirst();
    if (!row) throw new GoogleAdsError('GOOGLE_ADS_OAUTH_STATE', 'انتهت صلاحية طلب الربط أو استُخدم من قبل. ابدأ الربط مجددًا.', 400);
    const verifier = unseal(row.sealed_verifier, this.options.tokenKey, this.stateContext(ownerId));
    const { refreshToken, scope } = await this.client.exchangeCode(code, verifier, this.options.redirectUri);
    if (!scope.split(/\s+/).includes(GOOGLE_ADS_SCOPE)) throw new GoogleAdsError('GOOGLE_ADS_OAUTH_SCOPE', 'لم تُمنح صلاحية Google Ads في شاشة الموافقة.', 400);
    if (!refreshToken) throw new GoogleAdsError('GOOGLE_ADS_OAUTH_FAILED', 'لم تُرجع Google تفويضًا دائمًا. ألغِ وصول التطبيق من حساب Google ثم اربط مجددًا.', 400);
    const sealed = seal(refreshToken, this.options.tokenKey, this.tokenContext(ownerId));
    await this.db.insertInto('google_ads_connections').values({ owner_id: ownerId, sealed_refresh_token: sealed, status: 'needs_account', connected_at: new Date() })
      .onConflict(conflict => conflict.column('owner_id').doUpdateSet({ sealed_refresh_token: sealed, status: 'needs_account', customer_id: null, login_customer_id: null, account_name: null, currency: null, time_zone: null, connected_at: new Date(), rate_limited_until: null, updated_at: new Date() })).execute();
    await audit(this.db, ownerId, null, 'oauth_connected');
  }

  async row(ownerId: string): Promise<ConnectionRow> {
    const row = await this.db.selectFrom('google_ads_connections').selectAll().where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) return { status: 'disconnected', customerId: null, loginCustomerId: null, name: null, currency: null, timeZone: null, testAccount: false, connectedAt: null, lastCheckedAt: null, rateLimitedUntil: null, bookingRules: [] };
    return { status: row.status, customerId: row.customer_id, loginCustomerId: row.login_customer_id, name: row.account_name, currency: row.currency, timeZone: row.time_zone, testAccount: row.test_account, connectedAt: iso(row.connected_at), lastCheckedAt: iso(row.last_checked_at), rateLimitedUntil: iso(row.rate_limited_until), bookingRules: parsed(row.booking_rules) };
  }

  private async refreshToken(ownerId: string): Promise<string> {
    const row = await this.db.selectFrom('google_ads_connections').select(['sealed_refresh_token', 'status']).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row || row.status === 'disconnected' || !row.sealed_refresh_token) throw notConnected();
    if (row.status === 'unauthorized') throw unauthorized();
    return unseal(row.sealed_refresh_token, this.options.tokenKey, this.tokenContext(ownerId));
  }

  /** Any call for this owner runs through here, so losing access or quota updates the shown state. */
  async run<T>(ownerId: string, work: (context: CallContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const refreshToken = await this.refreshToken(ownerId), row = await this.row(ownerId);
    try {
      const result = await work({ refreshToken, loginCustomerId: row.loginCustomerId, ...(signal ? { signal } : {}) });
      await this.db.updateTable('google_ads_connections').set({ last_checked_at: new Date(), rate_limited_until: null }).where('owner_id', '=', ownerId).execute();
      return result;
    } catch (error) {
      if (error instanceof GoogleAdsError && error.code === 'GOOGLE_ADS_UNAUTHORIZED') {
        this.client.forget(refreshToken);
        await this.db.updateTable('google_ads_connections').set({ status: 'unauthorized', updated_at: new Date() }).where('owner_id', '=', ownerId).execute();
        await audit(this.db, ownerId, null, 'authorization_lost');
      }
      if (error instanceof GoogleAdsError && error.options.retryAfterSeconds) await this.db.updateTable('google_ads_connections').set({ rate_limited_until: new Date(Date.now() + error.options.retryAfterSeconds * 1000) }).where('owner_id', '=', ownerId).execute();
      throw error;
    }
  }

  /** Requires a selected account, and returns the context bound to it. */
  async runForAccount<T>(ownerId: string, work: (context: CallContext & { customerId: string }, row: ConnectionRow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const row = await this.row(ownerId);
    if (row.status === 'disconnected') throw notConnected();
    if (row.status === 'unauthorized') throw unauthorized();
    if (!row.customerId) throw new GoogleAdsError('GOOGLE_ADS_NO_ACCOUNT', 'اختر حساب إعلانات أولًا.', 409);
    const customerId = row.customerId;
    return this.run(ownerId, context => work({ ...context, customerId }, row), signal);
  }

  async listAccounts(ownerId: string): Promise<GoogleAdsAccountOption[]> {
    return this.run(ownerId, async context => {
      const options = new Map<string, GoogleAdsAccountOption>();
      for (const id of (await this.client.listAccessibleCustomers(context)).slice(0, 50)) {
        const direct = { ...context, customerId: id, loginCustomerId: null };
        try {
          const [row] = await this.client.search(ACCOUNT_QUERY, direct);
          if (!row?.customer) continue;
          options.set(id, { customerId: id, name: String(row.customer.descriptiveName ?? id), currency: String(row.customer.currencyCode ?? ''), timeZone: String(row.customer.timeZone ?? ''), manager: row.customer.manager === true, testAccount: row.customer.testAccount === true, status: String(row.customer.status ?? 'UNKNOWN'), loginCustomerId: null });
          if (row.customer.manager !== true) continue;
          for (const child of await this.client.search(CLIENTS_QUERY, direct)) {
            const client = child.customerClient, childId = String(client?.id ?? '');
            if (!/^\d{10}$/.test(childId) || childId === id || options.has(childId)) continue;
            options.set(childId, { customerId: childId, name: String(client.descriptiveName ?? childId), currency: String(client.currencyCode ?? ''), timeZone: String(client.timeZone ?? ''), manager: client.manager === true, testAccount: client.testAccount === true, status: String(client.status ?? 'UNKNOWN'), loginCustomerId: id });
          }
        } catch (error) {
          // One unreadable account must not hide the others; lost sign-in and quota must not be swallowed.
          if (error instanceof GoogleAdsError && ['GOOGLE_ADS_PERMISSION_DENIED', 'GOOGLE_ADS_ACCOUNT_DISABLED', 'GOOGLE_ADS_FORBIDDEN'].includes(error.code)) continue;
          throw error;
        }
      }
      return [...options.values()];
    });
  }

  async selectAccount(ownerId: string, customerId: string, loginCustomerId: string | null) {
    return this.run(ownerId, async context => {
      // Read again with the exact headers later calls will use, rather than trusting the list.
      const [row] = await this.client.search(ACCOUNT_QUERY, { ...context, customerId, loginCustomerId });
      if (!row?.customer) throw new GoogleAdsError('GOOGLE_ADS_NO_ACCOUNT', 'تعذرت قراءة هذا الحساب.', 404);
      if (row.customer.manager === true) throw new GoogleAdsError('GOOGLE_ADS_MANAGER_ACCOUNT', 'هذا حساب مدير لا يحمل حملات. اختر حسابًا تابعًا له.', 400);
      await this.db.updateTable('google_ads_connections').set({ status: 'connected', customer_id: customerId, login_customer_id: loginCustomerId, account_name: String(row.customer.descriptiveName ?? customerId), currency: String(row.customer.currencyCode ?? ''), time_zone: String(row.customer.timeZone ?? ''), test_account: row.customer.testAccount === true, booking_rules: json([]), updated_at: new Date() }).where('owner_id', '=', ownerId).execute();
      await audit(this.db, ownerId, null, 'account_selected', { customerId, testAccount: row.customer.testAccount === true });
    });
  }

  async setBookingRules(ownerId: string, rules: GoogleAdsBookingRule[]) {
    const customer = (await this.row(ownerId)).customerId;
    if (!customer) throw new GoogleAdsError('GOOGLE_ADS_NO_ACCOUNT', 'اختر حساب إعلانات أولًا.', 409);
    if (rules.flatMap(rule => rule.conversionActions).some(name => !name.startsWith(`customers/${customer}/`))) throw new GoogleAdsError('GOOGLE_ADS_MAPPING', 'إجراء التحويل لا يخص الحساب المحدد.', 400);
    const names = rules.flatMap(rule => rule.conversionActions);
    if (new Set(names).size !== names.length) throw new GoogleAdsError('GOOGLE_ADS_MAPPING', 'لا يُربط إجراء تحويل واحد بأكثر من خدمة، حتى لا يُحسب الحجز مرتين.', 400);
    await this.db.updateTable('google_ads_connections').set({ booking_rules: json(rules), updated_at: new Date() }).where('owner_id', '=', ownerId).execute();
    await audit(this.db, ownerId, null, 'booking_map_saved', { services: rules.map(rule => rule.service) });
  }

  async disconnect(ownerId: string) {
    const row = await this.db.selectFrom('google_ads_connections').select('sealed_refresh_token').where('owner_id', '=', ownerId).executeTakeFirst();
    if (row?.sealed_refresh_token) await this.client.revoke(unseal(row.sealed_refresh_token, this.options.tokenKey, this.tokenContext(ownerId))).catch(() => undefined);
    await this.db.updateTable('google_ads_connections').set({ sealed_refresh_token: null, status: 'disconnected', customer_id: null, login_customer_id: null, account_name: null, currency: null, time_zone: null, booking_rules: json([]), rate_limited_until: null, updated_at: new Date() }).where('owner_id', '=', ownerId).execute();
    await audit(this.db, ownerId, null, 'disconnected');
  }
}
