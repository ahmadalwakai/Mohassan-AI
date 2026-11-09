import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { SearchOutcome } from './engine.js';

export const SEARCH_POLICY_VERSION = 'owner-sql-public-index-v4';
export const PROVIDER_INTERVALS: Readonly<Record<string, number>> = Object.freeze({ Wikipedia: 1000, 'Stack Exchange': 1000, Crossref: 1000, 'Hacker News': 1000, arXiv: 3000 });
export const searchHash = (text: string) => createHash('sha256').update(text).digest('hex');
export const searchOwner = (ownerId: string) => z.string().min(1).max(200).parse(ownerId);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const cachedOutcome = z.object({
  hits: z.array(z.object({ title: z.string().max(240), url: z.string().url().max(2500), snippet: z.string().max(2000),
    providers: z.array(z.string().max(100)).max(10), relevance: z.literal('lexical'), score: z.number().finite(),
    coverage: z.literal('local_only').optional(), freshness:z.literal('indexed_snapshot').optional(), fetchedAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional(),
    contentHash: hash.optional(), sourceHash: hash.optional(), trust: z.literal('untrusted').optional(),
  }).strict()).max(20),
  fetchedAt: z.iso.datetime(), freshness: z.enum(['fresh','cached','indexed_snapshot']), coverage: z.enum(['specialized_sources','local_only','mixed']),
  failures: z.array(z.object({ provider: z.string().max(100), kind: z.enum(['rate_limited','unavailable','invalid_response']) }).strict()).max(20),
  limitations: z.array(z.string().max(1000)).max(20),
}).strict();

