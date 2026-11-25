import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { WorkspaceRole } from '../../members.js';
import { restoreRunLedger } from '../agent-run.js';
import { projectRunDeliberation } from './run-ledger.js';

/** Adds private trace fields only to the authenticated polling/detail response. */
export function installDeliberationRunView(app: FastifyInstance, db: Kysely<any>,
  owner: (request: FastifyRequest) => Promise<{ id: string }>,
  role: (ownerId: string) => Promise<WorkspaceRole | null>) {
  app.addHook('preSerialization', async (request, reply, payload) => {
    const path = request.routeOptions.url;
    if (reply.statusCode !== 200 || !path?.startsWith('/api/chat/conversations')) return payload;
    if (!payload || typeof payload !== 'object' || !('id' in payload) || typeof payload.id !== 'string' || !('run' in payload)) return payload;
    const run = payload.run;
    if (!run || typeof run !== 'object' || !('id' in run) || typeof run.id !== 'string') return payload;
    // A keyed POST may replay a chat snapshot cached before trace projection moved out of the runtime response.
    const { deliberation: _trace, earlierDeliberation: _earlier, ...publicRun } = run as { id: string } & Record<string, unknown>;
    const publicPayload = { ...payload, run: publicRun };
    if (request.method !== 'GET' || path !== '/api/chat/conversations/:id') return publicPayload;
    try {
      const { id: ownerId } = await owner(request);
      if (await role(ownerId) !== 'owner') return publicPayload;
      const row = await db.selectFrom('chat_runs').select('state').where('id', '=', run.id)
        .where('conversation_id', '=', payload.id).where('owner_id', '=', ownerId).executeTakeFirst();
      const trace = projectRunDeliberation(restoreRunLedger(row?.state?.agentRun, run.id), true);
      return trace.deliberation || trace.earlierDeliberation ? { ...publicPayload, run: { ...publicRun, ...trace } } : publicPayload;
    } catch {
      request.log.warn({ event: 'deliberation_projection_unavailable' });
      return publicPayload;
    }
  });
}
