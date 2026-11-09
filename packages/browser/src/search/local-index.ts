import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { parse } from 'parse5';
import { z } from 'zod';
import { BrowserError, SafeNetwork } from '../network.js';
import { readableSource, type SearchHit, type SearchProvider } from '../research.js';
import { safeResumeUrl } from '../session-state.js';
import { canonicalUrl, compileQuery, localSearchSnippet, matchesSearchPhrases, searchTokens } from './ranking.js';
import { RobotsPolicy } from './robots.js';
import { invalidateSearchOwner, lockSearchOwner, searchHash, searchOwner } from './store.js';

export const IndexPublicUrlSchema=z.object({url:z.string().url().max(2500),ttlHours:z.number().int().min(1).max(168).default(24)}).strict();
export interface LocalIndexHit extends SearchHit { coverage:'local_only'; freshness:'indexed_snapshot'; fetchedAt:string; expiresAt:string; contentHash:string; sourceHash:string; trust:'untrusted' }
export interface SearchLocalIndex extends SearchProvider { search(question:string,limit:number,signal?:AbortSignal,context?:{ownerId:string}):Promise<LocalIndexHit[]> }
const iso=(value:Date|string)=>new Date(value).toISOString();

/** Decode valid URL escapes independently: an unrelated literal '%' must not suppress the credential scan. */
export function publicSearchScan(value:string):string {
  let text=value.normalize('NFKC').replace(/\p{Cf}/gu,'');
  for(let pass=0;pass<3;pass++) {
    const decoded=text.replace(/(?:%[a-f0-9]{2})+/gi,fragment=>{
      try{return decodeURIComponent(fragment);}catch{return fragment.replace(/%([a-f0-9]{2})/gi,(escape,hex:string)=>parseInt(hex,16)<128?String.fromCharCode(parseInt(hex,16)):escape);}
    }).normalize('NFKC').replace(/\p{Cf}/gu,'');
    if(decoded===text)break;text=decoded;
  }
  return text;
}

/** Known credential patterns are rejected, not retained in the public index or its cache. */
export function publicSearchText(value:string):string {
  return value.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,'[REDACTED]')
    .replace(/\b(?:gsk_|sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g,'[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi,'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|secret|كلمة المرور|رمز التحقق)\s*(?:[:=]|\bis\b|هي|هو)\s*)["']?[^\s,"';]{3,}["']?/gi,'$1[REDACTED]');
}
function denySensitiveUrl(input:string,network:SafeNetwork):string {
  const url=network.validate(input);
  const decoded=publicSearchScan(url.href);
  if(!safeResumeUrl(url.href)||publicSearchText(decoded)!==decoded||/(?:^|\/)(?:\.env(?:\.|\/|$)|id_rsa|credentials\.json)|\.(?:pem|key|pfx)(?:\?|$)/i.test(decoded))throw new BrowserError('SEARCH_INDEX_URL_DENIED','لا يُفهرس عنوان يحمل بيانات اعتماد أو ملف أسرار.');
  // Fixture-only HTTP is accepted by SafeNetwork's explicit testOrigins; production canonicalization remains HTTPS.
  if(url.protocol==='https:')return canonicalUrl(url.href);
  url.hash='';for(const key of [...url.searchParams.keys()])if(/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key))url.searchParams.delete(key);
  return url.href;
}
function allowsIndexing(html:string):boolean {
  const stack:any[]=[parse(html)];
  while(stack.length){const node=stack.pop();if(node.tagName==='meta'){
    const name=node.attrs?.find((a:any)=>a.name==='name')?.value?.toLowerCase();
    const content=node.attrs?.find((a:any)=>a.name==='content')?.value??'';
    if(['robots','mohassanai','mohassanai-research'].includes(name)&&/\b(?:noindex|none)\b/i.test(content))return false;
  }stack.push(...node.childNodes??[]);}
  return true;
}
function metadata(row:any){return {id:row.id,url:row.url,title:row.title,sourceHash:row.source_hash,contentHash:row.content_hash,fetchedAt:iso(row.fetched_at),expiresAt:iso(row.expires_at),coverage:'local_only' as const,freshness:'indexed_snapshot' as const,trust:'untrusted' as const};}

