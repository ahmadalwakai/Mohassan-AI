// Isolated fixtures supply an explicit environment; never discover the owner's .env.
if (process.env.MOHASSAN_ISOLATED_TEST !== 'true') await import('dotenv/config');
import type { AppConfig } from './app.js';
import { resolve,delimiter } from 'node:path';
import { inferenceConfigFromEnv, withoutExternalAI } from './inference.js';
import { executorConfigFromEnv } from './executor.js';
import { adsLabConfigFromEnv } from './ads-lab.js';
export function getConfig(): AppConfig {
  return {
    // MOHASSAN_LOCAL_LAB (npm run dev:lab) never reaches an external database, whatever .env says.
    dataDir: process.env.DATA_DIR ?? '.data/postgres', databaseUrl: process.env.MOHASSAN_LOCAL_LAB === '1' ? undefined : process.env.DATABASE_URL || undefined,
    authSecret: process.env.BETTER_AUTH_SECRET ?? '', internalSecret: process.env.INTERNAL_API_SECRET ?? '',
    setupToken: process.env.SETUP_TOKEN ?? '', webOrigin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000',
    production: process.env.NODE_ENV === 'production', runWorker: process.env.RUN_WORKER !== 'false',
    skillEngineEnabled: process.env.SKILL_ENGINE_ENABLED === 'true',
    mindEnabled: process.env.NODE_ENV !== 'production' && process.env.MOHASSAN_LOCAL_LAB === '1' && process.env.MOHASSAN_MIND === '1',
    memberDailyRuns: /^[1-9]\d{0,3}$/.test(process.env.MEMBER_DAILY_RUNS ?? '') ? Number(process.env.MEMBER_DAILY_RUNS) : undefined,
    // Owner decision (2026-11-10, 2026-11-12): Mohassan uses only its own model. No Groq, no FreeLLMAPI
    // and no other AI platform API is reachable from the server, whatever .env or lab.env says.
    groqApiKey:undefined,groqModel:process.env.GROQ_MODEL||'openai/gpt-oss-20b',groqReasoningModel:process.env.GROQ_REASONING_MODEL||'openai/gpt-oss-120b',
    codingDataDir:process.env.CODING_DATA_DIR||resolve('.data/coding'),codingAllowedRoots:process.env.CODING_ALLOWED_ROOTS?.split(delimiter).filter(Boolean)??[process.cwd()],
    windowsEnabled:process.env.NODE_ENV==='production'?process.env.WINDOWS_REMOTE_ENABLED==='true':process.env.WINDOWS_REMOTE_ENABLED!=='false',
    waslaBridgeEnabled:process.env.WASLA_BRIDGE_ENABLED==='true',
    studioAiDataDir:process.env.STUDIO_AI_DATA_DIR||resolve('.data/studio-ai'),browserProfileDir:process.env.BROWSER_PROFILE_DIR||resolve('.data/browser-profile'),groqVisionModel:process.env.GROQ_VISION_MODEL||'qwen/qwen3.8-27b',
    googleAds:{clientId:process.env.GOOGLE_ADS_CLIENT_ID||undefined,clientSecret:process.env.GOOGLE_ADS_CLIENT_SECRET||undefined,tokenKey:process.env.GOOGLE_ADS_TOKEN_KEY||undefined,developerToken:process.env.GOOGLE_ADS_DEVELOPER_TOKEN||undefined,publishingEnabled:process.env.GOOGLE_ADS_PUBLISHING_ENABLED==='true',maxDailyBudgetMicros:/^\d{1,6}$/.test(process.env.GOOGLE_ADS_MAX_DAILY_BUDGET??'')?BigInt(process.env.GOOGLE_ADS_MAX_DAILY_BUDGET!)*1000000n:undefined},
    inference:withoutExternalAI(inferenceConfigFromEnv(process.env,undefined)),
    learningLocalModel:process.env.LEARNING_EVALUATION_MODEL?{model:process.env.LEARNING_EVALUATION_MODEL,baseUrl:process.env.LEARNING_EVALUATION_OLLAMA_URL||'http://127.0.0.1:11434'}:undefined,
    executor:executorConfigFromEnv(process.env,process.cwd(),process.env.NODE_ENV==='production'),
    adsLab:adsLabConfigFromEnv(process.env,executorConfigFromEnv(process.env,process.cwd(),process.env.NODE_ENV==='production')),
    studioGatewayUrl:process.env.STUDIO_GATEWAY_URL||undefined,studioGatewaySecret:process.env.STUDIO_GATEWAY_SECRET||undefined,studioPreviewPort:Number(process.env.STUDIO_PREVIEW_PORT||5000),
  };
}
