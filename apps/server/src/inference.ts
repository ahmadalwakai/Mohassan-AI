import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AIProviderSettingsInputSchema, AIProvidersStatusSchema, type AIProviderSettingsInput, type AIProvidersStatus } from '@mohassan/contracts';
import {
  FreeLLMAPIProvider, GroqProvider, InferenceRouter, ProviderError, UsageMonitor, normalizeFreeLLMAPIBaseUrl,
  type FreeLLMAPIModel, type FreeLLMAPIUsage, type RouteCandidate, type RoutedResult, type PriceTable,
} from '@mohassan/providers';

export interface InferenceConfig {
  freellmapi?: {
    /** Server default for the toggle; the owner's saved setting wins once it exists. */
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
    freeOnly?: boolean;
    timeoutMs?: number;
  };
  groq?: { apiKey?: string; fast: string[]; deep: string[] };
  automaticFallback?: boolean;
  /** Switching from a free FreeLLMAPI model to paid Groq mid-request. Off unless set on the server. */
  allowPaidFallback?: boolean;
  prices?: PriceTable;
  fetch?: typeof fetch;
}

export type InferenceTier = 'fast' | 'deep';
const DISCOVERY_TTL_MS = 5 * 60_000;
const USAGE_TTL_MS = 60_000;
const MAX_LISTED_MODELS = 400;

export async function inferenceMigration(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS ai_provider_settings (
      id text PRIMARY KEY CHECK (id IN ('freellmapi')),
      enabled boolean NOT NULL, models jsonb NOT NULL, automatic_fallback boolean NOT NULL, free_only boolean NOT NULL,
      updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(tx);
  });
}

/** Reads the FreeLLMAPI settings from the server environment. Absent values keep it off. */
export function inferenceConfigFromEnv(env: NodeJS.ProcessEnv, groq: InferenceConfig['groq']): InferenceConfig {
  const flag = (value: string | undefined, fallback: boolean) => value === undefined || value === '' ? fallback : value === 'true';
  const price = (value: string | undefined) => { const number = Number(value); return value && Number.isFinite(number) && number >= 0 ? number : undefined; };
  const groqInput = price(env.GROQ_PRICE_INPUT_PER_MTOK), groqOutput = price(env.GROQ_PRICE_OUTPUT_PER_MTOK);
  return {
    freellmapi: {
      enabled: flag(env.FREELLMAPI_ENABLED, false),
      baseUrl: env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001/v1',
      apiKey: env.FREELLMAPI_API_KEY || undefined,
      models: (env.FREELLMAPI_MODELS || 'auto').split(',').map(item => item.trim()).filter(Boolean).slice(0, 8),
      freeOnly: flag(env.FREELLMAPI_FREE_ONLY, true),
      timeoutMs: Number(env.FREELLMAPI_TIMEOUT_MS) > 0 ? Number(env.FREELLMAPI_TIMEOUT_MS) : undefined,
    },
    groq,
    automaticFallback: flag(env.AI_AUTOMATIC_FALLBACK, true),
    allowPaidFallback: flag(env.AI_ALLOW_PAID_FALLBACK, false),
    prices: groqInput !== undefined && groqOutput !== undefined ? { groq: { inputPerMTok: groqInput, outputPerMTok: groqOutput } } : undefined,
  };
}

/** Free models often wrap JSON in a Markdown fence; the content inside is what counts. */
export function unfenceJson(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return (match ? match[1]! : text).trim();
}

