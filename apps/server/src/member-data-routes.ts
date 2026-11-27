import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { MemberAccountIdSchema, MemberAuditQuerySchema, MemberDataExportQuerySchema } from '@mohassan/contracts';
import { createMemberDataExport } from './member-data-export.js';
import { listMemberAudit, recordMemberAudit } from './member-audit.js';
import { endMemberSessions, endOtherAccountSessions, listAccountSessions } from './member-sessions.js';

const data = '/api/member-data';
export const MEMBER_DATA_ROUTES = [
  `GET ${data}/export`, `GET ${data}/sessions`, `DELETE ${data}/sessions`,
  `GET ${data}/deletion`, `POST ${data}/deletion`, `DELETE ${data}/deletion`,
] as const;

const empty = z.object({}).strict();

export async function registerMemberDataRoutes(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner: (request: FastifyRequest) => Promise<{ id: string; sessionId: string }>;
  role: (request: FastifyRequest) => Promise<'owner' | 'member'>;
  documentsDir: string;
}) {
  const { db, owner, role } = options;
  const exports = createMemberDataExport(db, { documentsDir: options.documentsDir });
  const requireOwner = async (request: FastifyRequest) => {
    if (await role(request) !== 'owner') throw Object.assign(new Error('هذه الخدمة غير متاحة لحسابك.'), {
      statusCode: 403, code: 'MEMBER_FORBIDDEN',
    });
  };

  app.get(`${data}/export`, { exposeHeadRoute: false }, async (request, reply) => {
    const query = MemberDataExportQuerySchema.parse(request.query);
    const { id } = await owner(request);
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());
    let archive: Awaited<ReturnType<typeof exports.prepare>>;
    try {
      archive = await exports.prepare(id, abort.signal, query);
    } catch (error) {
      const seconds = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (typeof seconds === 'number') reply.header('Retry-After', String(seconds));
      throw error;
    }
    reply.raw.once('finish', () => {
      if (reply.statusCode !== 200) return;
      void recordMemberAudit(db, { actorId: id, targetId: id, action: 'export_downloaded' }).catch(() => {
        console.error(JSON.stringify({ level: 'error', event: 'member_export_audit_failed' }));
      });
    });
    return reply.type('application/zip')
      .header('Content-Disposition', 'attachment; filename="mohassan-data.zip"')
      .header('Content-Length', archive.bytes)
      .send(archive.stream);
  });
  app.get(`${data}/sessions`, async request => {
    empty.parse(request.query);
    const user = await owner(request);
    return { sessions: await listAccountSessions(db, user.id, user.sessionId) };
  });
  app.delete(`${data}/sessions`, async request => {
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    const user = await owner(request);
    return endOtherAccountSessions(db, user.id, user.sessionId);
  });
  app.get('/api/members/audit', async request => {
    await requireOwner(request);
    return listMemberAudit(db, MemberAuditQuerySchema.parse(request.query));
  });
  app.delete<{ Params: { userId: string } }>('/api/members/:userId/sessions', async request => {
    await requireOwner(request);
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    return endMemberSessions(db, MemberAccountIdSchema.parse(request.params.userId));
  });
}
