import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AgentBrowser } from '@mohassan/browser';
import type { AppConfig } from './app.js';
import { setAuthSessionCreationCheck, type createAuth } from './auth.js';
import type { registerMemberRoutes, WorkspaceRole } from './members.js';
import { registerAuditedMemberRoutes } from './member-administration.js';
import { migrateMemberDataRights } from './member-data-migration.js';
import { memberAuthResponseBody, suspendedMemberDataAccess } from './member-data-request.js';
import { registerMemberDataRoutes } from './member-data-routes.js';
import { assertDeletionCanSignIn, memberDeletionAccess, registerMemberDeletionRoutes, startMemberDeletionPurge } from './member-deletion.js';
import { memberAuthClientIp } from './member-sessions.js';
import { memberAgentBrowserClass } from './member-profile-storage.js';

/** Decide the restricted member cases inside the existing authenticated default-deny hook. */
export async function handleMemberDataRequest(db: Kysely<any>, reply: FastifyReply, key: string, userId: string, role: WorkspaceRole | null) {
  const access = await memberDeletionAccess(db, userId, key);
  if (access === 'blocked') {
    reply.code(403).send({ error: { code: 'MEMBER_DELETION_PENDING', message: 'حسابك بانتظار الحذف. يمكنك إلغاء الطلب خلال مهلة الحذف.' } });
    return true;
  }
  if (access === 'limited') return true;
  return role === null && await suspendedMemberDataAccess(db, userId, key);
}

type MemberRouteOptions = Parameters<typeof registerMemberRoutes>[1];
type BootstrapOptions = Pick<MemberRouteOptions, 'db' | 'auth' | 'owner' | 'role' | 'adsAvailable'> & {
  config: AppConfig;
  registerMemberRoutes: typeof registerMemberRoutes;
  AgentBrowser: typeof AgentBrowser;
  browserProfileDir: string;
};

function registerMemberAuthHttp(app: FastifyInstance, auth: ReturnType<typeof createAuth>, config: AppConfig) {
  // Fastify adds instance hooks to all routes at readiness. preHandler runs after the existing
  // internal-secret, origin and session gates, with the sign-in body already parsed.
  // https://fastify.dev/docs/v5.12.x/Reference/Hooks/#prehandler (retrieved 2026-11-25).
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.url !== '/api/auth/*') return;
    const path = request.url.split('?')[0];
    const signIn = request.method === 'POST' && path === '/api/auth/sign-in/email';
    if (!signIn && !(request.method === 'GET' && path === '/api/auth/get-session')) return;

    const headers = new Headers();
    for (const key of ['cookie', 'origin', 'user-agent', 'content-type']) {
      const value = request.headers[key];
      if (typeof value === 'string') headers.set(key, value);
    }
    const clientIp = memberAuthClientIp(request, config.production);
    if (clientIp) headers.set('x-forwarded-for', clientIp);
    const response = await auth.handler(new Request(new URL(request.url, config.webOrigin), {
      method: request.method, headers,
      ...(signIn ? { body: JSON.stringify(request.body ?? {}) } : {}),
    }));
    for (const [key, value] of response.headers) {
      if (!['set-cookie', 'content-length', 'transfer-encoding'].includes(key)) reply.header(key, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    return reply.code(response.status).send(await memberAuthResponseBody(response, path));
  });
}

export async function registerMemberDataRights(app: FastifyInstance, options: BootstrapOptions) {
  const { db, auth, config } = options;
  await migrateMemberDataRights(db);
  setAuthSessionCreationCheck(auth, userId => assertDeletionCanSignIn(db, userId));
  registerMemberAuthHttp(app, auth, config);

  const documentsDir = config.documentsDir ?? resolve('.data/documents');
  const Browser = memberAgentBrowserClass(options.AgentBrowser);
  const browser = new Browser({
    profileDir: options.browserProfileDir, testOrigins: config.browser?.testOrigins, channel: config.browserChannel,
  });
  const sessionOwner = async (request: FastifyRequest) => {
    const headers = new Headers();
    if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
    const session = await auth.api.getSession({ headers });
    if (!session) throw Object.assign(new Error('سجل الدخول للمتابعة.'), { statusCode: 401, code: 'UNAUTHORIZED' });
    return { id: session.user.id, sessionId: session.session.id };
  };
  await registerAuditedMemberRoutes(app, {
    db, auth, owner: options.owner, role: options.role, webOrigin: config.webOrigin,
    dailyRuns: config.memberDailyRuns ?? 40, adsAvailable: options.adsAvailable,
    imagesAvailable: () => false, sitesAvailable: () => true,
  }, options.registerMemberRoutes);
  await registerMemberDataRoutes(app, { db, owner: sessionOwner, role: options.role, documentsDir });
  registerMemberDeletionRoutes(app, { db, auth, owner: sessionOwner, role: options.role });
  startMemberDeletionPurge(app, db, { documentsDir, purgeBrowserProfiles: (id, accounts) => browser.purgeAccount(id, accounts) });
  return browser;
}
