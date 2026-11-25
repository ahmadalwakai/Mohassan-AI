import type { Quota } from './sample.js';

export const quotas = [
  { dataset: 'mintaka', area: 'factual', language: 'ar', count: 285 },
  { dataset: 'tydiqa', area: 'factual', language: 'ar', count: 140 },
  { dataset: 'mintaka', area: 'comparison', language: 'ar', count: 35 },
  { dataset: 'massive', area: 'refusal', language: 'ar', count: 138 },
  { dataset: 'massive', area: 'clarification', language: 'ar', count: 2 },
  { dataset: 'mintaka', area: 'factual', language: 'en', count: 45 },
  { dataset: 'tydiqa', area: 'factual', language: 'en', count: 45 },
  { dataset: 'mintaka', area: 'comparison', language: 'en', count: 35 },
  { dataset: 'canard', area: 'follow-up', language: 'en', count: 95 },
  { dataset: 'gsm8k', area: 'calculation', language: 'en', count: 110 },
  { dataset: 'mbpp', area: 'coding', language: 'en', count: 85 },
  { dataset: 'clinc150', area: 'small-talk', language: 'en', count: 50 },
  { dataset: 'clinc150', area: 'refusal', language: 'en', slice: 'in-scope', count: 54 },
  { dataset: 'clinc150', area: 'refusal', language: 'en', slice: 'oos', count: 6 },
  { dataset: 'massive', area: 'refusal', language: 'en', count: 60 },
  { dataset: 'clinc150', area: 'clarification', language: 'en', count: 15 },
] as const satisfies readonly Quota[];
