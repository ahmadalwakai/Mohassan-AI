import { createHash } from 'node:crypto';
import { z } from 'zod';

const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const identity = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const text = z.string().min(1).max(4000).refine(value => !!value.trim() && !/[\u0000\ud800-\udfff]/u.test(value));
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const ClarifiedRequestSourceSchema = z.object({ version: z.literal(1), messageId: identity,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type ClarifiedRequestSource = z.infer<typeof ClarifiedRequestSourceSchema>;
const Binding = z.object({ ownerId: identity, conversationId: identity, createdAt: instant, goal: text, now: instant }).strict();
const Message = z.object({ id: identity, ownerId: identity, conversationId: identity, role: z.literal('user'), text,
  createdAt: instant }).strict();
export type EffectiveRequestUserMessage = z.infer<typeof Message>;
export interface EffectiveRequestSourceInput {
  ownerId: string; conversationId: string; createdAt: number; goal: unknown; state: unknown; now: number;
}
export interface EffectiveRequestSource {
  request: string;
  evaluatedAt: number;
  source: 'run_created' | 'clarification_message';
}
export interface EffectiveRequestMessageLookup { ownerId: string; conversationId: string; messageId: string }
export type EffectiveRequestMessageLoader = (lookup: EffectiveRequestMessageLookup) => Promise<unknown>;

/** Metadata only. The message timestamp must subsequently be read from the host DB. */
export function createClarifiedRequestSource(request: unknown, messageId: unknown): ClarifiedRequestSource | null {
  const checked = text.safeParse(request), id = identity.safeParse(messageId);
  return checked.success && id.success ? { version: 1, messageId: id.data, requestHash: hash(checked.data) } : null;
}

function ownField(value: unknown, field: string): { present: boolean; value?: unknown; invalid?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { present: false, invalid: true };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { present: false, invalid: true };
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor) return { present: false, ...(field in value ? { invalid: true } : {}) };
  return 'value' in descriptor && descriptor.enumerable ? { present: true, value: descriptor.value } : { present: true, invalid: true };
}
const ownDataFields = (value: unknown, fields: readonly string[]) => fields.every(field => {
  const checked = ownField(value, field); return checked.present && !checked.invalid;
});

/**
 * Bind the effective full user instruction to a trusted host timestamp. This is
 * provenance, never tool permission. Missing/malformed NEW source metadata fails
 * closed; only legacy rows without that property retain run-created-time behavior.
 * The loader must project the exact owner+conversation-scoped DB user message.
 * No provider fields, receipt values, model notes, files or environment are read.
 */
export async function resolveEffectiveRequestSource(input: EffectiveRequestSourceInput, loadMessage: EffectiveRequestMessageLoader): Promise<EffectiveRequestSource | null> {
  try {
    const binding = Binding.safeParse({ ownerId: input.ownerId, conversationId: input.conversationId, createdAt: input.createdAt, goal: input.goal, now: input.now });
    if (!binding.success || binding.data.now < binding.data.createdAt) return null;
    const clarified = ownField(input.state, 'clarifiedRequest'), source = ownField(input.state, 'clarifiedRequestSource');
    if (clarified.invalid || source.invalid) return null;
    const checkedRequest = text.safeParse(clarified.present ? clarified.value : binding.data.goal);
    if (!checkedRequest.success) return null;
    const request = checkedRequest.data;
    if (!source.present) return { request, evaluatedAt: binding.data.createdAt, source: 'run_created' };
    if (!clarified.present) return null;
    if (!ownDataFields(source.value, ['version', 'messageId', 'requestHash'])) return null;
    const pointer = ClarifiedRequestSourceSchema.safeParse(source.value);
    if (!pointer.success || pointer.data.requestHash !== hash(request) || typeof loadMessage !== 'function') return null;
    const loaded = await loadMessage({ ownerId: binding.data.ownerId, conversationId: binding.data.conversationId, messageId: pointer.data.messageId });
    if (!ownDataFields(loaded, ['id', 'ownerId', 'conversationId', 'role', 'text', 'createdAt'])) return null;
    const message = Message.safeParse(loaded);
    if (!message.success || message.data.id !== pointer.data.messageId || message.data.ownerId !== binding.data.ownerId
      || message.data.conversationId !== binding.data.conversationId || message.data.text !== request
      || hash(message.data.text) !== pointer.data.requestHash || message.data.createdAt < binding.data.createdAt || message.data.createdAt > binding.data.now) return null;
    return { request, evaluatedAt: message.data.createdAt, source: 'clarification_message' };
  } catch { return null; }
}
