import { z } from 'zod';
import { BrowserError, type AgentAction, type AgentPage } from '@mohassan/browser';

const MAX_AUTOMATIC_ATTEMPTS = 3;
const counter = z.number().int().min(0).max(2_147_483_647);
export const BrowserRecoverySchema = z.object({
  attempts: z.number().int().min(0).max(MAX_AUTOMATIC_ATTEMPTS),
  uncertain: z.literal(true).optional(),
  history: z.array(z.object({
    reason: z.string().regex(/^[A-Z_]+$|^(?:stagnation|failures)$/).max(80),
    action: z.enum(['open', 'click', 'type', 'select', 'press', 'form', 'back', 'scroll', 'wait', 'observe', 'progress']),
    strategy: z.enum(['observe_and_retry', 'restore_and_read', 'observe_and_replan']),
    step: counter,
    sequence: counter,
  }).strict()).max(MAX_AUTOMATIC_ATTEMPTS),
}).strict().refine(value => value.attempts === value.history.length
  && value.history.every((entry, index) => !index || entry.step >= value.history[index - 1].step
    && entry.sequence >= value.history[index - 1].sequence));
export type BrowserRecoveryState = z.infer<typeof BrowserRecoverySchema>;
export type BrowserRecoveryEntry = BrowserRecoveryState['history'][number];

/** A separate bounded history, never a reset of lifetime steps or effect authority. */
export function reserveBrowserRecovery(value: BrowserRecoveryState | undefined, entry: BrowserRecoveryEntry): BrowserRecoveryState | null {
  const parsed = BrowserRecoverySchema.safeParse(value ?? { attempts: 0, history: [] });
  if (!parsed.success || parsed.data.uncertain || parsed.data.attempts >= MAX_AUTOMATIC_ATTEMPTS) return null;
  const next = BrowserRecoverySchema.safeParse({ ...parsed.data, attempts: parsed.data.attempts + 1, history: [...parsed.data.history, entry] });
  return next.success ? next.data : null;
}

/** Exact host error codes only. Policy, approvals and uncertain effects never qualify. */
export function transientBrowserFailure(error: unknown, action: AgentAction | 'observe', approved = false): string | null {
  if (approved || (action !== 'observe' && action.browserHands)) return null;
  const kind = action === 'observe' ? action : action.kind;
  if (error instanceof BrowserError) {
    if (['AGENT_PAGE_CLOSED', 'AGENT_NO_PAGE', 'AGENT_PAGE_UNREADABLE'].includes(error.code)) return error.code;
    if (error.code === 'AGENT_REF_STALE' && ['click', 'type', 'select', 'form'].includes(kind)) return error.code;
    if (error.code === 'AGENT_CLICK_FAILED' && kind === 'click') return error.code;
    if (error.code === 'AGENT_NAVIGATION_FAILED' && ['open', 'back'].includes(kind)) return error.code;
  }
  // Native observation and waits dispatch no click or form submission. An
  // untyped timeout from any mutating gesture has no such before-effect proof.
  return error instanceof Error && error.name === 'TimeoutError' && ['observe', 'wait'].includes(kind) ? 'BROWSER_READ_TIMEOUT' : null;
}

/** Rebind only an exact, unique, previously observed target on the same page. */
export function rebindBrowserAction(action: AgentAction, before: AgentPage | undefined, fresh: AgentPage, reason: string): AgentAction | null {
  if (action.kind === 'open') return action;
  if (['wait', 'scroll'].includes(action.kind)) return action;
  if (action.kind === 'back' || action.kind === 'press') return null;
  if (reason !== 'AGENT_REF_STALE') return null;
  if (!before || before.url !== fresh.url || action.submit || action.kind === 'form') return null;
  // Identical DOM hashes cannot rule out localStorage or another hidden effect.
  // Only stale-reference failure proves the gesture was not dispatched.
  const original = before.elements.find(element => element.ref === action.ref);
  if (!original || !original.label.trim() || original.disabled || ['password', 'otp', 'card'].includes(original.field ?? '')) return null;
  const sameIdentity = (element: AgentPage['elements'][number]) => !element.disabled && element.role === original.role
    && element.label === original.label && element.href === original.href && element.field === original.field;
  // The host ref binds an exact previously observed DOM node. Prefer that
  // surviving identity over another lookalike; a changed surviving ref is a
  // contradiction, never permission to choose a different matching label.
  const surviving = fresh.elements.find(element => element.ref === original.ref);
  if (surviving) return sameIdentity(surviving) ? { ...action, ref: surviving.ref } : null;
  const matches = fresh.elements.filter(sameIdentity);
  return matches.length === 1 ? { ...action, ref: matches[0].ref } : null;
}
