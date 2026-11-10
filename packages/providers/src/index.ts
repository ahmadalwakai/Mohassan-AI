export { classifyProviderFallback, MAX_AUTOMATIC_RETRY_DELAY_MS, parseRetryAfterHeader, validatedRetryAfterMs, waitForRetryAfter, type ProviderFallbackDecision } from './retry.js';
export * from './ollama.js';

export interface ModelRequest {
  goal:string; maxTokens?:number; signal?:AbortSignal; system?:string;
  structured?:{name:string;schema:Record<string,unknown>};
  image?:{mimeType:'image/png'|'image/jpeg';data:string};
}
export interface ModelUsage {inputTokens:number;outputTokens:number}
export interface ModelRateState {remainingTokens:number;resetMs:number}
export interface ModelResult {
  text:string;model:string;usage:ModelUsage;rate?:ModelRateState;
  /** True when the provider omitted usage and the counts are a local estimate. */
  usageEstimated?:boolean;provider?:string;
}
export interface ModelProvider {readonly id:string;generate(request:ModelRequest):Promise<ModelResult>}
export class ProviderError extends Error {
  usage?:ModelUsage;
  /** Original valid provider delay; waiting policy must not shorten this value. */
  retryAfterMs?:number;
  retryAfterInvalid?:boolean;
  /** The model's text when a provider rejected it for failing the schema. */
  failedGeneration?:string;
  constructor(public readonly code:string,message:string,public readonly retryable=false,public readonly httpStatus?:number){super(message);this.name='ProviderError';}
}
export function redactSecrets(text:string):string {
  return text.replace(/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|https?):\/\/)[^\s\/@:]+:[^\s\/@]+@/gi,'$1[اعتماد محجوب]@')
    .replace(/\bgsk_[A-Za-z0-9_-]{12,}\b/g,'[مفتاح محجوب]')
    .replace(/\bnpg_[A-Za-z0-9_-]{12,}\b/g,'[اعتماد محجوب]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g,'[مفتاح محجوب]')
    .replace(/\bBearer\s+[A-Za-z0-9_.-]{16,}/gi,'Bearer [محجوب]');
}
