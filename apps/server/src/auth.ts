import { betterAuth } from 'better-auth';
import { sql, type Kysely } from 'kysely';

export async function migrateAuth(database: Kysely<any>) {
  await database.transaction().execute(async (db) => {
  await sql`SELECT pg_advisory_xact_lock(1846021105)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS auth_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(db);
  const applied = await db.selectFrom('auth_schema_migrations').select('version').where('version','=','001_auth').executeTakeFirst();
  if (applied) return;
  await sql`CREATE TABLE IF NOT EXISTS "user" (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false, image text,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS session_user_idx ON session ("userId")`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS account (
    id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
    scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("providerId", "accountId")
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS verification (
    id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
    "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS "rateLimit" (
    id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS workspace_owner (
    id integer PRIMARY KEY CHECK (id = 1), owner_id text REFERENCES "user"(id),
    claimed_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await db.insertInto('auth_schema_migrations').values({version:'001_auth'}).execute();
  });
}

/** Safe only before serving requests, under the embedded process's exclusive directory lock. */
export async function recoverLocalSetupClaim(db: Kysely<any>) {
  await db.transaction().execute(async (tx) => {
    const user = await tx.selectFrom('user').select('id').limit(1).executeTakeFirst();
    if (!user) await tx.deleteFrom('workspace_owner').where('id','=',1).where('owner_id','is',null).execute();
  });
}

export function createAuth(db: Kysely<any>, options: {secret: string; webOrigin: string; production: boolean}) {
  const origin = new URL(options.webOrigin);
  const trustedOrigins = [origin.origin];
  if (!options.production && ['localhost', '127.0.0.1'].includes(origin.hostname)) {
    const alias = new URL(origin);
    alias.hostname = alias.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    trustedOrigins.push(alias.origin);
  }
  return betterAuth({
    appName: 'Mohassan AI',
    secret: options.secret,
    baseURL: options.webOrigin,
    database: {db, type: 'postgres'},
    trustedOrigins,
    emailAndPassword: {enabled: true, minPasswordLength: 12, maxPasswordLength: 128},
    session: {expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60, cookieCache: {enabled: false}},
    rateLimit: {enabled: true, storage: 'database', window: 60, max: 30,customRules:{'/get-session':{window:60,max:120}}},
    advanced: {useSecureCookies: options.production},
    logger: {disabled: true},
  });
}

export async function createOwner(db: Kysely<any>, auth: ReturnType<typeof createAuth>, input: {name: string; email: string; password: string}) {
  const existing = await db.selectFrom('user').select('id').limit(1).executeTakeFirst();
  if (existing) throw Object.assign(new Error('تم إعداد حساب المالك بالفعل.'), {statusCode: 409, code: 'SETUP_COMPLETE'});
  const claim = await sql<{id: number}>`INSERT INTO workspace_owner(id) VALUES (1) ON CONFLICT DO NOTHING RETURNING id`.execute(db);
  if (!claim.rows.length) throw Object.assign(new Error('إعداد المالك جارٍ بالفعل.'), {statusCode: 409, code: 'SETUP_IN_PROGRESS'});
  try {
    // Public HTTP registration is never mounted. Only this one-time server operation can call it.
    const result = await auth.api.signUpEmail({body: input});
    await db.updateTable('workspace_owner').set({owner_id: result.user.id}).where('id', '=', 1).execute();
    return result.user;
  } catch (error) {
    await db.deleteFrom('workspace_owner').where('id', '=', 1).where('owner_id', 'is', null).execute();
    throw error;
  }
}
