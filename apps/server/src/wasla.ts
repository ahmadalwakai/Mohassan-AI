import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { WorkspaceRole } from './members.js';

/**
 * The Wasla bridge: the owner's iPhone app reaches Mohassan through the Wasla
 * service on the same computer. That service holds one gateway key and calls
 * these routes over 127.0.0.1 only.
 *
 * - Closed by default (`waslaBridgeEnabled`), and refused on a production server:
 *   the owner's model lives on the PC, so the bridge belongs to the local server.
 * - The owner only. A gateway acts for the owner who paired it, and stops when
 *   that account is no longer the owner.
 * - A closed list of chat routes. Sign-in values (`secure`), the browser screen
 *   and browser input are not reachable through the gateway.
 */
const base = '/api/wasla/gateway';
const chat = `${base}/conversations`;
export const WASLA_GATEWAY_ROUTES: ReadonlySet<string> = new Set([
  `POST ${base}/pair`,
  `GET ${base}/status`,
  `GET ${chat}`, `POST ${chat}`, `GET ${chat}/:id`, `DELETE ${chat}/:id`, `GET ${chat}/:id/campaign-events`,
  `POST ${chat}/:id/messages`, `POST ${chat}/:id/respond`, `POST ${chat}/:id/approve`, `POST ${chat}/:id/cancel`,
]);

const PAIRING_MS = 120_000;
const MAX_GATEWAYS = 2;
const SEEN_EVERY_MS = 30_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const same = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const fault = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });
const uuid = z.uuid();
const Pair = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{16}$/), name: z.string().trim().min(1).max(80) }).strict();
const Empty = z.object({}).strict();

/** The chat control's calls the gateway may make, all scoped by owner id. */
export interface WaslaChat {
  list(ownerId: string): Promise<unknown>;
  create(ownerId: string, raw: unknown): Promise<unknown>;
  detail(ownerId: string, id: string): Promise<unknown>;
  remove(ownerId: string, id: string): Promise<unknown>;
  campaignEvents(ownerId: string, id: string, after: number): Promise<unknown>;
  send(ownerId: string, id: string, raw: unknown): Promise<unknown>;
  respond(ownerId: string, id: string, raw: unknown): Promise<unknown>;
  approve(ownerId: string, id: string, raw: unknown): Promise<unknown>;
  cancel(ownerId: string, id: string): Promise<unknown>;
}

type User = { id: string };
export interface WaslaRouteOptions {
  db: Kysely<any>;
  enabled: boolean;
  owner: (request: FastifyRequest) => Promise<User>;
  /** Pass the open transaction when there is one: the embedded database may hold a single connection. */
  roleOf: (userId: string, connection?: Kysely<any>) => Promise<WorkspaceRole | null>;
  chat: () => WaslaChat;
}

