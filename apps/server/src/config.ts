import 'dotenv/config';
import type { AppConfig } from './app.js';
import { resolve,delimiter } from 'node:path';
export function getConfig(): AppConfig {
  return {
    dataDir: process.env.DATA_DIR ?? '.data/postgres', databaseUrl: process.env.DATABASE_URL || undefined,
    authSecret: process.env.BETTER_AUTH_SECRET ?? '', internalSecret: process.env.INTERNAL_API_SECRET ?? '',
    setupToken: process.env.SETUP_TOKEN ?? '', webOrigin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000',
    production: process.env.NODE_ENV === 'production', runWorker: process.env.RUN_WORKER !== 'false',
    groqApiKey:process.env.GROQ_API_KEY||undefined,groqModel:process.env.GROQ_MODEL||'openai/gpt-oss-20b',groqReasoningModel:process.env.GROQ_REASONING_MODEL||'openai/gpt-oss-120b',
    codingDataDir:process.env.CODING_DATA_DIR||resolve('.data/coding'),codingAllowedRoots:process.env.CODING_ALLOWED_ROOTS?.split(delimiter).filter(Boolean)??[process.cwd()],
    windowsEnabled:process.env.NODE_ENV==='production'?process.env.WINDOWS_REMOTE_ENABLED==='true':process.env.WINDOWS_REMOTE_ENABLED!=='false',
    studioAiDataDir:process.env.STUDIO_AI_DATA_DIR||resolve('.data/studio-ai'),browserProfileDir:process.env.BROWSER_PROFILE_DIR||resolve('.data/browser-profile'),groqVisionModel:process.env.GROQ_VISION_MODEL||'qwen/qwen3.8-27b',
    studioGatewayUrl:process.env.STUDIO_GATEWAY_URL||undefined,studioGatewaySecret:process.env.STUDIO_GATEWAY_SECRET||undefined,studioPreviewPort:Number(process.env.STUDIO_PREVIEW_PORT||5000),
  };
}
