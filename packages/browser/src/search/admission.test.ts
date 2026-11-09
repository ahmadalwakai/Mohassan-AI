import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { sql } from 'kysely';
import { createDatabase,migrate } from '@mohassan/database';
import { SafeNetwork } from '../network.js';
import { SearchEngine } from './engine.js';
import { migrateSearch,searchHash,SqlSearchStore } from './store.js';
import { SearchProviderFailure,type DocumentedProvider } from './providers.js';

let database:Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async()=>{database=await createDatabase();await migrate(database.db);await migrateSearch(database.db);});
afterAll(async()=>{await database.close();});
const hit={title:'quantum research paper',url:'https://arxiv.org/abs/2401.12345',snippet:'quantum research paper'};
const provider=(search:DocumentedProvider['search']):DocumentedProvider=>({name:'arXiv',coverage:'scholarly',accessBasis:'documented_api',supports:()=>true,search});
const reset=()=>database.db.deleteFrom('search_provider_admission').execute(); // Only controlled fixture transports; no production reset endpoint.

describe('shared arXiv admission',()=>{
  it('grants one of two simultaneous SQL claims, including first creation of the global row',async()=>{
    await reset();const a=new SqlSearchStore(database.db,()=>0),b=new SqlSearchStore(database.db,()=>Number.MAX_SAFE_INTEGER);
    const results=await Promise.all([a.acquireProvider('arXiv'),b.acquireProvider('arXiv')]);
    expect(results.filter(result=>'token' in result)).toHaveLength(1);expect(results.filter(result=>'retryAfterMs' in result)).toHaveLength(1);
    const winner=results.find(result=>'token' in result)!;if('token' in winner)expect(await b.releaseProvider('arXiv',winner.token)).toBe(true);
  });
  it('disables arXiv without a shared admission store',async()=>{
    const search=vi.fn(async()=>[hit]),engine=new SearchEngine(new SafeNetwork(),{providers:[provider(search)]});
    expect(engine.name).not.toContain('arXiv');expect((await engine.execute('quantum research paper',5)).hits).toEqual([]);expect(search).not.toHaveBeenCalled();
  });
  it('holds a single global token across engine instances and different host clocks, even after caller cancellation',async()=>{
    await reset();let began!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const search=vi.fn(async()=>{began();await held;return [hit];});
    const aStore=new SqlSearchStore(database.db,()=>0),bStore=new SqlSearchStore(database.db,()=>Date.now()+86400000);
    const a=new SearchEngine(new SafeNetwork(),{providers:[provider(search)],admission:aStore,now:()=>0});
    const b=new SearchEngine(new SafeNetwork(),{providers:[provider(search)],admission:bStore,now:()=>Date.now()+86400000});
    const controller=new AbortController(),pending=a.execute('quantum research paper',5,controller.signal);await started;controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect((await b.execute('quantum research paper',5)).failures).toEqual([{provider:'arXiv',kind:'rate_limited'}]);expect(search).toHaveBeenCalledTimes(1);
    const before=await database.db.selectFrom('search_provider_admission').select('active_token').where('provider','=','arXiv').executeTakeFirstOrThrow();
    expect(await bStore.releaseProvider('arXiv','wrong-token')).toBe(false);
    expect((await database.db.selectFrom('search_provider_admission').select('active_token').where('provider','=','arXiv').executeTakeFirstOrThrow()).active_token).toBe(before.active_token);
    release();await expect.poll(async()=>Boolean((await database.db.selectFrom('search_provider_admission').select('active_token').where('provider','=','arXiv').executeTakeFirstOrThrow()).active_token)).toBe(false);
    const cooldown=await bStore.acquireProvider('arXiv');expect(cooldown).toHaveProperty('retryAfterMs');if('retryAfterMs' in cooldown)expect(cooldown.retryAfterMs).toBeGreaterThan(2000);
    // Even an arbitrarily old active timestamp is not proof that its transport stopped.
    await database.db.updateTable('search_provider_admission').set({active_token:'unresolved-token',acquired_at:new Date(0),next_allowed_at:new Date(0)}).where('provider','=','arXiv').execute();
    expect(await new SqlSearchStore(database.db).acquireProvider('arXiv')).toEqual({retryAfterMs:60000});
    await database.db.deleteFrom('search_provider_admission').execute();
  });
  it('shares Retry-After cooldown and releases only after actual completion with a database timestamp',async()=>{
    await reset();const store=new SqlSearchStore(database.db,()=>Number.MAX_SAFE_INTEGER);
    const engine=new SearchEngine(new SafeNetwork(),{providers:[provider(async()=>{throw new SearchProviderFailure('rate_limited',7000);})],admission:store});
    expect((await engine.execute('quantum research paper',5)).failures).toEqual([{provider:'arXiv',kind:'rate_limited'}]);
    const row=await database.db.selectFrom('search_provider_admission').select(['active_token',sql<number>`extract(epoch from (next_allowed_at-clock_timestamp()))`.as('remaining')]).where('provider','=','arXiv').executeTakeFirstOrThrow();
    expect(row.active_token).toBeNull();expect(Number(row.remaining)).toBeGreaterThan(6);expect(Number(row.remaining)).toBeLessThanOrEqual(7);
  });
});