/** Separate migration, shared by cache and the explicitly populated public-document index. */
export async function migrateSearch(db: Kysely<any>): Promise<void> {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_owners(owner_id text PRIMARY KEY, index_revision bigint NOT NULL DEFAULT 0)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_cache(owner_id text NOT NULL, cache_key text NOT NULL, policy text NOT NULL, index_revision bigint NOT NULL, result jsonb NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(owner_id,cache_key))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS search_cache_expiry ON search_cache(expires_at)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_provider_admission(provider text PRIMARY KEY, active_token text, acquired_at timestamptz, next_allowed_at timestamptz NOT NULL DEFAULT '1970-01-01')`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_provider_queries(provider text NOT NULL, query_hash text NOT NULL, next_allowed_at timestamptz NOT NULL, PRIMARY KEY(provider,query_hash))`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_index_documents(id text PRIMARY KEY, owner_id text NOT NULL, url text NOT NULL, url_hash text NOT NULL, source_hash text NOT NULL, content_hash text NOT NULL, title text NOT NULL, content text NOT NULL, term_count integer NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, UNIQUE(owner_id,url_hash), UNIQUE(owner_id,content_hash))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS search_index_owner_expiry ON search_index_documents(owner_id,expires_at)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS search_index_terms(document_id text NOT NULL REFERENCES search_index_documents(id) ON DELETE CASCADE, owner_id text NOT NULL, term text NOT NULL, frequency integer NOT NULL, PRIMARY KEY(document_id,term))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS search_index_owner_term ON search_index_terms(owner_id,term)`.execute(tx);
  });
}

export async function lockSearchOwner(tx: Kysely<any>, ownerId: string): Promise<number> {
  searchOwner(ownerId);
  await tx.insertInto('search_owners').values({owner_id:ownerId}).onConflict(oc=>oc.column('owner_id').doNothing()).execute();
  const row = await tx.selectFrom('search_owners').select('index_revision').where('owner_id','=',ownerId).forUpdate().executeTakeFirstOrThrow();
  return Number(row.index_revision);
}
export async function invalidateSearchOwner(tx: Kysely<any>, ownerId: string): Promise<void> {
  await tx.updateTable('search_owners').set({index_revision:sql`index_revision + 1`}).where('owner_id','=',ownerId).execute();
  await tx.deleteFrom('search_cache').where('owner_id','=',ownerId).execute();
}

export interface SearchCacheStore {
  revision(ownerId: string): Promise<number>;
  get(ownerId: string, key: string, revision: number): Promise<SearchOutcome | null>;
  put(ownerId: string, key: string, revision: number, result: SearchOutcome, ttlMs: number): Promise<void>;
  clear(ownerId: string): Promise<void>;
}
export interface SearchProviderAdmission {
  acquireProvider(provider:string,queryHash?:string):Promise<{token:string}|{retryAfterMs:number}>;
  releaseProvider(provider:string,token:string,retryAfterMs?:number):Promise<boolean>;
}
/** No stale-while-revalidate: expired evidence is never presented as a fresh cached result. */
export class SqlSearchStore implements SearchCacheStore,SearchProviderAdmission {
  constructor(private db: Kysely<any>, private now = Date.now) {}
  async acquireProvider(provider:string,queryHash?:string):Promise<{token:string}|{retryAfterMs:number}> {
    if(!Object.hasOwn(PROVIDER_INTERVALS,provider))throw new Error('SEARCH_ADMISSION_PROVIDER_INVALID');
    if(provider==='Stack Exchange')hash.parse(queryHash);
    return this.db.transaction().execute(async tx=>{
      await tx.insertInto('search_provider_admission').values({provider}).onConflict(oc=>oc.column('provider').doNothing()).execute();
      const row=await tx.selectFrom('search_provider_admission').select(['active_token','next_allowed_at',sql<Date>`clock_timestamp()`.as('database_now')]).where('provider','=',provider).forUpdate().executeTakeFirstOrThrow();
      if(row.active_token)return {retryAfterMs:60000}; // Never assume a paused/crashed request stopped because a lease timed out.
      const remaining=new Date(row.next_allowed_at).getTime()-new Date(row.database_now).getTime();
      if(remaining>0)return {retryAfterMs:Math.max(1,Math.ceil(remaining))};
      if(provider==='Stack Exchange'){
        await tx.deleteFrom('search_provider_queries').where('provider','=',provider).where('next_allowed_at','<=',sql`clock_timestamp()`).execute();
        const repeated=await tx.selectFrom('search_provider_queries').select('next_allowed_at').where('provider','=',provider).where('query_hash','=',queryHash!).executeTakeFirst();
        if(repeated)return {retryAfterMs:Math.max(1,new Date(repeated.next_allowed_at).getTime()-new Date(row.database_now).getTime())};
        await tx.insertInto('search_provider_queries').values({provider,query_hash:queryHash!,next_allowed_at:sql`clock_timestamp() + interval '60 seconds'`}).execute();
      }
      const token=randomUUID();await tx.updateTable('search_provider_admission').set({active_token:token,acquired_at:sql`clock_timestamp()`}).where('provider','=',provider).execute();
      return {token};
    });
  }
  async releaseProvider(provider:string,token:string,retryAfterMs=0):Promise<boolean> {
    if(!Object.hasOwn(PROVIDER_INTERVALS,provider))throw new Error('SEARCH_ADMISSION_PROVIDER_INVALID');
    const minimum=PROVIDER_INTERVALS[provider]!;
    const delay=Math.max(minimum,Math.min(86400000,Number.isFinite(retryAfterMs)?retryAfterMs:minimum));
    const changed=await this.db.updateTable('search_provider_admission').set({active_token:null,acquired_at:null,next_allowed_at:sql`clock_timestamp() + ${delay} * interval '1 millisecond'`})
      .where('provider','=',provider).where('active_token','=',token).returning('provider').executeTakeFirst();
    return Boolean(changed);
  }
  async revision(ownerId: string): Promise<number> {
    searchOwner(ownerId);
    const row = await this.db.selectFrom('search_owners').select('index_revision').where('owner_id','=',ownerId).executeTakeFirst();
    return Number(row?.index_revision ?? 0);
  }
  async get(ownerId: string, key: string, revision: number): Promise<SearchOutcome | null> {
    searchOwner(ownerId); hash.parse(key);
    const row = await this.db.selectFrom('search_cache as c').leftJoin('search_owners as o','o.owner_id','c.owner_id').select(['c.result','c.expires_at','c.index_revision','o.index_revision as current_revision'])
      .where('c.owner_id','=',ownerId).where('c.cache_key','=',key).where('c.policy','=',SEARCH_POLICY_VERSION).executeTakeFirst();
    if (!row || Number(row.index_revision)!==revision || Number(row.current_revision??0)!==revision || new Date(row.expires_at).getTime()<=this.now()) return null;
    const parsed = cachedOutcome.safeParse(row.result);
    if (!parsed.success || parsed.data.hits.some(hit=>hit.expiresAt && Date.parse(hit.expiresAt)<=this.now())) return null;
    return {...parsed.data, freshness:'cached'};
  }
  async put(ownerId: string, key: string, revision: number, result: SearchOutcome, ttlMs: number): Promise<void> {
    searchOwner(ownerId); hash.parse(key);
    const safe = cachedOutcome.parse(result);
    const time=this.now(), fetched=Date.parse(safe.fetchedAt);
    if (!Number.isFinite(ttlMs) || ttlMs<=0 || fetched>time+1000 || fetched<time-300000) return;
    const until=Math.min(time+Math.min(ttlMs,300000),...safe.hits.flatMap(hit=>hit.expiresAt?[Date.parse(hit.expiresAt)]:[]));
    if(until<=time)return;
    await this.db.transaction().execute(async tx=>{
      if(await lockSearchOwner(tx,ownerId)!==revision)return; // A concurrent delete/import must not reintroduce cached local hits.
      await tx.deleteFrom('search_cache').where('owner_id','=',ownerId).where('expires_at','<=',new Date(time)).execute();
      await tx.insertInto('search_cache').values({owner_id:ownerId,cache_key:key,policy:SEARCH_POLICY_VERSION,index_revision:revision,result:JSON.stringify(safe),fetched_at:new Date(fetched),expires_at:new Date(until)})
        .onConflict(oc=>oc.columns(['owner_id','cache_key']).doUpdateSet({policy:SEARCH_POLICY_VERSION,index_revision:revision,result:JSON.stringify(safe),fetched_at:new Date(fetched),expires_at:new Date(until)})).execute();
      const overflow=await tx.selectFrom('search_cache').select('cache_key').where('owner_id','=',ownerId).orderBy('fetched_at','desc').orderBy('cache_key').offset(200).execute();
      if(overflow.length)await tx.deleteFrom('search_cache').where('owner_id','=',ownerId).where('cache_key','in',overflow.map(row=>row.cache_key)).execute();
    });
  }
  async clear(ownerId: string): Promise<void> {
    await this.db.transaction().execute(async tx=>{await lockSearchOwner(tx,ownerId);await invalidateSearchOwner(tx,ownerId);});
  }
}
