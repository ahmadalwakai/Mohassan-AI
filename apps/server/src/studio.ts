import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { StudioCreateSchema, StudioEditSchema, StudioSessionSchema, StudioSessionSummarySchema, StudioSnapshotSchema, type StudioPreview } from '@mohassan/contracts';
import { applyStudioEdit, createStudioDemo, inspectStaticProject, renderStudio, studioRevision, StudioError } from '@mohassan/studio';
import { applyReactStudioEdit, buildReactStudio, checkReactSnapshot, createReactDemo, inspectReactProject, reactSourceHash, renderReactStudioArtifact, type ReactStudioArtifact, type ReactStudioSnapshot } from '@mohassan/studio-react';
import { WindowsAppContainerSandbox } from '@mohassan/sandbox';
import type { SandboxRunner } from '@mohassan/coding';
import { editableStudioPath, studioCanonicalJson, studioManifestHash, type StudioCandidateValidation, type StudioFileEdit, type StudioAiSnapshot, type StudioProposalManifest } from '@mohassan/studio-ai';
import { createStudioVisualControl } from './studio-visual.js';

type Snapshot = z.infer<typeof StudioSnapshotSchema>;
type Session = z.infer<typeof StudioSessionSchema>;
const UndoSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const maximumSessions = 20, maximumHistory = 20;
function isReact(snapshot: Snapshot): snapshot is ReactStudioSnapshot {return snapshot.framework === 'react' || snapshot.framework === 'next';}
function sourceHash(snapshot: Snapshot) {return isReact(snapshot) ? reactSourceHash(snapshot) : studioRevision(snapshot);}
function nextRevision(snapshot: Snapshot): string {return createHash('sha256').update(JSON.stringify([sourceHash(snapshot), randomUUID()])).digest('hex');}
function readSnapshot(value: unknown): Snapshot {return StudioSnapshotSchema.parse(value);}
function historyOf(row: any): Snapshot[] {return z.array(StudioSnapshotSchema).max(maximumHistory).parse(row.undo_history);}
function sessionDto(row: any): Session {
  const current = readSnapshot(row.current_snapshot), original = readSnapshot(row.base_snapshot);
  return StudioSessionSchema.parse({id:row.id,name:row.name,sourcePath:row.source_path,revision:row.revision,framework:current.framework??'static',entryPath:current.entryPath,files:current.files,baseFiles:original.files,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),historyCount:historyOf(row).length});
}