export async function waslaMigration(db: Kysely<any>) {
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS wasla_pairings(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,code_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS wasla_gateways(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,name text NOT NULL,key_hash text NOT NULL,revoked_at timestamptz,last_seen_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS wasla_gateways_owner_idx ON wasla_gateways(owner_id,created_at)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS wasla_audit(id text PRIMARY KEY,owner_id text NOT NULL,gateway_id text,type text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS wasla_audit_owner_idx ON wasla_audit(owner_id,created_at DESC)`.execute(tx);
  });
}

export async function registerWaslaRoutes(app: FastifyInstance, options: WaslaRouteOptions) {
  const { db } = options;
  const audit = (connection: Kysely<any>, ownerId: string, gatewayId: string | null, type: string) =>
    connection.insertInto('wasla_audit').values({ id: randomUUID(), owner_id: ownerId, gateway_id: gatewayId, type }).execute();
  const requireEnabled = () => { if (!options.enabled) throw fault(403, 'WASLA_BRIDGE_DISABLED', 'ربط وصلة مغلق على هذا الخادم.'); };
  const requireOwner = async (request: FastifyRequest) => {
    const user = await options.owner(request);
    if (await options.roleOf(user.id) !== 'owner') throw fault(403, 'MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
    return user;
  };

  /** Only the Wasla service on this computer: loopback, and not a browser. */
  function local(request: FastifyRequest) {
    requireEnabled();
    if (!LOOPBACK.has(request.ip)) throw fault(403, 'WASLA_LOCAL_ONLY', 'هذا المسار مخصص لخدمة وصلة على الكمبيوتر نفسه.');
    if (request.headers.origin !== undefined || request.headers.cookie !== undefined || Object.keys(request.headers).some(key => key.startsWith('sec-fetch-')))
      throw fault(403, 'WASLA_BROWSER_DENIED', 'هذا المسار مخصص لخدمة وصلة وليس للمتصفح.');
  }

  /** The owner the gateway acts for. A revoked key, or an owner who lost the role, stops here. */
  async function gateway(request: FastifyRequest) {
    local(request);
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(request.headers.authorization ?? ''));
    if (!match) throw fault(401, 'WASLA_GATEWAY_UNAUTHORIZED', 'مفتاح وصلة غير صالح.');
    const row = await db.selectFrom('wasla_gateways').selectAll().where('id', '=', match[1]!).executeTakeFirst();
    if (!row || row.revoked_at || !same(row.key_hash, hash(match[2]!))) throw fault(401, 'WASLA_GATEWAY_UNAUTHORIZED', 'أُلغي ربط وصلة أو لم تصح هويته.');
    if (await options.roleOf(row.owner_id) !== 'owner') throw fault(403, 'WASLA_OWNER_ONLY', 'وصلة متاح لمالك موحسن فقط.');
    if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > SEEN_EVERY_MS)
      await db.updateTable('wasla_gateways').set({ last_seen_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', row.id).execute();
    return { ownerId: row.owner_id as string, gatewayId: row.id as string };
  }

  // The owner, from the web workspace.
  app.get('/api/wasla', async (request) => {
    const user = await requireOwner(request);
    const gateways = await db.selectFrom('wasla_gateways').select(['id', 'name', 'revoked_at', 'last_seen_at', 'created_at']).where('owner_id', '=', user.id).orderBy('created_at', 'desc').execute();
    const events = await db.selectFrom('wasla_audit').select(['id', 'gateway_id', 'type', 'created_at']).where('owner_id', '=', user.id).orderBy('created_at', 'desc').limit(30).execute();
    const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null;
    return {
      enabled: options.enabled,
      gateways: gateways.map(row => ({ id: row.id, name: row.name, revoked: Boolean(row.revoked_at), lastSeenAt: iso(row.last_seen_at), createdAt: iso(row.created_at) })),
      events: events.map(row => ({ id: row.id, gatewayId: row.gateway_id, type: row.type, createdAt: iso(row.created_at) })),
    };
  });

  app.post('/api/wasla/pairing', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request) => {
    requireEnabled();
    const user = await requireOwner(request);
    Empty.parse(request.body ?? {});
    const code = randomBytes(12).toString('base64url'), id = randomUUID(), expiresAt = new Date(Date.now() + PAIRING_MS);
    await db.transaction().execute(async (tx) => {
      // One live code at a time: a new one ends the previous one.
      await tx.updateTable('wasla_pairings').set({ expires_at: new Date() }).where('owner_id', '=', user.id).where('consumed_at', 'is', null).execute();
      await tx.insertInto('wasla_pairings').values({ id, owner_id: user.id, code_hash: hash(code), expires_at: expiresAt }).execute();
      await audit(tx, user.id, null, 'pairing_created');
    });
    return { id, code, expiresAt: expiresAt.toISOString() };
  });

  app.post<{ Params: { id: string } }>('/api/wasla/gateways/:id/revoke', async (request) => {
    const user = await requireOwner(request);
    Empty.parse(request.body ?? {});
    const id = uuid.parse(request.params.id);
    return db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('wasla_gateways').select(['id', 'revoked_at']).where('id', '=', id).where('owner_id', '=', user.id).forUpdate().executeTakeFirst();
      if (!row) throw fault(404, 'WASLA_GATEWAY_NOT_FOUND', 'لا يوجد ربط وصلة بهذا المعرف.');
      if (!row.revoked_at) {
        await tx.updateTable('wasla_gateways').set({ revoked_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', id).execute();
        await audit(tx, user.id, id, 'gateway_revoked');
      }
      return { ok: true };
    });
  });

  // The Wasla service, over loopback.
  app.post(`${base}/pair`, { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    local(request);
    const input = Pair.parse(request.body);
    const key = randomBytes(32).toString('base64url'), id = randomUUID();
    return db.transaction().execute(async (tx) => {
      const pair = await tx.selectFrom('wasla_pairings').selectAll().where('code_hash', '=', hash(input.code)).forUpdate().executeTakeFirst();
      if (!pair || pair.consumed_at || new Date(pair.expires_at).getTime() <= Date.now()) throw fault(401, 'WASLA_PAIRING_INVALID', 'رمز ربط وصلة غير صالح أو انتهت مدته.');
      if (await options.roleOf(pair.owner_id, tx) !== 'owner') throw fault(403, 'WASLA_OWNER_ONLY', 'وصلة متاح لمالك موحسن فقط.');
      const count = await tx.selectFrom('wasla_gateways').select(eb => eb.fn.countAll().as('count')).where('owner_id', '=', pair.owner_id).where('revoked_at', 'is', null).executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_GATEWAYS) throw fault(409, 'WASLA_GATEWAY_LIMIT', `الحد ${MAX_GATEWAYS} ربط لوصلة. ألغ ربطًا قديمًا أولًا.`);
      await tx.updateTable('wasla_pairings').set({ consumed_at: sql`CURRENT_TIMESTAMP` }).where('id', '=', pair.id).execute();
      await tx.insertInto('wasla_gateways').values({ id, owner_id: pair.owner_id, name: input.name, key_hash: hash(key) }).execute();
      await audit(tx, pair.owner_id, id, 'gateway_paired');
      // The key is returned once and stored only as a hash.
      return { gatewayId: id, gatewayKey: `${id}.${key}` };
    });
  });

  app.get(`${base}/status`, async (request) => { await gateway(request); return { ok: true, bridge: 'mohassan' }; });

  type Conversation = { Params: { id: string } };
  const live = { config: { rateLimit: { max: 400, timeWindow: '1 minute' } } };
  const id = (value: string) => uuid.parse(value);
  // The key is checked before the chat is touched.
  const as = async (request: FastifyRequest) => ({ ownerId: (await gateway(request)).ownerId, control: options.chat() });
  app.get(chat, async (request) => { const { ownerId, control } = await as(request); return control.list(ownerId); });
  app.post(chat, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => { const { ownerId, control } = await as(request); return control.create(ownerId, request.body ?? {}); });
  app.get<Conversation>(`${chat}/:id`, live, async (request) => { const { ownerId, control } = await as(request); return control.detail(ownerId, id(request.params.id)); });
  app.delete<Conversation>(`${chat}/:id`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { const { ownerId, control } = await as(request); return control.remove(ownerId, id(request.params.id)); });
  app.get<Conversation & { Querystring: { after?: string } }>(`${chat}/:id/campaign-events`, live, async (request) => { const { ownerId, control } = await as(request); return control.campaignEvents(ownerId, id(request.params.id), z.coerce.number().int().min(0).max(100000).default(0).parse(request.query.after)); });
  app.post<Conversation>(`${chat}/:id/messages`, { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { const { ownerId, control } = await as(request); return control.send(ownerId, id(request.params.id), request.body); });
  app.post<Conversation>(`${chat}/:id/respond`, async (request) => { const { ownerId, control } = await as(request); return control.respond(ownerId, id(request.params.id), request.body); });
  app.post<Conversation>(`${chat}/:id/approve`, async (request) => { const { ownerId, control } = await as(request); return control.approve(ownerId, id(request.params.id), request.body); });
  app.post<Conversation>(`${chat}/:id/cancel`, async (request) => { const { ownerId, control } = await as(request); Empty.parse(request.body ?? {}); return control.cancel(ownerId, id(request.params.id)); });
}