/** Explicit owner-approved public URLs only. No cookies, credentials, files, model calls or crawl queue. */
export class LocalPublicIndex implements SearchLocalIndex {
  readonly name='Owner public-document index';
  readonly limitations=['فهرس محلي صغير لما أضافه المالك؛ ليس بحثًا شاملاً أو ضمانًا لحداثة الموقع.'];
  private robots:RobotsPolicy;
  constructor(private db:Kysely<any>,private network:SafeNetwork,private now=Date.now){this.robots=new RobotsPolicy(network,now);}
  private async prune(ownerId:string):Promise<void>{
    await this.db.transaction().execute(async tx=>{
      await lockSearchOwner(tx,ownerId);
      const result=await tx.deleteFrom('search_index_documents').where('owner_id','=',ownerId).where('expires_at','<=',new Date(this.now())).executeTakeFirst();
      if(Number(result.numDeletedRows)>0)await invalidateSearchOwner(tx,ownerId);
    });
  }
  /** Bounded retention cleanup. Never makes network requests or renews expired content. */
  async pruneExpired(batchSize=20):Promise<number>{
    const owners=await this.db.selectFrom('search_index_documents').select('owner_id').distinct().where('expires_at','<=',new Date(this.now())).limit(Math.max(1,Math.min(100,batchSize))).execute();
    for(const {owner_id:ownerId} of owners)await this.prune(ownerId);
    return owners.length;
  }
  async refresh(ownerId:string,id:string,signal?:AbortSignal){
    searchOwner(ownerId);z.uuid().parse(id);
    const selected=await this.db.transaction().execute(async tx=>{
      const revision=await lockSearchOwner(tx,ownerId);
      const row=await tx.selectFrom('search_index_documents').select(['url','fetched_at','expires_at']).where('owner_id','=',ownerId).where('id','=',id).executeTakeFirst();
      if(!row)throw new BrowserError('SEARCH_INDEX_NOT_FOUND','المصدر غير موجود في فهرسك.',404);
      return {revision,url:row.url,ttlHours:Math.max(1,Math.min(168,Math.round((new Date(row.expires_at).getTime()-new Date(row.fetched_at).getTime())/3600000)))};
    });
    return this.indexUrl(ownerId,{url:selected.url,ttlHours:selected.ttlHours},signal,selected.revision,id);
  }
  async list(ownerId:string){searchOwner(ownerId);await this.prune(ownerId);return (await this.db.selectFrom('search_index_documents').selectAll().where('owner_id','=',ownerId).orderBy('fetched_at','desc').limit(100).execute()).map(metadata);}
  async remove(ownerId:string,id:string):Promise<void>{
    searchOwner(ownerId);z.uuid().parse(id);
    await this.db.transaction().execute(async tx=>{
      await lockSearchOwner(tx,ownerId);
      const deleted=await tx.deleteFrom('search_index_documents').where('owner_id','=',ownerId).where('id','=',id).executeTakeFirst();
      if(!Number(deleted.numDeletedRows))throw new BrowserError('SEARCH_INDEX_NOT_FOUND','المصدر غير موجود في فهرسك.',404);
      await invalidateSearchOwner(tx,ownerId);
    });
  }
  async indexUrl(ownerId:string,raw:unknown,signal?:AbortSignal,expectedRevision?:number,refreshedId?:string){
    searchOwner(ownerId);const input=IndexPublicUrlSchema.parse(raw);signal?.throwIfAborted();
    let target=denySensitiveUrl(input.url,this.network);
    await this.prune(ownerId);
    const revision=await this.db.transaction().execute(tx=>lockSearchOwner(tx,ownerId));
    if(expectedRevision!==undefined&&revision!==expectedRevision)throw new BrowserError('SEARCH_INDEX_CHANGED','تغير فهرسك قبل التحديث؛ أعد المحاولة من القائمة الحالية.',409);
    const requested=target;
    try {
    let source:{url:string;raw:string;html:boolean}|undefined;
    for(let redirects=0;redirects<=5;redirects++){
      signal?.throwIfAborted();target=denySensitiveUrl(target,this.network);
      await this.robots.assertAllowed(target,signal);
      const response=await this.network.request(target,{signal,maxBytes:256000});
      if(/\b(?:noindex|none)\b/i.test(response.headers['x-robots-tag']??''))throw new BrowserError('SEARCH_INDEX_NOINDEX','طلب المصدر عدم فهرسته.',403);
      if([301,302,303,307,308].includes(response.status)&&response.headers.location){target=denySensitiveUrl(new URL(response.headers.location,target).href,this.network);continue;}
      if(response.status!==200)throw new BrowserError('SEARCH_INDEX_HTTP','لم يقدم الموقع مستندًا عامًا ناجحًا (HTTP 200).',502);
      const type=response.headers['content-type']??'';
      if(!/^(?:text\/(?:html|plain|markdown)|application\/xhtml\+xml)(?:;|$)/i.test(type))throw new BrowserError('SEARCH_INDEX_CONTENT','الفهرسة تدعم صفحات HTML والنصوص العامة فقط.');
      const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]??'utf-8';
      let text:string;try{text=new TextDecoder(charset,{fatal:true}).decode(response.body);}catch{throw new BrowserError('SEARCH_INDEX_ENCODING','تعذر فك ترميز المصدر.');}
      source={url:target,raw:text,html:/html/i.test(type)};break;
    }
    if(!source)throw new BrowserError('SEARCH_INDEX_REDIRECTS','تجاوز المصدر حد التحويلات.');
    signal?.throwIfAborted();
    if(source.html&&!allowsIndexing(source.raw))throw new BrowserError('SEARCH_INDEX_NOINDEX','طلب المصدر عدم فهرسته.',403);
    if(publicSearchText(source.raw)!==source.raw)throw new BrowserError('SEARCH_INDEX_SECRET','رُفض المصدر لاحتوائه نمطًا معروفًا لبيانات اعتماد.');
    const extracted=source.html?readableSource(source.raw,source.url):{title:new URL(source.url).hostname,text:source.raw.trim()};
    // HTML entities and compatibility characters can reveal credentials only after extraction.
    for(const value of [extracted.title,extracted.text]) {
      const normalized=value.normalize('NFKC').replace(/\p{Cf}/gu,'');
      if(publicSearchText(normalized)!==normalized)throw new BrowserError('SEARCH_INDEX_SECRET','رُفض المصدر لاحتوائه نمطًا معروفًا لبيانات اعتماد.');
    }
    const title=extracted.title.slice(0,240),content=extracted.text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
    if(!content||content.length>60000||source.html&&extracted.text.length>=60000)throw new BrowserError('SEARCH_INDEX_SIZE','النص فارغ أو يتجاوز حد 60000 حرف؛ لم تُحفظ نسخة مبتورة.');
    const terms=new Map<string,number>();for(const term of searchTokens(`${title} ${title} ${content}`)){if(term.length<=80)terms.set(term,(terms.get(term)??0)+1);}
    if(!terms.size||terms.size>4000)throw new BrowserError('SEARCH_INDEX_TERMS','المصدر خارج حدود المفردات القابلة للفهرسة.');
    const urlHash=searchHash(source.url),contentHash=searchHash(JSON.stringify([title,content])),sourceHash=searchHash(source.raw),time=this.now(),expires=new Date(time+input.ttlHours*3600000);
    return await this.db.transaction().execute(async tx=>{
      if(await lockSearchOwner(tx,ownerId)!==revision)throw new BrowserError('SEARCH_INDEX_CHANGED','تغير فهرسك أثناء الجلب؛ أعد الإضافة صراحةً إذا بقيت مطلوبة.',409);
      signal?.throwIfAborted();
      let prior=await tx.selectFrom('search_index_documents').selectAll().where('owner_id','=',ownerId).where('url_hash','=',urlHash).executeTakeFirst();
      if(refreshedId){
        const original=await tx.selectFrom('search_index_documents').selectAll().where('owner_id','=',ownerId).where('id','=',refreshedId).executeTakeFirst();
        if(!original)throw new BrowserError('SEARCH_INDEX_CHANGED','حُذف المصدر أثناء التحديث.',409);
        // A redirect replaces this explicit source, never leaves an obsolete searchable snapshot.
        if(!prior)prior=original;
        else if(prior.id!==original.id)await tx.deleteFrom('search_index_documents').where('owner_id','=',ownerId).where('id','=',original.id).execute();
      }
      const duplicate=await tx.selectFrom('search_index_documents').selectAll().where('owner_id','=',ownerId).where('content_hash','=',contentHash).executeTakeFirst();
      if(duplicate&&duplicate.id!==prior?.id){
        // The newly fetched URL is not evidence of freshness for the old URL. Do not renew it.
        if(prior){await tx.deleteFrom('search_index_documents').where('owner_id','=',ownerId).where('id','=',prior.id).execute();await invalidateSearchOwner(tx,ownerId);}
        return {document:metadata(duplicate),changed:Boolean(prior),duplicate:true};
      }
      if(!prior){const total=await tx.selectFrom('search_index_documents').select(eb=>eb.fn.countAll().as('count')).where('owner_id','=',ownerId).executeTakeFirstOrThrow();if(Number(total.count)>=100)throw new BrowserError('SEARCH_INDEX_QUOTA','وصل فهرسك إلى 100 مصدر؛ احذف مصدرًا قبل الإضافة.',409);}
      const id=prior?.id??randomUUID(),changed=prior?.content_hash!==contentHash;
      const values={id,owner_id:ownerId,url:source!.url,url_hash:urlHash,source_hash:sourceHash,content_hash:contentHash,title,content,term_count:[...terms.values()].reduce((sum,count)=>sum+count,0),fetched_at:new Date(time),expires_at:expires};
      await tx.insertInto('search_index_documents').values(values).onConflict(oc=>oc.column('id').doUpdateSet(values)).execute();
      if(changed){await tx.deleteFrom('search_index_terms').where('owner_id','=',ownerId).where('document_id','=',id).execute();const rows=[...terms].map(([term,frequency])=>({document_id:id,owner_id:ownerId,term,frequency}));for(let start=0;start<rows.length;start+=400)await tx.insertInto('search_index_terms').values(rows.slice(start,start+400)).execute();}
      await invalidateSearchOwner(tx,ownerId);
      return {document:metadata(values),changed,duplicate:false};
    });
    } catch(error) {
      if(error instanceof BrowserError&&['SEARCH_INDEX_NOINDEX','RESEARCH_ROBOTS_DENIED'].includes(error.code)) {
        await this.db.transaction().execute(async tx=>{
          // A late denied fetch cannot remove a newer explicit owner import.
          if(await lockSearchOwner(tx,ownerId)!==revision)return;
          const removed=await tx.deleteFrom('search_index_documents').where('owner_id','=',ownerId).where('url_hash','in',[...new Set([requested,target])].map(searchHash)).executeTakeFirst();
          if(Number(removed.numDeletedRows)>0)await invalidateSearchOwner(tx,ownerId);
        });
      }
      throw error;
    }
  }
  async search(question:string,limit:number,signal?:AbortSignal,context?:{ownerId:string}):Promise<LocalIndexHit[]>{
    if(!context?.ownerId)return [];const ownerId=searchOwner(context.ownerId);signal?.throwIfAborted();await this.prune(ownerId);
    let query:ReturnType<typeof compileQuery>;try{query=compileQuery(question);}catch{throw new BrowserError('RESEARCH_QUERY_INVALID','اكتب موضوعًا محددًا للبحث.',400);}
    const count=Math.max(1,Math.min(20,Number.isFinite(limit)?Math.floor(limit):5));
    // Full bounded owner corpus supplies BM25 document lengths/frequencies; only matching terms leave SQL.
    const docs=await this.db.selectFrom('search_index_documents').selectAll().where('owner_id','=',ownerId).where('expires_at','>',new Date(this.now())).limit(100).execute();
    const terms=await this.db.selectFrom('search_index_terms').select(['document_id','term','frequency']).where('owner_id','=',ownerId).where('term','in',query.tokens).execute();
    signal?.throwIfAborted();const average=docs.reduce((sum,row)=>sum+row.term_count,0)/Math.max(1,docs.length);
    const frequency=new Map(query.tokens.map(term=>[term,new Set(terms.filter(row=>row.term===term).map(row=>row.document_id)).size]));
    return docs.flatMap(row=>{
      if(new Date(row.expires_at).getTime()<=this.now())return [];
      if(!matchesSearchPhrases(query,row.title,row.content))return [];
      const host=new URL(row.url).hostname;if(query.sites.length&&!query.sites.some(site=>host===site||host.endsWith(`.${site}`)))return [];
      const found=terms.filter(term=>term.document_id===row.id);if(found.length<Math.min(2,query.tokens.length))return [];
      const score=found.reduce((sum,term)=>sum+Math.log(1+(docs.length-frequency.get(term.term)!+0.5)/(frequency.get(term.term)!+0.5))*term.frequency*2.2/(term.frequency+1.2*(0.25+0.75*row.term_count/Math.max(1,average))),0);
      const snippet=localSearchSnippet(query,row.title,row.content);
      if(snippet===null)return [];
      return [{title:row.title,url:row.url,snippet,coverage:'local_only' as const,freshness:'indexed_snapshot' as const,fetchedAt:iso(row.fetched_at),expiresAt:iso(row.expires_at),contentHash:row.content_hash,sourceHash:row.source_hash,trust:'untrusted' as const,score}];
    }).sort((a,b)=>b.score-a.score||a.url.localeCompare(b.url)).slice(0,count).map(({score,...hit})=>hit);
  }
}
