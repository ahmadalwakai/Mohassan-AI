import { createHash,randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { MemoryCorrectionSchema,MemoryCreateSchema,MemoryFeedbackSchema,MemoryItemSchema,MemoryMutationSchema,MemorySearchSchema,SkillActionSchema,SkillActivationSchema,SkillCreateSchema,SkillEvaluationSchema,SkillRevokeSchema,SkillRunSchema,SkillSchema,type MemoryLayer,type MemoryItem } from './contracts.ts';
import { evaluateChecklist,executeChecklist,manifestHash } from './skills.ts';
export * from './contracts.ts';
export * from './skills.ts';
export { memoryMigration } from './migration.ts';

export class MemoryError extends Error {constructor(public readonly code:string,message:string,public readonly statusCode=400){super(message);this.name='MemoryError';}}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const iso=(value:unknown)=>new Date(value as string|Date).toISOString();
const lifetime:Record<MemoryLayer,number>={working:1,episodic:90,semantic:180,procedural:365,failure:90,preference:365};
function clean(value:unknown,limit=1200):string {
  return String(value??'').replace(/\b(?:gsk_|sk-(?:proj-)?|ghp_|github_pat_|npg_)[A-Za-z0-9_-]{12,}/gi,'[اعتماد محجوب]').replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi,'[اعتماد محجوب]').replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|https?):\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[محجوب]@').replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret)\b\s*[:=]\s*["'`]?[A-Za-z0-9_./+~=-]{8,}["'`]?/gi,'$1=[محجوب]').slice(0,limit);
}
function checked(value:string){if(clean(value,10000)!==value)throw new MemoryError('MEMORY_SECRET_REJECTED','احذف بيانات الاعتماد من النص قبل حفظه في الذاكرة.');return value;}
const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670]/g,'');
type MemoryLookupOptions = {readOnly?: boolean};

