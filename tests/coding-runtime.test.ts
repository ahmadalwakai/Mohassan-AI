import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { randomUUID,createHash } from 'node:crypto';
import { createDatabase,migrate,type DatabaseHandle } from '@mohassan/database';
import { Runtime,type RuntimeOptions } from '@mohassan/runtime';
import type { CodingResult } from '@mohassan/contracts';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const projectId=randomUUID();
function resultFixture():CodingResult{
  const receipt={exitCode:0,stdout:'fixture tests passed',stderr:'',timedOut:false,durationMs:1,provider:'unit-fixture',network:'denied' as const,isolation:'appcontainer' as const,isolationVerified:true,snapshotHash:digest('fixture')};
  const diff='diff --git a/src/sum.mjs b/src/sum.mjs\n-return a-b;\n+return a+b;\n';
  return {kind:'coding',summary:'نتيجة اختبار محرك المهام فقط.',projectId,baseCommit:'a'.repeat(40),branch:'mohassan/fixture',checkpoint:'b'.repeat(40),worktreeRetained:true,diff,diffHash:digest(diff),changes:[{path:'src/sum.mjs',beforeHash:digest('before'),afterHash:digest('after')}],baselineTests:{...receipt,exitCode:1},tests:receipt,review:{passed:true,checks:[{id:'fixture',passed:true,message:'تحقق تجريبي لمحرك المهام.'}]},outcome:'ready_for_review',model:'fixture-model',usage:{inputTokens:44,outputTokens:12},sourceUnchanged:true,merged:false,verifiedAt:new Date().toISOString()};
}
const input={title:'تعديل برمجي مصرح',goal:'إصلاح الملف المحدد وتشغيل اختباراته المعزولة.',capabilityId:'coding.change' as const,projectId,autonomy:'scoped' as const};
describe('coding task authorization, results and usage persistence',()=>{
  let store:DatabaseHandle;
  beforeEach(async()=>{store=await createDatabase();await migrate(store.db);await store.db.insertInto('coding_projects').values({id:projectId,owner_id:'owner',name:'fixture',repo_path:'unit-only-no-files-executed',base_commit:'a'.repeat(40),allowed_paths:'["src/sum.mjs"]',test_profile:'node-test',scope_hash:randomUUID()}).execute();});
  afterEach(async()=>{await store.close();});
  const options=(code:RuntimeOptions['code']):RuntimeOptions=>({code,verifyCode:async raw=>raw as CodingResult});
  it('forces approval even for scoped coding and commits a reviewed result only afterward',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async(_goal,context)=>{calls++;await context.onProgress?.('edits_requested','ignored');await context.onModelReceipt?.({model:'fixture-model',usage:{inputTokens:44,outputTokens:12}});return resultFixture();}));
    const task=await runtime.createTask('owner',input,'scoped-code-request');expect(task.status).toBe('waiting_approval');await runtime.tick();expect(calls).toBe(0);
    await runtime.approve('owner',task.id);await runtime.tick();const detail=await runtime.detail('owner',task.id);
    expect(detail.task.status).toBe('completed');expect(detail.task.projectId).toBe(projectId);expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:44,outputTokens:12,resultCommitted:true});
    expect((await store.db.selectFrom('coding_runs').selectAll().executeTakeFirstOrThrow()).result_committed).toBe(true);
    expect((await runtime.snapshot('owner')).tasks[0]?.result).toBeNull();
    expect((await store.db.selectFrom('approvals').select('scope').executeTakeFirstOrThrow()).scope).toBe('coding:change');
  });
  it('retains failed-test diffs for review without claiming completed or retrying',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async()=>{calls++;return {...resultFixture(),outcome:'tests_failed',checkpoint:null,tests:{...resultFixture().tests,exitCode:1},review:{passed:false,checks:[{id:'tests',passed:false,message:'اختبار لم ينجح.'}]}};}));
    const task=await runtime.createTask('owner',input,'failed-code-request');await runtime.approve('owner',task.id);await runtime.tick();await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('failed');expect(detail.task.result?.outcome).toBe('tests_failed');expect(detail.task.result?.diff).toContain('diff --git');expect(calls).toBe(1);
  });
  it('preserves an immediate paid receipt when a later failure has no usage metadata',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async(_goal,context)=>{calls++;await context.onProgress?.('edits_requested','ignored');await context.onModelReceipt?.({model:'fixture-model',usage:{inputTokens:44,outputTokens:12}});throw new Error('never persist raw configuration');}));
    const task=await runtime.createTask('owner',input,'receipt-code-request');await runtime.approve('owner',task.id);await runtime.tick();await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('waiting_approval');expect(calls).toBe(1);
    expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:44,outputTokens:12,status:'failed',resultCommitted:false});expect(JSON.stringify(detail)).not.toContain('never persist');
  });
  it('never invokes code, a model, or creates a coding receipt in shadow mode',async()=>{
    let calls=0;const runtime=new Runtime(store.db,options(async()=>{calls++;return resultFixture();}));
    const task=await runtime.createTask('owner',{...input,autonomy:'shadow'},'shadow-code-request');await runtime.tick();const detail=await runtime.detail('owner',task.id);
    expect(detail.task.status).toBe('completed');expect(detail.task.result?.kind).toBe('shadow');expect(calls).toBe(0);expect(detail.modelRuns).toEqual([]);expect(await store.db.selectFrom('coding_runs').selectAll().execute()).toEqual([]);
  });
  it('denies a foreign project and binds project identity into idempotency',async()=>{
    const runtime=new Runtime(store.db,options(async()=>resultFixture()));
    await expect(runtime.createTask('another-owner',input,'foreign-code-request')).rejects.toMatchObject({statusCode:404});
    const other=randomUUID();await store.db.insertInto('coding_projects').values({id:other,owner_id:'owner',name:'other',repo_path:'unit-other',base_commit:'a'.repeat(40),allowed_paths:'["src/sum.mjs"]',test_profile:'node-test',scope_hash:randomUUID()}).execute();
    await runtime.createTask('owner',input,'same-project-request');await expect(runtime.createTask('owner',{...input,projectId:other},'same-project-request')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('does not enable coding without an independent verifier',async()=>{
    const runtime=new Runtime(store.db,{code:async()=>resultFixture()});await expect(runtime.createTask('owner',input,'no-verifier-request')).rejects.toMatchObject({code:'CAPABILITY_UNAVAILABLE'});
  });
  it('rejects forged diff hashes even when a callback claims review success',async()=>{
    const runtime=new Runtime(store.db,options(async()=>({...resultFixture(),diffHash:'0'.repeat(64)})));const task=await runtime.createTask('owner',input,'forged-diff-request');await runtime.approve('owner',task.id);await runtime.tick();
    expect((await runtime.detail('owner',task.id)).task.status).toBe('failed');
  });
});
