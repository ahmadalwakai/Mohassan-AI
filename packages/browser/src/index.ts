import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { BrowserEngine, type BrowserObservation, type BrowserPreparedSubmission } from './engine.js';
import { BrowserError, SafeNetwork, type NetworkPolicy } from './network.js';
import { conductResearch, PublicWebSearch, type SearchProvider, type ResearchReport } from './research.js';
export * from './network.js';
export * from './engine.js';
export * from './research.js';
export * from './agent-browser.js';

export interface BrowserConfig extends NetworkPolicy {searchProvider?:SearchProvider}
export const browserMigration=`
CREATE TABLE IF NOT EXISTS browser_sessions(id text PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,allowed_origins jsonb NOT NULL,status text NOT NULL DEFAULT 'open',observation jsonb,sequence integer NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS browser_sessions_owner_idx ON browser_sessions(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS browser_observations(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,sequence integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,sequence));
CREATE TABLE IF NOT EXISTS browser_events(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,kind text NOT NULL,message text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS browser_approvals(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,owner_id text NOT NULL,observation_id text NOT NULL,digest text NOT NULL,request jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS browser_locks(resource_key text PRIMARY KEY,token text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS research_runs(id text PRIMARY KEY,owner_id text NOT NULL,question text NOT NULL,status text NOT NULL,report jsonb,error text,lease_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS research_runs_owner_idx ON research_runs(owner_id,created_at DESC);
`;
export async function migrateBrowser(db:Kysely<any>){await db.transaction().execute(async transaction=>{await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(transaction);for(const statement of browserMigration.split(';').map(value=>value.trim()).filter(Boolean))await sql.raw(statement).execute(transaction);});}
export const BrowserCreateSchema=z.object({title:z.string().trim().min(3).max(100),allowedOrigins:z.array(z.string().max(2500)).min(1).max(6),ttlMinutes:z.number().int().min(5).max(60).default(30)}).strict();
export const BrowserActionSchema=z.object({action:z.enum(['navigate','read','click','scroll']),url:z.string().max(2500).optional(),linkId:z.string().regex(/^l\d{1,3}$/).optional(),direction:z.enum(['up','down']).optional(),expectedObservationId:z.uuid().nullable().optional()}).strict();
export const BrowserPrepareSchema=z.object({observationId:z.uuid(),formId:z.string().regex(/^f\d{1,2}$/),values:z.record(z.string().regex(/^i\d{1,2}$/),z.string().max(2000))}).strict();
export const BrowserFillSchema=z.object({observationId:z.uuid(),controlId:z.string().regex(/^c\d{1,3}$/),value:z.string().max(2000)}).strict();
export const BrowserPrepareButtonSchema=z.object({observationId:z.uuid(),controlId:z.string().regex(/^c\d{1,3}$/)}).strict();
export const ResearchCreateSchema=z.object({question:z.string().trim().min(5).max(1000),sourceBudget:z.number().int().min(1).max(5).default(3),maxDepth:z.number().int().min(1).max(2).default(1),allowedDomains:z.array(z.string().min(3).max(250).regex(/^[a-z\d.-]+$/i)).max(8).optional(),sourceUrls:z.array(z.string().max(2500)).max(5).optional()}).strict();
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function createBrowserResearchControl(db:Kysely<any>,config:BrowserConfig={}){
  const engine=new BrowserEngine(config),network=new SafeNetwork(config),provider=config.searchProvider??new PublicWebSearch(network);
  const researchControllers=new Map<string,AbortController>(),researchWorkers=new Set<Promise<void>>();
  async function recoverResearch(ownerId:string){await db.updateTable('research_runs').set({status:'failed',error:'انتهت مهلة متابعة البحث قبل اعتماد نتيجة. يمكنك إنشاء بحث جديد.',updated_at:sql`CURRENT_TIMESTAMP`}).where('owner_id','=',ownerId).where('status','=','running').where('lease_expires_at','<',sql`CURRENT_TIMESTAMP`).execute();}
  async function owned(ownerId:string,id:string,connection:Kysely<any>=db){const row=await connection.selectFrom('browser_sessions').selectAll().where('id','=',id).where('owner_id','=',ownerId).executeTakeFirst();if(!row)throw new BrowserError('BROWSER_NOT_FOUND','لم يُعثر على جلسة المتصفح.',404);return row;}
  async function event(id:string,kind:string,message:string,data:unknown={}){await db.insertInto('browser_events').values({id:randomUUID(),session_id:id,kind,message,data:JSON.stringify(data)}).execute();}
  async function usable(ownerId:string,id:string){const row=await owned(ownerId,id);if(row.status!=='open'||new Date(row.expires_at).getTime()<=Date.now())throw new BrowserError('BROWSER_SESSION_CLOSED','الجلسة مغلقة أو انتهت مدتها. أنشئ جلسة جديدة.',409);if(row.sequence>=50)throw new BrowserError('BROWSER_ACTION_LIMIT','وصلت الجلسة إلى حد خمسين مشاهدة؛ أنشئ جلسة جديدة.',409);return row;}
  async function saveObservation(ownerId:string,id:string,observation:BrowserObservation){
    await db.transaction().execute(async transaction=>{
      const row=await transaction.selectFrom('browser_sessions').selectAll().where('id','=',id).where('owner_id','=',ownerId).forUpdate().executeTakeFirst();
      if(!row||row.status!=='open'||new Date(row.expires_at).getTime()<=Date.now())throw new BrowserError('BROWSER_SESSION_CLOSED','أُغلقت الجلسة أثناء العملية؛ لم تعتمد مشاهدة جديدة.',409);
      const sequence=row.sequence+1;
      await transaction.updateTable('browser_sessions').set({observation:JSON.stringify(observation),sequence,updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).execute();
      await transaction.insertInto('browser_observations').values({id:observation.id,session_id:id,sequence,data:JSON.stringify({...observation,screenshot:null})}).execute();
    });
  }
  async function locked<T>(ownerId:string,id:string,run:()=>Promise<T>):Promise<T>{
    await owned(ownerId,id);
    const token=randomUUID();const claim=await sql<{token:string}>`INSERT INTO browser_locks(resource_key,token,expires_at) VALUES(${id},${token},CURRENT_TIMESTAMP+interval '120 seconds') ON CONFLICT(resource_key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE browser_locks.expires_at<CURRENT_TIMESTAMP RETURNING token`.execute(db);
    if(claim.rows[0]?.token!==token)throw new BrowserError('BROWSER_SESSION_BUSY','تجري عملية أخرى في هذه الجلسة.',409);
    try{return await run();}finally{await db.deleteFrom('browser_locks').where('resource_key','=',id).where('token','=',token).execute();}
  }
  async function detail(ownerId:string,id:string){const row=await owned(ownerId,id),events=await db.selectFrom('browser_events').select(['id','kind','message','created_at']).where('session_id','=',id).orderBy('created_at','desc').limit(50).execute(),approvals=await db.selectFrom('browser_approvals').select(['id','request','status','expires_at','receipt','created_at']).where('session_id','=',id).orderBy('created_at','desc').limit(20).execute();return {id:row.id,title:row.title,allowedOrigins:row.allowed_origins,status:row.status,live:engine.has(id),expired:new Date(row.expires_at).getTime()<=Date.now(),expiresAt:new Date(row.expires_at).toISOString(),sequence:row.sequence,observation:row.observation as BrowserObservation|null,events:events.map(item=>({...item,createdAt:new Date(item.created_at).toISOString()})),approvals:approvals.map(item=>({...item,expiresAt:new Date(item.expires_at).toISOString(),createdAt:new Date(item.created_at).toISOString()}))};}
  async function observations(ownerId:string,id:string,input:unknown={}){await owned(ownerId,id);const query=z.object({afterSequence:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(input);return {observations:await db.selectFrom('browser_observations').select(['sequence','data','created_at']).where('session_id','=',id).where('sequence','>',query.afterSequence).orderBy('sequence','asc').limit(query.limit).execute()};}
  async function workspace(ownerId:string){await recoverResearch(ownerId);return {sessions:await db.selectFrom('browser_sessions').select(['id','title','status','expires_at','updated_at','sequence']).where('owner_id','=',ownerId).orderBy('updated_at','desc').limit(20).execute(),research:await db.selectFrom('research_runs').select(['id','question','status','created_at','error']).where('owner_id','=',ownerId).orderBy('created_at','desc').limit(20).execute()};}
  async function create(ownerId:string,input:unknown){const request=BrowserCreateSchema.parse(input),origins=[...new Set(request.allowedOrigins.map(origin=>{const url=network.validate(origin);if(url.href!==url.origin+'/')throw new BrowserError('BROWSER_ORIGIN_REQUIRED','حدد أصل الموقع فقط، مثل https://example.com.');return url.origin;}))];for(const origin of origins)await network.pin(origin);
    const id=randomUUID();await db.transaction().execute(async transaction=>{const user=await transaction.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst();if(!user)throw new BrowserError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);const count=await transaction.selectFrom('browser_sessions').select(eb=>eb.fn.countAll<number>().as('count')).where('owner_id','=',ownerId).where('status','=','open').where('expires_at','>',sql`CURRENT_TIMESTAMP`).executeTakeFirstOrThrow();if(Number(count.count)>=6)throw new BrowserError('BROWSER_SESSION_LIMIT','أغلق إحدى جلساتك الست قبل إنشاء جلسة جديدة.',409);await transaction.insertInto('browser_sessions').values({id,owner_id:ownerId,title:request.title,allowed_origins:JSON.stringify(origins),status:'open',expires_at:new Date(Date.now()+request.ttlMinutes*60000)}).execute();});
    await event(id,'created','أُنشئت جلسة قراءة مستقلة ضمن المواقع المختارة.');return detail(ownerId,id);
  }
  async function action(ownerId:string,id:string,input:unknown){const request=BrowserActionSchema.parse(input);return locked(ownerId,id,async()=>{const row=await usable(ownerId,id),current=row.observation as BrowserObservation|null;
    if((current?.id??null)!==(request.expectedObservationId??null))throw new BrowserError('BROWSER_OBSERVATION_CHANGED','تغيرت المشاهدة؛ حدّث الجلسة قبل إصدار فعل جديد.',409);
    try{let observation:BrowserObservation;
      if(request.action==='navigate'){if(!request.url)throw new BrowserError('BROWSER_URL_REQUIRED','أدخل عنوان الصفحة.');network.validate(request.url,row.allowed_origins);await engine.open(id,row.allowed_origins,new Date(row.expires_at).getTime());observation=await engine.navigate(id,request.url);}
      else if(request.action==='read')observation=await engine.observe(id);
      else if(request.action==='scroll')observation=await engine.scroll(id,request.direction??'down');
      else {const link=current?.links.find(item=>item.id===request.linkId);if(!link)throw new BrowserError('BROWSER_LINK_CHANGED','الرابط غير موجود في المشاهدة المحددة.',409);observation=await engine.navigate(id,link.url);}
      await saveObservation(ownerId,id,observation);await event(id,request.action,'وصلت مشاهدة جديدة موثقة من المتصفح.',{url:observation.url,observationId:observation.id});return detail(ownerId,id);
    }catch(error){await event(id,'error',error instanceof BrowserError?error.message:'تعذر تقدم المتصفح.');throw error;}
  });}
  async function fill(ownerId:string,id:string,input:unknown){const request=BrowserFillSchema.parse(input);return locked(ownerId,id,async()=>{
    const row=await usable(ownerId,id),current=row.observation as BrowserObservation|null;
    if(!current||request.observationId!==current.id)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','اقرأ الصفحة قبل تعبئة الحقل.',409);
    const observation=await engine.fill(id,current,request.controlId,request.value);await saveObservation(ownerId,id,observation);await event(id,'fill','عُبئ حقل مرصود دون منح إذن إرسال نموذج.',{observationId:observation.id,controlId:request.controlId});return detail(ownerId,id);
  });}
  async function saveApproval(ownerId:string,id:string,current:BrowserObservation,prepared:BrowserPreparedSubmission){
    const approvalRequest={observationId:current.id,pageUrl:current.url,formId:prepared.form.id,action:prepared.form.action,method:prepared.form.method,fields:prepared.form.fields.filter(field=>prepared.values[field.id]!==undefined).map(field=>({label:field.label,name:field.name,value:prepared.values[field.id]})),values:prepared.values,payloadHash:prepared.payloadHash,...(prepared.submitter?{submitter:prepared.submitter}:{})};
    const approvalId=randomUUID();await db.transaction().execute(async transaction=>{
      // close() updates this same row before revoking pending approvals. Lock it
      // through insertion so a late prepare cannot add permission after close.
      const row=await transaction.selectFrom('browser_sessions').selectAll().where('id','=',id).where('owner_id','=',ownerId).forUpdate().executeTakeFirst();
      if(!row||row.status!=='open'||new Date(row.expires_at).getTime()<=Date.now())throw new BrowserError('BROWSER_SESSION_CLOSED','أُغلقت جلسة المتصفح قبل حفظ طلب الموافقة.',409);
      if((row.observation as BrowserObservation|null)?.id!==current.id)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','تغيرت المشاهدة قبل حفظ طلب الموافقة.',409);
      await transaction.insertInto('browser_approvals').values({id:approvalId,session_id:id,owner_id:ownerId,observation_id:current.id,digest:digest(approvalRequest),request:JSON.stringify(approvalRequest),status:'pending',expires_at:new Date(Date.now()+5*60000)}).execute();
    });
    await event(id,'approval_requested','حُفظ طلب موافقة لمرة واحدة على الوجهة والقيم وزر الإرسال المحدد.');return detail(ownerId,id);
  }
  async function prepare(ownerId:string,id:string,input:unknown){const request=BrowserPrepareSchema.parse(input);return locked(ownerId,id,async()=>{const row=await usable(ownerId,id),current=row.observation as BrowserObservation|null;if(!current||request.observationId!==current.id)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','اقرأ الصفحة قبل طلب موافقة الإرسال.',409);return saveApproval(ownerId,id,current,await engine.prepare(id,current,request.formId,request.values));});}
  async function prepareButton(ownerId:string,id:string,input:unknown){const request=BrowserPrepareButtonSchema.parse(input);return locked(ownerId,id,async()=>{const row=await usable(ownerId,id),current=row.observation as BrowserObservation|null;if(!current||request.observationId!==current.id)throw new BrowserError('BROWSER_OBSERVATION_CHANGED','اقرأ الصفحة قبل طلب موافقة الزر.',409);return saveApproval(ownerId,id,current,await engine.prepareButton(id,current,request.controlId));});}
  async function approve(ownerId:string,id:string,approvalId:string){return locked(ownerId,id,async()=>{
    const row=await usable(ownerId,id),current=row.observation as BrowserObservation|null;
    const approval=await db.transaction().execute(async transaction=>{const entry=await transaction.selectFrom('browser_approvals').selectAll().where('id','=',approvalId).where('session_id','=',id).where('owner_id','=',ownerId).forUpdate().executeTakeFirst();if(!entry||entry.status!=='pending'||new Date(entry.expires_at).getTime()<=Date.now()||entry.observation_id!==current?.id||digest(entry.request)!==entry.digest||!/^[a-f0-9]{64}$/.test(entry.request.payloadHash??''))throw new BrowserError('BROWSER_APPROVAL_INVALID','انتهت الموافقة أو تغيرت مدخلاتها. لا يمكن إعادة استخدامها.',409);await transaction.updateTable('browser_approvals').set({status:'consumed'}).where('id','=',approvalId).execute();return entry;});
    try{const receipt=await engine.submit(id,current!,approval.request.formId,approval.request.values,{payloadHash:approval.request.payloadHash,...(approval.request.submitter?{submitter:approval.request.submitter}:{})});await saveObservation(ownerId,id,receipt.observation);await db.updateTable('browser_approvals').set({status:'succeeded',receipt:JSON.stringify({...receipt,observation:{id:receipt.observation.id,url:receipt.observation.url}})}).where('id','=',approvalId).execute();await event(id,'submitted','أُرسل النموذج مرة واحدة ووصلت مشاهدة للنتيجة. تحقق من محتواها قبل اعتماد أثر خارجي.',{approvalId});return detail(ownerId,id);}
    catch(error){const failure=error as Error&{diagnostics?:unknown};await db.updateTable('browser_approvals').set({status:error instanceof BrowserError&&error.code==='BROWSER_SUBMIT_UNKNOWN'?'unknown':'failed',receipt:JSON.stringify({code:error instanceof BrowserError?error.code:'BROWSER_SUBMIT_FAILED',message:error instanceof BrowserError?error.message:'فشل الإرسال.',...(failure.diagnostics?{diagnostics:failure.diagnostics}:{})})}).where('id','=',approvalId).execute();await event(id,'submit_unresolved','توقفت محاولة الإرسال. لا توجد إعادة تلقائية؛ راجع المشاهدة قبل محاولة جديدة.',{code:error instanceof BrowserError?error.code:'BROWSER_SUBMIT_FAILED',...(failure.diagnostics?{diagnostics:failure.diagnostics}:{})});throw error;}
  });}
  async function close(ownerId:string,id:string){await owned(ownerId,id);await db.transaction().execute(async transaction=>{await transaction.updateTable('browser_sessions').set({status:'closed',updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).execute();await transaction.updateTable('browser_approvals').set({status:'revoked'}).where('session_id','=',id).where('status','=','pending').execute();});await engine.closeSession(id);await event(id,'closed','أُغلقت الجلسة وألغيت الموافقات المعلقة.');return detail(ownerId,id);}
  async function revoke(ownerId:string,id:string,approvalId:string){await owned(ownerId,id);const result=await db.updateTable('browser_approvals').set({status:'revoked'}).where('session_id','=',id).where('owner_id','=',ownerId).where('id','=',approvalId).where('status','=','pending').returning('id').executeTakeFirst();if(!result)throw new BrowserError('BROWSER_APPROVAL_INVALID','الموافقة غير معلقة أو غير متاحة لهذه الجلسة.',409);await event(id,'approval_revoked','أُلغي طلب الإرسال قبل التنفيذ.');return detail(ownerId,id);}
  async function research(ownerId:string,input:unknown){
    const request=ResearchCreateSchema.parse(input),id=randomUUID();await recoverResearch(ownerId);
    await db.transaction().execute(async transaction=>{const user=await transaction.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst();if(!user)throw new BrowserError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);const recent=await transaction.selectFrom('research_runs').select(eb=>eb.fn.countAll<number>().as('count')).where('owner_id','=',ownerId).where('status','=','running').executeTakeFirstOrThrow();if(Number(recent.count)>=2)throw new BrowserError('RESEARCH_BUSY','يوجد بحثان قيد القراءة؛ انتظر نتيجة أو أوقف أحدهما.',409);await transaction.insertInto('research_runs').values({id,owner_id:ownerId,question:request.question,status:'running',lease_expires_at:new Date(Date.now()+5*60000)}).execute();});
    const controller=new AbortController();researchControllers.set(id,controller);
    const deadline=setTimeout(()=>controller.abort(),4*60000);deadline.unref();
    const worker=(async()=>{try{const report=await conductResearch(network,provider,{...request,signal:controller.signal});if(controller.signal.aborted)throw new BrowserError('RESEARCH_CANCELLED','أُوقف البحث قبل اعتماد النتيجة.',409);report.id=id;await db.updateTable('research_runs').set({status:'completed',report:JSON.stringify(report),updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).where('status','=','running').execute();}catch(error){await db.updateTable('research_runs').set({status:controller.signal.aborted?'cancelled':'failed',error:error instanceof BrowserError?error.message:'تعذر إتمام البحث.',updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('status','=','running').execute();}finally{clearTimeout(deadline);researchControllers.delete(id);}})();
    researchWorkers.add(worker);void worker.finally(()=>researchWorkers.delete(worker)).catch(()=>{});
    return researchDetail(ownerId,id);
  }
  async function researchDetail(ownerId:string,id:string){await recoverResearch(ownerId);const row=await db.selectFrom('research_runs').selectAll().where('id','=',id).where('owner_id','=',ownerId).executeTakeFirst();if(!row)throw new BrowserError('RESEARCH_NOT_FOUND','لم يُعثر على البحث.',404);return {id:row.id,question:row.question,status:row.status,report:row.report as ResearchReport|null,error:row.error,createdAt:new Date(row.created_at).toISOString()};}
  async function cancelResearch(ownerId:string,id:string){await researchDetail(ownerId,id);researchControllers.get(id)?.abort();await db.updateTable('research_runs').set({status:'cancelled',error:'أُوقف البحث بناءً على طلبك.',updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).where('status','=','running').execute();return researchDetail(ownerId,id);}
  return {engine,workspace,create,detail,observations,action,fill,prepare,prepareButton,approve,revoke,close,research,researchDetail,cancelResearch,shutdown:async()=>{for(const controller of researchControllers.values())controller.abort();await Promise.allSettled([...researchWorkers]);await engine.close();}};
}
export type BrowserSessionDetail=Awaited<ReturnType<ReturnType<typeof createBrowserResearchControl>['detail']>>;
