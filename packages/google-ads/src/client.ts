import { GoogleAdsError, unauthorized } from './errors.ts';

/** Latest release on 2026-11-06, sunset November 2027. Bump it here only. */
export const GOOGLE_ADS_API_VERSION = 'v26';
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const API_HOST = 'https://googleads.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type Row = Record<string, any>;
export type MutateOperation = Record<string, unknown>;
export interface MutateResult { requestId: string | null; resourceNames: string[] }

export interface ClientOptions {
  clientId: string; clientSecret: string;
  /** Optional since Google sunset developer tokens on 2026-09-09; sent only when configured. */
  developerToken?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  maxReadAttempts?: number;
}

export interface CallContext { refreshToken: string; customerId?: string; loginCustomerId?: string | null; signal?: AbortSignal }

const googleCodes = (body: any): string[] => {
  const root = Array.isArray(body) ? body[0] : body;
  const details = root?.error?.details;
  if (!Array.isArray(details)) return [];
  const failures = details.flatMap((item: any) => Array.isArray(item?.errors) ? item.errors : []);
  return failures.flatMap((item: any) => Object.values(item?.errorCode ?? {}).filter((value): value is string => typeof value === 'string'));
};
const googleRequestId = (body: any, response: Response): string | undefined => response.headers.get('request-id') ?? (Array.isArray(body) ? body[0] : body)?.error?.details?.find?.((item: any) => item?.requestId)?.requestId;

