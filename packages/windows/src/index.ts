import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

const uuid = z.uuid();
const Target = z.object({key:z.string().regex(/^[a-f0-9]{64}$/),mode:z.enum(['window','desktop']),title:z.string().max(160),width:z.number().int().min(1).max(20000),height:z.number().int().min(1).max(20000)}).strict();
const State = z.object({approvalNonce:uuid,sessionId:z.number().int().positive(),safeDesktop:z.boolean(),localView:z.boolean(),localControl:z.boolean(),target:Target.nullable(),status:z.string().max(200)}).strict();
const Accessible = z.object({name:z.string().max(160),type:z.string().max(80),x:z.number().finite(),y:z.number().finite(),width:z.number().nonnegative(),height:z.number().nonnegative(),password:z.boolean()}).strict();
const Frame = z.object({id:uuid,targetKey:z.string().regex(/^[a-f0-9]{64}$/),capturedAt:z.iso.datetime(),width:z.number().int().positive().max(1024),height:z.number().int().positive().max(1024),jpeg:z.string().min(100).max(280000).regex(/^[A-Za-z0-9+/]+={0,2}$/),elements:z.array(Accessible).max(100)}).strict();
const Action = z.discriminatedUnion('type',[
  z.object({type:z.literal('click'),x:z.number().min(0).max(1),y:z.number().min(0).max(1),button:z.enum(['left','right']).default('left')}).strict(),
  z.object({type:z.literal('text'),text:z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/u)}).strict(),
  z.object({type:z.literal('key'),key:z.enum(['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Space'])}).strict(),
  z.object({type:z.literal('scroll'),delta:z.number().int().min(-3).max(3).refine(value=>value!==0)}).strict(),
]);
const Poll = z.object({nonce:uuid,sentAt:z.iso.datetime(),state:State,frame:Frame.nullable(),ack:z.object({id:uuid,status:z.enum(['applied','rejected','unknown']),code:z.string().regex(/^[A-Z_]{2,80}$/)}).strict().nullable()}).strict();
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const equal = (left:string,right:string) => {const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};
function fault(code:string,message:string,statusCode=409){return Object.assign(new Error(message),{code,statusCode});}
const instant = (value:unknown) => new Date(value as string|Date).getTime();
const active = (grant:any) => Boolean(grant && !grant.revoked_at && instant(grant.expires_at)>Date.now());
function binding(request:FastifyRequest){return hash(String(request.headers.cookie??''));}
function decode(value:any){return typeof value==='string'?JSON.parse(value):value;}

export async function windowsMigration(db:Kysely<any>) {
  await sql`CREATE TABLE IF NOT EXISTS windows_pairings(id text PRIMARY KEY,owner_id text NOT NULL,session_binding text NOT NULL,code_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS windows_devices(id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,key_hash text NOT NULL,revoked_at timestamptz,last_seen_at timestamptz,state jsonb,last_frame jsonb,stopped_nonce text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS windows_devices_owner_idx ON windows_devices(owner_id,created_at)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS windows_grants(id text PRIMARY KEY,owner_id text NOT NULL,device_id text NOT NULL REFERENCES windows_devices(id),session_binding text NOT NULL,scope text NOT NULL CHECK(scope IN ('view','control')),target_key text NOT NULL,approval_nonce text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,next_sequence integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS windows_commands(id text PRIMARY KEY,grant_id text NOT NULL REFERENCES windows_grants(id),device_id text NOT NULL REFERENCES windows_devices(id),owner_id text NOT NULL,nonce text NOT NULL,sequence integer NOT NULL,frame_id text NOT NULL,payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','dispatched','applied','rejected','unknown')),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,result_code text,UNIQUE(grant_id,sequence),UNIQUE(grant_id,nonce))`.execute(db);
  await sql`ALTER TABLE windows_commands ADD COLUMN IF NOT EXISTS input_hash text`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS windows_poll_nonces(device_id text NOT NULL REFERENCES windows_devices(id),nonce text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(device_id,nonce))`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS windows_audit(id text PRIMARY KEY,owner_id text NOT NULL,device_id text,type text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS windows_audit_owner_idx ON windows_audit(owner_id,created_at DESC)`.execute(db);
}

