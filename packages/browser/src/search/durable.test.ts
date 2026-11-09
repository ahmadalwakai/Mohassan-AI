import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate } from '@mohassan/database';
import { SafeNetwork, type SafeResponse } from '../network.js';
import { SearchEngine, type SearchOutcome } from './engine.js';
import { LocalPublicIndex } from './local-index.js';
import { migrateSearch, searchHash, SqlSearchStore } from './store.js';

let database:Awaited<ReturnType<typeof createDatabase>>;
beforeAll(async()=>{database=await createDatabase();await migrate(database.db);await migrateSearch(database.db);});
afterAll(async()=>{await database.close();});
const initial=Date.parse('2026-11-08T12:00:00Z');
const fixture=(page='Node API supports verified requests.')=>{
  const network=new SafeNetwork();let html=`<title>Node API guide</title><main>${page}</main>`;
  const requests:string[]=[];
  vi.spyOn(network,'request').mockImplementation(async url=>{requests.push(url);return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(new URL(url).pathname==='/robots.txt'?'User-agent: *\nAllow: /':html)};});
  return {network,requests,setHtml:(value:string)=>{html=value;}};
};
const result=(at:number):SearchOutcome=>({hits:[{title:'Node API',url:'https://example.com/node',snippet:'Node API documentation',providers:['fixture'],score:1,relevance:'lexical'}],fetchedAt:new Date(at).toISOString(),freshness:'fresh',coverage:'specialized_sources',failures:[],limitations:[]});

describe('durable owner search cache',()=>{
  it('survives a new store instance, isolates owners, preserves fetch time and expires without stale fallback',async()=>{
    let now=initial;const store=new SqlSearchStore(database.db,()=>now),key=searchHash('durable');
    await store.put('cache-owner',key,0,result(now),15000);now+=5000;
    const restarted=new SqlSearchStore(database.db,()=>now);
    expect(await restarted.get('cache-owner',key,0)).toMatchObject({freshness:'cached',fetchedAt:new Date(initial).toISOString()});
    expect(await restarted.get('other-owner',key,0)).toBeNull();
    now+=10001;expect(await restarted.get('cache-owner',key,0)).toBeNull();
  });
  it('does not reinsert a pre-delete result when an in-flight search finishes later',async()=>{
    const store=new SqlSearchStore(database.db,()=>initial),key=searchHash('race');
    const revision=await store.revision('cache-race');await store.clear('cache-race');
    await store.put('cache-race',key,revision,result(initial),60000);
    expect(await store.get('cache-race',key,await store.revision('cache-race'))).toBeNull();
  });
  it('uses SQL across engine instances and strips known secret snippets before storage',async()=>{
    let now=initial;const call=vi.fn(async()=>[{title:'Node API',url:'https://example.com/node',snippet:'Node API password=fixture-secret-123'}]);
    const providers=[{name:'fixture',coverage:'programming' as const,accessBasis:'documented_api' as const,supports:()=>true,search:call}];
    const store=new SqlSearchStore(database.db,()=>now),first=new SearchEngine(new SafeNetwork(),{providers,store,now:()=>now});
    await first.execute('Node API',5,undefined,{ownerId:'engine-owner'});now+=2000;
    const second=new SearchEngine(new SafeNetwork(),{providers,store:new SqlSearchStore(database.db,()=>now),now:()=>now});
    const cached=await second.execute('Node API',5,undefined,{ownerId:'engine-owner'});
    expect(cached.freshness).toBe('cached');expect(call).toHaveBeenCalledTimes(1);expect(JSON.stringify(cached)).not.toContain('fixture-secret-123');
  });
});

