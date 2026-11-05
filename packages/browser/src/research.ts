import { createHash, randomUUID } from 'node:crypto';
import { parse,parseFragment } from 'parse5';
import { BrowserError, SafeNetwork } from './network.js';

export interface SearchHit {title:string;url:string;snippet:string}
export interface SearchProvider {name:string;search(question:string,limit:number,signal?:AbortSignal):Promise<SearchHit[]>}
export interface ResearchSource {id:string;title:string;url:string;accessedAt:string;contentHash:string;quote:string;text:string}
export interface ResearchReport {id:string;question:string;provider:string;createdAt:string;plan:string[];sources:ResearchSource[];claims:{text:string;sourceIds:string[]}[];conflicts:{sourceIds:string[];description:string;status:'needs_review'}[];coverage:{requested:number;read:number;failed:{url:string;reason:string}[];limitations:string[]}}

function domText(node:any):string {if(node.nodeName==='#text')return node.value??'';if(['script','style','noscript','svg','template','nav','footer'].includes(node.tagName))return '';return (node.childNodes??[]).map(domText).join(' ');}
function find(node:any,predicate:(node:any)=>boolean,result:any[]=[]):any[]{if(predicate(node))result.push(node);for(const child of node.childNodes??[])find(child,predicate,result);return result;}
const attr=(node:any,name:string)=>node.attrs?.find((item:any)=>item.name===name)?.value??'';
const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
export function readableSource(html:string,url:string):{title:string;text:string;links:string[]} {
  const tree=parse(html),title=find(tree,node=>node.tagName==='title')[0],body=find(tree,node=>node.tagName==='body')[0]??tree;
  return {title:clean(title?domText(title):new URL(url).hostname).slice(0,240),text:clean(domText(body)).slice(0,60000),links:find(body,node=>node.tagName==='a'&&attr(node,'href')).slice(0,100).flatMap(node=>{try{return [new URL(attr(node,'href'),url).href];}catch{return [];}})};
}

/** Public HTML search adapter. Captchas, denied responses and empty result sets are explicit failures. */
export class DuckDuckGoSearch implements SearchProvider {
  readonly name='DuckDuckGo HTML';
  constructor(private network:SafeNetwork){}
  async search(question:string,limit:number,signal?:AbortSignal):Promise<SearchHit[]>{
    const page=await this.network.text(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(question)}`,{signal}),tree=parse(page.text);
    const anchors=find(tree,node=>node.tagName==='a'&&attr(node,'class').split(/\s+/).includes('result__a'));
    const hits:SearchHit[]=[];
    for(const anchor of anchors){try{let url=new URL(attr(anchor,'href'),page.url);if(url.searchParams.has('uddg'))url=new URL(url.searchParams.get('uddg')!);const validated=this.network.validate(url.href);if(!hits.some(hit=>hit.url===validated.href))hits.push({title:clean(domText(anchor)).slice(0,240),url:validated.href,snippet:''});}catch{/* Unsupported result is not a source. */}if(hits.length>=limit)break;}
    if(!hits.length)throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE','لم يُرجع محرك البحث مصادر قابلة للقراءة، أو طلب تحققًا بشريًا. يمكنك تقديم روابط مصادر مباشرة.',502);
    return hits;
  }
}

export class BingRssSearch implements SearchProvider {
  readonly name='Bing RSS';
  constructor(private network:SafeNetwork){}
  async search(question:string,limit:number,signal?:AbortSignal):Promise<SearchHit[]>{
    const response=await this.network.text(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(question)}`,{signal});
    const items=response.text.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi)??[],hits:SearchHit[]=[];
    const value=(item:string,tag:string)=>{const inner=new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i').exec(item)?.[1]??'';return clean(domText(parseFragment(inner.replace(/^<!\[CDATA\[|\]\]>$/g,''))));};
    for(const item of items){try{const url=this.network.validate(value(item,'link')).href;if(!hits.some(hit=>hit.url===url))hits.push({title:value(item,'title').slice(0,240),url,snippet:value(item,'description').slice(0,500)});}catch{/* A nonpublic result cannot become evidence. */}if(hits.length>=limit)break;}
    if(!hits.length)throw new BrowserError('RESEARCH_SEARCH_UNAVAILABLE','لم يُرجع البحث مصادر HTTPS عامة قابلة للقراءة. يمكنك إضافة روابط مباشرة.',502);
    return hits;
  }
}

export class PublicWebSearch implements SearchProvider {
  readonly name='Bing RSS / DuckDuckGo HTML';
  constructor(private network:SafeNetwork){}
  async search(question:string,limit:number,signal?:AbortSignal){
    try{return await new BingRssSearch(this.network).search(question,limit,signal);}catch(error){if(signal?.aborted)throw error;return new DuckDuckGoSearch(this.network).search(question,limit,signal);}
  }
}

