import { z } from 'zod';
import { ChatKeyboardSchema, ChatPointerSchema, ChatSecureRequestSchema } from './command-chat';

// Small-mode budget from https://github.com/ahmadalwakai/Mohassan-AI/pull/36 (retrieved 2026-11-27).
export const browserLiveBudget = { intervalMs: 1_000, maxFrameBytes: 256 * 1024 } as const;
export const browserLiveFrameHeader = 'x-mohassan-browser-frame';

// PR #36 uses the first eight keys. The remaining four are viewport navigation keys from
// https://www.w3.org/TR/uievents-key/#keys-navigation (retrieved 2026-11-27).
export const browserLiveKeys = [...ChatKeyboardSchema.shape.key.unwrap().options, 'PageUp', 'PageDown', 'Home', 'End'] as const;

const browserLiveInputTarget = { handoverId: z.uuid(), frameId: z.uuid() };
export const BrowserLiveInputSchema = z.discriminatedUnion('kind', [
  ChatPointerSchema.extend({ ...browserLiveInputTarget, kind: z.literal('pointer') }),
  z.object({ ...browserLiveInputTarget, kind: z.literal('keyboard'), text: ChatKeyboardSchema.shape.text.unwrap().min(1).optional(), key: z.enum(browserLiveKeys).optional() }).strict(),
]).refine(input => input.kind !== 'keyboard' || Boolean(input.key) !== Boolean(input.text));
export type BrowserLiveInput = z.infer<typeof BrowserLiveInputSchema>;

export const browserLiveHandoverNote = 'أكمل الخطوة في نافذة المتصفح، ثم اضغط «متابعة» لإعادة التحكم إلى موحسن.';

export function isBrowserLiveHandover(secure: unknown): boolean {
  return readBrowserLiveHandover(secure) !== null;
}

export function readBrowserLiveHandover(secure: unknown): { id: string; prompt: string } | null {
  const card = ChatSecureRequestSchema.safeParse(secure);
  if (!card.success || card.data.kind !== 'hands_on' || card.data.fields.length || card.data.note !== browserLiveHandoverNote) return null;
  return { id: card.data.id, prompt: card.data.prompt };
}

export type BrowserLiveStatus = { runId: string | null; handover: ReturnType<typeof readBrowserLiveHandover> };