export async function createInferenceControl(db: Kysely<any>, config: InferenceConfig) {
  await inferenceMigration(db);
  const free = config.freellmapi ?? {};
  let baseUrl: string | null = null;
  let configError: string | null = null;
  try { baseUrl = free.baseUrl ? normalizeFreeLLMAPIBaseUrl(free.baseUrl) : null; }
  catch (error) { configError = error instanceof ProviderError ? error.message : 'عنوان FreeLLMAPI غير صالح.'; }
  const configured = Boolean(free.apiKey && baseUrl);
  const groqConfigured = Boolean(config.groq?.apiKey);
  const monitor = new UsageMonitor({ freeProviders: ['freellmapi'], prices: config.prices });
  const inflight = new Map<string, Promise<RoutedResult>>();
  const defaults: AIProviderSettingsInput = AIProviderSettingsInputSchema.parse({
    enabled: Boolean(free.enabled), models: free.models?.length ? [...new Set(free.models)] : ['auto'],
    automaticFallback: config.automaticFallback ?? true, freeOnly: free.freeOnly ?? true,
  });
  let settings = defaults;
  const saved = await db.selectFrom('ai_provider_settings').selectAll().where('id', '=', 'freellmapi').executeTakeFirst();
  if (saved) {
    const parsed = AIProviderSettingsInputSchema.safeParse({ enabled: saved.enabled, models: saved.models, automaticFallback: saved.automatic_fallback, freeOnly: saved.free_only });
    if (parsed.success) settings = parsed.data;
  }

  const providers = new Map<string, FreeLLMAPIProvider>();
  const freeProvider = (model: string) => {
    let provider = providers.get(model);
    if (!provider) {
      provider = new FreeLLMAPIProvider({ baseUrl: baseUrl!, apiKey: free.apiKey!, model, fetch: config.fetch, timeoutMs: free.timeoutMs ?? 60000 });
      providers.set(model, provider);
      // Settings may name at most 8 models; this cap only guards against misuse.
      while (providers.size > 32) providers.delete(providers.keys().next().value!);
    }
    return provider;
  };
  const groqProviders = new Map<string, GroqProvider>();
  const groqProvider = (model: string) => {
    let provider = groqProviders.get(model);
    if (!provider) { provider = new GroqProvider({ apiKey: config.groq!.apiKey!, model, fetch: config.fetch, timeoutMs: 45000 }); groqProviders.set(model, provider); }
    return provider;
  };

  let catalog: { models: FreeLLMAPIModel[]; at: number } | null = null;
  let discovery: Promise<FreeLLMAPIModel[]> | null = null;
  let health: AIProvidersStatus['freellmapi']['health'] = configured
    ? { status: 'unknown', checkedAt: null, code: null, message: 'لم يُفحص اتصال FreeLLMAPI بعد.', readyModels: null }
    : { status: 'error', checkedAt: null, code: 'NOT_CONFIGURED', message: configError ?? 'أضف FREELLMAPI_API_KEY وFREELLMAPI_BASE_URL إلى ملف .env على الخادم.', readyModels: null };
  let gatewayUsage: { value: FreeLLMAPIUsage | null; at: number } | null = null;

  /** One discovery at a time; `GET /v1/models` lists the catalog without spending quota. */
  function discover(force = false): Promise<FreeLLMAPIModel[]> {
    if (!configured) return Promise.resolve([]);
    if (!force && catalog && Date.now() - catalog.at < DISCOVERY_TTL_MS) return Promise.resolve(catalog.models);
    if (discovery) return discovery;
    discovery = freeProvider('auto').listModels(AbortSignal.timeout(15000)).then(models => {
      catalog = { models, at: Date.now() };
      const ready = models.filter(model => !model.router && model.executionStatus === 'ready').length;
      health = {
        status: 'reachable', checkedAt: new Date().toISOString(), code: null, readyModels: ready,
        message: ready ? `الخادم متصل والمفتاح مقبول. ${ready} نموذجًا جاهزًا الآن حسب FreeLLMAPI.` : 'الخادم متصل والمفتاح مقبول، لكن لا يوجد نموذج جاهز الآن. أضف مفاتيح مزودين في لوحة FreeLLMAPI.',
      };
      return models;
    }).catch(error => {
      health = { status: 'error', checkedAt: new Date().toISOString(), code: error instanceof ProviderError ? error.code : 'DISCOVERY_FAILED', readyModels: null, message: error instanceof ProviderError ? error.message : 'تعذر فحص FreeLLMAPI.' };
      throw error;
    }).finally(() => { discovery = null; });
    return discovery;
  }

  async function readGatewayUsage(force = false) {
    if (!configured) return null;
    if (!force && gatewayUsage && Date.now() - gatewayUsage.at < USAGE_TTL_MS) return gatewayUsage.value;
    const value = await freeProvider('auto').usage(AbortSignal.timeout(10000)).catch(() => null);
    gatewayUsage = { value, at: Date.now() };
    if (value) monitor.setQuota({ provider: 'freellmapi', model: null, metric: 'tokens', remaining: null, limit: null, resetAt: value.resetsAt, source: 'verified', note: `استهلاك الشهر ${value.month} من سجل FreeLLMAPI: ${value.requests} طلبًا و${value.tokens} توكنًا. لا يعرض المزود حدًا شخصيًا موحدًا.` });
    return value;
  }

  /** True when the assistant can reach any model through the router. */
  const freeActive = () => configured && settings.enabled;

  /** Candidates in priority order: enabled FreeLLMAPI models first, then the existing Groq tier order. */
  function candidates(tier: InferenceTier): RouteCandidate[] {
    const list: RouteCandidate[] = [];
    if (freeActive()) {
      const known = new Map((catalog?.models ?? []).map(model => [model.id, model]));
      for (const model of settings.models) {
        const entry = known.get(model);
        // Catalog rows report their parameters; router entries leave the choice to the gateway.
        const reported = entry && !entry.router;
        list.push({
          key: `freellmapi:${model}`, providerId: 'freellmapi', model, cost: 'free', provider: freeProvider(model),
          capabilities: { structured: reported ? entry.supportsStructuredOutput : null, tools: reported ? entry.supportsTools : null, vision: null },
        });
      }
    }
    if (groqConfigured && config.groq) {
      const order = tier === 'deep' ? [...config.groq.deep, ...config.groq.fast] : [...config.groq.fast, ...config.groq.deep];
      for (const model of new Set(order)) list.push({ key: `groq:${model}`, providerId: 'groq', model, cost: 'paid', provider: groqProvider(model), capabilities: { structured: true, vision: null, tools: null } });
    }
    return list;
  }

  /** Null while FreeLLMAPI is off: callers then keep their existing Groq path unchanged. */
  function routerFor(tier: InferenceTier): InferenceRouter | null {
    if (!freeActive()) return null;
    if (!catalog) void discover().catch(() => {});
    return new InferenceRouter(candidates(tier), {
      freeOnly: settings.freeOnly, automaticFallback: settings.automaticFallback,
      allowPaidFallback: config.allowPaidFallback === true,
    }, monitor, { inflight });
  }

  async function recordedToday() {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const rows = await db.selectFrom('chat_model_receipts').select(['model',
      sql<number>`count(*)::int`.as('requests'),
      sql<number>`count(*) FILTER (WHERE status IN ('failed','unknown','invalid'))::int`.as('failures'),
      sql<number>`coalesce(sum(input_tokens),0)::int`.as('input_tokens'),
      sql<number>`coalesce(sum(output_tokens),0)::int`.as('output_tokens')])
      .where('started_at', '>=', start).groupBy('model').orderBy('model').limit(100).execute().catch(() => []);
    return rows.map(row => ({ model: String(row.model).slice(0, 320), requests: Number(row.requests), failures: Number(row.failures), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) }));
  }

  async function status(): Promise<AIProvidersStatus> {
    const [usage, recorded] = await Promise.all([freeActive() ? readGatewayUsage() : Promise.resolve(gatewayUsage?.value ?? null), recordedToday()]);
    const models = catalog?.models ?? [];
    return AIProvidersStatusSchema.parse({
      freellmapi: {
        configured, baseUrl, settings, allowPaidFallback: config.allowPaidFallback === true, health,
        models: models.slice(0, MAX_LISTED_MODELS), modelsTruncated: models.length > MAX_LISTED_MODELS,
        gatewayUsage: usage,
      },
      groq: { configured: groqConfigured, models: [...new Set([...(config.groq?.fast ?? []), ...(config.groq?.deep ?? [])])].slice(0, 10) },
      usage: { ...monitor.snapshot(), recorded },
    });
  }

  async function check() {
    if (!configured) throw new ProviderError('NOT_CONFIGURED', health.message);
    await discover(true).catch(() => {});
    await readGatewayUsage(true);
    return status();
  }

  let saving: Promise<unknown> = Promise.resolve();
  async function save(ownerId: string, input: unknown) {
    const next = AIProviderSettingsInputSchema.parse(input);
    if (next.enabled && !configured) throw Object.assign(new Error(health.message), { statusCode: 409, code: 'FREELLMAPI_NOT_CONFIGURED' });
    // Serialise writes so two quick toggles cannot interleave.
    const write = saving.then(() => db.insertInto('ai_provider_settings').values({ id: 'freellmapi', enabled: next.enabled, models: JSON.stringify(next.models), automatic_fallback: next.automaticFallback, free_only: next.freeOnly, updated_by: ownerId, updated_at: new Date() })
      .onConflict(conflict => conflict.column('id').doUpdateSet({ enabled: next.enabled, models: JSON.stringify(next.models), automatic_fallback: next.automaticFallback, free_only: next.freeOnly, updated_by: ownerId, updated_at: new Date() })).execute());
    saving = write.catch(() => {});
    await write;
    settings = next;
    if (next.enabled) await discover().catch(() => {});
    return status();
  }

  return {
    configured, monitor, routerFor, candidates, discover, status, check, save,
    /** Whether FreeLLMAPI currently serves assistant requests. */
    active: freeActive,
  };
}
export type InferenceControl = Awaited<ReturnType<typeof createInferenceControl>>;

export async function registerInferenceRoutes(app: FastifyInstance, options: { control: InferenceControl; owner: (request: { headers: Record<string, unknown> }) => Promise<{ id: string }> }) {
  const { control, owner } = options;
  app.get('/api/ai/providers', async request => { await owner(request); return control.status(); });
  app.post('/api/ai/providers/freellmapi/settings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    return control.save(user.id, request.body);
  });
  app.post('/api/ai/providers/freellmapi/check', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    z.object({}).strict().parse(request.body ?? {});
    try { return await control.check(); }
    catch (error) {
      const known = error instanceof ProviderError;
      return reply.code(known && error.code === 'NOT_CONFIGURED' ? 409 : 502).send({ error: { code: known ? error.code : 'FREELLMAPI_CHECK_FAILED', message: known ? error.message : 'تعذر فحص FreeLLMAPI.' } });
    }
  });
}
