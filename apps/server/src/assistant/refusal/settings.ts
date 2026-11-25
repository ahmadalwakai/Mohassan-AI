import type { RefusalCode } from './types.js';

export function refusalPolicyEnabled(): boolean {
  return process.env.MOHASSAN_REFUSAL_POLICY === '1';
}

/** Requests and operands can contain credentials. Log only bounded metadata. */
export function logRefusalDecision(reason: RefusalCode, enabled: boolean): void {
  console.info(JSON.stringify({ event: 'assistant_refusal_policy', mode: enabled ? 'enforce' : 'shadow', reason }));
}
