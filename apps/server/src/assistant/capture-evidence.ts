import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentCaptureResult, AgentPage } from '@mohassan/browser';

const identity = z.string().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pageHash = z.string().regex(/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/);
const stamp = z.iso.datetime();
const ReceiptSchema = z.object({
  version: z.literal(1), scope: z.literal('stable_observation_samples'),
  ownerId: identity, conversationId: identity, requestedPageId: identity, pageId: identity,
  pageHash, url: z.string().min(1).max(2500), imageHash: hash,
  imageBytes: z.number().int().min(4).max(8 * 1024 * 1024), mimeType: z.literal('image/jpeg'),
  startedAt: stamp, finishedAt: stamp, captureStartedAt: stamp, captureFinishedAt: stamp,
  documentFingerprint: hash, viewportFingerprint: hash, beforeFingerprint: hash, afterFingerprint: hash,
}).strict();

export interface ValidatedChatCapture {
  page: AgentPage;
  image: Buffer;
  imageHash: string;
  capturedAt: number;
}

/**
 * Validate a result from the trusted browser method against the current host
 * scope and the actual JPEG. Equal samples do not prove atomic DOM/pixel truth.
 * Model/page JSON must never be used as a browser result at this boundary.
 */
export function validateChatCapture(capture: AgentCaptureResult, expected: {
  ownerId: string; conversationId: string; requestedPage: Pick<AgentPage, 'id' | 'url' | 'hash'>;
  startedAt: number; now?: number;
}): ValidatedChatCapture | null {
  const now = expected.now ?? Date.now();
  if (capture?.status !== 'captured' || !Buffer.isBuffer(capture.image) || !capture.page
    || !Number.isFinite(expected.startedAt) || !Number.isFinite(now) || expected.startedAt > now) return null;
  const parsed = ReceiptSchema.safeParse(capture.receipt);
  if (!parsed.success) return null;
  const receipt = parsed.data, page = capture.page;
  if (page.documentStatus !== undefined && (!Number.isInteger(page.documentStatus) || page.documentStatus < 100 || page.documentStatus > 599)) return null;
  if (receipt.ownerId !== expected.ownerId || receipt.conversationId !== expected.conversationId
    || receipt.requestedPageId !== expected.requestedPage.id || receipt.pageId !== page.id
    || receipt.pageHash !== page.hash || receipt.pageHash !== expected.requestedPage.hash
    || receipt.url !== page.url || receipt.url !== expected.requestedPage.url
    || !identity.safeParse(page.id).success || !pageHash.safeParse(page.hash).success
    || receipt.beforeFingerprint !== receipt.afterFingerprint) return null;
  const url = URL.parse(receipt.url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const started = Date.parse(receipt.startedAt), captureStarted = Date.parse(receipt.captureStartedAt);
  const captureFinished = Date.parse(receipt.captureFinishedAt), finished = Date.parse(receipt.finishedAt);
  const observed = Date.parse(page.observedAt);
  if (!Number.isFinite(observed) || expected.startedAt > started || started > captureStarted
    || captureStarted > captureFinished || captureFinished > observed || observed > finished || finished > now) return null;
  // Copy before hashing so a caller-held buffer cannot alter the validated bytes.
  if (capture.image.length !== receipt.imageBytes || capture.image.length > 8 * 1024 * 1024) return null;
  const image = Buffer.from(capture.image);
  if (image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9
    || createHash('sha256').update(image).digest('hex') !== receipt.imageHash) return null;
  return { page, image, imageHash: receipt.imageHash, capturedAt: finished };
}
