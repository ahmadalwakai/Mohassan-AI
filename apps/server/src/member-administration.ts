import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import type { registerMemberRoutes } from './members.js';
import { withMemberAuditActor } from './member-audit.js';

export { MEMBER_DATA_ROUTES } from './member-data-routes.js';
export { readLimitedMemberAccess } from './member-data-request.js';

type MemberRouteOptions = Parameters<typeof registerMemberRoutes>[1];
type MemberUser = Awaited<ReturnType<MemberRouteOptions['owner']>>;

// Existing member administration routes at c2a0ff7 (retrieved 2026-11-25).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/members.ts
const auditedRoutes = new Set([
  '/api/members/invites',
  '/api/members/invites/:id/revoke',
  '/api/members/:id/access',
]);

/** Run existing member administration writes with their verified actor in the same transaction. */
export function registerAuditedMemberRoutes(app: FastifyInstance, options: MemberRouteOptions, registerRoutes: typeof registerMemberRoutes) {
  const scope = new AsyncLocalStorage<{ request: FastifyRequest; actor: MemberUser; tx: Transaction<any> }>();
  const db = new Proxy(options.db, {
    get(base, property) {
      const tx = scope.getStore()?.tx;
      // Legacy registration starts its own transaction with .execute; join the audit transaction.
      if (tx && property === 'transaction') {
        return () => ({ execute: <T>(run: (current: Transaction<any>) => Promise<T>) => run(tx) });
      }
      const source = tx ?? base;
      const value = Reflect.get(source, property, source);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });

  app.addHook('onRoute', route => {
    if (route.method !== 'POST' || !auditedRoutes.has(route.url)) return;
    const handle = route.handler;
    route.handler = async function (request, reply) {
      const actor = await options.owner(request);
      if (await options.role(request) !== 'owner') return handle.call(this, request, reply);
      return withMemberAuditActor(options.db, actor.id, async tx =>
        scope.run({ request, actor, tx }, () => handle.call(this, request, reply)));
    };
  });

  return registerRoutes(app, {
    ...options,
    db,
    owner: async request => {
      const active = scope.getStore();
      return active?.request === request ? active.actor : options.owner(request);
    },
    role: async request => scope.getStore()?.request === request ? 'owner' : options.role(request),
  });
}