export interface WindowsRouteContext {
  db:Kysely<any>;
  owner(request:any):Promise<{id:string}>;
  config:{webOrigin:string;production:boolean;windowsEnabled?:boolean};
}
/** Called by the shared auth sign-out route; no credential is retained in these rows. */
export async function revokeWindowsSession(db:Kysely<any>,cookie:string) {
  if(!cookie)return;
  const sessionBinding=hash(cookie);
  await db.transaction().execute(async transaction=>{
    await transaction.updateTable('windows_pairings').set({expires_at:new Date()}).where('session_binding','=',sessionBinding).where('consumed_at','is',null).execute();
    const candidates=await transaction.selectFrom('windows_grants').select(['device_id']).where('session_binding','=',sessionBinding).where('revoked_at','is',null).execute();
    if(!candidates.length)return;
    const devices=[...new Set(candidates.map(grant=>grant.device_id))].sort();
    // Use the same device-before-grant lock order as command creation and STOP.
    await transaction.selectFrom('windows_devices').select('id').where('id','in',devices).orderBy('id','asc').forUpdate().execute();
    const grants=await transaction.selectFrom('windows_grants').select(['id','owner_id','device_id']).where('session_binding','=',sessionBinding).where('revoked_at','is',null).forUpdate().execute();
    if(!grants.length)return;
    const ids=grants.map(grant=>grant.id);
    await transaction.updateTable('windows_grants').set({revoked_at:sql`CURRENT_TIMESTAMP`}).where('id','in',ids).execute();
    await transaction.updateTable('windows_commands').set({status:'rejected',payload:'{}',finished_at:sql`CURRENT_TIMESTAMP`,result_code:'SESSION_REVOKED'}).where('grant_id','in',ids).where('status','=','queued').execute();
    await transaction.updateTable('windows_commands').set({status:'unknown',payload:'{}',finished_at:sql`CURRENT_TIMESTAMP`,result_code:'SESSION_REVOKED_UNCONFIRMED'}).where('grant_id','in',ids).where('status','=','dispatched').execute();
    await transaction.updateTable('windows_devices').set({last_frame:null}).where('id','in',devices).execute();
    for(const grant of grants)await transaction.insertInto('windows_audit').values({id:randomUUID(),owner_id:grant.owner_id,device_id:grant.device_id,type:'session_revoked',detail:JSON.stringify({grantId:grant.id})}).execute();
  });
}
export async function registerWindowsRoutes(app:FastifyInstance,{db,owner,config}:WindowsRouteContext) {
  const enabled=config.windowsEnabled??!config.production;
  const audit=async(connection:Kysely<any>,ownerId:string,deviceId:string|null,type:string,detail:Record<string,unknown>={})=>connection.insertInto('windows_audit').values({id:randomUUID(),owner_id:ownerId,device_id:deviceId,type,detail:JSON.stringify(detail)}).execute();
  const requireEnabled=()=>{if(!enabled)throw fault('WINDOWS_DISABLED','ربط Windows غير مفعّل في إعدادات الخدمة.',503);};
  async function deviceFor(ownerId:string,id:string,connection:Kysely<any>=db,lock=false) {
    let query=connection.selectFrom('windows_devices').selectAll().where('id','=',id).where('owner_id','=',ownerId);
    if(lock)query=query.forUpdate();
    const device=await query.executeTakeFirst();
    if(!device)throw fault('WINDOWS_DEVICE_NOT_FOUND','لم يُعثر على الجهاز.',404);
    return device;
  }
  async function revokeGrants(connection:Kysely<any>,device:any,reason:string) {
    await connection.updateTable('windows_grants').set({revoked_at:sql`CURRENT_TIMESTAMP`}).where('device_id','=',device.id).where('revoked_at','is',null).execute();
    await connection.updateTable('windows_commands').set({status:'rejected',payload:'{}',finished_at:sql`CURRENT_TIMESTAMP`,result_code:reason}).where('device_id','=',device.id).where('status','=','queued').execute();
    await connection.updateTable('windows_commands').set({status:'unknown',payload:'{}',finished_at:sql`CURRENT_TIMESTAMP`,result_code:reason+'_UNCONFIRMED'}).where('device_id','=',device.id).where('status','=','dispatched').execute();
  }
  async function companion(request:FastifyRequest) {
    requireEnabled();
    if(request.headers.origin!==undefined||Object.keys(request.headers).some(key=>key.startsWith('sec-fetch-')))throw fault('WINDOWS_COMPANION_BROWSER_DENIED','هذا المسار مخصص للمرافق المحلي فقط.',403);
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip);
    if(!local&&request.protocol!=='https')throw fault('WINDOWS_TLS_REQUIRED','المرافق البعيد يحتاج اتصال HTTPS موثوقًا.',403);
  }
  async function authenticateDevice(request:FastifyRequest,connection:Kysely<any>) {
    const match=/^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(request.headers.authorization??''));
    if(!match)throw fault('WINDOWS_DEVICE_UNAUTHORIZED','مفتاح الجهاز غير صالح.',401);
    const device=await connection.selectFrom('windows_devices').selectAll().where('id','=',match[1]!).forUpdate().executeTakeFirst();
    if(!device||device.revoked_at||!equal(device.key_hash,hash(match[2]!)))throw fault('WINDOWS_DEVICE_UNAUTHORIZED','أُلغي ربط الجهاز أو لم تصح هويته.',401);
    return device;
  }
  function grantDto(grant:any){return {id:grant.id,scope:grant.scope,targetKey:grant.target_key,approvalNonce:grant.approval_nonce,expiresAt:new Date(grant.expires_at).toISOString()};}
  async function sessionGrant(request:FastifyRequest,ownerId:string,device:any,connection:Kysely<any>=db) {
    const grant=await connection.selectFrom('windows_grants').selectAll().where('device_id','=',device.id).where('owner_id','=',ownerId).where('session_binding','=',binding(request)).where('revoked_at','is',null).orderBy('created_at','desc').executeTakeFirst();
    if(!grant)return null;
    const state=device.state?decode(device.state):null;
    return active(grant)&&!device.revoked_at&&state?.safeDesktop&&state.localView&&state.approvalNonce===grant.approval_nonce&&state.target?.key===grant.target_key&&(grant.scope!=='control'||state.localControl)?grant:null;
  }
  const timer=setInterval(()=>{void (async()=>{
    // Independent cleanup statements release command locks before touching devices.
    await db.updateTable('windows_commands').set({status:'unknown',payload:'{}',result_code:'EXPIRED_UNCONFIRMED',finished_at:sql`CURRENT_TIMESTAMP`}).where('status','in',['queued','dispatched']).where('expires_at','<',new Date()).execute();
    await db.updateTable('windows_devices').set({last_frame:null}).where(eb=>eb.or([eb('last_seen_at','<',new Date(Date.now()-5000)),eb.not(eb.exists(eb.selectFrom('windows_grants').select('id').whereRef('windows_grants.device_id','=','windows_devices.id').where('revoked_at','is',null).where('expires_at','>',new Date())))] )).execute();
    await db.deleteFrom('windows_poll_nonces').where('created_at','<',new Date(Date.now()-60000)).execute();
    await db.deleteFrom('windows_pairings').where('expires_at','<',new Date(Date.now()-60000)).execute();
  })().catch(()=>{});},2500);timer.unref();
  app.addHook('onClose',async()=>{clearInterval(timer);});

  app.get('/api/windows',async request=>{
    const user=await owner(request);const devices=await db.selectFrom('windows_devices').select(['id','name','revoked_at','last_seen_at','state','created_at']).where('owner_id','=',user.id).orderBy('created_at','desc').execute();
    const list=[];
    for(const device of devices){const grant=await sessionGrant(request,user.id,device);list.push({id:device.id,name:device.name,revoked:Boolean(device.revoked_at),online:!device.revoked_at&&Boolean(device.last_seen_at)&&Date.now()-instant(device.last_seen_at)<3500,lastSeenAt:device.last_seen_at?new Date(device.last_seen_at).toISOString():null,state:device.state?decode(device.state):null,grant:grant?grantDto(grant):null});}
    const events=await db.selectFrom('windows_audit').select(['id','device_id','type','detail','created_at']).where('owner_id','=',user.id).orderBy('created_at','desc').limit(50).execute();
    return {enabled,devices:list,events:events.map(row=>({id:row.id,deviceId:row.device_id,type:row.type,detail:decode(row.detail),createdAt:new Date(row.created_at).toISOString()}))};
  });
  app.post('/api/windows/pairing',{config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async request=>{
    requireEnabled();const user=await owner(request);z.object({}).strict().parse(request.body??{});
    const code=randomBytes(12).toString('base64url'),id=randomUUID(),expiresAt=new Date(Date.now()+120000);
    await db.transaction().execute(async transaction=>{await transaction.updateTable('windows_pairings').set({expires_at:new Date()}).where('owner_id','=',user.id).where('consumed_at','is',null).execute();await transaction.insertInto('windows_pairings').values({id,owner_id:user.id,session_binding:binding(request),code_hash:hash(code),expires_at:expiresAt}).execute();await audit(transaction,user.id,null,'pairing_created');});
    return {id,code,expiresAt:expiresAt.toISOString()};
  });
  app.post('/api/windows/companion/pair',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{
    await companion(request);const input=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{16}$/),name:z.string().trim().min(1).max(80)}).strict().parse(request.body);
    const key=randomBytes(32).toString('base64url'),id=randomUUID();
    return db.transaction().execute(async transaction=>{
      const pair=await transaction.selectFrom('windows_pairings').selectAll().where('code_hash','=',hash(input.code)).forUpdate().executeTakeFirst();
      if(!pair||pair.consumed_at||instant(pair.expires_at)<=Date.now())throw fault('WINDOWS_PAIRING_INVALID','رمز الربط غير صالح أو انتهت مدته.',401);
      await transaction.selectFrom('user').select('id').where('id','=',pair.owner_id).forUpdate().executeTakeFirstOrThrow();
      const count=await transaction.selectFrom('windows_devices').select(eb=>eb.fn.countAll().as('count')).where('owner_id','=',pair.owner_id).where('revoked_at','is',null).executeTakeFirstOrThrow();
      if(Number(count.count)>=3)throw fault('WINDOWS_DEVICE_LIMIT','الحد ثلاثة أجهزة مرتبطة. ألغ ربط جهاز قبل إضافة غيره.');
      await transaction.updateTable('windows_pairings').set({consumed_at:sql`CURRENT_TIMESTAMP`}).where('id','=',pair.id).execute();
      await transaction.insertInto('windows_devices').values({id,owner_id:pair.owner_id,name:input.name,key_hash:hash(key)}).execute();await audit(transaction,pair.owner_id,id,'device_paired');
      return {deviceId:id,deviceKey:key,pollIntervalMs:1000};
    });
  });
  app.post('/api/windows/companion/poll',{bodyLimit:400000,config:{rateLimit:{max:220,timeWindow:'1 minute'}}},async request=>{
    await companion(request);const input=Poll.parse(request.body);
    if(Math.abs(Date.now()-instant(input.sentAt))>5000)throw fault('WINDOWS_POLL_STALE','انتهت صلاحية طلب المرافق.');
    return db.transaction().execute(async transaction=>{
      const device=await authenticateDevice(request,transaction);
      const nonce=await transaction.insertInto('windows_poll_nonces').values({device_id:device.id,nonce:input.nonce}).onConflict(conflict=>conflict.doNothing()).returning('nonce').executeTakeFirst();
      if(!nonce)throw fault('WINDOWS_POLL_REPLAY','تكرر طلب المرافق.');
      const state=input.state;
      if(!state.safeDesktop||!state.localView||!state.target||state.approvalNonce===device.stopped_nonce)await revokeGrants(transaction,device,'LOCAL_STOP_OR_UNSAFE_DESKTOP');
      let grant:any=await transaction.selectFrom('windows_grants').selectAll().where('device_id','=',device.id).where('revoked_at','is',null).orderBy('created_at','desc').executeTakeFirst();
      if(!active(grant)||grant.approval_nonce!==state.approvalNonce||grant.target_key!==state.target?.key||grant.scope==='control'&&!state.localControl)grant=null;
      if(input.ack){const ack=await transaction.updateTable('windows_commands').set({status:input.ack.status,result_code:input.ack.code,payload:'{}',finished_at:sql`CURRENT_TIMESTAMP`}).where('id','=',input.ack.id).where('device_id','=',device.id).where('status','=','dispatched').returning('id').executeTakeFirst();if(ack)await audit(transaction,device.owner_id,device.id,'input_'+input.ack.status,{id:input.ack.id,code:input.ack.code});}
      let frame:any=null;
      if(grant&&input.frame&&input.frame.targetKey===grant.target_key&&Math.abs(Date.now()-instant(input.frame.capturedAt))<5000){const bytes=Buffer.from(input.frame.jpeg,'base64');if(bytes.length>200000||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw fault('WINDOWS_FRAME_INVALID','صورة المرافق غير صالحة.',400);frame={...input.frame,receivedAt:new Date().toISOString()};}
      await transaction.updateTable('windows_devices').set({last_seen_at:sql`CURRENT_TIMESTAMP`,state:JSON.stringify(state),last_frame:frame?JSON.stringify(frame):null}).where('id','=',device.id).execute();
      let command:any=null;
      if(grant?.scope==='control'&&state.localControl){const pending=await transaction.selectFrom('windows_commands').selectAll().where('device_id','=',device.id).where('grant_id','=',grant.id).where('status','=','queued').where('expires_at','>',new Date()).orderBy('sequence','asc').forUpdate().executeTakeFirst();if(pending){await transaction.updateTable('windows_commands').set({status:'dispatched'}).where('id','=',pending.id).execute();await audit(transaction,device.owner_id,device.id,'input_dispatched',{id:pending.id,sequence:pending.sequence});command={id:pending.id,grantId:grant.id,sequence:pending.sequence,frameId:pending.frame_id,expiresAt:new Date(pending.expires_at).toISOString(),action:decode(pending.payload)};}}
      return {grant:grant?grantDto(grant):null,command,stop:device.stopped_nonce===state.approvalNonce,serverTime:new Date().toISOString()};
    });
  });
  app.post<{Params:{id:string}}>('/api/windows/devices/:id/grants',async request=>{
    requireEnabled();const user=await owner(request);const input=z.object({scope:z.enum(['view','control']),durationSeconds:z.union([z.literal(30),z.literal(60),z.literal(120)]),targetKey:z.string().regex(/^[a-f0-9]{64}$/),approvalNonce:uuid}).strict().parse(request.body);
    return db.transaction().execute(async transaction=>{const device=await deviceFor(user.id,uuid.parse(request.params.id),transaction,true);const state=device.state?State.parse(decode(device.state)):null;
      if(device.revoked_at||!device.last_seen_at||Date.now()-instant(device.last_seen_at)>3500||!state?.safeDesktop||!state.localView||state.target?.key!==input.targetKey||state.approvalNonce!==input.approvalNonce||device.stopped_nonce===state.approvalNonce||input.scope==='control'&&!state.localControl)throw fault('WINDOWS_LOCAL_CONSENT_REQUIRED','يحتاج الجهاز اتصالًا حيًا وموافقة محلية حديثة على النطاق المحدد.');
      await revokeGrants(transaction,device,'GRANT_REPLACED');const id=randomUUID(),expiresAt=new Date(Date.now()+input.durationSeconds*1000);
      await transaction.insertInto('windows_grants').values({id,owner_id:user.id,device_id:device.id,session_binding:binding(request),scope:input.scope,target_key:input.targetKey,approval_nonce:input.approvalNonce,expires_at:expiresAt}).execute();await audit(transaction,user.id,device.id,'grant_created',{id,scope:input.scope,durationSeconds:input.durationSeconds,targetMode:state.target.mode});
      return {id,scope:input.scope,targetKey:input.targetKey,approvalNonce:input.approvalNonce,expiresAt:expiresAt.toISOString()};
    });
  });
  app.get<{Params:{id:string}}>('/api/windows/devices/:id/frame',async request=>{const user=await owner(request);const device=await deviceFor(user.id,uuid.parse(request.params.id));const grant=await sessionGrant(request,user.id,device);const frame=device.last_frame?decode(device.last_frame):null;if(!grant||!frame||Date.now()-instant(frame.capturedAt)>3500||frame.targetKey!==grant.target_key)throw fault('WINDOWS_FRAME_UNAVAILABLE','لا توجد صورة حديثة ضمن إذن مشاهدة صالح.');return {frame,grant:grantDto(grant)};});
  app.post<{Params:{id:string}}>('/api/windows/devices/:id/actions',async request=>{
    requireEnabled();const user=await owner(request);const input=z.object({grantId:uuid,nonce:uuid,frameId:uuid,action:Action}).strict().parse(request.body);
    return db.transaction().execute(async transaction=>{const device=await deviceFor(user.id,uuid.parse(request.params.id),transaction,true);const grant=await sessionGrant(request,user.id,device,transaction);const state=device.state?State.parse(decode(device.state)):null;const frame=device.last_frame?decode(device.last_frame):null;
      if(!grant||grant.id!==input.grantId||grant.scope!=='control')throw fault('WINDOWS_CONTROL_DENIED','هذا الإذن لا يسمح بالإدخال.',403);
      const inputHash=hash(JSON.stringify([input.grantId,input.frameId,input.action]));
      const previous=await transaction.selectFrom('windows_commands').select(['id','status','result_code','input_hash']).where('grant_id','=',grant.id).where('nonce','=',input.nonce).executeTakeFirst();if(previous){if(previous.input_hash!==inputHash)throw fault('WINDOWS_NONCE_CONFLICT','استُخدم معرف الطلب لإجراء مختلف.');return {id:previous.id,status:previous.status,code:previous.result_code};}
      if(device.revoked_at||!state?.safeDesktop||!state.localControl||!state.localView||state.approvalNonce!==grant.approval_nonce||state.approvalNonce===device.stopped_nonce||state.target?.key!==grant.target_key||Date.now()-instant(device.last_seen_at)>3500||!frame||frame.id!==input.frameId||Date.now()-instant(frame.capturedAt)>3000)throw fault('WINDOWS_FRESH_SCREEN_REQUIRED','توقف الإدخال؛ حدّث الشاشة وتحقق من الاتصال والموافقة المحلية.');
      const pending=await transaction.selectFrom('windows_commands').select('id').where('device_id','=',device.id).where('status','in',['queued','dispatched']).where('expires_at','>',new Date()).executeTakeFirst();if(pending)throw fault('WINDOWS_INPUT_PENDING','انتظر نتيجة الإجراء السابق ثم حدّث الشاشة.');
      const id=randomUUID(),sequence=grant.next_sequence;
      await transaction.updateTable('windows_grants').set({next_sequence:sequence+1}).where('id','=',grant.id).execute();await transaction.insertInto('windows_commands').values({id,grant_id:grant.id,device_id:device.id,owner_id:user.id,nonce:input.nonce,sequence,frame_id:input.frameId,input_hash:inputHash,payload:JSON.stringify(input.action),status:'queued',expires_at:new Date(Date.now()+2000)}).execute();await audit(transaction,user.id,device.id,'input_requested',{id,sequence,type:input.action.type,...(input.action.type==='text'?{characters:input.action.text.length}:{})});return {id,status:'queued'};
    });
  });
  app.post<{Params:{id:string}}>('/api/windows/devices/:id/stop',async request=>{const user=await owner(request);z.object({}).strict().parse(request.body??{});return db.transaction().execute(async transaction=>{const device=await deviceFor(user.id,uuid.parse(request.params.id),transaction,true);await revokeGrants(transaction,device,'OWNER_STOP');await transaction.updateTable('windows_devices').set({last_frame:null,stopped_nonce:device.state?decode(device.state).approvalNonce:null}).where('id','=',device.id).execute();await audit(transaction,user.id,device.id,'owner_stop');return {ok:true};});});
  app.post<{Params:{id:string}}>('/api/windows/devices/:id/revoke',async request=>{const user=await owner(request);z.object({}).strict().parse(request.body??{});return db.transaction().execute(async transaction=>{const device=await deviceFor(user.id,uuid.parse(request.params.id),transaction,true);await revokeGrants(transaction,device,'DEVICE_REVOKED');await transaction.updateTable('windows_devices').set({revoked_at:sql`CURRENT_TIMESTAMP`,last_frame:null}).where('id','=',device.id).execute();await audit(transaction,user.id,device.id,'device_revoked');return {ok:true};});});
}
