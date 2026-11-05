import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {sql,type Kysely} from 'kysely';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse,serialize} from 'parse5';
import {StudioError} from '@mohassan/studio';
import {instrumentReactSnapshot,reactSourceHash,renderReactStudioArtifact,type ReactStudioArtifact,type ReactStudioSnapshot} from '@mohassan/studio-react';

interface LiveSessionSource {id:string;revision:string;framework?:string;entryPath:string;files:{path:string;content:string}[]}
export interface StudioLiveConfig {gatewayUrl?:string;gatewaySecret?:string;webOrigin:string;production:boolean;previewPort?:number;getSession?:(ownerId:string,id:string)=>Promise<LiveSessionSource>;fetch?:typeof fetch}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const capPattern=/^[a-f0-9]{48}$/;
const namePattern=/^mohassan-studio-[a-f0-9]{32}$/;
const failure=(code:string,message:string,status=400)=>new StudioError(code,message,status);
const migration=[
`CREATE TABLE IF NOT EXISTS studio_live_sessions(id text PRIMARY KEY,owner_id text NOT NULL,session_id text NOT NULL,revision text NOT NULL,cap_hash text NOT NULL UNIQUE,name text NOT NULL,status text NOT NULL,nonce text NOT NULL,elements jsonb NOT NULL DEFAULT '[]',expires_at timestamptz NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS studio_live_owner_idx ON studio_live_sessions(owner_id,created_at DESC)`,
`CREATE TABLE IF NOT EXISTS studio_live_requests(live_id text NOT NULL REFERENCES studio_live_sessions(id) ON DELETE CASCADE,request_id text NOT NULL,request_hash text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(live_id,request_id))`,
];
type GatewayProxy={status:number;headers:{'content-type'?:string;location?:string|null};body:string};
type LiveRuntime={cap:string;controller:AbortController;artifact?:ReactStudioArtifact;bridge?:string;requests:number;responses:Map<string,{status:number;headers:Record<string,string>;body:Buffer}>};

