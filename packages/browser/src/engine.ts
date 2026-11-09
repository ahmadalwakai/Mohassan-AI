import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BrowserError, SafeNetwork, type NetworkPolicy } from './network.js';

export interface BrowserField {id:string;index:number;name:string;type:string;label:string;options:string[]}
export interface BrowserForm {id:string;index:number;action:string;method:string;fingerprint:string;fields:BrowserField[];sensitive?:boolean}
export interface BrowserPageControl {id:string;index:number;kind:'input'|'button';tagName:string;type:string;name:string;label:string;formId:string|null;fingerprint:string;disabled:boolean;readOnly:boolean;sensitive:boolean;submit:boolean;options:string[]}
export interface BrowserSubmitter {controlId:string;label:string;fingerprint:string;formId:string}
export interface BrowserPreparedSubmission {form:BrowserForm;values:Record<string,string>;payloadHash:string;submitter?:BrowserSubmitter}
export interface BrowserSubmitDiagnostics {requestAttempted:boolean;responseStatus:number|null;failureCode:string;redirectOrigin:string|null;pageProtocol:string;warnings:string[]}
export interface BrowserObservation {id:string;url:string;title:string;text:string;links:{id:string;url:string;text:string}[];forms:BrowserForm[];controls?:BrowserPageControl[];screenshot:string|null;observedAt:string;documentStatus?:number;warnings:string[]}
interface LiveSession {context:BrowserContext;page:Page;allowedOrigins:string[];requests:number;denials:string[];abort:AbortController;expiresAt:number;redirectTarget?:string;lastRedirectOrigin?:string;lastNavigationFailure?:string;navigationUrl?:string;documentResponse?:{url:string;status:number};formEvidence:Map<string,string>;controlEvidence:Map<string,string>;timer?:ReturnType<typeof setTimeout>;permit?:{url:string;method:string;bodyHash:string;used:boolean;responseStatus?:number}}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const formBodyHash=(value:string)=>hash(JSON.stringify([...new URLSearchParams(value)].map(([key,item])=>[key,item.replace(/\r\n?/g,'\n')])));
// Only fixed code is evaluated in the page. Model/user input is passed as JSON
// data; selectors, JavaScript, hidden values and credentials are never tools.
const domHelpers=String.raw`
  const clean=text=>String(text??'').replace(/\s+/g,' ').trim();
  const forms=Array.from(document.forms).slice(0,10);
  const controls=Array.from(document.querySelectorAll('input,textarea,select,button,[role="button"]')).slice(0,400);
  const type=node=>node.tagName==='TEXTAREA'?'textarea':node.tagName==='SELECT'?'select':String(node.type||'button').toLowerCase();
  const label=node=>clean(node.labels?.[0]?.textContent||node.getAttribute('aria-label')||(node.tagName==='BUTTON'||node.getAttribute('role')==='button'?node.textContent:'')||(type(node)==='submit'?node.value:'')||node.name).slice(0,160);
  const sensitive=node=>type(node)==='password'||/password|passcode|one.?time|\botp\b|credit.?card|card.?number|\bcc-|cvv|secret|token|security.?code|api.?key|كلمة.?المرور|رمز.?التحقق/i.test(String(node.name||'')+' '+String(node.autocomplete||'')+' '+label(node));
  const formSensitive=form=>Array.from(form.elements).slice(0,200).some(node=>type(node)==='password'||type(node)!=='hidden'&&sensitive(node)||type(node)==='hidden'&&/password|passcode|credit.?card|card.?number|cvv/i.test(String(node.name||'')));
  const formSource=form=>JSON.stringify({action:form.action||location.href,method:form.method.toUpperCase(),encoding:form.enctype,target:form.target,elements:Array.from(form.elements).slice(0,200).map(node=>({tag:node.tagName,type:type(node),name:String(node.name||''),disabled:Boolean(node.disabled),readOnly:Boolean(node.readOnly),checked:['checkbox','radio'].includes(type(node))?Boolean(node.checked):null,value:type(node)==='hidden'||type(node)==='submit'?String(node.value||'').slice(0,16000):null,action:node.getAttribute('formaction'),method:node.getAttribute('formmethod'),encoding:node.getAttribute('formenctype'),target:node.getAttribute('formtarget')}))});
  const controlSource=(node,index)=>JSON.stringify({index,kind:node.tagName==='BUTTON'||node.getAttribute('role')==='button'||['submit','button','reset','image'].includes(type(node))?'button':'input',tagName:node.tagName,type:type(node),name:String(node.name||'').slice(0,120),label:label(node),formId:node.form&&forms.includes(node.form)?'f'+forms.indexOf(node.form):null,disabled:Boolean(node.disabled),readOnly:Boolean(node.readOnly),sensitive:sensitive(node),submit:(node.tagName==='BUTTON'||node.tagName==='INPUT')&&type(node)==='submit',options:node.tagName==='SELECT'?Array.from(node.options).slice(0,100).map(option=>option.value):[],action:node.getAttribute('formaction'),method:node.getAttribute('formmethod'),encoding:node.getAttribute('formenctype'),target:node.getAttribute('formtarget'),value:type(node)==='submit'?String(node.value||'').slice(0,16000):null});
  const visible=node=>Boolean(node.getClientRects().length)&&getComputedStyle(node).visibility!=='hidden'&&getComputedStyle(node).visibility!=='collapse'&&type(node)!=='hidden';
  const setValue=(node,value)=>{const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:node.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,value);};
`;

