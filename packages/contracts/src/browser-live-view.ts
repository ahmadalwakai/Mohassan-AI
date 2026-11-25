import { z } from 'zod';
import type { ChatBrowserVisibility, ChatConversation } from './command-chat';

export const browserLiveCorners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type BrowserLiveCorner = typeof browserLiveCorners[number];

export const browserLiveAttentionCodes = ['needs_login', 'needs_code', 'hands_on', 'needs_approval'] as const;
export type BrowserLiveAttentionCode = typeof browserLiveAttentionCodes[number];

export type BrowserLiveMode = 'small' | 'medium' | 'pill' | 'closed';

export const browserLiveBudget = {
  framesPerSecond: { small: 1, medium: 4, pill: 0, closed: 0 },
  maxFrameBytes: 256 * 1024,
  viewport: { width: 1280, height: 800 },
} as const;

export interface BrowserLiveCaption {
  caption: string;
  visibility: ChatBrowserVisibility;
}

export interface BrowserLiveSnapshot extends BrowserLiveCaption {
  conversationId: string;
  runId: string | null;
  status: ChatConversation['status'];
  title: string;
  secure: ChatConversation['secure'];
  approval: ChatConversation['approval'];
}

export interface BrowserLiveAttention {
  code: BrowserLiveAttentionCode;
  id: string;
  message: string;
  detail?: string;
}

/** The wheel payload uses viewport fractions and Chromium wheel deltas in CSS pixels. */
export const BrowserLiveWheelSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  deltaX: z.number().min(-1200).max(1200),
  deltaY: z.number().min(-1200).max(1200),
}).strict();
export type BrowserLiveWheel = z.infer<typeof BrowserLiveWheelSchema>;

export const browserTakeoverKeys = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type BrowserLiveInput =
  | { kind: 'pointer'; x: number; y: number }
  | { kind: 'key'; key: typeof browserTakeoverKeys[number] }
  | { kind: 'text'; text: string }
  | ({ kind: 'scroll' } & BrowserLiveWheel);

export interface BrowserLiveFrame {
  url: string;
  byteLength: number;
}

export interface BrowserLiveMetrics {
  frames: number;
  bytes: number;
  bytesPerSecond: number;
}
