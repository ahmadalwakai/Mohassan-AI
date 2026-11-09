import { createHash } from 'node:crypto';
import { BrowserError, SafeNetwork } from '../network.js';
import type { SearchHit, SearchProvider } from '../research.js';
import { compileQuery, rankResults, type RankedHit } from './ranking.js';
import { documentedProviders, SearchProviderFailure, type DocumentedProvider } from './providers.js';
import { PROVIDER_INTERVALS, SEARCH_POLICY_VERSION, searchHash, type SearchCacheStore, type SearchProviderAdmission } from './store.js';
import { publicSearchScan, publicSearchText, type LocalIndexHit, type SearchLocalIndex } from './local-index.js';
import { safeResumeUrl } from '../session-state.js';

export interface SearchOutcome {
  hits: (RankedHit & Partial<Pick<LocalIndexHit,'coverage'|'freshness'|'fetchedAt'|'expiresAt'|'contentHash'|'sourceHash'|'trust'>>)[];
  fetchedAt: string;
  freshness: 'fresh' | 'cached' | 'indexed_snapshot';
  coverage: 'specialized_sources' | 'local_only' | 'mixed';
  failures: { provider: string; kind: 'rate_limited' | 'unavailable' | 'invalid_response' }[];
  limitations: string[];
}
export interface SearchContext { ownerId: string }
/** Owner-partitioned bounded cache, circuit breaker and deterministic concurrent retrieval. */
export class SearchEngine implements SearchProvider {
  readonly name:string;
  readonly limitations = ['مصادر متخصصة وليست فهرسًا شاملًا للويب؛ لا تثبت الأسعار أو الطقس أو المواعيد الحالية.'];
  private cache = new Map<string, { until: number; result: SearchOutcome }>();
  private health = new Map<string, { failures: number; next: number }>();
  private active = new Set<string>();
  private providers: DocumentedProvider[];
  private now: () => number;
  constructor(private network: SafeNetwork, private options: { providers?: DocumentedProvider[]; now?: () => number; store?:SearchCacheStore; localIndex?:SearchLocalIndex; admission?:SearchProviderAdmission } = {}) {
    this.now = options.now ?? Date.now;
    this.providers = (options.providers ?? documentedProviders(network, this.now)).filter(provider=>provider.name!=='arXiv'||options.admission);
    this.name=[...this.providers.map(provider=>provider.name),...(options.localIndex?[options.localIndex.name]:[])].join(' / ');
  }
  async execute(question: string, limit: number, signal?: AbortSignal, context?: SearchContext): Promise<SearchOutcome> {
    signal?.throwIfAborted();
    const publicQuery=question.normalize('NFKC').replace(/\p{Cf}/gu,'');
    const decodedQuery=publicSearchScan(publicQuery);
    if(publicSearchText(publicQuery)!==publicQuery||publicSearchText(decodedQuery)!==decodedQuery||(decodedQuery.match(/https?:\/\/\S+/gi)??[]).some(url=>safeResumeUrl(url)===null))throw new BrowserError('RESEARCH_QUERY_SECRET','أزل بيانات الاعتماد من الاستعلام قبل البحث العام.',400);
    let query:ReturnType<typeof compileQuery>;
    try { query = compileQuery(question); } catch { throw new BrowserError('RESEARCH_QUERY_INVALID','اكتب موضوعًا محددًا للبحث، واستخدم site: مع اسم نطاق صالح فقط.',400); }
    const count = Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
    const key = context?.ownerId ? createHash('sha256').update(JSON.stringify([SEARCH_POLICY_VERSION,context.ownerId,query,count,this.providers.map(p=>p.name)])).digest('hex') : null;
    const revision=context?.ownerId&&this.options.store?await this.options.store.revision(context.ownerId):0;
    if(key&&this.options.store){const stored=await this.options.store.get(context!.ownerId,key,revision);signal?.throwIfAborted();if(stored)return stored;}
    const cached = key&&!this.options.store&&!this.options.localIndex ? this.cache.get(key) : undefined;
    if (cached && cached.until > this.now()) return { ...structuredClone(cached.result), freshness:'cached' };
    const failures: SearchOutcome['failures'] = [];
    const rows = await Promise.all(this.providers.filter(provider => provider.supports(query)).map(async provider => {
      const health = this.health.get(provider.name) ?? { failures:0,next:0 };
      if (health.next > this.now() || this.active.has(provider.name)) { failures.push({provider:provider.name,kind:'rate_limited'}); return {provider:provider.name,hits:[]}; }
      let admissionToken:string|undefined;
      if(this.options.admission&&Object.hasOwn(PROVIDER_INTERVALS,provider.name)){
        try {
          const claimed=await this.options.admission.acquireProvider(provider.name,searchHash(query.retrievalQuestion.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()));
          if(!('token' in claimed)){failures.push({provider:provider.name,kind:'rate_limited'});return {provider:provider.name,hits:[]};}
          admissionToken=claimed.token;
        }catch{signal?.throwIfAborted();failures.push({provider:provider.name,kind:'unavailable'});return {provider:provider.name,hits:[]};}
      }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      // The deadline also bounds a faulty injected provider that ignores its signal.
      let onAbort:()=>void;
      const abort = new Promise<never>((_, reject) => {onAbort=()=>reject(combined.reason);if(combined.aborted)onAbort();else combined.addEventListener('abort',onAbort,{once:true});});
      this.active.add(provider.name);
      this.health.set(provider.name,{...health,next:this.now()+1000});
      const providerRequest=Promise.resolve().then(()=>{combined.throwIfAborted();return provider.search(query,Math.min(count*3,20),combined);});
      // A caller timeout is not proof that a non-cooperative transport has stopped.
      // Keep this provider busy until its original promise settles, including late rejection.
      const completed=async(error?:unknown)=>{
        const delay=Math.max(error instanceof SearchProviderFailure?error.retryAfterMs:0,provider.cooldownMs?.()??0);
        if(admissionToken&&!await this.options.admission!.releaseProvider(provider.name,admissionToken,delay))throw new Error('SEARCH_ADMISSION_LOST');
        this.active.delete(provider.name);
      };
      const releasedRequest=providerRequest.then(async hits=>{await completed();return hits;},async error=>{await completed(error);throw error;});
      try {
        const hits = await Promise.race([releasedRequest,abort]);
        this.health.set(provider.name,{failures:0,next:this.now()+1000});
        return {provider:provider.name,hits:hits.filter(hit => { try { this.network.validate(hit.url); return Boolean(safeResumeUrl(hit.url)); } catch { return false; } }).map(hit=>({...hit,title:publicSearchText(hit.title).slice(0,240),snippet:publicSearchText(hit.snippet).slice(0,2000)}))};
      } catch (error) {
        signal?.throwIfAborted();
        const kind = error instanceof SearchProviderFailure ? error.kind : 'unavailable';
        const delay = error instanceof SearchProviderFailure && error.retryAfterMs ? error.retryAfterMs : health.failures >= 2 ? 60_000 : 1000;
        this.health.set(provider.name,{failures:health.failures+1,next:this.now()+delay});
        failures.push({provider:provider.name,kind}); return {provider:provider.name,hits:[]};
      } finally { clearTimeout(timer); combined.removeEventListener('abort',onAbort!); }
    }));
    const local=await this.options.localIndex?.search(question,Math.min(count*3,20),signal,context)??[];
    if(local.length)rows.push({provider:this.options.localIndex!.name,hits:local});
    signal?.throwIfAborted();
    const hits=rankResults(query,rows,count);
    // Preserve index provenance even when a live provider has the richer description of the same URL.
    const indexed=new Map(local.map(hit=>[hit.url,hit]));
    const annotated:SearchOutcome['hits']=hits.map(hit=>{const item=indexed.get(hit.url);return item?{...hit,...item}:hit;});
    const hasLocal=annotated.some(hit=>hit.coverage==='local_only'),hasRemote=annotated.some(hit=>hit.providers.some(name=>name!==this.options.localIndex?.name));
    const result: SearchOutcome = { hits:annotated,fetchedAt:new Date(this.now()).toISOString(),freshness:hasLocal&&!hasRemote?'indexed_snapshot':'fresh',coverage:hasLocal?(hasRemote?'mixed':'local_only'):'specialized_sources',failures:failures.sort((a,b)=>a.provider.localeCompare(b.provider)),
      limitations:['هذه مصادر موسوعية وتقنية وأكاديمية متخصصة، وليست فهرسًا شاملاً للويب.','الترتيب مبني على تطابق النص؛ يلزم فتح المصدر للتحقق من الادعاءات.',...(hasLocal?['المصادر المحلية نسخ أضافها المالك صراحة؛ fetchedAt وقت جلب النسخة وليس تاريخ تحديث الموقع.']:[]),...(query.timeSensitive?['لا تثبت هذه النتائج الأسعار أو الطقس أو المواعيد الحالية؛ استخدم مصدر الخدمة المباشر.']:[])] };
    const ttl=result.hits.length?(query.timeSensitive?15_000:query.intent==='general'?60_000:120_000):10_000;
    if(key&&this.options.store){signal?.throwIfAborted();await this.options.store.put(context!.ownerId,key,revision,result,ttl);signal?.throwIfAborted();}
    else if (key&&!this.options.localIndex) {
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,{until:this.now()+ttl,result:structuredClone(result)});
    }
    return result;
  }
  async search(question:string,limit:number,signal?:AbortSignal,context?:SearchContext): Promise<SearchHit[]> {
    const result=await this.execute(question,limit,signal,context);
    if (!result.hits.length) throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE','لم تجد المصادر المتخصصة نتيجة موثوقة. افتح موقع الخدمة مباشرة أو أضف رابطًا للمصدر.',502);
    return result.hits.map(hit=>hit.coverage==='local_only'?{...hit,snippet:`نسخة مفهرسة بتاريخ ${hit.fetchedAt}. ${hit.snippet}`} : hit);
  }
}
