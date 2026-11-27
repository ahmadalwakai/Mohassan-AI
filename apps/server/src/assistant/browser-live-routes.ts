import { BrowserError } from '@mohassan/browser';
import { BrowserLiveInputSchema, browserLiveBudget, browserLiveFrameHeader, readBrowserLiveHandover, type BrowserLiveInput, type BrowserLiveStatus } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { abortWhenClosed } from '../chat-wait.js';

interface BrowserLiveControl {
  hasPage(ownerId: string, conversationId: string, runId: string): boolean | Promise<boolean>;
  frame(ownerId: string, conversationId: string, runId: string, signal?: AbortSignal): Promise<{ id: string; bytes: Buffer } | null>;
  input(ownerId: string, conversationId: string, runId: string, input: BrowserLiveInput, signal?: AbortSignal): Promise<unknown>;
  continue(ownerId: string, conversationId: string, runId: string, handoverId: string): Promise<unknown>;
}

interface BrowserLiveRouteOptions {
  db: Kysely<any>;
  owner(request: FastifyRequest): Promise<{ id: string }>;
  isOwner(ownerId: string): Promise<boolean>;
  enabled: boolean;
  live: BrowserLiveControl;
}

const base = '/api/chat/conversations/:id/browser/live';
const uuid = z.uuid();
const continueSchema = z.object({ handoverId: uuid }).strict();
const activeStatuses = new Set(['running', 'waiting_input', 'waiting_approval', 'waiting_user']);
// Preserve the existing live and secure route limits from command-chat.ts.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts (retrieved 2026-11-27).
const liveRate = { rateLimit: { max: 400, timeWindow: '1 minute' } };
const continueRate = { rateLimit: { max: 12, timeWindow: '1 minute' } };
const forbidden = () => new BrowserError('MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.', 403);
const unavailable = () => new BrowserError('CHAT_BROWSER_LIVE_UNAVAILABLE', 'لا توجد جلسة متصفح مباشرة لهذا الطلب.', 404);
const handoverChanged = () => new BrowserError('CHAT_BROWSER_HANDOVER_CHANGED', 'لم تعد هذه الخطوة معلّقة.', 409);

export function registerBrowserLiveRoutes(app: FastifyInstance, { db, owner, isOwner, enabled, live }: BrowserLiveRouteOptions) {
  // The same conversation shares one capture slot across browser tabs and across run switches.
  // Release it only after the frame completes and the interval elapses, even for discarded frames.
  const captureSlots = new Map<string, ReturnType<typeof setTimeout> | null>();
  app.addHook('onClose', async () => { for (const timer of captureSlots.values()) if (timer) clearTimeout(timer); });
  type Conversation = { Params: { id: string } };
  type Run = { Params: { id: string; runId: string } };

  async function requireOwner(request: FastifyRequest) {
    const { id } = await owner(request);
    if (!await isOwner(id)) throw forbidden();
    if (!enabled) throw unavailable();
    return id;
  }

  async function activeRun(ownerId: string, conversationId: string): Promise<BrowserLiveStatus> {
    const row = await db.selectFrom('chat_conversations as c')
      .leftJoin('chat_runs as r', join => join.onRef('r.id', '=', 'c.active_run_id')
        .onRef('r.conversation_id', '=', 'c.id').onRef('r.owner_id', '=', 'c.owner_id')
        .onRef('r.status', '=', 'c.status').on('r.lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`))
      .select(['r.id as runId', 'c.status', 'c.secure'])
      .where('c.id', '=', conversationId).where('c.owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw unavailable();
    if (!row.runId || !activeStatuses.has(row.status)) return { runId: null, handover: null };
    return { runId: row.runId as string, handover: row.status === 'waiting_input' ? readBrowserLiveHandover(row.secure) : null };
  }

  async function runScope(request: FastifyRequest<Run>) {
    const ownerId = await requireOwner(request);
    const conversationId = uuid.parse(request.params.id);
    const runId = uuid.parse(request.params.runId);
    const current = await activeRun(ownerId, conversationId);
    if (current.runId !== runId) throw unavailable();
    return { ownerId, conversationId, runId, handover: current.handover };
  }

  app.get<Conversation>(base, { config: liveRate, exposeHeadRoute: false }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ownerId = await requireOwner(request);
    const conversationId = uuid.parse(request.params.id);
    const current = await activeRun(ownerId, conversationId);
    if (!current.runId || current.handover || await live.hasPage(ownerId, conversationId, current.runId)) return current;
    return { runId: null, handover: null };
  });

  app.get<Run>(`${base}/:runId/frame`, { config: liveRate, exposeHeadRoute: false }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const signal = abortWhenClosed(reply.raw);
    const { ownerId, conversationId, runId } = await runScope(request);
    if (signal.aborted) return reply.code(204).send();
    const key = `${ownerId}/${conversationId}`;
    if (captureSlots.has(key)) return reply.header('Retry-After', String(Math.ceil(browserLiveBudget.intervalMs / 1000))).code(429).send();
    captureSlots.set(key, null);
    try {
      const frame = await live.frame(ownerId, conversationId, runId, signal);
      if (signal.aborted || !frame?.bytes.length || frame.bytes.length > browserLiveBudget.maxFrameBytes) return reply.code(204).send();
      if (!await isOwner(ownerId)) throw forbidden();
      if ((await activeRun(ownerId, conversationId)).runId !== runId) throw unavailable();
      if (signal.aborted) return reply.code(204).send();
      return reply.type('image/jpeg').header('Content-Disposition', 'inline').header(browserLiveFrameHeader, frame.id).send(frame.bytes);
    } catch (error) {
      if (signal.aborted) return reply.code(204).send();
      throw error;
    } finally {
      const timer = setTimeout(() => captureSlots.delete(key), browserLiveBudget.intervalMs);
      captureSlots.set(key, timer.unref());
    }
  });

  app.post<Run>(`${base}/:runId/input`, { config: liveRate }, async (request, reply) => {
    const signal = abortWhenClosed(reply.raw);
    const { ownerId, conversationId, runId, handover } = await runScope(request);
    const input = BrowserLiveInputSchema.parse(request.body);
    if (handover?.id !== input.handoverId) throw handoverChanged();
    if (!signal.aborted) await live.input(ownerId, conversationId, runId, input, signal);
    return reply.code(204).send();
  });

  app.post<Run>(`${base}/:runId/continue`, { config: continueRate }, async (request, reply) => {
    const { ownerId, conversationId, runId, handover } = await runScope(request);
    const { handoverId } = continueSchema.parse(request.body);
    if (handover?.id !== handoverId) throw handoverChanged();
    await live.continue(ownerId, conversationId, runId, handoverId);
    return reply.code(204).send();
  });
}