describe('explicit public index lifecycle',()=>{
  it('retains a late exact phrase through local retrieval and the shared ranking gate',async()=>{
    const f=fixture('machine unrelated learning padding '.repeat(120)+'Exact phrase machine learning appears here.'),index=new LocalPublicIndex(database.db,f.network,()=>initial);
    const owner='quoted-local-evidence';await index.indexUrl(owner,{url:'https://example.com/late-phrase'});
    const engine=new SearchEngine(f.network,{providers:[],localIndex:index,now:()=>initial});
    const result=await engine.execute('"machine learning"',5,undefined,{ownerId:owner});
    expect(result.hits).toHaveLength(1);expect(result.hits[0].snippet).toContain('machine learning');
    expect(result.hits[0]).toMatchObject({coverage:'local_only',trust:'untrusted'});
  });
  it('cleans expired owners in bounded batches without reading sources or deleting fresh content',async()=>{
    let now=initial;const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>now);
    await index.indexUrl('retention-expired',{url:'https://example.com/old',ttlHours:1});
    await index.indexUrl('retention-fresh',{url:'https://example.com/fresh',ttlHours:24});
    const calls=f.requests.length;now+=3600001;
    expect(await index.pruneExpired(1)).toBe(1);expect(f.requests).toHaveLength(calls);
    expect(await database.db.selectFrom('search_index_documents').select('id').where('owner_id','=','retention-expired').execute()).toEqual([]);
    expect(await index.list('retention-fresh')).toHaveLength(1);
  });
  it('rechecks noindex on explicit refresh and removes the revoked source',async()=>{
    const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>initial),owner='refresh-noindex';
    const added=await index.indexUrl(owner,{url:'https://example.com/refresh'});
    await expect(index.refresh('different-owner',added.document.id)).rejects.toMatchObject({code:'SEARCH_INDEX_NOT_FOUND'});
    f.setHtml('<meta name="robots" content="noindex"><title>Node API</title>Node API revoked.');
    await expect(index.refresh(owner,added.document.id)).rejects.toMatchObject({code:'SEARCH_INDEX_NOINDEX'});
    expect(await index.list(owner)).toEqual([]);
  });
  it.each([false,true])('replaces a refreshed redirect without retaining stale searchable content (destination indexed=%s)',async existing=>{
    const network=new SafeNetwork(),owner=`refresh-move-${existing}`;let moved=false;
    vi.spyOn(network,'request').mockImplementation(async (url):Promise<SafeResponse>=>{
      if(new URL(url).pathname==='/robots.txt')return {url,status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nAllow: /')};
      if(moved&&url==='https://example.com/old')return {url,status:302,headers:{location:'/new'},body:Buffer.alloc(0)};
      const content=url.endsWith('/old')?'Legacy warranty OLD42':'Current warranty NEW42';
      return {url,status:200,headers:{'content-type':'text/html'},body:Buffer.from(`<title>Warranty guide</title><p>${content}</p>`)};
    });
    const index=new LocalPublicIndex(database.db,network,()=>initial);
    const old=await index.indexUrl(owner,{url:'https://example.com/old'});
    const destination=existing?await index.indexUrl(owner,{url:'https://example.com/new'}):undefined;
    moved=true;const refreshed=await index.refresh(owner,old.document.id);
    expect((await index.list(owner)).map(row=>row.url)).toEqual(['https://example.com/new']);
    expect(refreshed.document.id).toBe(destination?.document.id??old.document.id);
    expect(await index.search('warranty OLD42',5,undefined,{ownerId:owner})).toEqual([]);
    expect(await index.search('warranty NEW42',5,undefined,{ownerId:owner})).toHaveLength(1);
  });
  it('does not crawl, deduplicates owner content, updates terms incrementally and removes expired sources',async()=>{
    let now=initial;const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>now),owner='index-owner';
    expect(await index.search('Node API',5,undefined,{ownerId:owner})).toEqual([]);expect(f.requests).toEqual([]);
    const added=await index.indexUrl(owner,{url:'https://example.com/guide?utm_source=test',ttlHours:1});
    expect(added.changed).toBe(true);expect(added.document.url).toBe('https://example.com/guide');
    const same=await index.indexUrl(owner,{url:'https://example.com/guide',ttlHours:1});expect(same.changed).toBe(false);expect(same.document.id).toBe(added.document.id);
    const duplicate=await index.indexUrl(owner,{url:'https://example.com/duplicate',ttlHours:1});expect(duplicate.duplicate).toBe(true);expect(await index.list(owner)).toHaveLength(1);
    const hits=await index.search('Node API',5,undefined,{ownerId:owner});expect(hits[0]).toMatchObject({coverage:'local_only',freshness:'indexed_snapshot',trust:'untrusted',fetchedAt:new Date(initial).toISOString()});
    expect(await index.search('Node API',5,undefined,{ownerId:'another-owner'})).toEqual([]);
    expect(await index.search('Node API',5)).toEqual([]);
    await expect(index.remove('another-owner',added.document.id)).rejects.toMatchObject({code:'SEARCH_INDEX_NOT_FOUND'});
    f.setHtml('<title>Shipping handbook</title><main>Shipment arrival confirmation.</main>');
    const changed=await index.indexUrl(owner,{url:'https://example.com/guide',ttlHours:1});expect(changed.changed).toBe(true);expect(changed.document.id).toBe(added.document.id);
    expect(await index.search('Node API',5,undefined,{ownerId:owner})).toEqual([]);expect(await index.search('Shipment arrival',5,undefined,{ownerId:owner})).toHaveLength(1);
    now+=3600001;expect(await index.list(owner)).toEqual([]);expect(await database.db.selectFrom('search_index_terms').select('term').where('owner_id','=',owner).execute()).toEqual([]);
  });
  it('retrieves late text, retains source provenance across SQL caching and invalidates on deletion',async()=>{
    let now=initial;const f=fixture(`${'general introduction '.repeat(500)} Unique warranty reference ZX491.`),index=new LocalPublicIndex(database.db,f.network,()=>now),store=new SqlSearchStore(database.db,()=>now);
    const owner='local-engine';
    const make=()=>new SearchEngine(f.network,{providers:[],localIndex:index,store,now:()=>now});
    expect((await make().execute('warranty ZX491',5,undefined,{ownerId:owner})).hits).toEqual([]);
    const added=await index.indexUrl(owner,{url:'https://example.com/long'});
    const first=await make().execute('warranty ZX491',5,undefined,{ownerId:owner});
    expect(first).toMatchObject({coverage:'local_only',freshness:'indexed_snapshot'});expect(first.hits[0].snippet).toContain('ZX491');expect(first.hits[0].sourceHash).toBe(added.document.sourceHash);
    now+=2000;expect((await make().execute('warranty ZX491',5,undefined,{ownerId:owner})).freshness).toBe('cached');
    expect((await make().search('warranty ZX491',5,undefined,{ownerId:owner}))[0].snippet).toMatch(/^نسخة مفهرسة بتاريخ 2026-11-08T12:00:00.000Z/);
    await index.remove(owner,added.document.id);expect((await make().execute('warranty ZX491',5,undefined,{ownerId:owner})).hits).toEqual([]);
  });
  it('refuses private or credential URLs before fetching, robots denial, noindex, secret and non-text documents',async()=>{
    const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>initial);
    await expect(index.indexUrl('blocked',{url:'http://127.0.0.1/private'})).rejects.toMatchObject({code:'BROWSER_URL_DENIED'});
    await expect(index.indexUrl('blocked',{url:'https://example.com/?token=private'})).rejects.toMatchObject({code:'SEARCH_INDEX_URL_DENIED'});
    expect(f.requests).toEqual([]);
    f.setHtml('<meta name="robots" content="noindex"><title>Node API</title><main>Node API text</main>');
    await expect(index.indexUrl('blocked',{url:'https://example.com/noindex'})).rejects.toMatchObject({code:'SEARCH_INDEX_NOINDEX'});
    f.setHtml('<title>Node API</title><main>Node API password=fixture-private-secret</main>');
    await expect(index.indexUrl('blocked',{url:'https://example.com/secret'})).rejects.toMatchObject({code:'SEARCH_INDEX_SECRET'});
    f.setHtml('<title>Node API</title><main>Node API password&#61;fixture-entity-secret</main>');
    await expect(index.indexUrl('blocked',{url:'https://example.com/encoded-secret'})).rejects.toMatchObject({code:'SEARCH_INDEX_SECRET'});
    f.setHtml('<title>ｐａｓｓｗｏｒｄ=fixture-title-secret</title><main>Node API public content</main>');
    await expect(index.indexUrl('blocked',{url:'https://example.com/normalized-secret'})).rejects.toMatchObject({code:'SEARCH_INDEX_SECRET'});
    const network=new SafeNetwork(),request=vi.spyOn(network,'request').mockResolvedValue({url:'https://example.org/robots.txt',status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /blocked')});
    await expect(new LocalPublicIndex(database.db,network,()=>initial).indexUrl('blocked',{url:'https://example.org/blocked'})).rejects.toMatchObject({code:'RESEARCH_ROBOTS_DENIED'});expect(request).toHaveBeenCalledTimes(1);
    const pdf=fixture();vi.mocked(pdf.network.request).mockImplementation(async url=>({url,status:200,headers:{'content-type':url.endsWith('robots.txt')?'text/plain':'application/pdf'},body:Buffer.from(url.endsWith('robots.txt')?'User-agent: *\nAllow: /':'pdf')}));
    await expect(new LocalPublicIndex(database.db,pdf.network,()=>initial).indexUrl('blocked',{url:'https://example.org/file'})).rejects.toMatchObject({code:'SEARCH_INDEX_CONTENT'});
    const headerOnly=fixture();vi.mocked(headerOnly.network.request).mockImplementation(async url=>({url,status:200,headers:{'content-type':'text/html','x-robots-tag':url.endsWith('robots.txt')?'':'otherbot: noindex'},body:Buffer.from(url.endsWith('robots.txt')?'User-agent: *\nAllow: /':'<title>Node API</title><p>Node API text</p>')}));
    await expect(new LocalPublicIndex(database.db,headerOnly.network,()=>initial).indexUrl('blocked',{url:'https://example.org/header-only'})).rejects.toMatchObject({code:'SEARCH_INDEX_NOINDEX'});
    expect(await index.list('blocked')).toEqual([]);
  });
  it('does not commit a canceled fetch or resurrect content after a concurrent owner deletion',async()=>{
    const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>initial),owner='index-race';
    const added=await index.indexUrl(owner,{url:'https://example.com/first'});
    let finish!:(response:SafeResponse)=>void,started!:()=>void;let begun=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(f.network.request).mockImplementation(async url=>{started();return new Promise<SafeResponse>(resolve=>{finish=resolve;});});
    const controller=new AbortController(),pending=index.indexUrl(owner,{url:'https://example.com/second'},controller.signal);await begun;controller.abort();
    finish({url:'https://example.com/second',status:200,headers:{'content-type':'text/plain'},body:Buffer.from('new index content')});await expect(pending).rejects.toMatchObject({name:'AbortError'});
    begun=new Promise<void>(resolve=>{started=resolve;});const raced=index.indexUrl(owner,{url:'https://example.com/third'});await begun;await index.remove(owner,added.document.id);
    finish({url:'https://example.com/third',status:200,headers:{'content-type':'text/plain'},body:Buffer.from('another new content')});await expect(raced).rejects.toMatchObject({code:'SEARCH_INDEX_CHANGED'});
    expect(await index.list(owner)).toEqual([]);
  });
  it('checks the redirected destination and its robots rules before fetching its content',async()=>{
    const network=new SafeNetwork(),calls:string[]=[];
    vi.spyOn(network,'request').mockImplementation(async (url):Promise<SafeResponse>=>{
      calls.push(url);
      const parsed=new URL(url);
      if(parsed.pathname==='/robots.txt')return {url,status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /blocked')};
      return {url,status:302,headers:{location:parsed.pathname==='/private'?'https://127.0.0.1/secret':'https://other.example.org/blocked'},body:Buffer.alloc(0)};
    });
    const index=new LocalPublicIndex(database.db,network,()=>initial);
    await expect(index.indexUrl('redirects',{url:'https://example.org/redirect'})).rejects.toMatchObject({code:'RESEARCH_ROBOTS_DENIED'});
    expect(calls).toEqual(['https://example.org/robots.txt','https://example.org/redirect','https://other.example.org/robots.txt']);
    await expect(index.indexUrl('redirects',{url:'https://example.org/private'})).rejects.toMatchObject({code:'BROWSER_NETWORK_DENIED'});
    expect(calls).not.toContain('https://127.0.0.1/secret');expect(await index.list('redirects')).toEqual([]);
  });
  it('keeps the indexed snippet bound to its own hash when a live provider returns the same URL',async()=>{
    const f=fixture('Node API original public content.'),index=new LocalPublicIndex(database.db,f.network,()=>initial);
    const added=await index.indexUrl('provenance',{url:'https://example.com/guide'});
    const engine=new SearchEngine(f.network,{localIndex:index,now:()=>initial,providers:[{name:'remote',coverage:'programming',accessBasis:'documented_api',supports:()=>true,search:async()=>[{url:'https://example.com/guide',title:'Node API Node API',snippet:'Node API unrelated replacement text'}]}]});
    const outcome=await engine.execute('Node API',5,undefined,{ownerId:'provenance'});
    expect(outcome.hits[0].contentHash).toBe(added.document.contentHash);expect(outcome.hits[0].snippet).toContain('original public content');expect(outcome.hits[0].snippet).not.toContain('replacement');expect(outcome.coverage).toBe('mixed');
  });
  it('withdraws confirmed noindex or robots denial only for that owner and preserves transient failures without renewal',async()=>{
    let now=initial;const f=fixture(),index=new LocalPublicIndex(database.db,f.network,()=>now);
    const a=await index.indexUrl('withdraw-a',{url:'https://example.com/guide'});await index.indexUrl('withdraw-b',{url:'https://example.com/guide'});
    f.setHtml('<meta name="robots" content="none"><title>Node API</title><p>Node API text</p>');
    await expect(index.indexUrl('withdraw-a',{url:'https://example.com/guide'})).rejects.toMatchObject({code:'SEARCH_INDEX_NOINDEX'});
    expect(await index.list('withdraw-a')).toEqual([]);expect(await index.list('withdraw-b')).toHaveLength(1);
    now+=60000;
    vi.mocked(f.network.request).mockRejectedValue(new Error('temporary connection failure'));
    await expect(index.indexUrl('withdraw-b',{url:'https://example.com/guide'})).rejects.toThrow('temporary');
    expect((await index.list('withdraw-b'))[0]).toMatchObject({fetchedAt:a.document.fetchedAt,expiresAt:a.document.expiresAt});
    const denied=new SafeNetwork();vi.spyOn(denied,'request').mockImplementation(async url=>({url,status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nDisallow: /guide')}));
    await expect(new LocalPublicIndex(database.db,denied,()=>now).indexUrl('withdraw-b',{url:'https://example.com/guide'})).rejects.toMatchObject({code:'RESEARCH_ROBOTS_DENIED'});
    expect(await index.list('withdraw-b')).toEqual([]);
  });
});
