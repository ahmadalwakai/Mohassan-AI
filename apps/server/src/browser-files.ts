import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { AgentBrowser, BrowserError, createBrowserFileControl, migrateBrowserFiles } from '@mohassan/browser';

/** Owner HTTP actions only. The model has no file-grant, approval or release tool. */
export async function registerBrowserFileRoutes(app: FastifyInstance, { db, browser, owner }: { db: Kysely<any>; browser: AgentBrowser; owner: (request: any) => Promise<{ id: string }> }) {
  await migrateBrowserFiles(db);
  const control = createBrowserFileControl(db, browser, async (ownerId, conversationId, requireIdle) => {
    const row = await db.selectFrom('chat_conversations').select(['id', 'status', 'active_run_id', 'browser_account']).where('owner_id', '=', ownerId).where('id', '=', conversationId).executeTakeFirst();
    if (!row) throw new BrowserError('BROWSER_FILE_CONVERSATION_NOT_FOUND', 'المحادثة غير موجودة.', 404);
    if (requireIdle && (row.active_run_id || ['running', 'waiting_input', 'waiting_approval', 'waiting_user'].includes(row.status))) throw new BrowserError('BROWSER_FILE_CONVERSATION_BUSY', 'أوقف المهمة أو أكملها قبل نقل ملف.', 409);
    return { accountId: row.browser_account ?? null };
  });
  await control.recover();
  await control.sweep();
  let maintenance: Promise<unknown> | undefined;
  const timer = setInterval(() => { if (!maintenance) { maintenance = control.sweep().catch(() => {}).finally(() => { maintenance = undefined; }); } }, 60000);
  timer.unref();
  type Params = { conversationId: string; id: string };
  const keys = (request: { params: Partial<Params> }) => ({ conversation: z.uuid().parse(request.params.conversationId), id: z.uuid().parse(request.params.id) });
  const base = '/api/browser/files/:conversationId';
  app.get<{ Params: Params }>(base, async request => control.list((await owner(request)).id, z.uuid().parse(request.params.conversationId)));
  app.get<{ Params: Params }>(`${base}/targets`, async request => control.targets((await owner(request)).id, z.uuid().parse(request.params.conversationId)));
  app.post<{ Params: Params }>(`${base}/grants`, { bodyLimit: 720000, config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async request => control.create((await owner(request)).id, z.uuid().parse(request.params.conversationId), request.body));
  app.post<{ Params: Params }>(`${base}/grants/:id/execute`, { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async request => { const { conversation, id } = keys(request); return control.execute((await owner(request)).id, conversation, id, request.body); });
  app.delete<{ Params: Params }>(`${base}/grants/:id`, async request => { const { conversation, id } = keys(request); return control.revoke((await owner(request)).id, conversation, id); });
  app.post<{ Params: Params }>(`${base}/grants/:id/release`, async request => { const { conversation, id } = keys(request); return control.release((await owner(request)).id, conversation, id, request.body); });
  app.get<{ Params: Params }>(`${base}/grants/:id/content`, async (request, reply) => {
    const { conversation, id } = keys(request), result = await control.content((await owner(request)).id, conversation, id);
    const fallback = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,99}$/.test(result.name) ? result.name : 'download.bin';
    return reply.type('application/octet-stream').header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(result.name)}`).send(result.bytes);
  });
  app.addHook('preClose', async () => { clearInterval(timer); await maintenance; await control.shutdown(); });
  return control;
}