export function createMemoryControl(db:Kysely<any>,options:{now?:()=>Date}={}){
  const now=()=>options.now?.()??new Date();
  const expiry=(layer:MemoryLayer,requested?:string)=>requested?new Date(requested):new Date(now().getTime()+lifetime[layer]*86400000);
  async function ownerLock(connection:Kysely<any>,ownerId:string){if(!await connection.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst())throw new MemoryError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);}
  async function ownedTask(ownerId:string,taskId:string,connection:Kysely<any>=db){const task=await connection.selectFrom('tasks').select(['id','title','status','updated_at']).where('id','=',taskId).where('owner_id','=',ownerId).executeTakeFirst();if(!task)throw new MemoryError('TASK_NOT_FOUND','لم يُعثر على المهمة.',404);return task;}
  async function evidence(ownerId:string,ids:string[],connection:Kysely<any>=db){
    if(!ids.length)return [];
    const rows=await connection.selectFrom('memory_evidence').selectAll().where('owner_id','=',ownerId).where('id','in',[...new Set(ids)]).execute();
    if(rows.length!==new Set(ids).size||rows.some(row=>row.status!=='active'||row.expires_at&&new Date(row.expires_at)<=now()))throw new MemoryError('MEMORY_EVIDENCE_UNAVAILABLE','أحد المصادر غير مملوك أو منتهي أو ملغى.',409);
    return rows;
  }
  async function manualEvidence(connection:Kysely<any>,ownerId:string,description:string,kind='manual',taskId:string|null=null,sourceContent=description){
    const id=randomUUID();await connection.insertInto('memory_evidence').values({id,owner_id:ownerId,source_key:`manual:${id}`,kind,description:clean(description,240),task_id:taskId,event_id:null,content_hash:hash(sourceContent),trust:'manual',status:'active',observed_at:now(),expires_at:null}).execute();return id;
  }
  async function taskEvidence(connection:Kysely<any>,ownerId:string,taskId:string){
    const task=await ownedTask(ownerId,taskId,connection),key=`task-reference:${taskId}`;
    const row=await connection.insertInto('memory_evidence').values({id:randomUUID(),owner_id:ownerId,source_key:key,kind:'task',description:`مرجع إلى المهمة: ${clean(task.title,120)}`,task_id:taskId,event_id:null,content_hash:hash(JSON.stringify([task.id,task.status,iso(task.updated_at)])),trust:'observed',status:'active',observed_at:now(),expires_at:null}).onConflict(conflict=>conflict.columns(['owner_id','source_key']).doNothing()).returning('id').executeTakeFirst();
    return row?.id??(await connection.selectFrom('memory_evidence').select('id').where('owner_id','=',ownerId).where('source_key','=',key).executeTakeFirstOrThrow()).id;
  }
  async function insertItem(connection:Kysely<any>,ownerId:string,input:{title:string;content:string;layer:MemoryLayer;taskId?:string;expiresAt?:string;evidenceIds:string[]},details:{rootId?:string;version?:number;confidenceKind?:'user_asserted'|'task_observed'}={}){
    const id=randomUUID(),rootId=details.rootId??id;
    const row=await connection.insertInto('memory_items').values({id,root_id:rootId,owner_id:ownerId,version:details.version??1,title:input.title,content:input.content,layer:input.layer,status:'active',confidence:details.confidenceKind==='task_observed'?1:0.5,confidence_kind:details.confidenceKind??'user_asserted',task_id:input.taskId??null,expires_at:expiry(input.layer,input.expiresAt),created_at:now(),updated_at:now()}).returningAll().executeTakeFirstOrThrow();
    for(const evidenceId of new Set(input.evidenceIds))await connection.insertInto('memory_provenance').values({memory_id:id,evidence_id:evidenceId,relation:details.confidenceKind==='task_observed'?'observed':'asserted'}).execute();
    return row;
  }
  async function provenance(rows:any[]){
    if(!rows.length)return [];
    const refs=await db.selectFrom('memory_provenance as p').innerJoin('memory_evidence as e','e.id','p.evidence_id').selectAll('e').select('p.memory_id').where('p.memory_id','in',rows.map(row=>row.id)).execute();
    return rows.map(row=>MemoryItemSchema.parse({id:row.id,rootId:row.root_id,version:row.version,title:row.title,content:row.content,layer:row.layer,status:row.status==='active'&&new Date(row.expires_at)<=now()?'expired':row.status,confidence:Number(row.confidence),confidenceKind:row.confidence_kind,taskId:row.task_id,expiresAt:iso(row.expires_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),provenance:refs.filter(ref=>ref.memory_id===row.id).map(ref=>({id:ref.id,kind:ref.kind,description:ref.description,taskId:ref.task_id,eventId:ref.event_id,contentHash:ref.content_hash,trust:ref.trust,status:ref.status,observedAt:iso(ref.observed_at),expiresAt:ref.expires_at?iso(ref.expires_at):null}))}));
  }
  async function itemRow(ownerId:string,id:string,connection:Kysely<any>=db,lock=false){let query=connection.selectFrom('memory_items').selectAll().where('id','=',id).where('owner_id','=',ownerId);if(lock)query=query.forUpdate();const row=await query.executeTakeFirst();if(!row)throw new MemoryError('MEMORY_NOT_FOUND','لم يُعثر على الذاكرة.',404);return row;}
  async function audit(connection:Kysely<any>,ownerId:string,targetId:string,operation:string,reason:string){await connection.insertInto('memory_audit').values({id:randomUUID(),owner_id:ownerId,target_id:targetId,operation,reason:clean(reason,500)}).execute();}
  async function create(ownerId:string,input:unknown){
    const request=MemoryCreateSchema.parse(input);checked(request.title);checked(request.content);
    const row=await db.transaction().execute(async tx=>{
      await ownerLock(tx,ownerId);await evidence(ownerId,request.evidenceIds,tx);
      const count=await tx.selectFrom('memory_items').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).executeTakeFirstOrThrow();if(Number(count.n)>=2000)throw new MemoryError('MEMORY_LIMIT','بلغت الذاكرة حد ألفي إصدار محفوظ.',409);
      const ids=[...request.evidenceIds,await manualEvidence(tx,ownerId,`ملاحظة يدوية: ${request.title}`,'manual',request.taskId??null,request.content)];
      if(request.taskId)ids.push(await taskEvidence(tx,ownerId,request.taskId));
      return insertItem(tx,ownerId,{...request,evidenceIds:ids});
    });return (await provenance([row]))[0];
  }
  async function detail(ownerId:string,id:string){const row=await itemRow(ownerId,id);const versions=await db.selectFrom('memory_items').selectAll().where('owner_id','=',ownerId).where('root_id','=',row.root_id).orderBy('version','desc').limit(20).execute();return {item:(await provenance([row]))[0],versions:await provenance(versions)};}
  async function correct(ownerId:string,id:string,input:unknown){
    const request=MemoryCorrectionSchema.parse(input);checked(request.title);checked(request.content);
    const row=await db.transaction().execute(async tx=>{
      const current=await itemRow(ownerId,id,tx,true);
      if(current.version!==request.expectedVersion||current.status!=='active')throw new MemoryError('MEMORY_VERSION_CONFLICT','تغير إصدار الذاكرة؛ حدّثها قبل التصحيح.',409);
      await evidence(ownerId,request.evidenceIds,tx);
      const ids=[...request.evidenceIds,await manualEvidence(tx,ownerId,`تصحيح يدوي: ${request.title}`,'manual',current.task_id,request.content)];
      if(current.task_id)ids.push(await taskEvidence(tx,ownerId,current.task_id));
      await tx.updateTable('memory_items').set({status:'superseded',updated_at:now()}).where('id','=',id).execute();
      const changed=await insertItem(tx,ownerId,{...request,taskId:current.task_id??undefined,evidenceIds:ids},{rootId:current.root_id,version:current.version+1});
      await audit(tx,ownerId,changed.id,'correct',request.reason);return changed;
    });return (await provenance([row]))[0];
  }
  async function revoke(ownerId:string,id:string,input:unknown){const request=MemoryMutationSchema.parse(input);await db.transaction().execute(async tx=>{const row=await itemRow(ownerId,id,tx,true);if(row.version!==request.expectedVersion||row.status!=='active')throw new MemoryError('MEMORY_VERSION_CONFLICT','تغير إصدار الذاكرة.',409);await tx.updateTable('memory_items').set({status:'revoked',updated_at:now()}).where('id','=',id).execute();await audit(tx,ownerId,id,'revoke',request.reason);});return {revoked:true};}
  async function remove(ownerId:string,id:string,input:unknown){const request=MemoryMutationSchema.parse(input);await db.transaction().execute(async tx=>{const row=await itemRow(ownerId,id,tx,true);const latest=await tx.selectFrom('memory_items').select(['id','version']).where('owner_id','=',ownerId).where('root_id','=',row.root_id).orderBy('version','desc').executeTakeFirstOrThrow();if(row.version!==request.expectedVersion||latest.id!==id)throw new MemoryError('MEMORY_VERSION_CONFLICT','تغير إصدار الذاكرة.',409);const versions=await tx.selectFrom('memory_items').select('id').where('owner_id','=',ownerId).where('root_id','=',row.root_id).execute();const ids=versions.map(version=>version.id);const refs=await tx.selectFrom('memory_provenance').select('evidence_id').where('memory_id','in',ids).execute();await tx.deleteFrom('memory_items').where('owner_id','=',ownerId).where('root_id','=',row.root_id).execute();for(const ref of refs){const linked=await tx.selectFrom('memory_provenance').select('memory_id').where('evidence_id','=',ref.evidence_id).executeTakeFirst();const skillLink=await sql`SELECT 1 FROM memory_skill_versions WHERE evidence_ids ? ${ref.evidence_id} LIMIT 1`.execute(tx);if(!linked&&!skillLink.rows.length)await tx.deleteFrom('memory_evidence').where('id','=',ref.evidence_id).where('owner_id','=',ownerId).where('kind','in',['manual','feedback']).execute();}await audit(tx,ownerId,row.root_id,'delete','حذف المستخدم محتوى الذاكرة وإصداراته.');});return {deleted:true};}
  async function sync(ownerId:string){
    const observed=await sql<any>`SELECT t.id,t.title,t.status,t.attempt,t.error,t.updated_at,t.result->>'summary' AS summary,e.id AS event_id FROM tasks t LEFT JOIN LATERAL(SELECT id FROM task_events WHERE task_id=t.id ORDER BY sequence DESC LIMIT 1)e ON true WHERE t.owner_id=${ownerId} AND t.status IN('completed','failed','cancelled') ORDER BY t.updated_at DESC LIMIT 80`.execute(db);
    const keys=observed.rows.map(task=>`outcome:${task.id}:${task.attempt}:${task.status}`);if(!keys.length)return {created:0};
    const known=await db.selectFrom('memory_evidence').select('source_key').where('owner_id','=',ownerId).where('source_key','in',keys).execute();const seen=new Set(known.map(row=>row.source_key));let created=0;
    await db.transaction().execute(async tx=>{await ownerLock(tx,ownerId);for(const task of observed.rows){const key=`outcome:${task.id}:${task.attempt}:${task.status}`;if(seen.has(key))continue;
      const content=`المهمة «${clean(task.title,120)}» انتهت بالحالة المسجلة: ${task.status}.${task.summary?` ملخص النتيجة المسجل، وليس حقيقة مستقلة: ${clean(task.summary,800)}`:''}${task.error?` الخطأ المسجل: ${clean(task.error,400)}`:''}`;
      const id=randomUUID(),source=await tx.insertInto('memory_evidence').values({id,owner_id:ownerId,source_key:key,kind:task.status==='failed'?'task_error':'task_result',description:`نتيجة فعلية محفوظة للمهمة ${clean(task.title,120)}`,task_id:task.id,event_id:task.event_id??null,content_hash:hash(content),trust:'observed',status:'active',observed_at:task.updated_at,expires_at:null}).onConflict(conflict=>conflict.columns(['owner_id','source_key']).doNothing()).returning('id').executeTakeFirst();
      if(!source)continue;await insertItem(tx,ownerId,{title:`${task.status==='failed'?'تعثر':'نتيجة'}: ${clean(task.title,100)}`,content,layer:task.status==='failed'?'failure':'episodic',taskId:task.id,evidenceIds:[id]},{confidenceKind:'task_observed'});created++;
    }});return {created};
  }
  async function search(ownerId:string,input:unknown,options:MemoryLookupOptions={}){
    const request=MemorySearchSchema.parse(input);
    if(request.taskId)await ownedTask(ownerId,request.taskId);
    if(!options.readOnly)await sync(ownerId);
    let query=db.selectFrom('memory_items').selectAll().where('owner_id','=',ownerId).where('status','=','active').where('expires_at','>',now());
    if(request.layers?.length)query=query.where('layer','in',request.layers);
    query=query.where(eb=>eb.or([eb('layer','!=','working'),request.taskId?eb('task_id','=',request.taskId):eb('task_id','is',null)]));
    const rows=await query.orderBy('updated_at','desc').limit(300).execute(),items=await provenance(rows);
    const terms=[...new Set(normalize(request.query).split(/[^\p{L}\p{N}]+/u).filter(word=>word.length>1))].slice(0,20);
    const available=items.filter(item=>item.provenance.length&&item.provenance.every(ref=>ref.status==='active'&&(!ref.expiresAt||new Date(ref.expiresAt)>now())));
    const ranked=available.map(item=>({item,score:terms.reduce((score,term)=>score+(normalize(item.title).includes(term)?3:0)+(normalize(item.content).includes(term)?1:0),0)})).filter(item=>!terms.length||item.score>0).sort((left,right)=>right.score-left.score||right.item.updatedAt.localeCompare(left.item.updatedAt)).slice(0,request.limit).map(row=>row.item);
    const expired=await db.selectFrom('memory_items').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).where('status','=','active').where('expires_at','<=',now()).executeTakeFirstOrThrow();
    return {items:ranked,citations:ranked.flatMap(item=>item.provenance.map(ref=>({memoryId:item.id,evidenceId:ref.id,taskId:ref.taskId,kind:ref.kind}))),method:'lexical-v1' as const,expiredExcluded:Number(expired.n)};
  }
  async function context(ownerId:string,query:string,taskId?:string,options?:MemoryLookupOptions){const result=await search(ownerId,{query:query.slice(0,500),limit:5,taskId},options);const active=await db.selectFrom('memory_skill_versions').select('id').where('owner_id','=',ownerId).where('status','=','active').orderBy('updated_at','desc').limit(3).execute();const skillProposals=[];if(query.trim().length>=3)for(const skill of active){try{skillProposals.push(await runSkill(ownerId,skill.id,{input:query.slice(0,1000)}));}catch(error){if(!(error instanceof MemoryError))throw error;}}const items=result.items.map(item=>({...item,content:item.content.slice(0,1200)}));let bounded={...result,items,citations:result.citations,skillProposals};while(JSON.stringify(bounded).length>9000&&items.length){items.pop();bounded={...result,items,citations:result.citations.filter(ref=>items.some(item=>item.id===ref.memoryId)),skillProposals};}return bounded;}
  async function feedback(ownerId:string,input:unknown){
    const request=MemoryFeedbackSchema.parse(input);checked(request.comment);await ownedTask(ownerId,request.taskId);
    return db.transaction().execute(async tx=>{await ownerLock(tx,ownerId);const existing=await tx.selectFrom('memory_feedback').selectAll().where('owner_id','=',ownerId).where('submission_key','=',request.submissionKey).executeTakeFirst();if(existing){if(existing.task_id!==request.taskId||existing.kind!==request.kind||existing.comment!==request.comment||existing.persisted_preference!==request.persistPreference)throw new MemoryError('FEEDBACK_CONFLICT','مفتاح التغذية الراجعة مرتبط بطلب مختلف.',409);return {id:existing.id,persistedPreference:existing.persisted_preference};}
      const id=randomUUID();await tx.insertInto('memory_feedback').values({id,owner_id:ownerId,task_id:request.taskId,kind:request.kind,comment:request.comment,rating:request.rating??null,persisted_preference:request.kind==='preference'&&request.persistPreference,submission_key:request.submissionKey,created_at:now()}).execute();
      if(request.kind==='preference'&&request.persistPreference){const manual=await manualEvidence(tx,ownerId,'تفضيل مستمر وافق المستخدم على حفظه.','feedback',request.taskId,request.comment);await insertItem(tx,ownerId,{title:'تفضيل صريح من التغذية الراجعة',content:request.comment,layer:'preference',evidenceIds:[manual,await taskEvidence(tx,ownerId,request.taskId)]});}
      await audit(tx,ownerId,id,'feedback',`تغذية راجعة من نوع ${request.kind}`);return {id,persistedPreference:request.kind==='preference'&&request.persistPreference};
    });
  }
  async function skillRow(ownerId:string,id:string,connection:Kysely<any>=db,lock=false){let query=connection.selectFrom('memory_skill_versions').selectAll().where('owner_id','=',ownerId).where('id','=',id);if(lock)query=query.forUpdate();const row=await query.executeTakeFirst();if(!row)throw new MemoryError('SKILL_NOT_FOUND','لم يُعثر على المهارة.',404);return row;}
  async function skillDto(row:any){const family=await db.selectFrom('memory_skill_families').select('active_skill_id').where('id','=',row.family_id).where('owner_id','=',row.owner_id).executeTakeFirstOrThrow();const evaluations=await db.selectFrom('memory_skill_evaluations').selectAll().where('skill_id','=',row.id).where('owner_id','=',row.owner_id).orderBy('created_at','desc').limit(12).execute();return SkillSchema.parse({id:row.id,familyId:row.family_id,version:row.version,revision:row.revision,name:row.name,description:row.description,manifest:row.manifest,manifestHash:row.manifest_hash,status:row.status,activeVersionId:family.active_skill_id,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),evidenceIds:row.evidence_ids,evaluations:evaluations.map(evaluation=>SkillEvaluationSchema.parse({...evaluation.result,id:evaluation.id,createdAt:iso(evaluation.created_at)}))});}
  async function createSkill(ownerId:string,input:unknown){
    const request=SkillCreateSchema.parse(input);checked(request.name);checked(request.description);checked(JSON.stringify(request.manifest));
    const row=await db.transaction().execute(async tx=>{await ownerLock(tx,ownerId);await evidence(ownerId,request.evidenceIds,tx);const total=await tx.selectFrom('memory_skill_versions').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).executeTakeFirstOrThrow();if(Number(total.n)>=100)throw new MemoryError('SKILL_LIMIT','بلغت حد مئة إصدار مهارة محفوظ.',409);
      const parent=request.parentSkillId?await skillRow(ownerId,request.parentSkillId,tx):null,familyId=parent?.family_id??randomUUID();
      if(!parent)await tx.insertInto('memory_skill_families').values({id:familyId,owner_id:ownerId,name:request.name,active_skill_id:null}).execute();
      const last=await tx.selectFrom('memory_skill_versions').select('version').where('family_id','=',familyId).orderBy('version','desc').executeTakeFirst();
      const evidenceIds=[...request.evidenceIds,await manualEvidence(tx,ownerId,`مصدر مرشح مهارة يدوي: ${request.name}`,'manual',null,JSON.stringify(request.manifest))];
      return tx.insertInto('memory_skill_versions').values({id:randomUUID(),family_id:familyId,owner_id:ownerId,version:(last?.version??0)+1,revision:1,name:request.name,description:request.description,manifest:JSON.stringify(request.manifest),manifest_hash:manifestHash(request.manifest),status:'candidate',evidence_ids:JSON.stringify(evidenceIds),created_at:now(),updated_at:now()}).returningAll().executeTakeFirstOrThrow();
    });return skillDto(row);
  }
  async function evaluateSkill(ownerId:string,id:string,input:unknown,kind:'sandbox'|'benchmark'){
    const request=SkillActionSchema.parse(input),initial=await skillRow(ownerId,id);if(initial.revision!==request.expectedRevision)throw new MemoryError('SKILL_VERSION_CONFLICT','تغير إصدار المهارة.',409);
    if(initial.status==='revoked'||initial.status==='active'||kind==='benchmark'&&!['sandbox_tested','benchmarked'].includes(initial.status))throw new MemoryError('SKILL_LIFECYCLE_DENIED','ابدأ باختبار المرشح، ثم قياسه قبل الموافقة.',409);
    const result=evaluateChecklist(initial.manifest,kind),evaluationId=randomUUID();
    const row=await db.transaction().execute(async tx=>{const current=await skillRow(ownerId,id,tx,true);if(current.revision!==request.expectedRevision||current.manifest_hash!==result.manifestHash)throw new MemoryError('SKILL_VERSION_CONFLICT','تغير إصدار المهارة أثناء القياس.',409);await tx.insertInto('memory_skill_evaluations').values({id:evaluationId,skill_id:id,owner_id:ownerId,kind,manifest_hash:result.manifestHash,result:JSON.stringify(result),created_at:now()}).execute();return tx.updateTable('memory_skill_versions').set({status:result.passed?(kind==='sandbox'?'sandbox_tested':'benchmarked'):current.status==='benchmarked'?'sandbox_tested':current.status,revision:current.revision+1,updated_at:now()}).where('id','=',id).returningAll().executeTakeFirstOrThrow();});return skillDto(row);
  }
  async function activateSkill(ownerId:string,id:string,input:unknown){
    const request=SkillActivationSchema.parse(input),initial=await skillRow(ownerId,id);
    const row=await db.transaction().execute(async tx=>{const family=await tx.selectFrom('memory_skill_families').selectAll().where('id','=',initial.family_id).where('owner_id','=',ownerId).forUpdate().executeTakeFirstOrThrow();const current=await skillRow(ownerId,id,tx,true);if(current.revision!==request.expectedRevision||current.status!=='benchmarked')throw new MemoryError('SKILL_LIFECYCLE_DENIED','لا تفعّل مهارة قبل اختبارها وقياس هذا الإصدار.',409);await evidence(ownerId,current.evidence_ids,tx);const evaluation=await tx.selectFrom('memory_skill_evaluations').selectAll().where('id','=',request.evaluationId).where('skill_id','=',id).where('owner_id','=',ownerId).where('kind','=','benchmark').executeTakeFirst();if(!evaluation||evaluation.manifest_hash!==current.manifest_hash||evaluation.result.passed!==true)throw new MemoryError('SKILL_EVALUATION_FAILED','لا يوجد قياس ناجح مستقل لهذا الإصدار.',409);
      if(family.active_skill_id&&family.active_skill_id!==id)await tx.updateTable('memory_skill_versions').set({status:'benchmarked',revision:sql`revision+1`,updated_at:now()}).where('id','=',family.active_skill_id).where('owner_id','=',ownerId).execute();
      await tx.updateTable('memory_skill_families').set({active_skill_id:id,revision:family.revision+1}).where('id','=',family.id).execute();const changed=await tx.updateTable('memory_skill_versions').set({status:'active',revision:current.revision+1,updated_at:now()}).where('id','=',id).returningAll().executeTakeFirstOrThrow();await audit(tx,ownerId,id,family.active_skill_id&&family.active_skill_id!==id?'skill_activate_or_rollback':'skill_activate',`موافقة صريحة مع قياس ${evaluation.id}`);return changed;});return skillDto(row);
  }
  async function revokeSkill(ownerId:string,id:string,input:unknown){const request=SkillRevokeSchema.parse(input);const row=await db.transaction().execute(async tx=>{const current=await skillRow(ownerId,id,tx,true);if(current.revision!==request.expectedRevision)throw new MemoryError('SKILL_VERSION_CONFLICT','تغير إصدار المهارة.',409);await tx.updateTable('memory_skill_families').set({active_skill_id:null,revision:sql`revision+1`}).where('id','=',current.family_id).where('active_skill_id','=',id).execute();await audit(tx,ownerId,id,'skill_revoke',request.reason);return tx.updateTable('memory_skill_versions').set({status:'revoked',revision:current.revision+1,updated_at:now()}).where('id','=',id).returningAll().executeTakeFirstOrThrow();});return skillDto(row);}
  async function runSkill(ownerId:string,id:string,input:unknown){const request=SkillRunSchema.parse(input),row=await skillRow(ownerId,id);const family=await db.selectFrom('memory_skill_families').select('active_skill_id').where('id','=',row.family_id).where('owner_id','=',ownerId).executeTakeFirstOrThrow();if(row.status!=='active'||family.active_skill_id!==id)throw new MemoryError('SKILL_NOT_ACTIVE','هذا الإصدار غير مفعّل.',409);await evidence(ownerId,row.evidence_ids);return {skillId:id,version:row.version,manifestHash:row.manifest_hash,...executeChecklist(row.manifest,request.input)};}
  async function metrics(ownerId:string){const counts=await db.selectFrom('tasks').select('status').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).where('status','in',['completed','failed','cancelled']).groupBy('status').execute();const usage=await sql<any>`SELECT COALESCE(SUM(m.input_tokens),0) AS input,COALESCE(SUM(m.output_tokens),0) AS output,COUNT(*) FILTER(WHERE m.usage_known=false) AS unknown FROM model_runs m JOIN tasks t ON t.id=m.task_id WHERE t.owner_id=${ownerId}`.execute(db);return {terminalTasks:counts.reduce((sum,row)=>sum+Number(row.n),0),completed:Number(counts.find(row=>row.status==='completed')?.n??0),failed:Number(counts.find(row=>row.status==='failed')?.n??0),knownInputTokens:Number(usage.rows[0]?.input??0),knownOutputTokens:Number(usage.rows[0]?.output??0),unknownUsageRuns:Number(usage.rows[0]?.unknown??0)};}
  async function workspace(ownerId:string){await sync(ownerId);const rows=await db.selectFrom('memory_items').selectAll().where('owner_id','=',ownerId).where('status','!=','superseded').orderBy('updated_at','desc').limit(100).execute();const skills=await db.selectFrom('memory_skill_versions').selectAll().where('owner_id','=',ownerId).orderBy('created_at','desc').limit(100).execute();const feedbackRows=await db.selectFrom('memory_feedback').selectAll().where('owner_id','=',ownerId).orderBy('created_at','desc').limit(50).execute();const expiredCount=await db.selectFrom('memory_items').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).where('status','=','active').where('expires_at','<=',now()).executeTakeFirstOrThrow();return {items:await provenance(rows),skills:await Promise.all(skills.map(skillDto)),feedback:feedbackRows.map(row=>({id:row.id,taskId:row.task_id,kind:row.kind,comment:row.comment,rating:row.rating,persistedPreference:row.persisted_preference,createdAt:iso(row.created_at)})),metrics:await metrics(ownerId),method:'lexical-v1' as const,expiredCount:Number(expiredCount.n)};}
  return {workspace,search,context,create,detail,correct,revoke,remove,sync,feedback,createSkill,evaluateSkill,activateSkill,revokeSkill,runSkill,metrics};
}