export async function createStudioLiveControl(db:Kysely<any>,config:StudioLiveConfig){
  let gateway:URL|undefined;
  try{if(config.gatewayUrl){const target=new URL(config.gatewayUrl);if(target.protocol==='https:'&&!target.username&&!target.password)gateway=target;}}catch{/* Configuration is reported without exposing its contents. */}
  const available=Boolean(gateway&&config.gatewaySecret&&config.gatewaySecret.length>=32),transport=config.fetch??fetch;
  await db.transaction().execute(async transaction=>{await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(transaction);for(const statement of migration)await sql.raw(statement).execute(transaction);await transaction.insertInto('schema_migrations').values({version:'010_studio_live'}).onConflict(conflict=>conflict.column('version').doNothing()).execute();});
  const runtimes=new Map<string,LiveRuntime>(),workers=new Set<Promise<void>>(),buildControllers=new Set<AbortController>();
  let server:Server|undefined,port=config.previewPort??5000;
  function configured(){if(!available)throw failure('STUDIO_LIVE_NOT_CONFIGURED','لم يُجهّز جسر Next السحابي. أضف عنوان الجسر وسره على الخادم لتشغيل المعاينة التفاعلية.',503);}
  async function callGateway(input:Record<string,unknown>,signal?:AbortSignal):Promise<any>{
    configured();const body=JSON.stringify(input),stamp=String(Date.now()),signature=createHmac('sha256',config.gatewaySecret!).update(stamp+'\n'+body).digest('hex');
    let response:Response;try{response=await transport(gateway!,{method:'POST',headers:{'content-type':'application/json','x-studio-time':stamp,'x-studio-signature':signature},body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(input.op==='create'?360000:30000)]):AbortSignal.timeout(input.op==='create'?360000:30000),redirect:'error'});}catch{throw failure('STUDIO_GATEWAY_UNAVAILABLE','تعذر الوصول إلى بيئة Next المعزولة. لم تُفترض نتيجة ناجحة أو تُعد المحاولة تلقائيًا.',503);}
    if(Number(response.headers.get('content-length')??0)>4200000)throw failure('STUDIO_GATEWAY_RESPONSE_LIMIT','تجاوزت استجابة الجسر حد النقل.',502);
    const raw=await response.text();if(Buffer.byteLength(raw)>4200000)throw failure('STUDIO_GATEWAY_RESPONSE_LIMIT','تجاوزت استجابة الجسر حد النقل.',502);
    let result:any;try{result=JSON.parse(raw);}catch{throw failure('STUDIO_GATEWAY_RESPONSE_INVALID','أعاد الجسر استجابة غير صالحة.',502);}
    if(!response.ok)throw failure('STUDIO_GATEWAY_REJECTED',response.status===401||response.status===403?'رفض جسر Next المصادقة. راجع إعداد اتصال Vercel قبل تشغيل المعاينة.':'رفضت البيئة المعزولة عملية البناء أو المعاينة.',response.status===422?422:503);
    return result;
  }
  async function stopName(name:string){if(available&&namePattern.test(name))await callGateway({op:'stop',name},AbortSignal.timeout(4000)).catch(()=>{});}
  async function createCloud(snapshot:ReactStudioSnapshot,name:string,cap:string,signal?:AbortSignal){
    const instrumented=instrumentReactSnapshot(snapshot),expected=hash(JSON.stringify(instrumented.files));
    const result=await callGateway({op:'create',name,cap,framework:snapshot.framework,entryPath:snapshot.entryPath,files:instrumented.files},signal);
    if(result.name!==name||result.ready!==true||result.isolation!=='microvm'||result.network!=='denied'||result.sourceHash!==expected||!Number.isFinite(Date.parse(result.expiresAt))||Date.parse(result.expiresAt)<=Date.now()||Date.parse(result.expiresAt)>Date.now()+11*60000)throw failure('STUDIO_CLOUD_UNVERIFIED','لم يثبت الجسر عزل Next أو تطابق المصدر والمدة.',502);
    return {instrumented,result,expected};
  }
  async function proxy(name:string,cap:string,path:string,method='GET',headers:Record<string,string>={},body=''):Promise<GatewayProxy>{
    if(!namePattern.test(name)||!capPattern.test(cap)||!safePath(path,cap))throw failure('STUDIO_PREVIEW_PATH_DENIED','مسار المعاينة خارج نطاق النسخة.');
    const result=await callGateway({op:'proxy',name,path,method,headers,body});
    if(!Number.isInteger(result.status)||result.status<100||result.status>599||typeof result.body!=='string'||result.body.length>4100000||!/^[A-Za-z\d+/]*={0,2}$/.test(result.body)||!result.headers||typeof result.headers!=='object')throw failure('STUDIO_GATEWAY_RESPONSE_INVALID','استجابة المعاينة غير صالحة.',502);
    return result;
  }
  function safePath(path:string,cap:string){if(path.length>4096||!path.startsWith('/')||path.startsWith('//')||/[\\\r\n\0]|%(?:2e|2f|5c)/i.test(path))return false;const parsed=new URL(path,'http://preview.invalid');return parsed.pathname===`/p/${cap}`||parsed.pathname.startsWith(`/p/${cap}/`);}
  async function capture(snapshot:ReactStudioSnapshot,name:string,cap:string,created:Awaited<ReturnType<typeof createCloud>>):Promise<ReactStudioArtifact>{
    const response=await proxy(name,cap,`/p/${cap}`);if(response.status!==200||!String(response.headers['content-type']).includes('text/html'))throw failure('STUDIO_NEXT_RENDER_FAILED','لم يرجع Next صفحة HTML جاهزة للمراجعة.',422);
    const original=Buffer.from(response.body,'base64').toString('utf8'),tree=parse(original),css:string[]=[];const stylesheets:string[]=[];
    function visit(node:any){
      if(node.tagName==='link'&&node.attrs?.some((attr:any)=>attr.name==='rel'&&attr.value==='stylesheet')){const href=node.attrs.find((attr:any)=>attr.name==='href')?.value;if(href&&safePath(href,cap)&&!stylesheets.includes(href))stylesheets.push(href);}
      if(node.tagName==='style')css.push((node.childNodes??[]).map((child:any)=>child.value??'').join(''));
      if(node.childNodes){node.childNodes=node.childNodes.filter((child:any)=>!['script','style','link'].includes(child.tagName));for(const child of node.childNodes)visit(child);}
    }
    // Collect styles before filtering nodes out of their parent's children.
    const pending:any[]=[tree];while(pending.length){const node=pending.pop();if(node.tagName==='link'&&node.attrs?.some((attr:any)=>attr.name==='rel'&&attr.value==='stylesheet')){const href=node.attrs.find((attr:any)=>attr.name==='href')?.value;if(href&&safePath(href,cap)&&!stylesheets.includes(href))stylesheets.push(href);}if(node.tagName==='style')css.push((node.childNodes??[]).map((child:any)=>child.value??'').join(''));pending.push(...(node.childNodes??[]));}
    visit(tree);
    for(const path of stylesheets.slice(0,8)){const stylesheet=await proxy(name,cap,path);if(stylesheet.status!==200)throw failure('STUDIO_NEXT_CSS_FAILED','تعذر حفظ CSS الناتج من بناء Next.',422);css.push(Buffer.from(stylesheet.body,'base64').toString('utf8'));}
    const html=serialize(tree),combined=css.join('\n');if(Buffer.byteLength(html)>44000||Buffer.byteLength(combined)>64000)throw failure('STUDIO_NEXT_CAPTURE_LIMIT','تجاوزت الصفحة أو CSS حد نسخة المراجعة المحفوظة.',422);
    const sourceHash=reactSourceHash(snapshot),artifact:ReactStudioArtifact={sourceHash,html,css:combined,elements:created.instrumented.elements,warnings:[...created.instrumented.warnings.filter(value=>!value.includes('لا تشغّل خادم Next')),'هذه نسخة أولية محفوظة من بناء Next فعلي داخل microVM. التفاعل الحي يحتاج تشغيل جلسة منفصلة.'],verification:{provider:'vercel-sandbox',sourceHash,snapshotHash:created.expected,network:'denied',isolation:'microvm',isolationVerified:true,durationMs:0}};
    renderReactStudioArtifact(artifact,'cloud-validate-nonce-000000',sourceHash);return artifact;
  }
  async function build(snapshot:ReactStudioSnapshot,signal?:AbortSignal):Promise<ReactStudioArtifact&{cloud?:{name:string;expiresAt:string}}>{
    configured();const name='mohassan-studio-'+randomUUID().replaceAll('-',''),cap=randomBytes(24).toString('hex'),start=Date.now(),controller=new AbortController();buildControllers.add(controller);
    const signalListener=()=>controller.abort();signal?.addEventListener('abort',signalListener,{once:true});if(signal?.aborted)controller.abort();
    try{const created=await createCloud(snapshot,name,cap,controller.signal),artifact=await capture(snapshot,name,cap,created);artifact.verification.durationMs=Date.now()-start;return {...artifact,cloud:{name,expiresAt:created.result.expiresAt}};}finally{signal?.removeEventListener('abort',signalListener);buildControllers.delete(controller);await stopName(name);}
  }
  async function owned(ownerId:string,sessionId:string){if(!config.getSession)throw failure('STUDIO_LIVE_UNAVAILABLE','لم يُربط الاستوديو التفاعلي بمخزن المشاريع.',503);return config.getSession(ownerId,sessionId);}
  async function status(ownerId:string,sessionId:string){const source=await owned(ownerId,sessionId),row=await db.selectFrom('studio_live_sessions').selectAll().where('owner_id','=',ownerId).where('session_id','=',sessionId).orderBy('created_at','desc').executeTakeFirst();if(!row)return {available,status:available?'idle':'unconfigured',message:available?'يمكن تشغيل نسخة تفاعلية لمدة عشر دقائق.':'لم يُجهّز جسر Next السحابي على الخادم.'};
    let state=row.status;
    if(['active','building'].includes(state)&&(source.revision!==row.revision||new Date(row.expires_at).getTime()<=Date.now())){state=source.revision!==row.revision?'stale':'expired';await revokeRow(row,state);}
    const runtime=runtimes.get(row.id),url=state==='active'&&runtime?`http://${runtime.cap}.localhost:${port}/p/${runtime.cap}`:null;
    return {available,id:row.id,status:state,message:row.error??(state==='active'?'نسخة Next تفاعلية داخل microVM، مرتبطة بإصدار المصدر المحفوظ.':state==='stale'?'تغير المصدر. شغّل نسخة جديدة لمعاينة هذا الإصدار.':state==='building'?'يجري تجهيز العزل وبناء Next.':'المعاينة متوقفة.'),revision:row.revision,expiresAt:new Date(row.expires_at).toISOString(),url,nonce:row.nonce,elements:row.elements};
  }
  async function revokeRow(row:any,state='revoked'){await db.updateTable('studio_live_sessions').set({status:state,updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',row.id).execute();const runtime=runtimes.get(row.id);runtime?.controller.abort();runtimes.delete(row.id);void stopName(row.name);}
  async function start(ownerId:string,sessionId:string,revision:string){
    configured();const source=await owned(ownerId,sessionId);if(source.revision!==revision)throw failure('STUDIO_REVISION_CONFLICT','تغير إصدار المصدر. حدّث المشروع قبل التشغيل.',409);if(!['react','next'].includes(source.framework??''))throw failure('STUDIO_LIVE_FRAMEWORK','تحتاج المعاينة التفاعلية مشروع React أو Next.');
    const snapshot={framework:source.framework as 'react'|'next',entryPath:source.entryPath,files:source.files};instrumentReactSnapshot(snapshot);
    const old=await db.selectFrom('studio_live_sessions').selectAll().where('owner_id','=',ownerId).where('status','in',['building','active']).execute();for(const row of old)await revokeRow(row);
    const id=randomUUID(),cap=randomBytes(24).toString('hex'),name='mohassan-studio-'+randomUUID().replaceAll('-',''),nonce=randomUUID(),controller=new AbortController();
    await db.transaction().execute(async transaction=>{const user=await transaction.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst();if(!user)throw failure('UNAUTHORIZED','سجل الدخول للمتابعة.',401);const active=await transaction.selectFrom('studio_live_sessions').select('id').where('owner_id','=',ownerId).where('status','in',['building','active']).executeTakeFirst();if(active)throw failure('STUDIO_LIVE_BUSY','توجد معاينة أخرى لهذا المالك. أوقفها قبل تشغيل نسخة جديدة.',409);await transaction.insertInto('studio_live_sessions').values({id,owner_id:ownerId,session_id:sessionId,revision,cap_hash:hash(cap),name,status:'building',nonce,elements:'[]',expires_at:new Date(Date.now()+10*60000)}).execute();});
    runtimes.set(id,{cap,controller,requests:0,responses:new Map()});
    const worker=(async()=>{try{const created=await createCloud(snapshot,name,cap,controller.signal),artifact=await capture(snapshot,name,cap,created),current=await owned(ownerId,sessionId);if(current.revision!==revision||controller.signal.aborted)throw failure('STUDIO_REVISION_CONFLICT','تغير المصدر أو أُلغي التشغيل قبل جاهزية المعاينة.',409);const rendered=renderReactStudioArtifact(artifact,nonce,revision),script=rendered.document.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];if(!script)throw failure('STUDIO_LIVE_BRIDGE_FAILED','تعذر تجهيز جسر اختيار العناصر.',502);const runtime=runtimes.get(id);if(!runtime)throw failure('STUDIO_LIVE_REVOKED','أُوقف تشغيل المعاينة.',409);runtime.artifact=artifact;runtime.bridge=script.replaceAll('data-mohassan-studio-id','data-mohassan-source-id').replace('let selecting=true,selected=null','let selecting=false,selected=null').replace("event.preventDefault();event.stopPropagation();if(!selecting", "if(!selecting)return;event.preventDefault();event.stopPropagation();if(!selecting");await db.updateTable('studio_live_sessions').set({status:'active',elements:JSON.stringify(rendered.elements),expires_at:new Date(created.result.expiresAt),updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('status','=','building').execute();}catch(error){await db.updateTable('studio_live_sessions').set({status:controller.signal.aborted?'revoked':'failed',error:error instanceof StudioError?error.message:'فشل تجهيز المعاينة التفاعلية.',updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('status','=','building').execute();runtimes.delete(id);await stopName(name);}})();workers.add(worker);void worker.finally(()=>workers.delete(worker)).catch(()=>{});
    return status(ownerId,sessionId);
  }
  async function stop(ownerId:string,sessionId:string){await owned(ownerId,sessionId);const rows=await db.selectFrom('studio_live_sessions').selectAll().where('owner_id','=',ownerId).where('session_id','=',sessionId).where('status','in',['active','building']).execute();for(const row of rows)await revokeRow(row);return status(ownerId,sessionId);}
  async function respond(request:IncomingMessage,response:ServerResponse){
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    try{
      const host=/^([a-f0-9]{48})\.localhost(?::\d+)?$/i.exec(request.headers.host??''),cap=host?.[1].toLowerCase(),path=request.url??'';
      if(!cap||!safePath(path,cap))throw failure('STUDIO_PREVIEW_DENIED','مسار المعاينة غير متاح.',404);
      const row=await db.selectFrom('studio_live_sessions').selectAll().where('cap_hash','=',hash(cap)).where('status','=','active').executeTakeFirst();if(!row||new Date(row.expires_at).getTime()<=Date.now())throw failure('STUDIO_PREVIEW_EXPIRED','انتهت صلاحية المعاينة.',410);
      const runtime=runtimes.get(row.id),source=await owned(row.owner_id,row.session_id);if(!runtime||runtime.cap!==cap||source.revision!==row.revision){await revokeRow(row,'stale');throw failure('STUDIO_PREVIEW_STALE','تغير المصدر أو أُلغيت المعاينة.',410);}
      if(++runtime.requests>300)throw failure('STUDIO_PREVIEW_REQUEST_LIMIT','وصلت المعاينة إلى حد طلبات جلستها. شغّل نسخة جديدة عند الحاجة.',429);
      const method=request.method??'GET';if(!['GET','HEAD','POST','OPTIONS'].includes(method))throw failure('STUDIO_PREVIEW_METHOD_DENIED','نوع الطلب غير مسموح.',405);
      if(request.headers.origin&&request.headers.origin!=='null'||method==='POST'&&request.headers.origin!=='null')throw failure('STUDIO_PREVIEW_ORIGIN_DENIED','مصدر طلب المعاينة غير مصرح به.',403);
      response.setHeader('Access-Control-Allow-Origin','null');response.setHeader('Vary','Origin');
      if(method==='OPTIONS'){response.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');response.setHeader('Access-Control-Allow-Headers','content-type, rsc, next-action, next-router-state-tree, next-router-prefetch, next-url, x-studio-request-id');response.writeHead(204);response.end();return;}
      let size=0;const chunks:Buffer[]=[];for await(const chunk of request){size+=chunk.length;if(size>500000)throw failure('STUDIO_PREVIEW_REQUEST_LIMIT','تجاوز الطلب حد المعاينة.',413);chunks.push(Buffer.from(chunk));}const body=Buffer.concat(chunks);
      const headers:Record<string,string>={};for(const key of ['content-type','accept','rsc','next-action','next-router-state-tree','next-router-prefetch','next-url'])if(typeof request.headers[key]==='string'&&request.headers[key]!.length<12000)headers[key]=request.headers[key] as string;
      const requestId=String(request.headers['x-studio-request-id']??'');
      if(method==='POST'){
        if(!/^[a-f0-9]{32}$/.test(requestId))throw failure('STUDIO_PREVIEW_REQUEST_ID_REQUIRED','طلب التفاعل يحتاج معرفًا يمنع تكرار الإرسال.',400);
        const expected=hash(JSON.stringify([path,method,headers['next-action']??'',hash(body.toString('base64'))]));
        const inserted=await db.insertInto('studio_live_requests').values({live_id:row.id,request_id:requestId,request_hash:expected,status:'started'}).onConflict(conflict=>conflict.columns(['live_id','request_id']).doNothing()).returning('request_id').executeTakeFirst();
        if(!inserted){const previous=await db.selectFrom('studio_live_requests').select('request_hash').where('live_id','=',row.id).where('request_id','=',requestId).executeTakeFirst();const cached=runtime.responses.get(requestId);if(previous?.request_hash!==expected||!cached)throw failure('STUDIO_PREVIEW_REQUEST_REPLAY','هذا الطلب أُرسل من قبل ولم يُعد تنفيذه.',409);response.writeHead(cached.status,cached.headers);response.end(cached.body);return;}
      }
      try{
        const result=await proxy(row.name,cap,path,method,headers,body.toString('base64')),outputHeaders:Record<string,string>={'content-type':String(result.headers['content-type']??'application/octet-stream')};
        if(result.headers.location){const location=new URL(result.headers.location,`http://${cap}.localhost:${port}${path}`);if(!['127.0.0.1',`${cap}.localhost`].includes(location.hostname)||!safePath(location.pathname+location.search,cap))throw failure('STUDIO_PREVIEW_REDIRECT_DENIED','إعادة التوجيه خارج المعاينة مرفوضة.',502);outputHeaders.location=location.pathname+location.search;}
        let output=Buffer.from(result.body,'base64');
        if(outputHeaders['content-type'].includes('text/html')&&method!=='HEAD'){
          const allowed=(row.elements as any[]).map(element=>({id:element.id,tag:element.tag}));
          const guard=`(()=>{const allowed=new Map(${JSON.stringify(allowed.map(element=>[element.id,element.tag]))});let selecting=false;addEventListener('message',event=>{const m=event.data;if(event.source===parent&&m?.type==='mohassan:studio:mode'&&m.nonce===${JSON.stringify(row.nonce)}&&m.revision===${JSON.stringify(row.revision)}&&typeof m.selecting==='boolean')selecting=m.selecting;});addEventListener('click',event=>{if(!selecting)return;const target=event.target instanceof Element?event.target.closest('[data-mohassan-source-id]'):null;if(!target)return;const id=target.getAttribute('data-mohassan-source-id');if(!allowed.has(id)||allowed.get(id)!==target.tagName.toLowerCase()||document.querySelectorAll('[data-mohassan-source-id="'+id+'"]').length!==1)event.stopImmediatePropagation();},true);const original=globalThis.fetch.bind(globalThis);globalThis.fetch=(input,init={})=>{const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();if(method==='POST'){const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));if(!headers.has('x-studio-request-id')){const bytes=crypto.getRandomValues(new Uint8Array(16));headers.set('x-studio-request-id',Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''));}init={...init,headers};}return original(input,init);};})();`;
          const injected=`<script>${guard}${runtime.bridge??''}</script>`;let html=output.toString('utf8');html=/<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,match=>match+injected):injected+html;output=Buffer.from(html);
        }
        const origins=[new URL(config.webOrigin).origin];const alias=new URL(config.webOrigin);if(['127.0.0.1','localhost'].includes(alias.hostname)){alias.hostname=alias.hostname==='localhost'?'127.0.0.1':'localhost';origins.push(alias.origin);}
        outputHeaders['content-security-policy']=`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors ${origins.join(' ')}`;
        if(method==='POST'){await db.updateTable('studio_live_requests').set({status:'succeeded'}).where('live_id','=',row.id).where('request_id','=',requestId).execute();if(output.length<=500000&&runtime.responses.size<20)runtime.responses.set(requestId,{status:result.status,headers:outputHeaders,body:output});}
        response.writeHead(result.status,outputHeaders);response.end(method==='HEAD'?undefined:output);
      }catch(error){if(method==='POST')await db.updateTable('studio_live_requests').set({status:'unknown'}).where('live_id','=',row.id).where('request_id','=',requestId).execute();throw error;}
    }catch(error){const fault=error instanceof StudioError?error:failure('STUDIO_PREVIEW_FAILED','تعذر إكمال طلب المعاينة.',502);response.writeHead(fault.statusCode,{'content-type':'text/plain; charset=utf-8'});response.end(fault.message);}
  }
  async function register(app:FastifyInstance,owner:(request:any)=>Promise<{id:string}>){
    // An app restart never resumes cloud compute automatically or revives a cap.
    const abandoned=await db.selectFrom('studio_live_sessions').select(['id','name']).where('status','in',['building','active']).execute();for(const row of abandoned){await db.updateTable('studio_live_sessions').set({status:'revoked',error:'أُعيد تشغيل الخدمة. شغّل معاينة جديدة عند الحاجة.'}).where('id','=',row.id).execute();void stopName(row.name);}
    if(available){server=createServer((request,response)=>void respond(request,response));await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(port,'127.0.0.1',resolve);});const address=server.address();if(address&&typeof address!=='string')port=address.port;}
    app.get<{Params:{id:string}}>('/api/studio/sessions/:id/live',async request=>status((await owner(request)).id,z.uuid().parse(request.params.id)));
    app.post<{Params:{id:string}}>('/api/studio/sessions/:id/live',async(request,reply)=>{const input=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body);const result=await start((await owner(request)).id,z.uuid().parse(request.params.id),input.revision);return reply.code(202).send(result);});
    app.post<{Params:{id:string}}>('/api/studio/sessions/:id/live/stop',async request=>{z.object({}).strict().parse(request.body??{});return stop((await owner(request)).id,z.uuid().parse(request.params.id));});
  }
  async function close(){for(const controller of buildControllers)controller.abort();const ids=[...runtimes.keys()];if(ids.length){const rows=await db.selectFrom('studio_live_sessions').selectAll().where('id','in',ids).where('status','in',['building','active']).execute();for(const row of rows)await revokeRow(row);}await Promise.allSettled([...workers]);if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}
  return {available,build,register,close};
}