export async function createStudioControl(db: Kysely<any>, config: {allowedRoots:string[];sandbox?:SandboxRunner;buildReact?:typeof buildReactStudio;buildNext?:(snapshot:ReactStudioSnapshot,signal?:AbortSignal)=>Promise<ReactStudioArtifact>}) {
  const sandbox = config.sandbox ?? new WindowsAppContainerSandbox(), build = config.buildReact ?? buildReactStudio;
  const reviews=await createStudioVisualControl(db);
  async function rowFor(ownerId:string,id:string,connection:Kysely<any>=db,lock=false) {
    let query=connection.selectFrom('studio_sessions').selectAll().where('id','=',id).where('owner_id','=',ownerId);
    if(lock)query=query.forUpdate();
    const row=await query.executeTakeFirst();
    if(!row)throw new StudioError('STUDIO_NOT_FOUND','لم يُعثر على جلسة الاستوديو.',404);
    return row;
  }
  async function artifactFor(snapshot:Snapshot,id:string,connection:Kysely<any>=db):Promise<ReactStudioArtifact|null> {
    if(!isReact(snapshot))return null;
    const row=await connection.selectFrom('studio_builds').select('artifact').where('session_id','=',id).where('source_hash','=',sourceHash(snapshot)).executeTakeFirst();
    if(!row)throw new StudioError('STUDIO_BUILD_MISSING','تعذر العثور على المعاينة المحفوظة لهذا الإصدار.',503);
    const artifact=row.artifact as ReactStudioArtifact;
    if(artifact.sourceHash!==sourceHash(snapshot)||artifact.verification?.sourceHash!==sourceHash(snapshot))throw new StudioError('STUDIO_BUILD_MISMATCH','لا تطابق المعاينة المحفوظة إصدار المصدر.',409);
    return artifact;
  }
  function render(snapshot:Snapshot,artifact:ReactStudioArtifact|null,nonce:string,revision:string):Omit<StudioPreview,'nonce'|'revision'> {
    if(isReact(snapshot)){
      checkReactSnapshot(snapshot);
      if(!artifact||artifact.sourceHash!==sourceHash(snapshot))throw new StudioError('STUDIO_BUILD_MISMATCH','لا تطابق المعاينة إصدار المصدر.',409);
      return renderReactStudioArtifact(artifact,nonce,revision);
    }
    return renderStudio(snapshot,nonce,revision);
  }
  async function prepare(snapshot:Snapshot,ownerId:string,sessionId?:string,signal?:AbortSignal):Promise<ReactStudioArtifact|null> {
    signal?.throwIfAborted();
    if(!isReact(snapshot)){renderStudio(snapshot,randomUUID());return null;}
    checkReactSnapshot(snapshot);
    if(sessionId){
      const cached=await db.selectFrom('studio_builds').select('artifact').where('session_id','=',sessionId).where('source_hash','=',sourceHash(snapshot)).executeTakeFirst();
      if(cached){const artifact=cached.artifact as ReactStudioArtifact;render(snapshot,artifact,randomUUID(),sourceHash(snapshot));return artifact;}
    }
    const resource=createHash('sha256').update(`studio:${ownerId}`).digest('hex'),token=randomUUID();
    const claimed=await sql<{token:string}>`INSERT INTO studio_build_locks(resource_key,token,expires_at) VALUES(${resource},${token},CURRENT_TIMESTAMP+interval '360 seconds') ON CONFLICT(resource_key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE studio_build_locks.expires_at<CURRENT_TIMESTAMP RETURNING token`.execute(db);
    if(claimed.rows[0]?.token!==token)throw new StudioError('STUDIO_BUILD_BUSY','تجري معاينة معزولة أخرى. انتظر اكتمالها ثم أعد المحاولة.',409);
    try {
      const artifact=snapshot.framework==='next'&&config.buildNext?await config.buildNext(snapshot,signal):await build(snapshot,sandbox);
      signal?.throwIfAborted();
      if(artifact.sourceHash!==sourceHash(snapshot)||artifact.verification.sourceHash!==sourceHash(snapshot))throw new StudioError('STUDIO_BUILD_MISMATCH','رفضت نتيجة معاينة لا تطابق المصدر.',409);
      render(snapshot,artifact,randomUUID(),sourceHash(snapshot));
      const lock=await db.selectFrom('studio_build_locks').select('token').where('resource_key','=',resource).where('token','=',token).where('expires_at','>',sql`CURRENT_TIMESTAMP`).executeTakeFirst();
      if(!lock)throw new StudioError('STUDIO_BUILD_EXPIRED','انتهت مهلة اعتماد المعاينة؛ لم يُحفظ التعديل.',409);
      return artifact;
    } finally {await db.deleteFrom('studio_build_locks').where('resource_key','=',resource).where('token','=',token).execute();}
  }
  async function retain(connection:Kysely<any>,id:string,artifact:ReactStudioArtifact|null) {
    if(artifact)await connection.insertInto('studio_builds').values({session_id:id,source_hash:artifact.sourceHash,artifact:JSON.stringify(artifact)}).onConflict(conflict=>conflict.columns(['session_id','source_hash']).doNothing()).execute();
  }
  async function prune(connection:Kysely<any>,id:string,snapshots:Snapshot[]) {
    const hashes=[...new Set(snapshots.filter(isReact).map(sourceHash))];
    let query=connection.deleteFrom('studio_builds').where('session_id','=',id);
    if(hashes.length)query=query.where('source_hash','not in',hashes);
    await query.execute();
  }
  async function workspace(ownerId:string) {
    const rows=await db.selectFrom('studio_sessions').select(['id','name','source_path','revision','created_at','updated_at',sql<string>`current_snapshot ->> 'entryPath'`.as('entry_path'),sql<string>`COALESCE(current_snapshot ->> 'framework','static')`.as('framework'),sql<number>`jsonb_array_length(undo_history)`.as('history_count')]).where('owner_id','=',ownerId).orderBy('updated_at','desc').orderBy('id','asc').limit(maximumSessions).execute();
    return {sessions:rows.map(row=>StudioSessionSummarySchema.parse({id:row.id,name:row.name,sourcePath:row.source_path,revision:row.revision,framework:row.framework,entryPath:row.entry_path,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),historyCount:Number(row.history_count)}))};
  }
  async function saveNew(ownerId:string,name:string,sourcePath:string|null,snapshot:Snapshot,demo=false):Promise<Session> {
    const current=readSnapshot(snapshot);
    if(!await db.selectFrom('user').select('id').where('id','=',ownerId).executeTakeFirst())throw new StudioError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);
    if(demo){const existing=await db.selectFrom('studio_sessions').selectAll().where('owner_id','=',ownerId).where('source_path','is',null).where('name','=',name).executeTakeFirst();if(existing)return sessionDto(existing);}
    const artifact=await prepare(current,ownerId);
    return db.transaction().execute(async transaction=>{
      const user=await transaction.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst();
      if(!user)throw new StudioError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);
      if(demo){const existing=await transaction.selectFrom('studio_sessions').selectAll().where('owner_id','=',ownerId).where('source_path','is',null).where('name','=',name).executeTakeFirst();if(existing)return sessionDto(existing);}
      const count=await transaction.selectFrom('studio_sessions').select(eb=>eb.fn.countAll<number>().as('count')).where('owner_id','=',ownerId).executeTakeFirstOrThrow();
      if(Number(count.count)>=maximumSessions)throw new StudioError('STUDIO_SESSION_LIMIT','وصل الاستوديو إلى حد عشرين جلسة محفوظة.',409);
      const encoded=JSON.stringify(current);
      const row=await transaction.insertInto('studio_sessions').values({id:randomUUID(),owner_id:ownerId,name,source_path:sourcePath,revision:nextRevision(current),base_snapshot:encoded,current_snapshot:encoded,undo_history:'[]'}).returningAll().executeTakeFirstOrThrow();
      await retain(transaction,row.id,artifact);
      return sessionDto(row);
    });
  }
  async function create(ownerId:string,input:unknown):Promise<Session> {
    const request=StudioCreateSchema.parse(input),framework=request.framework;
    const entryPath=request.entryPath??(framework==='next'?'app/page.tsx':framework==='react'?'src/App.tsx':'index.html');
    const snapshot=framework==='static'?await inspectStaticProject(request.path,entryPath,config.allowedRoots):await inspectReactProject(request.path,entryPath,config.allowedRoots,framework);
    return saveNew(ownerId,request.name,resolve(request.path),snapshot);
  }
  async function demo(ownerId:string,framework:'static'|'react'|'next'='static'):Promise<Session> {
    if(!['static','react','next'].includes(framework))throw new StudioError('INVALID_STUDIO_FRAMEWORK','نوع المشروع غير مدعوم.');
    const snapshot=framework==='static'?createStudioDemo():createReactDemo(framework);
    const name=framework==='static'?'مشروع الاستوديو التجريبي':framework==='react'?'مشروع React التجريبي':'صفحة Next التجريبية';
    return saveNew(ownerId,name,null,snapshot,true);
  }
  async function detail(ownerId:string,id:string):Promise<Session> {return sessionDto(await rowFor(ownerId,id));}
  async function preview(ownerId:string,id:string,baseline=false):Promise<StudioPreview> {
    const row=await rowFor(ownerId,id),snapshot=readSnapshot(baseline?row.base_snapshot:row.current_snapshot),nonce=randomUUID();
    return {revision:row.revision as string,nonce,...render(snapshot,await artifactFor(snapshot,id),nonce,row.revision)};
  }
  async function edit(ownerId:string,id:string,input:unknown):Promise<Session> {
    const request=StudioEditSchema.parse(input),initial=await rowFor(ownerId,id);
    if(request.revision!==initial.revision)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو؛ أعد تحميلها قبل حفظ التعديل.',409);
    const current=readSnapshot(initial.current_snapshot),edit={elementId:request.elementId,...(request.text!==undefined?{text:request.text}:{}),...(request.styles!==undefined?{styles:request.styles}:{})};
    let changed:Snapshot;
    if(isReact(current)){
      const rendered=render(current,await artifactFor(current,id),randomUUID(),initial.revision);
      const selected=rendered.elements.find(element=>element.id===request.elementId);
      if(!selected)throw new StudioError('STUDIO_ELEMENT_NOT_FOUND','العنصر غير متاح للربط الدقيق بالمصدر.',409);
      if(request.text!==undefined&&!selected.editableText||request.styles!==undefined&&selected.editableStyles===false)throw new StudioError('STUDIO_DYNAMIC_ELEMENT','لا يمكن تعديل هذه الخاصية الديناميكية بصريًا بأمان.');
      changed=applyReactStudioEdit(current,edit);
    }else changed=applyStudioEdit(current,edit);
    if(sourceHash(changed)===sourceHash(current))return sessionDto(initial);
    // Never hold a SQL transaction while compiling or executing project code.
    // Failed builds preserve the source revision and last successful preview.
    const artifact=await prepare(changed,ownerId,id);
    return db.transaction().execute(async transaction=>{
      const row=await rowFor(ownerId,id,transaction,true);
      if(request.revision!==row.revision)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو أثناء المعاينة؛ لم يُحفظ التعديل.',409);
      const history=[...historyOf(row),current].slice(-maximumHistory);
      const updated=await transaction.updateTable('studio_sessions').set({current_snapshot:JSON.stringify(changed),undo_history:JSON.stringify(history),revision:nextRevision(changed),updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).where('revision','=',request.revision).returningAll().executeTakeFirst();
      if(!updated)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو؛ أعد تحميلها قبل حفظ التعديل.',409);
      await retain(transaction,id,artifact);await prune(transaction,id,[readSnapshot(row.base_snapshot),changed,...history]);
      return sessionDto(updated);
    });
  }
  async function undo(ownerId:string,id:string,input:unknown):Promise<Session> {
    const request=UndoSchema.parse(input);
    return db.transaction().execute(async transaction=>{
      const row=await rowFor(ownerId,id,transaction,true);
      if(request.revision!==row.revision)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو؛ أعد تحميلها قبل التراجع.',409);
      const history=historyOf(row),previous=history.pop();
      if(!previous)throw new StudioError('STUDIO_NOTHING_TO_UNDO','لا يوجد تعديل محفوظ للتراجع عنه.',409);
      render(previous,await artifactFor(previous,id,transaction),randomUUID(),row.revision);
      const updated=await transaction.updateTable('studio_sessions').set({current_snapshot:JSON.stringify(previous),undo_history:JSON.stringify(history),revision:nextRevision(previous),updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).where('revision','=',request.revision).returningAll().executeTakeFirst();
      if(!updated)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو؛ أعد تحميلها قبل التراجع.',409);
      await prune(transaction,id,[readSnapshot(row.base_snapshot),previous,...history]);
      return sessionDto(updated);
    });
  }
  async function validateCandidate(ownerId:string,id:string,input:{revision:string;edits:StudioFileEdit[]},context:{taskId:string;signal:AbortSignal}):Promise<StudioCandidateValidation>{
    context.signal.throwIfAborted();
    const row=await rowFor(ownerId,id);
    if(row.revision!==input.revision)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو قبل مراجعة المقترح.',409);
    if(!input.edits.length||input.edits.length>5||new Set(input.edits.map(edit=>edit.path)).size!==input.edits.length)throw new StudioError('STUDIO_CANDIDATE_INVALID','قائمة التعديلات غير صالحة.');
    const current=readSnapshot(row.current_snapshot),edits=new Map(input.edits.map(edit=>[edit.path,edit]));
    for(const edit of input.edits){
      const original=current.files.find(file=>file.path===edit.path);
      if(!original||!editableStudioPath(edit.path)||createHash('sha256').update(original.content).digest('hex')!==edit.expectedHash)throw new StudioError('STUDIO_CANDIDATE_SCOPE','لا يطابق التعديل ملفًا مصرحًا من الإصدار الحالي.',409);
    }
    const changed=readSnapshot({...current,files:current.files.map(file=>edits.has(file.path)?{path:file.path,content:edits.get(file.path)!.content}:file)});
    if(sourceHash(changed)===sourceHash(current))throw new StudioError('STUDIO_CANDIDATE_EMPTY','لا يتضمن المقترح تغييرًا.');
    const artifact=await prepare(changed,ownerId,id,context.signal);
    const baseline=render(current,await artifactFor(current,id),randomUUID(),input.revision),candidate=render(changed,artifact,randomUUID(),sourceHash(changed));
    const images=await reviews.compare(ownerId,id,context.taskId,{document:baseline.document,sourceHash:sourceHash(current)},{document:candidate.document,sourceHash:sourceHash(changed)},context.signal);
    const latest=await rowFor(ownerId,id);
    if(latest.revision!==input.revision)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت النسخة أثناء مراجعة المقترح؛ لم يُحفظ التعديل.',409);
    return {candidateSnapshot:changed,artifact,verification:{passed:true,provider:artifact?.verification.provider??'static-sanitizer+chromium',sourceHash:sourceHash(changed),baselineHash:sourceHash(current)},...images};
  }
  async function applyCandidate(ownerId:string,id:string,input:{revision:string;files?:{path:string;content:string}[];candidateSnapshot:StudioAiSnapshot;artifact:unknown;proposalId:string}){
    const changed=readSnapshot(input.candidateSnapshot),artifact=input.artifact as ReactStudioArtifact|null;
    render(changed,artifact,randomUUID(),sourceHash(changed));
    return db.transaction().execute(async transaction=>{
      const row=await rowFor(ownerId,id,transaction,true);
      const proposal=await transaction.selectFrom('studio_ai_proposals').selectAll().where('id','=',input.proposalId).where('owner_id','=',ownerId).where('session_id','=',id).forUpdate().executeTakeFirst();
      if(!proposal||!proposal.payload)throw new StudioError('STUDIO_PROPOSAL_NOT_FOUND','لم يُعثر على مقترح قابل للتطبيق.',404);
      const payload=proposal.payload as StudioProposalManifest;
      if(studioManifestHash(payload)!==proposal.payload_hash||payload.ownerId!==ownerId||payload.sessionId!==id||payload.result.proposalId!==input.proposalId||payload.baseRevision!==input.revision||studioCanonicalJson(payload.candidateSnapshot)!==studioCanonicalJson(changed)||studioCanonicalJson(payload.artifact)!==studioCanonicalJson(artifact))throw new StudioError('STUDIO_PROPOSAL_CHANGED','لا يطابق التعديل إيصال المراجعة المحفوظ.',409);
      if(proposal.status==='applied')return {applied:true,revision:proposal.applied_revision,sessionId:id};
      if(proposal.status!=='ready'||proposal.base_revision!==input.revision||row.revision!==input.revision||sourceHash(readSnapshot(row.current_snapshot))!==sourceHash(readSnapshot(payload.baseline)))throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت نسخة الاستوديو؛ أنشئ مقترحًا جديدًا.',409);
      const task=await transaction.selectFrom('tasks').select(['status','cancellation_requested','result']).where('id','=',proposal.task_id).where('owner_id','=',ownerId).forUpdate().executeTakeFirst();
      if(!task||task.status!=='completed'||task.cancellation_requested||task.result?.proposalId!==input.proposalId||task.result?.diffHash!==payload.result.diffHash||payload.result.outcome!=='ready_for_review'||!payload.validation.verification.passed||payload.validation.verification.sourceHash!==sourceHash(changed))throw new StudioError('STUDIO_APPLY_DENIED','يلزم مقترح مكتمل ومتحقق منه قبل التطبيق.',409);
      const current=readSnapshot(row.current_snapshot),history=[...historyOf(row),current].slice(-maximumHistory),revision=nextRevision(changed);
      const applied=await transaction.updateTable('studio_ai_proposals').set({status:'applied',applied_revision:revision,applied_at:sql`CURRENT_TIMESTAMP`,updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',input.proposalId).where('status','=','ready').where('payload_hash','=',proposal.payload_hash).returning('id').executeTakeFirst();
      if(!applied)throw new StudioError('STUDIO_REVISION_CONFLICT','تغيرت حالة المقترح قبل التطبيق.',409);
      await transaction.updateTable('studio_sessions').set({current_snapshot:JSON.stringify(changed),undo_history:JSON.stringify(history),revision,updated_at:sql`CURRENT_TIMESTAMP`}).where('id','=',id).where('owner_id','=',ownerId).where('revision','=',input.revision).executeTakeFirstOrThrow();
      await retain(transaction,id,artifact);await prune(transaction,id,[readSnapshot(row.base_snapshot),changed,...history]);
      return {applied:true,revision,sessionId:id};
    });
  }
  return {workspace,create,demo,detail,preview,edit,undo,validateCandidate,applyCandidate,reviews};
}
