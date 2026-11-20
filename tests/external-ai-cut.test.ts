import { describe, it, expect, beforeAll } from 'vitest';
import { withoutExternalAI, inferenceConfigFromEnv, EXTERNAL_AI_DISABLED_MESSAGE } from '../apps/server/src/inference.js';

// Owner decision 2026-11-12: Mohassan uses only its own model. Keys in the environment must not
// reach Groq, FreeLLMAPI or any other AI platform.
const env = {
  GROQ_API_KEY: 'fixture-groq-key', FREELLMAPI_ENABLED: 'true', FREELLMAPI_API_KEY: 'fixture-free-key',
  FREELLMAPI_BASE_URL: 'http://127.0.0.1:31415/v1', AI_ALLOW_PAID_FALLBACK: 'true', AI_AUTOMATIC_FALLBACK: 'true',
  GROQ_PRICE_INPUT_PER_MTOK: '1', GROQ_PRICE_OUTPUT_PER_MTOK: '1',
};

describe('external AI platforms are cut off', () => {
  let getConfig: typeof import('../apps/server/src/config.js').getConfig;
  beforeAll(async () => {
    process.env.MOHASSAN_ISOLATED_TEST = 'true';
    ({ getConfig } = await import('../apps/server/src/config.js'));
  });

  it('drops every external credential and fallback from the inference settings', () => {
    const config = withoutExternalAI(inferenceConfigFromEnv(env, { apiKey: 'fixture-groq-key', fast: ['a'], deep: ['b'] }));
    expect(config.groq).toBeUndefined();
    expect(config.prices).toBeUndefined();
    expect(config.freellmapi).toMatchObject({ enabled: false, apiKey: undefined });
    expect(config).toMatchObject({ automaticFallback: false, allowPaidFallback: false, externalDisabled: EXTERNAL_AI_DISABLED_MESSAGE });
  });

  it('getConfig ignores Groq and FreeLLMAPI keys in the environment', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, env);
      const config = getConfig();
      expect(config.groqApiKey).toBeUndefined();
      expect((config.inference as { groq?: unknown } | undefined)?.groq).toBeUndefined();
      expect(config.inference?.freellmapi).toMatchObject({ enabled: false, apiKey: undefined });
      expect(config.inference?.externalDisabled).toBe(EXTERNAL_AI_DISABLED_MESSAGE);
    } finally {
      for (const key of Object.keys(env)) if (!(key in saved)) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
});
