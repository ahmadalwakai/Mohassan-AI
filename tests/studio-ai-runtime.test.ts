import { randomUUID,createHash } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createDatabase,migrate } from '@mohassan/database';
import { Runtime,type RuntimeOptions } from '@mohassan/runtime';
import type { StudioChangeResult } from '@mohassan/contracts';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex'),sessionId=randomUUID(),revision='a'.repeat(64);
const input={title:'تعديل بصري محدد',goal:'عدّل عنوان الصفحة ولون النص مع الحفاظ على المصدر.',capabilityId:'studio.change' as const,autonomy:'scoped' as const,studioInput:{sessionId,revision}};
function fixture():StudioChangeResult{const diff='diff --git a/index.html b/index.html\n-before\n+after\n';return {kind:'studio_change',summary:'مقترح تجريبي لاختبار محرك المهام فقط.',sessionId,proposalId:randomUUID(),baseRevision:revision,diff,diffHash:digest(diff),branch:'codex/studio/fixture',checkpoint:'b'.repeat(40),changes:[{path:'index.html',beforeHash:digest('before'),afterHash:digest('after')}],review:{passed:true,checks:[{id:'fixture',passed:true,message:'تحقق fixture مستقل لمحرك المهام.'}]},outcome:'ready_for_review',verification:{passed:true,provider:'unit-fixture',sourceHash:digest('after')},baselineImageId:randomUUID(),candidateImageId:randomUUID(),visualDiff:{changedPixels:1,totalPixels:10,ratio:0.1},model:'fixture-model',usage:{inputTokens:31,outputTokens:9},applied:false,verifiedAt:new Date().toISOString()};}
describe('studio tasks use shared grants, paid receipts and lease fencing',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>;
  beforeEach(async()=>{store=await createDatabase();await migrate(store.db);await store.db.insertInto('studio_sessions').values({id:sessionId,owner_id:'owner',name:'fixture',source_path:null,revision,base_snapshot:'{"entryPath":"index.html","files":[{"path":"index.html","content":"<p>before</p>"}]}',current_snapshot:'{"entryPath":"index.html","files":[{"path":"index.html","content":"<p>before</p>"}]}',undo_history:'[]'}).execute();});
  afterEach(async()=>{await store.close();});
  const options=(studioChange:RuntimeOptions['studioChange']):RuntimeOptions=>({studioChange,verifyStudioChange:async raw=>raw as StudioChangeResult});
  it('requires approval even scoped, binds the source revision and commits only a review proposal',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async(_goal,context)=>{calls++;await context.onProgress?.('edits_requested','fixture');await context.onModelReceipt?.({model:'fixture-model',usage:{inputTokens:31,outputTokens:9}});return fixture();}));
    const task=await runtime.createTask('owner',input,'studio-scoped-request');expect(task.status).toBe('waiting_approval');await runtime.tick();expect(calls).toBe(0);await runtime.approve('owner',task.id);await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('completed');expect(detail.task.studioInput).toEqual(input.studioInput);expect(detail.task.result?.applied).toBe(false);expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:31,outputTokens:9,resultCommitted:true});
    expect((await store.db.selectFrom('approvals').select('scope').executeTakeFirstOrThrow()).scope).toBe('studio:change');expect((await store.db.selectFrom('studio_sessions').select('revision').executeTakeFirstOrThrow()).revision).toBe(revision);
  });
  it('denies foreign/stale sessions and includes the whole studio input in idempotency',async()=>{
    const runtime=new Runtime(store.db,options(async()=>fixture()));await expect(runtime.createTask('foreign',input,'foreign-studio-key')).rejects.toMatchObject({code:'STUDIO_NOT_FOUND'});await expect(runtime.createTask('owner',{...input,studioInput:{sessionId,revision:'c'.repeat(64)}},'stale-studio-key')).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT'});await runtime.createTask('owner',input,'same-studio-key');await expect(runtime.createTask('owner',{...input,studioInput:{...input.studioInput,elementId:'n1'}},'same-studio-key')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('shadow calls neither model nor renderer and consumes no paid receipt',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async()=>{calls++;return fixture();}));const task=await runtime.createTask('owner',{...input,autonomy:'shadow'},'studio-shadow-key');await runtime.tick();const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('completed');expect(detail.task.result).toMatchObject({kind:'shadow',capabilityId:'studio.change',executed:false});expect(detail.modelRuns).toEqual([]);expect(calls).toBe(0);
  });
  it('preserves immediate usage after a later render failure and never retries automatically',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async(_goal,context)=>{calls++;await context.onProgress?.('edits_requested','fixture');await context.onModelReceipt?.({model:'fixture-model',usage:{inputTokens:31,outputTokens:9}});throw new Error('private error text must not persist');}));const task=await runtime.createTask('owner',input,'studio-failed-key');await runtime.approve('owner',task.id);await runtime.tick();await runtime.tick();const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('waiting_approval');expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:31,outputTokens:9,status:'failed',resultCommitted:false});expect(JSON.stringify(detail)).not.toContain('private error');expect(calls).toBe(1);
  });
  it('rejects forged review hashes and does not mark failed visual review completed',async()=>{
    const runtime=new Runtime(store.db,options(async()=>({...fixture(),diffHash:'0'.repeat(64)})));const task=await runtime.createTask('owner',input,'studio-forged-key');await runtime.approve('owner',task.id);await runtime.tick();expect((await runtime.detail('owner',task.id)).task.status).toBe('failed');
    const failed=new Runtime(store.db,options(async()=>({...fixture(),outcome:'review_failed',checkpoint:null,review:{passed:false,checks:[{id:'visual',passed:false,message:'failed unit visual fixture'}]}})));const second=await failed.createTask('owner',input,'studio-review-failed');await failed.approve('owner',second.id);await failed.tick();const detail=await failed.detail('owner',second.id);expect(detail.task.status).toBe('failed');expect(detail.task.result?.diff).toContain('diff --git');
  });
});