describe('shared documented-provider admission',()=>{
  it.each(['Wikipedia','Stack Exchange','Crossref','Hacker News'])('serializes %s across engine instances and retains successful response cooldown',async name=>{
    await reset();await database.db.deleteFrom('search_provider_queries').execute();
    let began!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const search=vi.fn(async()=>{began();await held;return [hit];});
    const documented={...provider(search),name,cooldownMs:()=>8000};
    const a=new SearchEngine(new SafeNetwork(),{providers:[documented],admission:new SqlSearchStore(database.db,()=>0)});
    const b=new SearchEngine(new SafeNetwork(),{providers:[documented],admission:new SqlSearchStore(database.db,()=>Number.MAX_SAFE_INTEGER)});
    const pending=a.execute('quantum research paper',5);await started;
    expect((await b.execute('different research paper',5)).failures).toEqual([{provider:name,kind:'rate_limited'}]);expect(search).toHaveBeenCalledTimes(1);
    release();await pending;
    const row=await database.db.selectFrom('search_provider_admission').select([sql<number>`extract(epoch from (next_allowed_at-clock_timestamp()))`.as('remaining')]).where('provider','=',name).executeTakeFirstOrThrow();
    expect(Number(row.remaining)).toBeGreaterThan(7);
  });
  it('prevents repeated Stack Exchange queries after process restart without delaying unrelated queries by a minute',async()=>{
    await reset();await database.db.deleteFrom('search_provider_queries').execute();
    const store=new SqlSearchStore(database.db),key=searchHash('node api');
    const claimed=await store.acquireProvider('Stack Exchange',key);expect(claimed).toHaveProperty('token');
    if(!('token' in claimed))throw new Error('fixture claim failed');
    await store.releaseProvider('Stack Exchange',claimed.token);
    // Fixture-only clock advancement. Query ledger expiry remains unchanged.
    await database.db.updateTable('search_provider_admission').set({next_allowed_at:new Date(0)}).where('provider','=','Stack Exchange').execute();
    const restarted=new SqlSearchStore(database.db);
    const denied=await restarted.acquireProvider('Stack Exchange',key);expect(denied).toHaveProperty('retryAfterMs');
    if('retryAfterMs' in denied)expect(denied.retryAfterMs).toBeGreaterThan(55000);
    expect(await restarted.acquireProvider('Stack Exchange',searchHash('react hooks'))).toHaveProperty('token');
    await expect(restarted.acquireProvider('__proto__')).rejects.toThrow('SEARCH_ADMISSION_PROVIDER_INVALID');
  });
});
