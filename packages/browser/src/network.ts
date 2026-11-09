import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export class BrowserError extends Error {
  constructor(public readonly code:string,message:string,public readonly statusCode=400){super(message);this.name='BrowserError';}
}
export interface NetworkAddress {address:string;family:4|6}
export interface NetworkPolicy {testOrigins?:string[];resolver?:(hostname:string)=>Promise<NetworkAddress[]>;userAgent?:string}
export interface SafeResponse {status:number;headers:Record<string,string>;body:Buffer;url:string}

export function isPublicAddress(address:string):boolean {
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(address)===6){
    const lower=address.toLowerCase();
    // Only native global unicast. IPv4-mapped, transition, local and reserved
    // address families cannot turn a public hostname into a private connection.
    if(!/^[23][\da-f]{3}:/i.test(lower)||lower.includes('.'))return false;
    const first=parseInt(lower.split(':')[0],16),second=parseInt(lower.split(':')[1]||'0',16);
    return !(first===0x2002||first===0x2001&&(second===0||second===2||second===0xdb8||second>=0x10&&second<=0x2f));
  }
  return false;
}

/** Set by Node for the connection, or framing that must not cross this proxy. */
const CONNECTION_HEADERS = new Set(['host', 'connection', 'content-length', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const BROWSER_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function decoded(body: Buffer, encoding: string, maxOutputLength: number): Buffer {
  if (encoding === 'gzip') return gunzipSync(body, { maxOutputLength });
  if (encoding === 'br') return brotliDecompressSync(body, { maxOutputLength });
  if (encoding === 'deflate') return inflateSync(body, { maxOutputLength });
  return body;
}

export class SafeNetwork {
  private testOrigins:Set<string>;
  constructor(readonly policy:NetworkPolicy={}){this.testOrigins=new Set((policy.testOrigins??[]).map(value=>new URL(value).origin));}
  validate(input:string,allowedOrigins?:readonly string[]):URL {
    let url:URL;try{url=new URL(input);}catch{throw new BrowserError('BROWSER_URL_INVALID','عنوان الصفحة غير صالح.');}
    const test=this.testOrigins.has(url.origin);
    if(url.username||url.password||url.hash.length>2000||input.length>2500||(!test&&(url.protocol!=='https:'||url.port&&url.port!=='443'))||(test&&!['http:','https:'].includes(url.protocol)))throw new BrowserError('BROWSER_URL_DENIED','تحتاج القراءة عنوان HTTPS عامًا دون بيانات دخول أو منفذ خاص.');
    const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    if(!test&&(/(?:^|\.)(?:localhost|local|internal|home|onion|invalid|test)$/.test(hostname)||isIP(hostname)&&!isPublicAddress(hostname)))throw new BrowserError('BROWSER_NETWORK_DENIED','القراءة إلى الشبكات الداخلية والعناوين الخاصة غير مسموحة.');
    if(allowedOrigins&&!allowedOrigins.includes(url.origin))throw new BrowserError('BROWSER_SCOPE_DENIED','الوجهة خارج نطاق المواقع الذي اخترته.');
    url.hash='';return url;
  }
  async pin(input:string,allowedOrigins?:readonly string[]):Promise<{url:URL;address:NetworkAddress}> {
    const url=this.validate(input,allowedOrigins),hostname=url.hostname.replace(/^\[|\]$/g,'');
    if(this.testOrigins.has(url.origin))return {url,address:{address:hostname,family:(isIP(hostname)||4) as 4|6}};
    let deadline:ReturnType<typeof setTimeout>|undefined;
    const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname) as 4|6}]:await Promise.race([this.policy.resolver?.(hostname)??lookup(hostname,{all:true,verbatim:true}).then(rows=>rows.map(row=>({address:row.address,family:row.family as 4|6}))),new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('DNS timeout')),5000);})]).catch(()=>{throw new BrowserError('BROWSER_DNS_FAILED','تعذر التحقق من عنوان الموقع.',502);}).finally(()=>{if(deadline)clearTimeout(deadline);});
    if(!addresses.length||addresses.length>16||addresses.some(item=>![4,6].includes(item.family)||!isPublicAddress(item.address)))throw new BrowserError('BROWSER_NETWORK_DENIED','رفض فحص الشبكة عنوانًا داخليًا أو سجل DNS مختلطًا.');
    return {url,address:addresses[0]};
  }
  /** browser: carries a real page's traffic with its own identity. Address checks are the same. */
  async request(input:string,options:{allowedOrigins?:readonly string[];method?:string;headers?:Record<string,string>;body?:string|Buffer;signal?:AbortSignal;maxBytes?:number;browser?:boolean;allowAttachment?:boolean;beforeDispatch?:()=>Promise<void>}={}):Promise<SafeResponse>{
    const browser=options.browser===true;
    const {url,address}=await this.pin(input,options.allowedOrigins),maximum=options.maxBytes??(browser?64_000_000:2_000_000);
    const method=options.method??'GET';
    if(!(browser?BROWSER_METHODS:['GET','HEAD','POST']).includes(method)||options.body&&Buffer.byteLength(options.body)>(browser?8_000_000:16000))throw new BrowserError('BROWSER_METHOD_DENIED','نوع الطلب أو حجمه خارج نطاق القراءة والموافقة.');
    const userAgent=this.policy.userAgent??'MohassanAI-Research/1.0 (+https://www.mohassansy.com)';
    if(!browser&&(!userAgent.trim()||userAgent.length>250||/[\r\n\u0000-\u001f]/.test(userAgent)))throw new BrowserError('BROWSER_USER_AGENT_INVALID','هوية قارئ المصادر غير صالحة.');
    const headers:Record<string,string>=browser?{}:{'user-agent':userAgent,'accept-encoding':'identity',accept:'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'};
    for(const [key,value] of Object.entries(options.headers??{})){
      const name=key.toLowerCase();
      if(browser?!name.startsWith(':')&&!CONNECTION_HEADERS.has(name):['accept','accept-language','content-type','cookie'].includes(name)&&value.length<16000)headers[name]=value;
    }
    if(browser)headers['accept-encoding']='gzip, br';
    if(options.body)headers['content-length']=String(Buffer.byteLength(options.body));
    options.signal?.throwIfAborted();
    await options.beforeDispatch?.();
    options.signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const transport=url.protocol==='https:'?https:http;
      const request=transport.request(url,{method,headers,agent:false,lookup:((_host:any,opts:any,callback:any)=>opts?.all?callback(null,[address]):callback(null,address.address,address.family)) as any,signal:options.signal,timeout:browser?30000:10000},response=>{
        const encoding=String(response.headers['content-encoding']??'').toLowerCase();
        if(!['','identity','gzip','br','deflate'].includes(encoding)){response.destroy();reject(new BrowserError('BROWSER_ENCODING_DENIED','أعاد الموقع ترميزًا غير مدعوم ضمن حدود القراءة.',502));return;}
        const resultHeaders:Record<string,string>={};
        for(const key of browser?Object.keys(response.headers).filter(name=>!CONNECTION_HEADERS.has(name)&&name!=='content-encoding'):['content-type','location','set-cookie','content-language','retry-after','etag','last-modified','x-robots-tag','access-control-allow-origin','access-control-allow-credentials','access-control-expose-headers']){const value=response.headers[key];if(value)resultHeaders[key]=Array.isArray(value)?value.join('\n'):value;}
        if(/attachment/i.test(response.headers['content-disposition']??'')&&!options.allowAttachment){response.destroy();reject(new BrowserError('BROWSER_DOWNLOAD_DENIED','التنزيلات غير مفعلة في جلسة القراءة.'));return;}
        let total=0;const chunks:Buffer[]=[];
        response.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>maximum){response.destroy();reject(new BrowserError('BROWSER_RESPONSE_TOO_LARGE','تجاوزت الصفحة حد حجم القراءة.'));}else chunks.push(chunk);});
        response.on('end',()=>{
          try{resolve({status:response.statusCode??502,headers:resultHeaders,body:decoded(Buffer.concat(chunks),encoding,maximum),url:url.href});}
          catch{reject(new BrowserError('BROWSER_FETCH_FAILED','تعذر فك ترميز الرد ضمن حدود الحجم.',502));}
        });
        response.on('error',()=>reject(new BrowserError('BROWSER_FETCH_FAILED','انقطع نقل الصفحة؛ لم تُفترض نتيجة ناجحة.',502)));
      });
      request.on('timeout',()=>request.destroy(new Error('timeout')));
      const deadline=setTimeout(()=>request.destroy(new Error('deadline')),browser?45000:12000);request.once('close',()=>clearTimeout(deadline));
      request.on('error',()=>reject(new BrowserError('BROWSER_FETCH_FAILED','تعذر جلب الصفحة ضمن المهلة وحدود الشبكة.',502)));
      request.end(options.body);
    });
  }
  async text(input:string,options:{allowedOrigins?:readonly string[];signal?:AbortSignal;beforeRequest?:(url:string)=>Promise<void>}={}):Promise<{url:string;text:string;status:number}> {
    let target=input;
    for(let redirects=0;redirects<=5;redirects++){
      target=this.validate(target,options.allowedOrigins).href;
      await options.beforeRequest?.(target);
      const response=await this.request(target,options);
      if([301,302,303,307,308].includes(response.status)&&response.headers.location){target=this.validate(new URL(response.headers.location,target).href,options.allowedOrigins).href;continue;}
      if(response.status<200||response.status>=400)throw new BrowserError('BROWSER_HTTP_ERROR',`لم يسمح المصدر بقراءة المحتوى (HTTP ${response.status}).`,502);
      if(response.status===202)throw new BrowserError('RESEARCH_SOURCE_PENDING','لم يقدّم المصدر محتوى نهائيًا؛ قد يكون بانتظار تحقق أو معالجة.',502);
      const type=response.headers['content-type']??'';
      if(type&&!/^(?:text\/|application\/(?:xhtml\+xml|xml|json))/i.test(type))throw new BrowserError('BROWSER_CONTENT_DENIED','نوع المصدر ليس صفحة نصية قابلة للقراءة.');
      const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]??'utf-8';
      let text:string;
      try{text=new TextDecoder(charset,{fatal:true}).decode(response.body);}catch{throw new BrowserError('BROWSER_ENCODING_DENIED','تعذر فك ترميز المصدر حسب الترميز المعلن.',502);}
      return {url:target,text,status:response.status};
    }
    throw new BrowserError('BROWSER_REDIRECT_LIMIT','تجاوز المصدر حد إعادة التوجيه.');
  }
}
