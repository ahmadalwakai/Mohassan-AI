import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createDatabase, migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { studioRevision } from '@mohassan/studio';
import { StudioChangeResultSchema } from '@mohassan/contracts';
import type { StudioFileEdit } from '@mohassan/studio-ai';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createStudioControl } from '../apps/server/src/studio.js';
import { createStudioAiControl } from '../apps/server/src/studio-ai.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
describe('studio candidate validation, real Chromium evidence and atomic application',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>,directory='';
  const runtimes:Runtime[]=[];
  beforeAll(async()=>{store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);directory=await mkdtemp(join(tmpdir(),'mohassan-studio-candidate-'));});
  afterAll(async()=>{for(const runtime of runtimes)await runtime.stop();await store?.close();if(directory){const root=await realpath(tmpdir()),target=await realpath(directory),inside=relative(root,target);if(!inside.startsWith('mohassan-studio-candidate-')||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe candidate fixture cleanup');await rm(target,{recursive:true,force:true});}});
  async function setup(){
    const ownerId=randomUUID(),otherId=randomUUID();
    for(const id of [ownerId,otherId])await store.db.insertInto('user').values({id,name:'Candidate fixture',email:id+'@candidate.example.test'}).execute();
    const studio=await createStudioControl(store.db,{allowedRoots:[]}),session=await studio.demo(ownerId),preview=await studio.preview(ownerId,session.id),heading=preview.elements.find(element=>element.tag==='h1'&&element.editableText)!;
    const original=session.files.find(file=>file.path===heading.file)!;
    const changedText='عنوان مرئي للمقترح المتحقق منه';
    const content=original.content.replace(heading.text!,changedText);
    expect(content).not.toBe(original.content);
    const edits:StudioFileEdit[]=[{path:original.path,expectedHash:hash(original.content),content}];
    return {ownerId,otherId,studio,session,heading,edits,changedText};
  }
  async function pendingTask(fixture:Awaited<ReturnType<typeof setup>>){
    const runtime=new Runtime(store.db,{studioChange:async()=>{throw new Error('This validation fixture never requests a model');},verifyStudioChange:async()=>null});runtimes.push(runtime);
    return runtime.createTask(fixture.ownerId,{title:'مرجع مراجعة بصرية',goal:'تحقق من نسخة المراجعة دون تطبيقها على المصدر.',capabilityId:'studio.change',autonomy:'scoped',studioInput:{sessionId:fixture.session.id,revision:fixture.session.revision}},randomUUID());
  }
  async function readyProposal(){
    const fixture=await setup();let modelCalls=0;
    const ai=await createStudioAiControl(store.db,{dataDir:join(directory,fixture.ownerId),model:'candidate-test-model',studio:fixture.studio,validateCandidate:fixture.studio.validateCandidate,applyCandidate:fixture.studio.applyCandidate,generate:async()=>{modelCalls++;return {text:JSON.stringify({summary:'مقترح fixture؛ لا طلب شبكة أو نموذج مدفوع.',edits:fixture.edits.map(({path,content})=>({path,content}))}),model:'candidate-test-model',usage:{inputTokens:44,outputTokens:12}};}});
    const runtime=new Runtime(store.db,{studioChange:ai.execute,verifyStudioChange:ai.verify});runtimes.push(runtime);
    const task=await runtime.createTask(fixture.ownerId,{title:'تعديل مرئي في نسخة Git',goal:'غيّر عنوان الصفحة داخل نسخة المراجعة مع دليل بصري.',capabilityId:'studio.change',autonomy:'scoped',studioInput:{sessionId:fixture.session.id,revision:fixture.session.revision}},randomUUID());
    expect(task.status).toBe('waiting_approval');expect(modelCalls).toBe(0);
    await runtime.approve(fixture.ownerId,task.id);await runtime.tick();
    const detail=await runtime.detail(fixture.ownerId,task.id);expect(detail.task.status).toBe('completed');
    const result=StudioChangeResultSchema.parse(detail.task.result);expect(result.outcome).toBe('ready_for_review');
    const stored=await ai.proposal(fixture.ownerId,result.proposalId);
    const input={revision:fixture.session.revision,candidateSnapshot:stored.payload.candidateSnapshot,artifact:stored.payload.artifact,proposalId:result.proposalId};
    return {...fixture,ai,runtime,task,result,stored,input,modelCalls:()=>modelCalls};
  }

  it('captures two actual PNGs with SQL hashes and pixel measurements while leaving session files untouched',async()=>{
    const fixture=await setup(),task=await pendingTask(fixture);
    const result=await fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{revision:fixture.session.revision,edits:fixture.edits},{taskId:task.id,signal:AbortSignal.timeout(30000)});
    expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(fixture.session);
    expect(result.candidateSnapshot.files.find(file=>file.path===fixture.edits[0]!.path)?.content).toContain(fixture.changedText);
    expect(result.verification).toMatchObject({passed:true,provider:'static-sanitizer+chromium',sourceHash:studioRevision(result.candidateSnapshot)});
    expect(result.visualDiff!.changedPixels).toBeGreaterThan(0);expect(result.visualDiff!.totalPixels).toBe(1024*768);expect(result.visualDiff!.ratio).toBeCloseTo(result.visualDiff!.changedPixels/result.visualDiff!.totalPixels,10);
    for(const image of [result.baselineScreenshot!,result.candidateScreenshot!]){
      const bytes=await fixture.studio.reviews.image(fixture.ownerId,image.id),row=await store.db.selectFrom('studio_review_images').selectAll().where('id','=',image.id).executeTakeFirstOrThrow();
      expect(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);expect(hash(bytes)).toBe(image.hash);expect(row.content_hash).toBe(image.hash);expect(row.owner_id).toBe(fixture.ownerId);expect(row.session_id).toBe(fixture.session.id);expect(row.task_id).toBe(task.id);expect(row.width).toBe(1024);expect(row.height).toBe(768);
      await expect(fixture.studio.reviews.image(fixture.otherId,image.id)).rejects.toMatchObject({code:'STUDIO_REVIEW_NOT_FOUND',statusCode:404});
    }
    expect(result.baselineScreenshot!.hash).not.toBe(result.candidateScreenshot!.hash);
  });

  it('rejects owner, revision, file-hash, duplicate, empty and aborted candidates before recording screenshots',async()=>{
    const fixture=await setup(),task=await pendingTask(fixture),context={taskId:task.id,signal:AbortSignal.timeout(30000)},input={revision:fixture.session.revision,edits:fixture.edits};
    await expect(fixture.studio.validateCandidate(fixture.otherId,fixture.session.id,input,context)).rejects.toMatchObject({code:'STUDIO_NOT_FOUND'});
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{...input,revision:'0'.repeat(64)},context)).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT'});
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{...input,edits:[{...fixture.edits[0]!,expectedHash:'0'.repeat(64)}]},context)).rejects.toMatchObject({code:'STUDIO_CANDIDATE_SCOPE'});
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{...input,edits:[...fixture.edits,...fixture.edits]},context)).rejects.toMatchObject({code:'STUDIO_CANDIDATE_INVALID'});
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{...input,edits:[{...fixture.edits[0]!,path:'../outside.html'}]},context)).rejects.toMatchObject({code:'STUDIO_CANDIDATE_SCOPE'});
    const file=fixture.session.files.find(item=>item.path===fixture.edits[0]!.path)!;
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,{...input,edits:[{...fixture.edits[0]!,content:file.content}]},context)).rejects.toMatchObject({code:'STUDIO_CANDIDATE_EMPTY'});
    await expect(fixture.studio.validateCandidate(fixture.ownerId,fixture.session.id,input,{taskId:task.id,signal:AbortSignal.abort()})).rejects.toMatchObject({name:'AbortError'});
    expect(await store.db.selectFrom('studio_review_images').select('id').where('session_id','=',fixture.session.id).execute()).toEqual([]);
    expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(fixture.session);
  });

  it('atomically applies one verified proposal once, retains baseline, and undo does not replay an old application',async()=>{
    const fixture=await readyProposal();expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(fixture.session);
    const [first,second]=await Promise.all([fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input),fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input)]);
    expect(first).toEqual(second);expect(first.applied).toBe(true);
    const applied=await fixture.studio.detail(fixture.ownerId,fixture.session.id);expect(applied.revision).toBe(first.revision);expect(applied.historyCount).toBe(1);expect(applied.baseFiles).toEqual(fixture.session.files);expect(applied.files.find(file=>file.path===fixture.edits[0]!.path)?.content).toContain(fixture.changedText);
    const proposal=await store.db.selectFrom('studio_ai_proposals').selectAll().where('id','=',fixture.result.proposalId).executeTakeFirstOrThrow();expect(proposal.status).toBe('applied');expect(proposal.applied_revision).toBe(applied.revision);
    const undo=await fixture.studio.undo(fixture.ownerId,applied.id,{revision:applied.revision});expect(undo.files).toEqual(fixture.session.files);expect(undo.historyCount).toBe(0);expect(undo.revision).not.toBe(fixture.session.revision);
    expect(await fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input)).toEqual(first);expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(undo);expect(fixture.modelCalls()).toBe(1);
    expect((await fixture.runtime.detail(fixture.ownerId,fixture.task.id)).modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:44,outputTokens:12,resultCommitted:true});
  });

  it('rejects another owner, malformed snapshot, changed candidate/artifact and cancelled task without writes',async()=>{
    const fixture=await readyProposal();
    await expect(fixture.studio.applyCandidate(fixture.otherId,fixture.session.id,fixture.input)).rejects.toMatchObject({code:'STUDIO_NOT_FOUND'});
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,{...fixture.input,candidateSnapshot:{...fixture.input.candidateSnapshot,entryPath:'../outside.html'}})).rejects.toBeInstanceOf(Error);
    const modified={...fixture.input.candidateSnapshot,files:fixture.input.candidateSnapshot.files.map(file=>({...file,content:file.path===fixture.edits[0]!.path?file.content.replace(fixture.changedText,'تغيير لم يخضع للمراجعة'):file.content}))};
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,{...fixture.input,candidateSnapshot:modified})).rejects.toMatchObject({code:'STUDIO_PROPOSAL_CHANGED'});
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,{...fixture.input,artifact:{sourceHash:'0'.repeat(64)}})).rejects.toMatchObject({code:'STUDIO_PROPOSAL_CHANGED'});
    await store.db.updateTable('tasks').set({cancellation_requested:true}).where('id','=',fixture.task.id).execute();
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input)).rejects.toMatchObject({code:'STUDIO_APPLY_DENIED'});
    expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(fixture.session);
    expect((await store.db.selectFrom('studio_ai_proposals').select('status').where('id','=',fixture.result.proposalId).executeTakeFirstOrThrow()).status).toBe('ready');
  });

  it('refuses a previously verified proposal after a direct edit changes the revision, including undo ABA',async()=>{
    const fixture=await readyProposal();
    const direct=await fixture.studio.edit(fixture.ownerId,fixture.session.id,{revision:fixture.session.revision,elementId:fixture.heading.id,text:'تعديل مباشر أحدث'});
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input)).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT'});
    const restored=await fixture.studio.undo(fixture.ownerId,fixture.session.id,{revision:direct.revision});expect(restored.files).toEqual(fixture.session.files);expect(restored.revision).not.toBe(fixture.session.revision);
    await expect(fixture.studio.applyCandidate(fixture.ownerId,fixture.session.id,fixture.input)).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT'});
    expect(await fixture.studio.detail(fixture.ownerId,fixture.session.id)).toEqual(restored);
    const imageId=fixture.result.candidateImageId!;await store.db.updateTable('studio_review_images').set({data_base64:Buffer.from('tampered image').toString('base64')}).where('id','=',imageId).execute();
    await expect(fixture.studio.reviews.image(fixture.ownerId,imageId)).rejects.toMatchObject({code:'STUDIO_REVIEW_CHANGED'});
  });
});
