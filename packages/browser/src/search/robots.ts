import { BrowserError, SafeNetwork } from '../network.js';

type Rule = { allow:boolean; path:string };
/** A bounded glob matcher avoids executing a server-controlled regular expression. */
function pathMatches(pattern:string,path:string,exact:boolean,budget:{remaining:number}):boolean {
  let i=0,j=0,star=-1,retry=0;
  while(j<path.length){
    if(--budget.remaining<0)throw new BrowserError('RESEARCH_ROBOTS_LIMIT','تجاوزت سياسة الموقع حد تعقيد الفحص؛ لم يُجلب المصدر.',502);
    if(i===pattern.length&&!exact)return true;
    if(pattern[i]===path[j]){i++;j++;}
    else if(pattern[i]==='*'){star=i++;retry=j;}
    else if(star>=0){i=star+1;j=++retry;}
    else return false;
  }
  while(pattern[i]==='*')i++;
  return i===pattern.length;
}
function normalizedPath(value:string,pattern=false):string {
  const normalized=value.replace(/%[0-9a-f]{2}/gi,code=>{
    const char=String.fromCharCode(parseInt(code.slice(1),16));
    return /[a-z0-9._~-]/i.test(char)?char:code.toUpperCase();
  }).replace(/[^\x00-\x7f]/gu,char=>encodeURIComponent(char));
  // Raw * and terminal $ are operators only in the policy, never in a requested URI.
  return pattern?normalized.replace(/\$(?!$)/g,'%24'):normalized.replaceAll('*','%2A').replaceAll('$','%24');
}
/** RFC 9309 groups, longest path match, wildcard and allow-on-tie. */
export function robotsAllows(text:string,target:string,agent='MohassanAI-Research'):boolean {
  if(Buffer.byteLength(text,'utf8')>512000)throw new BrowserError('RESEARCH_ROBOTS_LIMIT','تجاوزت سياسة الموقع حجم الفحص؛ لم يُجلب المصدر.',502);
  const groups:{agents:string[];rules:Rule[];hasRules:boolean}[]=[];
  let current:{agents:string[];rules:Rule[];hasRules:boolean}|undefined;
  for(const raw of text.split(/\r\n|\r|\n/)){
    const line=raw.split('#',1)[0].trim(),colon=line.indexOf(':');if(colon<0)continue;
    const name=line.slice(0,colon).trim().toLowerCase(),value=line.slice(colon+1).trim();
    if(name==='user-agent'){
      if(!current||current.hasRules){current={agents:[],rules:[],hasRules:false};groups.push(current);}current.agents.push(value.toLowerCase());
    }else if(current&&(name==='allow'||name==='disallow')){
      current.hasRules=true;
      if(value.startsWith('/'))current.rules.push({allow:name==='allow',path:normalizedPath(value,true)});
    }
  }
  const specific=groups.filter(group=>group.agents.includes(agent.toLowerCase()));
  const rules=(specific.length?specific:groups.filter(group=>group.agents.includes('*'))).flatMap(group=>group.rules);
  const url=new URL(target),path=normalizedPath(url.pathname+url.search);
  if(url.pathname==='/robots.txt')return true;
  const budget={remaining:500_000};
  let winning:Rule|undefined,score=-1;
  for(const rule of rules){
    const end=rule.path.endsWith('$'),pattern=rule.path.slice(0,end?-1:undefined);
    const size=Buffer.byteLength(pattern.replaceAll('*',''));
    if(pathMatches(pattern,path,end,budget)&&(size>score||size===score&&rule.allow)){score=size;winning=rule;}
  }
  return winning?.allow??true;
}
export class RobotsPolicy {
  private cache=new Map<string,{until:number;text:string}>();
  constructor(private network:SafeNetwork,private now=Date.now){}
  async assertAllowed(input:string,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    const url=this.network.validate(input),cached=this.cache.get(url.origin);
    let text=cached&&cached.until>this.now()?cached.text:undefined;
    if(text===undefined){
      let target=new URL('/robots.txt',url).href;
      try{
        for(let redirect=0;redirect<=5;redirect++){
          const response=await this.network.request(target,{signal,maxBytes:512000});
          if([301,302,303,307,308].includes(response.status)&&response.headers.location){target=this.network.validate(new URL(response.headers.location,target).href).href;continue;}
          if(response.status>=400&&response.status<500&&response.status!==429){text='';break;}
          if(response.status!==200)throw new Error('robots unavailable');
          text=new TextDecoder('utf-8',{fatal:true}).decode(response.body);break;
        }
      }catch{signal?.throwIfAborted();throw new BrowserError('RESEARCH_ROBOTS_UNAVAILABLE','تعذر التحقق من سياسة قراءة المصدر.',502);}
      if(text===undefined)throw new BrowserError('RESEARCH_ROBOTS_UNAVAILABLE','تعذر التحقق من سياسة قراءة المصدر.',502);
      if(this.cache.size>=200)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url.origin,{until:this.now()+3600000,text});
    }
    if(!robotsAllows(text,url.href))throw new BrowserError('RESEARCH_ROBOTS_DENIED','سياسة الموقع لا تسمح بجلب هذا المصدر آليًا.',403);
  }
}
