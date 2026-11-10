import { z } from 'zod';
import { LocalModelQueue, OllamaProvider, ProviderError, type ModelProvider } from '@mohassan/providers';

/**
 * Mohassan's only model: the owner's own model served by Ollama on this computer.
 * Every role shares one queue, so the single GPU serves one request at a time.
 * There is no cloud fallback: when the model is not configured or not reachable,
 * model features fail closed with an Arabic message and the deterministic parts
 * of the assistant (clarification, checks, approvals) keep working.
 */
export type LocalModelRole = 'chat' | 'plan' | 'coding' | 'studio' | 'vision' | 'skill';

/** Owner-approved limits (2026-11-10). A limit starts when the request reaches the model. */
export const LOCAL_MODEL_LIMITS = {
  maxWaiting: 3,
  timeoutMs: { chat: 120_000, plan: 300_000, coding: 180_000, studio: 180_000, vision: 90_000, skill: 120_000 } satisfies Record<LocalModelRole, number>,
} as const;

export interface LocalModelConfig {
  /** Ollama model name, for example qwen3.5:9b-q4_K_M. Absent: model features are off. */
  model?: string;
  /** Loopback Ollama origin; anything else is refused by the provider. */
  baseUrl?: string;
  /** True when the model can read images (it has a vision projector). */
  vision?: boolean;
  /** Injected transport for isolated tests and measurements only. */
  fetch?: typeof fetch;
  /** Overrides for isolated tests only. */
  timeouts?: Partial<Record<LocalModelRole, number>>;
}

export interface LocalModel {
  readonly model: string;
  readonly origin: string;
  readonly vision: boolean;
  readonly queue: LocalModelQueue;
  provider(role: LocalModelRole): ModelProvider;
  /** Installed digest and Ollama version, or the reason it is not reachable. */
  check(signal?: AbortSignal): Promise<LocalModelHealth>;
}

export type LocalModelHealth =
  | { status: 'ready'; model: string; version: string; digest: string | null; loaded: boolean; vision: boolean; checkedAt: string }
  | { status: 'unreachable' | 'missing'; model: string; message: string; checkedAt: string };

export const NOT_CONFIGURED_MESSAGE = 'لم يُضبط نموذج موحسن المحلي على هذا الخادم. ميزات النموذج متاحة للمالك على كمبيوتره فقط، وتعمل بقية المساعد دونه.';

export function localModelConfigFromEnv(env: NodeJS.ProcessEnv): LocalModelConfig {
  const model = env.LOCAL_MODEL_NAME?.trim();
  return {
    ...(model ? { model } : {}),
    baseUrl: env.LOCAL_MODEL_URL?.trim() || 'http://127.0.0.1:11434',
    vision: env.LOCAL_MODEL_VISION !== 'false',
  };
}

export function createLocalModel(config: LocalModelConfig | undefined): LocalModel | null {
  if (!config?.model) return null;
  const model = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/).parse(config.model);
  const queue = new LocalModelQueue(LOCAL_MODEL_LIMITS.maxWaiting);
  const vision = config.vision !== false;
  const timeout = (role: LocalModelRole) => config.timeouts?.[role] ?? LOCAL_MODEL_LIMITS.timeoutMs[role];
  const providers = new Map<LocalModelRole, OllamaProvider>();
  const build = (role: LocalModelRole) => new OllamaProvider({
    model, baseUrl: config.baseUrl, fetch: config.fetch, queue, vision,
    // A screenshot question gets the vision limit; a Studio edit from an image stays a Studio edit.
    timeoutMs: timeout(role), imageTimeoutMs: role === 'chat' || role === 'vision' ? timeout('vision') : timeout(role),
    // Low but non-zero variety for free text; decisions are validated by schema either way.
    temperature: 0.2, seed: 42,
  });
  const first = build('chat');
  providers.set('chat', first);
  return {
    model, origin: first.origin, vision, queue,
    provider(role) {
      let provider = providers.get(role);
      if (!provider) { provider = build(role); providers.set(role, provider); }
      return provider;
    },
    async check(signal) {
      const checkedAt = new Date().toISOString();
      try {
        const inspected = await first.inspect(AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
        return { status: 'ready', model, version: inspected.version, digest: inspected.digest, loaded: inspected.loaded.includes(model), vision, checkedAt };
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'MODEL_UNAVAILABLE') return { status: 'missing', model, message: 'النموذج المحدد غير مثبت في Ollama على هذا الكمبيوتر.', checkedAt };
        return { status: 'unreachable', model, message: 'تعذر الوصول إلى Ollama على هذا الكمبيوتر. شغّل Ollama ثم أعد الفحص.', checkedAt };
      }
    },
  };
}
