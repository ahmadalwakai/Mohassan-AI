import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

export type Db = Kysely<any>;

export async function googleAdsMigration(db: Db) {
  await sql`CREATE TABLE IF NOT EXISTS google_ads_connections(owner_id text PRIMARY KEY,sealed_refresh_token text,status text NOT NULL CHECK(status IN ('disconnected','needs_account','connected','unauthorized')),customer_id text,login_customer_id text,account_name text,currency text,time_zone text,test_account boolean NOT NULL DEFAULT false,booking_rules jsonb NOT NULL DEFAULT '[]'::jsonb,connected_at timestamptz,last_checked_at timestamptz,rate_limited_until timestamptz,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS google_ads_oauth_states(state_hash text PRIMARY KEY,owner_id text NOT NULL,sealed_verifier text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS google_ads_drafts(id text PRIMARY KEY,owner_id text NOT NULL,customer_id text NOT NULL,idempotency_key text NOT NULL,state text NOT NULL,revision integer NOT NULL DEFAULT 1,brief jsonb NOT NULL,bidding text NOT NULL,operations jsonb NOT NULL,draft_hash text NOT NULL,geo_targets jsonb NOT NULL DEFAULT '[]'::jsonb,summary jsonb,strategy jsonb,validation jsonb,verification jsonb,campaign_resource_name text,error text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,idempotency_key))`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS google_ads_drafts_owner_idx ON google_ads_drafts(owner_id,updated_at DESC)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS google_ads_approvals(id text PRIMARY KEY,owner_id text NOT NULL,draft_id text NOT NULL REFERENCES google_ads_drafts(id) ON DELETE CASCADE,action text NOT NULL CHECK(action IN ('publish','launch')),draft_hash text NOT NULL,customer_id text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS google_ads_approvals_draft_idx ON google_ads_approvals(draft_id,action,expires_at)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS google_ads_audit(id text PRIMARY KEY,owner_id text NOT NULL,draft_id text,type text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS google_ads_audit_owner_idx ON google_ads_audit(owner_id,created_at DESC)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS google_ads_experiences(id text PRIMARY KEY,owner_id text NOT NULL,customer_id text NOT NULL,kind text NOT NULL,statement text NOT NULL,evidence jsonb NOT NULL,dedup_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,dedup_key))`.execute(db);
}

export const json = (value: unknown) => JSON.stringify(value);
/** The two database drivers disagree on whether jsonb arrives parsed. */
export const parsed = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
export const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();

/** Append-only by design: no code path updates or deletes these rows. */
export async function audit(db: Db, ownerId: string, draftId: string | null, type: string, detail: Record<string, unknown> = {}) {
  await db.insertInto('google_ads_audit').values({ id: randomUUID(), owner_id: ownerId, draft_id: draftId, type, detail: json(detail) }).execute();
}
