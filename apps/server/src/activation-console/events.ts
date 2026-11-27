// Adapted from PR #43's event projections, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/470d5593e4c8/apps/server/src/activation-registry.ts
export interface ActivationEvent {
  name: string;
  at: Date;
  changed: boolean | null;
  error: boolean;
}

export function logObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function event(name: string, at: Date, changed: boolean | null = null, error = false): ActivationEvent {
  return { name, at, changed, error };
}

export function projectConsoleObservation(value: Record<string, unknown>, at: Date): ActivationEvent | undefined {
  switch (value.event) {
    case 'plan_compiler_shadow':
      return event('MOHASSAN_PLAN_COMPILER', at, null, value.status === 'compile_failed');
    case 'structured_memory_shadow':
      return event('MOHASSAN_STRUCTURED_MEMORY', at);
    case 'conversation_review_unavailable':
      return event('MOHASSAN_CONVERSATION_REVIEW_APPLY', at, null, true);
    case 'clarification_shadow':
      return event('MOHASSAN_CLARIFY_CHOICES', at, value.enabled === true ? null : value.decision === 'ask' ? true
        : value.legacyWouldAsk === false && value.decision === 'clear_winner' ? false : null);
    case 'extractive_writing_shadow':
      return event('MOHASSAN_EXTRACTIVE_WRITING', at);
  }
}

export function projectFileObservations(source: 'judge' | 'conversation', value: Record<string, unknown>, at: Date): ActivationEvent[] {
  if (source === 'conversation') {
    const agreement = logObject(value.agreement);
    if (!agreement && value.mode !== 'active') return [];
    const changed = value.mode === 'active' ? null : agreement?.type === false || agreement?.standalone === false ? true
      : agreement?.type === true ? false : null;
    return [event('MOHASSAN_CONVERSATION_SHADOW', at, changed)];
  }
  const result: ActivationEvent[] = [];
  const decision = value.decision;
  if (decision === 'send' || decision === 'fix' || decision === 'withhold') {
    result.push(event('MOHASSAN_JUDGE_SHADOW', at));
    if (decision === 'fix') result.push(event('MOHASSAN_JUDGE_FIX', at));
    if (decision === 'withhold') result.push(event('MOHASSAN_JUDGE_WITHHOLD', at));
  }
  const review = logObject(value.conversationReview);
  if (review?.action === 'send' || review?.action === 'fix' || review?.action === 'note') {
    result.push(event('MOHASSAN_CONVERSATION_REVIEW_APPLY', at, review.applied === true ? null : review.action !== 'send'));
  }
  return result;
}