export class BrowserEngine {
  readonly network:SafeNetwork;
  private browser?:Promise<Browser>;
  private denialProxy?:Server;
  private sessions=new Map<string,LiveSession>();
  constructor(policy:NetworkPolicy={}){this.network=new SafeNetwork(policy);}
  has(id:string){return this.sessions.has(id);}
  private async launch():Promise<Browser>{
    if(!this.browser)this.browser=(async()=>{
      const proxy=createServer((_request,response)=>{response.writeHead(403);response.end();});
      proxy.on('connect',(_request,socket)=>socket.destroy());
      await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));this.denialProxy=proxy;
      const address=proxy.address();if(!address||typeof address==='string')throw new Error('proxy');
      return chromium.launch({headless:true,proxy:{server:`http://127.0.0.1:${address.port}`,bypass:'<-loopback>'},args:['--disable-background-networking','--disable-quic','--disable-sync','--no-first-run','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND'],timeout:15000});
    })().catch(()=>{this.browser=undefined;throw new BrowserError('BROWSER_UNAVAILABLE','تعذر تشغيل Chromium المستقل. تأكد من تثبيت متصفح Playwright.',503);});
    return this.browser;
  }
  async open(id:string,allowedOrigins:string[],expiresAt=Date.now()+30*60000):Promise<void>{
    if(this.sessions.has(id))return;
    if(this.sessions.size>=6)throw new BrowserError('BROWSER_RESOURCE_LIMIT','أغلق جلسة متصفح قبل إنشاء جلسة إضافية.',409);
    const browser=await this.launch(),context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',viewport:{width:1100,height:760},locale:'ar',permissions:[]});
    const live:LiveSession={context,page:undefined as any,allowedOrigins,requests:0,denials:[],abort:new AbortController(),expiresAt,formEvidence:new Map(),controlEvidence:new Map()};
    await context.routeWebSocket('**/*',route=>route.close());
    await context.route('**/*',async route=>{
      const request=route.request();
      let topDocument=false,documentResponse:LiveSession['documentResponse'];
      try{
        topDocument=request.isNavigationRequest()&&request.frame()===live.page.mainFrame();
        if(live.abort.signal.aborted||Date.now()>=live.expiresAt)throw new BrowserError('BROWSER_SESSION_CLOSED','انتهى تفويض الجلسة.');
        if(++live.requests>200)throw new BrowserError('BROWSER_REQUEST_LIMIT','تجاوزت الصفحة عدد طلبات الجلسة المسموح.');
        const url=this.network.validate(request.url(),live.allowedOrigins).href,method=request.method(),body=request.postData()??'';
        if(topDocument){
          const authorized=live.navigationUrl===url||live.permit&&!live.permit.used&&live.permit.url===url&&live.permit.method===method;
          if(!authorized)throw new BrowserError('BROWSER_SUBMIT_DENIED','تنقل الصفحة أو الإرسال التلقائي يحتاج فعلًا محددًا من جلسة المتصفح.');
          live.documentResponse=undefined;
          if(live.navigationUrl===url)live.navigationUrl=undefined;
        }
        if(!['GET','HEAD'].includes(method)){
          const permit=live.permit;
          if(!permit||permit.used||permit.url!==url||permit.method!==method||permit.bodyHash!==formBodyHash(body))throw new BrowserError('BROWSER_SUBMIT_DENIED','طلب إرسال بلا موافقة مطابقة للوجهة والقيم.');
          permit.used=true;
        }else if(live.permit?.method==='GET'&&live.permit.url===url&&!live.permit.used)live.permit.used=true;
        if(['media','websocket','manifest'].includes(request.resourceType()))throw new BrowserError('BROWSER_RESOURCE_DENIED','هذا المورد خارج نطاق جلسة القراءة.');
        let target=url,headers=request.headers();
        for(let redirects=0;redirects<=5;redirects++){
          const response=await this.network.request(target,{allowedOrigins:live.allowedOrigins,method,headers,signal:live.abort.signal,...(body?{body}:{})});
          if(live.permit?.used&&live.permit.url===url)live.permit.responseStatus=response.status;
          if([301,302,303,307,308].includes(response.status)&&response.headers.location){
            if(topDocument)live.lastRedirectOrigin=new URL(response.headers.location,target).origin;
            const next=this.network.validate(new URL(response.headers.location,target).href,live.allowedOrigins).href;
            if(!['GET','HEAD'].includes(method)&&[307,308].includes(response.status))throw new BrowserError('BROWSER_SUBMIT_DENIED','لم يُعد إرسال النموذج إلى وجهة تحويل جديدة؛ يلزم إذن مستقل.');
            if(topDocument){
              // Chromium does not re-enter a Playwright route for HTTP redirect
              // hops. Keep its direct-network denial proxy in place and initiate
              // each validated navigation ourselves, so the final URL is real.
              live.redirectTarget=next;
              await route.fulfill({status:200,headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; sandbox",...(response.headers['set-cookie']?{'set-cookie':response.headers['set-cookie']}:{})},body:'<!doctype html><title>Loading</title>'});
              return;
            }
            if(!['GET','HEAD'].includes(method))throw new BrowserError('BROWSER_SUBMIT_DENIED','لم يُكرر طلب إرسال أثناء تحويل مورد الصفحة.');
            if(redirects===5)throw new BrowserError('BROWSER_REDIRECT_LIMIT','تجاوز المورد حد إعادة التوجيه.');
            if(new URL(next).origin!==new URL(target).origin){headers={...headers};delete headers.cookie;}
            target=next;
            if(++live.requests>200)throw new BrowserError('BROWSER_REQUEST_LIMIT','تجاوزت الصفحة عدد طلبات الجلسة المسموح.');
            continue;
          }
          // A redirected resource is fulfilled at its original browser URL;
          // avoid attaching cookies from the final response to that wrong URL.
          if(target!==url)delete response.headers['set-cookie'];
          if(topDocument){
            documentResponse={url:target,status:response.status};
            live.documentResponse=documentResponse;
          }
          await route.fulfill({status:response.status,headers:response.headers,body:response.body});
          return;
        }
      }catch(error){
        if(documentResponse&&live.documentResponse===documentResponse)live.documentResponse=undefined;
        if(topDocument)live.lastNavigationFailure=error instanceof BrowserError?error.code:'BROWSER_FETCH_FAILED';
        live.denials.push(error instanceof BrowserError?error.message:'تعذر تحميل مورد من الصفحة.');await route.abort('blockedbyclient').catch(()=>{});
      }
    });
    context.on('page',page=>{if(live.page&&page!==live.page)void page.close().catch(()=>{});});
    const page=await context.newPage();live.page=page;page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(12000);
    page.on('dialog',dialog=>void dialog.dismiss());page.on('download',download=>void download.cancel());
    this.sessions.set(id,live);
    live.timer=setTimeout(()=>void this.closeSession(id),Math.max(1,expiresAt-Date.now()));live.timer.unref();
  }
  private live(id:string):LiveSession {const live=this.sessions.get(id);if(!live)throw new BrowserError('BROWSER_SESSION_STALE','انتهت جلسة التشغيل. افتح العنوان مجددًا لاستئناف القراءة بجلسة مستقلة.',409);return live;}
  private async bounded<T>(id:string,work:Promise<T>,timeoutMs=8000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{void this.closeSession(id);reject(new BrowserError('BROWSER_PAGE_TIMEOUT','لم تستجب الصفحة ضمن المهلة. أُغلقت جلسة التشغيل وبقيت الأدلة السابقة محفوظة.',502));},timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}}
  private async followNavigation(live:LiveSession,url:string,deadline=Date.now()+30000):Promise<void>{
    let target=this.network.validate(url,live.allowedOrigins).href;
    for(let redirects=0;redirects<=5;redirects++){
      this.network.validate(target,live.allowedOrigins);live.redirectTarget=undefined;
      const remaining=deadline-Date.now();if(remaining<=0)throw new BrowserError('BROWSER_NAVIGATION_FAILED','تجاوز فتح الصفحة والتحويلات المهلة المسموحة.',502);
      live.navigationUrl=target;
      try{await live.page.goto(target,{waitUntil:'domcontentloaded',timeout:Math.min(12000,remaining)});}finally{live.navigationUrl=undefined;}
      if(!live.redirectTarget){await live.page.waitForLoadState('load',{timeout:Math.min(4000,Math.max(1,deadline-Date.now()))}).catch(()=>live.denials.push('لم يكتمل تحميل بعض موارد الصفحة قبل التقاط المشاهدة.'));return;}
      target=live.redirectTarget;
    }
    throw new BrowserError('BROWSER_REDIRECT_LIMIT','تجاوزت الصفحة حد إعادة التوجيه.');
  }
  async navigate(id:string,url:string):Promise<BrowserObservation>{
    const live=this.live(id);this.network.validate(url,live.allowedOrigins);live.denials=[];
    try{await this.followNavigation(live,url);}catch(error){if(error instanceof BrowserError)throw error;throw new BrowserError('BROWSER_NAVIGATION_FAILED',live.denials[0]??'تعذر فتح الصفحة ضمن الوقت والنطاق المسموح.',502);}
    this.network.validate(live.page.url(),live.allowedOrigins);return this.observe(id);
  }
  async scroll(id:string,direction:'up'|'down'):Promise<BrowserObservation>{const live=this.live(id);await live.page.evaluate(delta=>window.scrollBy(0,delta),direction==='down'?600:-600);return this.observe(id);}
  async observe(id:string):Promise<BrowserObservation>{
    const live=this.live(id);this.network.validate(live.page.url(),live.allowedOrigins);
    const documentResponse=live.documentResponse;
    // This is fixed, trusted code. A string avoids tsx/esbuild keepNames helpers
    // leaking into a serialized callback and depending on host lexical scope.
    const result=await this.bounded(id,live.page.evaluate<Pick<BrowserObservation,'url'|'title'|'text'|'links'>&{forms:(BrowserForm&{evidence:string})[];controls:(BrowserPageControl&{evidence:string})[]}>(`(()=>{
      ${domHelpers}
      const links=Array.from(document.querySelectorAll('a[href]')).slice(0,100).map((node,index)=>({id:'l'+index,url:node.href,text:clean(node.textContent).slice(0,160)}));
      const observedForms=forms.map((form,index)=>({id:'f'+index,index,action:form.action||location.href,method:form.method.toUpperCase(),fingerprint:'',sensitive:formSensitive(form),evidence:formSource(form),fields:Array.from(form.querySelectorAll('input,textarea,select')).slice(0,200).map((field,fieldIndex)=>({id:'i'+fieldIndex,index:fieldIndex,name:String(field.name||'').slice(0,120),type:type(field),label:label(field).slice(0,120),options:field.tagName==='SELECT'?Array.from(field.options).slice(0,100).map(option=>option.value):[]})).filter(field=>!['hidden','submit','button','reset','file'].includes(field.type)).slice(0,20)}));
      const observedControls=controls.map((node,index)=>({node,index})).filter(item=>visible(item.node)).slice(0,80).map(({node,index})=>({id:'c'+index,...JSON.parse(controlSource(node,index)),fingerprint:'',evidence:controlSource(node,index)}));
      return {url:location.href,title:clean(document.title).slice(0,240),text:clean(document.body?.innerText).slice(0,30000),links,forms:observedForms,controls:observedControls};
    })()`));
    result.links=result.links.filter(link=>{try{this.network.validate(link.url,live.allowedOrigins);return true;}catch{return false;}});
    live.formEvidence.clear();live.controlEvidence.clear();
    const forms=result.forms.filter(form=>{try{this.network.validate(form.action,live.allowedOrigins);return ['GET','POST'].includes(form.method);}catch{return false;}}).map(({evidence,...form})=>{live.formEvidence.set(form.id,evidence);return {...form,fingerprint:hash(JSON.stringify({url:result.url,...form,evidence}))};});
    const controls=result.controls.map(({evidence,...control})=>{live.controlEvidence.set(control.id,evidence);const {action,method,encoding,target,value,...safe}=control as BrowserPageControl&Record<string,unknown>;return {...safe,fingerprint:hash(JSON.stringify({url:result.url,evidence,formFingerprint:forms.find(form=>form.id===control.formId)?.fingerprint??null}))} as BrowserPageControl;});
    let screenshot:string|null=null;try{const bytes=await live.page.screenshot({type:'jpeg',quality:55,timeout:4000});if(bytes.length<500000)screenshot=`data:image/jpeg;base64,${bytes.toString('base64')}`;}catch{/* Text evidence remains available. */}
    const sameDocument=documentResponse&&live.documentResponse===documentResponse&&
      documentResponse.url===result.url.split('#',1)[0]&&live.page.url()===result.url;
    return {...result,forms,controls,id:randomUUID(),screenshot,observedAt:new Date().toISOString(),warnings:[...new Set(live.denials)].slice(0,12),
      ...(sameDocument?{documentStatus:documentResponse.status}:{})};
  }
  async fill(id:string,observation:BrowserObservation,controlId:string,value:string):Promise<BrowserObservation>{
    const live=this.live(id),current=await this.observe(id),control=current.controls?.find(item=>item.id===controlId),expected=observation.controls?.find(item=>item.id===controlId);
    if(current.url!==observation.url||!control||!expected||control.fingerprint!==expected.fingerprint)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','تغير الحقل أو ارتباطه بالصفحة؛ اقرأ الصفحة مجددًا قبل التعبئة.',409);
    if(value.length>2000||control.kind!=='input'||control.disabled||control.readOnly||control.sensitive||current.forms.find(form=>form.id===control.formId)?.sensitive||!['text','email','search','url','tel','number','textarea','select'].includes(control.type))throw new BrowserError('BROWSER_SENSITIVE_FORM','الحقل غير قابل للتعبئة أو يحتوي بيانات دخول أو دفع أو بيانات حساسة.');
    if(control.type==='select'&&!control.options.includes(value))throw new BrowserError('BROWSER_FORM_INVALID','قيمة القائمة غير موجودة في الحقل.');
    const input={index:control.index,evidence:live.controlEvidence.get(control.id),formEvidence:control.formId?live.formEvidence.get(control.formId):null,value};
    const filled=await this.bounded(id,live.page.evaluate<boolean>(String.raw`(()=>{${domHelpers}
      const input=${JSON.stringify(input)},node=controls[input.index];
      if(!node||!visible(node)||controlSource(node,input.index)!==input.evidence||node.form&&input.formEvidence&&formSource(node.form)!==input.formEvidence||sensitive(node)||node.form&&formSensitive(node.form)||node.disabled||node.readOnly||!['text','email','search','url','tel','number','textarea','select'].includes(type(node)))return false;
      setValue(node,input.value);
      if(String(node.value).replace(/\r\n?/g,'\n')!==input.value.replace(/\r\n?/g,'\n'))return false;
      const preventSubmission=event=>event.preventDefault();document.addEventListener('submit',preventSubmission,true);
      try{node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}finally{document.removeEventListener('submit',preventSubmission,true);}
      return true;
    })()`));
    if(!filled)throw new BrowserError('BROWSER_FORM_CHANGED','تغير الحقل أثناء التعبئة؛ لم يُرسل نموذج.',409);
    return this.observe(id);
  }
  private async payload(id:string,form:BrowserForm,values:Record<string,string>,submitter?:BrowserSubmitter,apply=false):Promise<{payload:string;action:string;method:string}>{
    const live=this.live(id),control=submitter?JSON.parse(live.controlEvidence.get(submitter.controlId)??'null'):null;
    const input={formIndex:form.index,formEvidence:live.formEvidence.get(form.id),controlIndex:control?.index??null,controlEvidence:submitter?live.controlEvidence.get(submitter.controlId):null,fields:Object.entries(values).map(([key,value])=>({...form.fields.find(field=>field.id===key)!,value})),apply};
    const prepared=await this.bounded(id,live.page.evaluate<{payload:string;action:string;method:string}>(String.raw`(()=>{${domHelpers}
      const input=${JSON.stringify(input)},form=forms[input.formIndex],button=input.controlIndex===null?null:controls[input.controlIndex];
      if(!form||formSource(form)!==input.formEvidence||formSensitive(form))throw new Error('Changed or sensitive form');
      if(input.controlIndex!==null&&(!button||button.form!==form||!visible(button)||button.disabled||type(button)!=='submit'||!['BUTTON','INPUT'].includes(button.tagName)||controlSource(button,input.controlIndex)!==input.controlEvidence))throw new Error('Changed submitter');
      const action=button&&button.hasAttribute('formaction')?button.formAction:form.action||location.href;
      const method=(button&&button.hasAttribute('formmethod')?button.formMethod:form.method).toUpperCase();
      const encoding=button&&button.hasAttribute('formenctype')?button.formEnctype:form.enctype;
      const target=button&&button.hasAttribute('formtarget')?button.formTarget:form.target;
      if(encoding!=='application/x-www-form-urlencoded'||target&&!['_self'].includes(target)||!['GET','POST'].includes(method))throw new Error('Unsupported submission');
      const fields=Array.from(form.querySelectorAll('input,textarea,select')).slice(0,200),original=[];
      try{
        for(const field of input.fields){const node=fields[field.index];if(!node||node.name!==field.name||type(node)!==field.type||sensitive(node)||node.disabled||node.readOnly)throw new Error('Changed field');original.push([node,node.value]);setValue(node,field.value);if(String(node.value).replace(/\r\n?/g,'\n')!==field.value.replace(/\r\n?/g,'\n'))throw new Error('Changed value');}
        const entries=Array.from(new FormData(form,button||undefined).entries()).map(([key,value])=>{if(typeof value!=='string')throw new Error('Files disabled');return [key,value];});
        return {payload:new URLSearchParams(entries).toString(),action,method};
      }finally{if(!input.apply)for(const [node,value]of original)setValue(node,value);}
    })()`)).catch(()=>{throw new BrowserError('BROWSER_FORM_CHANGED','تغير النموذج أو زر الإرسال أو ترميزه؛ اقرأ الصفحة وراجع الوجهة من جديد.',409);});
    if(Buffer.byteLength(prepared.payload)>16000)throw new BrowserError('BROWSER_FORM_ENCODING','تجاوز جسم النموذج حد الإرسال المسموح.');
    this.network.validate(prepared.action,live.allowedOrigins);
    return prepared;
  }
  private async prepareSubmission(id:string,observation:BrowserObservation,formId:string,values:Record<string,string>,controlId?:string):Promise<BrowserPreparedSubmission>{
    const current=await this.observe(id),form=current.forms.find(item=>item.id===formId),expected=observation.forms.find(item=>item.id===formId);
    if(current.url!==observation.url||!form||!expected||form.fingerprint!==expected.fingerprint)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','تغيرت الصفحة أو النموذج؛ اقرأ الصفحة مجددًا قبل طلب الموافقة.',409);
    if(Object.keys(values).length>20||Object.entries(values).some(([key,value])=>!form.fields.some(field=>field.id===key)||value.length>2000))throw new BrowserError('BROWSER_FORM_INVALID','قيم النموذج خارج الحقول المرصودة أو تتجاوز الحد.');
    if(form.sensitive||form.fields.some(field=>field.type==='password'||/password|passcode|credit.?card|card.?number|cvv/i.test(field.name)))throw new BrowserError('BROWSER_SENSITIVE_FORM','النموذج يحتوي حقول دخول أو دفع تتطلب نطاق صلاحية مستقلًا.');
    for(const [key,value]of Object.entries(values)){const field=form.fields.find(item=>item.id===key)!;if(!['text','email','search','url','tel','number','textarea','select'].includes(field.type)||/password|passcode|credit.?card|card.?number|cvv|secret|token/i.test(field.name))throw new BrowserError('BROWSER_SENSITIVE_FORM','لا تقبل هذه الجلسة كلمات المرور أو بيانات الدفع أو الحقول الحساسة.');if(field.type==='select'&&!field.options.includes(value))throw new BrowserError('BROWSER_FORM_INVALID','قيمة القائمة غير موجودة في النموذج.');}
    let submitter:BrowserSubmitter|undefined;
    if(controlId){
      const control=current.controls?.find(item=>item.id===controlId),expectedControl=observation.controls?.find(item=>item.id===controlId);
      if(!control||!expectedControl||control.fingerprint!==expectedControl.fingerprint||control.formId!==formId)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','تغير زر الإرسال أو ارتباطه بالنموذج.',409);
      if(control.kind!=='button'||!control.submit||control.disabled||control.sensitive)throw new BrowserError('BROWSER_BUTTON_DENIED','هذا الزر لا يملك إرسال نموذج معروفًا يمكن مراجعته والموافقة عليه.');
      submitter={controlId,label:control.label,fingerprint:control.fingerprint,formId};
    }
    const payload=await this.payload(id,form,values,submitter);
    return {form:{...form,action:payload.action,method:payload.method},values,payloadHash:formBodyHash(payload.payload),...(submitter?{submitter}:{})};
  }
  async prepare(id:string,observation:BrowserObservation,formId:string,values:Record<string,string>):Promise<BrowserPreparedSubmission>{return this.prepareSubmission(id,observation,formId,values);}
  async prepareButton(id:string,observation:BrowserObservation,controlId:string):Promise<BrowserPreparedSubmission>{
    const control=observation.controls?.find(item=>item.id===controlId);
    if(!control?.formId||control.kind!=='button'||!control.submit)throw new BrowserError('BROWSER_BUTTON_DENIED','الزر لا يرتبط بنموذج إرسال معروف؛ لم يُنقر الزر.');
    return this.prepareSubmission(id,observation,control.formId,{},controlId);
  }
  async submit(id:string,observation:BrowserObservation,formId:string,values:Record<string,string>,approved?:{payloadHash:string;submitter?:BrowserSubmitter}):Promise<{observation:BrowserObservation;requestSent:boolean;status:number|null;method:string;url:string}>{
    const live=this.live(id),prepared=await this.prepareSubmission(id,observation,formId,values,approved?.submitter?.controlId),form=prepared.form;
    const sameSubmitter=!approved?.submitter&&!prepared.submitter||approved?.submitter&&prepared.submitter&&(['controlId','label','fingerprint','formId'] as const).every(key=>approved.submitter![key]===prepared.submitter![key]);
    if(approved&&(approved.payloadHash!==prepared.payloadHash||!sameSubmitter))throw new BrowserError('BROWSER_FORM_CHANGED','تغيرت القيم أو زر الإرسال بعد الموافقة؛ لم يُرسل الطلب.',409);
    const payload=await this.payload(id,form,values,prepared.submitter,true);
    if(formBodyHash(payload.payload)!==prepared.payloadHash)throw new BrowserError('BROWSER_FORM_CHANGED','تغير جسم النموذج بعد مراجعته؛ لم يُرسل الطلب.',409);
    const target=new URL(payload.action);if(payload.method==='GET')target.search=payload.payload;
    this.network.validate(target.href,live.allowedOrigins);live.permit={url:target.href,method:payload.method,bodyHash:formBodyHash(payload.method==='POST'?payload.payload:''),used:false};live.lastNavigationFailure=undefined;live.lastRedirectOrigin=undefined;live.denials=[];
    const control=prepared.submitter?JSON.parse(live.controlEvidence.get(prepared.submitter.controlId)??'null'):null;
    const input={formIndex:form.index,controlIndex:control?.index??null,formEvidence:live.formEvidence.get(form.id),controlEvidence:prepared.submitter?live.controlEvidence.get(prepared.submitter.controlId):null};
    try{
      live.redirectTarget=undefined;
      await Promise.all([live.page.waitForNavigation({waitUntil:'domcontentloaded',timeout:12000}),this.bounded(id,live.page.evaluate(String.raw`(()=>{${domHelpers}
        const input=${JSON.stringify(input)},form=forms[input.formIndex],button=input.controlIndex===null?null:controls[input.controlIndex];
        if(!form||formSource(form)!==input.formEvidence||formSensitive(form)||button&&(button.form!==form||controlSource(button,input.controlIndex)!==input.controlEvidence))throw new Error('Changed submission');
        if(button)HTMLFormElement.prototype.requestSubmit.call(form,button);else HTMLFormElement.prototype.submit.call(form);
      })()`))]);
      if(live.redirectTarget)await this.followNavigation(live,live.redirectTarget);
      const next=await this.observe(id);return {observation:next,requestSent:live.permit.used,status:live.permit.responseStatus??null,method:payload.method,url:target.href};
    }catch(error){const diagnostics:BrowserSubmitDiagnostics={requestAttempted:Boolean(live.permit?.used),responseStatus:live.permit?.responseStatus??null,failureCode:live.lastNavigationFailure??(error instanceof BrowserError?error.code:'BROWSER_NAVIGATION_FAILED'),redirectOrigin:live.lastRedirectOrigin??null,pageProtocol:new URL(live.page.url()).protocol,warnings:[...new Set(live.denials)].slice(0,12)};throw Object.assign(new BrowserError(live.permit?.used?'BROWSER_SUBMIT_UNKNOWN':'BROWSER_SUBMIT_FAILED',live.permit?.used?'بدأت محاولة الطلب ولم تثبت نتيجتها. راجع الصفحة قبل أي إرسال جديد؛ لن يكرر النظام الطلب.':'لم يثبت إرسال النموذج؛ اقرأ الصفحة واطلب موافقة جديدة.',live.permit?.used?409:502),{diagnostics});}
    finally{live.permit=undefined;}
  }
  async closeSession(id:string){const live=this.sessions.get(id);this.sessions.delete(id);if(live){live.abort.abort();if(live.timer)clearTimeout(live.timer);await live.context.close().catch(()=>{});}}
  async close(){for(const id of [...this.sessions.keys()])await this.closeSession(id);if(this.browser)await (await this.browser.catch(()=>null))?.close();this.browser=undefined;if(this.denialProxy)await new Promise<void>(resolve=>this.denialProxy!.close(()=>resolve()));this.denialProxy=undefined;}
}