/** Google's text is kept out of the owner's message; the codes are enough to act on. */
export function classifyFailure(status: number, body: any, response: Response): GoogleAdsError {
  const codes = googleCodes(body), options = { googleCodes: codes, requestId: googleRequestId(body, response) };
  const has = (...names: string[]) => names.some(name => codes.includes(name));
  const retryAfter = Number(response.headers.get('retry-after'));
  if (has('RESOURCE_EXHAUSTED')) return new GoogleAdsError('GOOGLE_ADS_DAILY_QUOTA', 'نفدت الحصة اليومية لمشروع Google Cloud. تتجدد لاحقًا؛ لا تفيد إعادة المحاولة الآن.', 429, { ...options, retryAfterSeconds: 3600 });
  if (has('RESOURCE_TEMPORARILY_EXHAUSTED') || status === 429) return new GoogleAdsError('GOOGLE_ADS_RATE_LIMITED', 'طلبات كثيرة إلى Google Ads. انتظر قليلًا ثم أعد المحاولة.', 429, { ...options, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30 });
  if (has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')) return new GoogleAdsError('GOOGLE_ADS_ACCESS_LEVEL', 'مشروع Google Cloud على مستوى Test ولا يقرأ الحسابات الحقيقية. اطلب مستوى Explorer من صفحة Google Ads API في Cloud Console.', 403, options);
  if (status === 401 || has('OAUTH_TOKEN_INVALID', 'OAUTH_TOKEN_EXPIRED', 'OAUTH_TOKEN_REVOKED')) return new GoogleAdsError('GOOGLE_ADS_UNAUTHORIZED', 'انتهى تفويض Google أو أُلغي. أعد ربط الحساب.', 401, options);
  if (has('USER_PERMISSION_DENIED')) return new GoogleAdsError('GOOGLE_ADS_PERMISSION_DENIED', 'حساب Google المربوط لا يملك صلاحية كافية على حساب الإعلانات هذا.', 403, options);
  if (has('CUSTOMER_NOT_ENABLED', 'CUSTOMER_NOT_ACTIVE')) return new GoogleAdsError('GOOGLE_ADS_ACCOUNT_DISABLED', 'حساب الإعلانات غير مفعّل أو غير نشط.', 403, options);
  if (status === 403) return new GoogleAdsError('GOOGLE_ADS_FORBIDDEN', 'رفضت Google الوصول إلى هذا الحساب.', 403, options);
  if (status >= 500) return new GoogleAdsError('GOOGLE_ADS_UNAVAILABLE', 'خدمة Google Ads غير متاحة الآن. أعد المحاولة لاحقًا.', 503, options);
  return new GoogleAdsError('GOOGLE_ADS_REJECTED', `رفضت Google الطلب${codes.length ? ` (${codes.slice(0, 3).join('، ')})` : ''}.`, 422, options);
}

export class GoogleAdsClient {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  /** Access tokens stay in memory and are never written anywhere. */
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxReadAttempts = options.maxReadAttempts ?? 4;
  }

  forget(refreshToken: string) { this.tokens.delete(refreshToken); }

  private signal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async post(url: string, form: URLSearchParams, signal?: AbortSignal) {
    let response: Response;
    try { response = await this.fetcher(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: this.signal(signal) }); }
    catch { throw new GoogleAdsError('GOOGLE_ADS_UNAVAILABLE', 'تعذر الوصول إلى Google. أعد المحاولة لاحقًا.', 503); }
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }

  async exchangeCode(code: string, verifier: string, redirectUri: string, signal?: AbortSignal) {
    const { status, body } = await this.post(TOKEN_URL, new URLSearchParams({ code, code_verifier: verifier, client_id: this.options.clientId, client_secret: this.options.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }), signal);
    if (status !== 200 || typeof body?.access_token !== 'string') throw new GoogleAdsError('GOOGLE_ADS_OAUTH_FAILED', 'لم تكتمل موافقة Google. حاول الربط مجددًا.', 400);
    return { refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token as string : null, scope: String(body.scope ?? '') };
  }

  private async accessToken(refreshToken: string, signal?: AbortSignal): Promise<string> {
    const cached = this.tokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.value;
    const { status, body } = await this.post(TOKEN_URL, new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }), signal);
    if (body?.error === 'invalid_grant' || status === 401) throw unauthorized();
    if (status !== 200 || typeof body?.access_token !== 'string') throw new GoogleAdsError('GOOGLE_ADS_UNAVAILABLE', 'تعذر تجديد تفويض Google. أعد المحاولة لاحقًا.', 503);
    this.tokens.set(refreshToken, { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3000) * 1000 });
    return body.access_token as string;
  }

  async revoke(refreshToken: string) {
    this.forget(refreshToken);
    await this.post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token: refreshToken })).catch(() => undefined);
  }

  private async request(path: string, context: CallContext, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken(context.refreshToken, context.signal)}`, 'content-type': 'application/json' };
    if (this.options.developerToken) headers['developer-token'] = this.options.developerToken;
    if (context.loginCustomerId) headers['login-customer-id'] = context.loginCustomerId;
    let response: Response;
    try { response = await this.fetcher(`${API_HOST}/${GOOGLE_ADS_API_VERSION}/${path}`, { method: init.method, headers, signal: this.signal(context.signal), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); }
    catch { throw new GoogleAdsError('GOOGLE_ADS_UNAVAILABLE', 'تعذر الوصول إلى Google Ads. أعد المحاولة لاحقًا.', 503); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw classifyFailure(response.status, body, response);
    return body;
  }

  /** Reads are safe to repeat, so short rate limits and outages get a bounded backoff. */
  private async read(path: string, context: CallContext, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<any> {
    for (let attempt = 1; ; attempt += 1) {
      try { return await this.request(path, context, init); } catch (error) {
        const retryable = error instanceof GoogleAdsError && ['GOOGLE_ADS_RATE_LIMITED', 'GOOGLE_ADS_UNAVAILABLE'].includes(error.code);
        if (!retryable || attempt >= this.maxReadAttempts) throw error;
        await this.sleep(Math.min(16000, 1000 * 2 ** attempt) * (0.5 + this.random() / 2));
      }
    }
  }

  async listAccessibleCustomers(context: CallContext): Promise<string[]> {
    const body = await this.read('customers:listAccessibleCustomers', context, { method: 'GET' });
    return (Array.isArray(body?.resourceNames) ? body.resourceNames as string[] : []).map(name => name.replace('customers/', ''));
  }

  async search(query: string, context: CallContext & { customerId: string }): Promise<Row[]> {
    const body = await this.read(`customers/${context.customerId}/googleAds:searchStream`, context, { method: 'POST', body: { query } });
    return (Array.isArray(body) ? body : [body]).flatMap((batch: any) => Array.isArray(batch?.results) ? batch.results as Row[] : []);
  }

  async generateKeywordIdeas(request: Record<string, unknown>, context: CallContext & { customerId: string }): Promise<Row[]> {
    const body = await this.read(`customers/${context.customerId}:generateKeywordIdeas`, context, { method: 'POST', body: request });
    return Array.isArray(body?.results) ? body.results : [];
  }

  async suggestGeoTargets(names: string[], locale: string, countryCode: string, context: CallContext): Promise<Row[]> {
    const body = await this.read('geoTargetConstants:suggest', context, { method: 'POST', body: { locale, countryCode, locationNames: { names } } });
    return Array.isArray(body?.geoTargetConstantSuggestions) ? body.geoTargetConstantSuggestions : [];
  }

  /**
   * One atomic request: every operation applies or none does. A write is never
   * repeated here. After a timeout or outage the result is unknown, and only the
   * publishing controller decides what happens next, after reading the account.
   */
  async mutate(operations: MutateOperation[], validateOnly: boolean, context: CallContext & { customerId: string }): Promise<MutateResult> {
    const body = await this.request(`customers/${context.customerId}/googleAds:mutate`, context, { method: 'POST', body: { mutateOperations: operations, partialFailure: false, validateOnly } });
    const names = (Array.isArray(body?.mutateOperationResponses) ? body.mutateOperationResponses : []).flatMap((item: any) => Object.values(item ?? {}).map((entry: any) => entry?.resourceName).filter((name: unknown): name is string => typeof name === 'string'));
    return { requestId: typeof body?.requestId === 'string' ? body.requestId : null, resourceNames: names };
  }
}