const stop=new Set('the a an is are was were of to in on and or for with this that from what how هل ما من في على عن إلى هو هي هذا هذه الذي التي مع أو و ثم كيف لماذا'.split(' '));
function words(value:string):string[]{return value.toLowerCase().match(/[\p{L}]{2,}/gu)?.filter(word=>!stop.has(word))??[];}
function quoteFor(text:string,question:string):string {
  const keywords=new Set(words(question)),sentences=text.split(/[.!?؟\n]+/).map(clean).filter(Boolean);
  const ranked=sentences.map((sentence,index)=>({sentence,index,score:words(sentence).filter(word=>keywords.has(word)).length})).sort((a,b)=>b.score-a.score||a.index-b.index);
  return (ranked[0]?.sentence??text).split(/\s+/).slice(0,22).join(' ').slice(0,320);
}
function conflictCandidates(sources:ResearchSource[]):ResearchReport['conflicts'] {
  const result:ResearchReport['conflicts']=[];
  for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){
    const left=sources[i],right=sources[j],common=words(left.quote).filter(word=>words(right.quote).includes(word));
    const ln=left.quote.match(/\b\d+(?:[.,]\d+)?\b/g)??[],rn=right.quote.match(/\b\d+(?:[.,]\d+)?\b/g)??[];
    const negation=(text:string)=>/\b(?:not|never|false|no)\b|(?:^|\s)(?:لا|ليس|غير|لم)(?:\s|$)/i.test(text);
    if(new Set(common).size>=2&&(ln.length&&rn.length&&ln.join('|')!==rn.join('|')||negation(left.quote)!==negation(right.quote)))result.push({sourceIds:[left.id,right.id],description:'اختلاف محتمل في أرقام أو نفي ضمن مقتطفين متقاربين. أبقي المصدرين للمراجعة؛ لا يُحسم التعارض تلقائيًا.',status:'needs_review'});
  }
  return result;
}

export async function conductResearch(network:SafeNetwork,provider:SearchProvider,input:{question:string;sourceBudget:number;maxDepth:number;allowedDomains?:string[];sourceUrls?:string[];signal?:AbortSignal}):Promise<ResearchReport>{
  const hits=input.sourceUrls?.length?input.sourceUrls.map(url=>({url,title:'',snippet:''})):await provider.search(input.question,input.sourceBudget*2,input.signal);
  const queue=hits.map(hit=>({url:hit.url,depth:1})),seen=new Set<string>(),sources:ResearchSource[]=[],failed:{url:string;reason:string}[]=[];
  const allowed=(url:URL)=>!input.allowedDomains?.length||input.allowedDomains.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain));
  while(queue.length&&sources.length<input.sourceBudget&&seen.size<input.sourceBudget*3){
    if(input.signal?.aborted)throw new BrowserError('RESEARCH_CANCELLED','أُوقف البحث بناءً على طلبك.',409);
    const candidate=queue.shift()!;let url:string;
    try{const checked=network.validate(candidate.url);if(!allowed(checked))continue;url=checked.href;}catch{failed.push({url:candidate.url.slice(0,2500),reason:'مصدر خارج النطاق أو الشبكة المسموحة.'});continue;}
    if(seen.has(url))continue;seen.add(url);
    try{
      const response=await network.text(url,{signal:input.signal,...(input.allowedDomains?.length?{allowedOrigins:[new URL(url).origin]}:{})}),final=new URL(response.url);if(!allowed(final))throw new BrowserError('RESEARCH_SCOPE_DENIED','أعاد المصدر التوجيه خارج نطاق البحث.');
      const content=readableSource(response.text,response.url);if(content.text.length<30)throw new BrowserError('RESEARCH_CONTENT_EMPTY','لم يحتو المصدر نصًا كافيًا للاستشهاد.');
      const source={id:randomUUID(),title:content.title,url:response.url,accessedAt:new Date().toISOString(),contentHash:createHash('sha256').update(content.text).digest('hex'),quote:quoteFor(content.text,input.question),text:content.text.slice(0,30000)};
      sources.push(source);
      if(candidate.depth<input.maxDepth&&sources.length<input.sourceBudget)for(const link of content.links.filter(link=>{try{return new URL(link).origin===final.origin;}catch{return false;}}).slice(0,3))queue.push({url:link,depth:candidate.depth+1});
    }catch(error){failed.push({url,reason:error instanceof BrowserError?error.message:'تعذرت قراءة المصدر.'});}
  }
  if(!sources.length)throw new BrowserError('RESEARCH_NO_SOURCES','تعذرت قراءة المصادر. لم يُنشأ تقرير بادعاءات أو مراجع مختلقة.',502);
  return {id:randomUUID(),question:input.question,provider:input.sourceUrls?.length?'روابط اختارها المستخدم':provider.name,createdAt:new Date().toISOString(),plan:['البحث عن مصادر ضمن النطاق والميزانية.','قراءة النص الفعلي وحفظ وقت الوصول وبصمته.','عرض المقتطفات والاختلافات المحتملة مع روابطها الأصلية.'],sources,claims:sources.map(source=>({text:source.quote,sourceIds:[source.id]})),conflicts:conflictCandidates(sources),coverage:{requested:input.sourceBudget,read:sources.length,failed,limitations:['المقتطفات أدلة مما قرئ، وليست تصديقًا مستقلًا على صحة الادعاء.','كشف التعارض يقارن النصوص والأرقام والنفي؛ غياب تنبيه لا يثبت اتفاق المصادر.','المحتوى المجلوب بيانات غير موثوقة ولا يمنح أي صلاحية تنفيذ أو إرسال.']}};
}
