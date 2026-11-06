import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { createSkillScheduler, hashSkillData, skillsMigration } from '@mohassan/skills';
import type { CreateTaskInput, SkillNodeBinding, SkillToolId } from '@mohassan/contracts';
import { Runtime, type SkillRuntimeOptions } from './index.ts';

const owner='skill-runtime-owner';
const input=():CreateTaskInput=>({title:'مخطط مهارات مثبت',goal:'نفذ خطوات القراءة المحددة بعد الموافقة.',capabilityId:'skill.run',autonomy:'scoped',skillInput:{plan:{nodes:[{id:'read',skillId:randomUUID(),inputs:{},dependsOn:[]}],inputs:[]},values:{}}});
let database:Awaited<ReturnType<typeof createDatabase>>;
beforeEach(async()=>{database=await createDatabase();await migrate(database.db);});
afterEach(async()=>{await database.close();});

function fixture(waves=1,nodeSpec:{kind:'tool'|'model';tool?:SkillToolId;input?:Record<string,unknown>}={kind:'tool',tool:'file.read'}){
  const runId=randomUUID(),versionId=randomUUID(),children:Array<{id:string;binding:SkillNodeBinding}>=[];
  let parentId='',effects=0,cancelled=false,rollbackDispatch=false;
  const options:SkillRuntimeOptions={
    advance:async(_input,context)=>{
      parentId=context.taskId;
      const last=children.at(-1),row=last?await database.db.selectFrom('tasks').selectAll().where('id','=',last.id).executeTakeFirst():null;
      if(row&&['failed','cancelled'].includes(row.status))throw new Error('Child has no successful evidence');
      if(row&&row.status!=='completed')return {kind:'pending',runId,childTaskIds:[row.id]};
      if(children.length>=waves)return {kind:'complete',runId,result:{kind:'skill_run',runId,outcome:'succeeded',outputs:{count:effects}}};
      const binding:SkillNodeBinding={parentTaskId:context.taskId,runId,nodeId:`read.node${children.length}`,versionId,contentHash:'a'.repeat(64),inputsHash:hashSkillData(nodeSpec.input??{}),kind:nodeSpec.kind,...(nodeSpec.tool?{tool:nodeSpec.tool}:{})};
      await database.db.transaction().execute(async tx=>{
        const child=await context.dispatchChild(tx,{binding,input:nodeSpec.input??{},idempotencyKey:`skill:${runId}:${binding.nodeId}`});
        if(rollbackDispatch)throw new Error('Rollback this wave');
        children.push({id:child.id,binding});
      });
      return {kind:'pending',runId,childTaskIds:[children.at(-1)!.id]};
    },
    verify:async(raw,context)=>{await context.assertActive();return (raw as any)?.kind==='skill_run'?raw as Record<string,unknown>:null;},
    wakeCandidates:async()=>{
      const last=children.at(-1);if(!last)return [];
      const row=await database.db.selectFrom('tasks').select('status').where('id','=',last.id).executeTakeFirst();
      return row&&['completed','failed','cancelled'].includes(row.status)?[{ownerId:owner,parentTaskId:parentId}]:[];
    },
    cancelRun:async()=>{cancelled=true;},
    mapChild:()=>null,
    validateBinding:async(_tx,context)=>children.some(child=>child.id===context.taskId&&JSON.stringify(child.binding)===JSON.stringify(context.binding)),
    executeNode:async context=>{await context.assertActive();effects++;return {kind:'node_evidence',nodeId:context.binding.nodeId,output:{count:effects}};},
    verifyNode:async(raw,context)=>{await context.assertActive();return (raw as any)?.nodeId===context.binding.nodeId?raw as Record<string,unknown>:null;},
  };
  return {options,children,get effects(){return effects;},get cancelled(){return cancelled;},set rollbackDispatch(value:boolean){rollbackDispatch=value;}};
}

describe('skill workflows reuse durable Runtime tasks',()=>{
  it('keeps internal nodes and bindings outside the public input boundary',async()=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});
    await expect(runtime.createTask(owner,{...input(),capabilityId:'skill.node'} as any,randomUUID())).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(runtime.createTask(owner,{...input(),skillBinding:{runId:randomUUID()}} as any,randomUUID())).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(runtime.createTask(owner,{...input(),skillNodeInput:{path:'untrusted'}} as any,randomUUID())).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(runtime.getCapabilities().some(capability=>capability.id==='skill.node')).toBe(false);
    await expect(new Runtime(database.db).createTask(owner,input(),randomUUID())).rejects.toMatchObject({code:'CAPABILITY_UNAVAILABLE'});
  });

  it.each(['write','model'] as const)('makes %s approval concrete and rejects changes to its reviewable inputs',async kind=>{
    const nodeInput=kind==='write'?{path:'C:/isolated-fixture/report.txt',content:'Exact proposed file contents'}:{prompt:'An explicit paid model request'};
    const f=fixture(1,kind==='write'?{kind:'tool',tool:'file.write',input:nodeInput}:{kind:'model',input:nodeInput});
    const runtime=new Runtime(database.db,{skillRuntime:f.options}),parent=await runtime.createTask(owner,input(),randomUUID());
    await runtime.approve(owner,parent.id);await runtime.tick();
    const child=await runtime.detail(owner,f.children[0].id);expect(child.task.skillNodeInput).toEqual(nodeInput);
    const approval=child.events.find(event=>event.type==='approval_required')!.message;
    expect(approval).not.toContain('فحص القراءة فقط');expect(approval).toContain(kind==='write'?'تغيير بيانات أو ملفات محلية':'توكنات مدفوعة');
    if(kind==='write'){expect(approval).toContain(nodeInput.path);expect(approval).toContain('SHA-256');}
    await database.db.updateTable('tasks').set({skill_node_input:JSON.stringify({changed:true})}).where('id','=',child.task.id).execute();
    await expect(runtime.approve(owner,child.task.id)).rejects.toMatchObject({code:'SKILL_BINDING_INVALID'});expect(f.effects).toBe(0);
  });

  it('runs five waves without deadlock, repeated parent approval or consuming retry attempts',async()=>{
    const f=fixture(5),runtime=new Runtime(database.db,{skillRuntime:f.options,maxAttempts:1});
    const parent=await runtime.createTask(owner,input(),randomUUID());expect(parent.status).toBe('waiting_approval');
    await runtime.approve(owner,parent.id);expect(await runtime.tick()).toMatchObject({id:parent.id,status:'paused',attempt:1});
    for(let wave=0;wave<5;wave++){
      const child=f.children[wave];expect((await runtime.detail(owner,child.id)).task.status).toBe('waiting_approval');
      expect(f.effects).toBe(wave);await runtime.approve(owner,child.id);
      expect(await runtime.tick()).toMatchObject({id:child.id,status:'completed',attempt:1});
      expect(await runtime.tick()).toMatchObject({id:parent.id,status:wave===4?'completed':'paused',attempt:1});
    }
    expect(f.effects).toBe(5);
    const approvals=await database.db.selectFrom('approvals').selectAll().where('task_id','=',parent.id).execute();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].consumed_lease_token).toBe((await database.db.selectFrom('tasks').select('workflow_token').where('id','=',parent.id).executeTakeFirstOrThrow()).workflow_token);
  });

  it('allows competing Runtime workers to dispatch and execute a bound child only once',async()=>{
    const f=fixture(),first=new Runtime(database.db,{skillRuntime:f.options}),second=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await first.createTask(owner,input(),randomUUID());await first.approve(owner,parent.id);
    await Promise.all([first.tick(),second.tick()]);expect(f.children).toHaveLength(1);expect(f.effects).toBe(0);
    await first.approve(owner,f.children[0].id);await Promise.all([first.tick(),second.tick()]);await first.tick();
    expect(f.children).toHaveLength(1);expect(f.effects).toBe(1);expect((await first.detail(owner,parent.id)).task).toMatchObject({status:'completed',attempt:1});
  });

  it('does not dispatch a graph or child in shadow mode',async()=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await runtime.createTask(owner,{...input(),autonomy:'shadow'},randomUUID());
    expect(await runtime.tick()).toMatchObject({id:parent.id,status:'completed',result:{kind:'shadow',capabilityId:'skill.run',executed:false}});
    expect(f.children).toEqual([]);expect(f.effects).toBe(0);
  });

  it('gives a scheduler-approved retry a new child key and requires a fresh child approval',async()=>{
    const f=fixture(),original=f.options.advance;
    f.options.advance=async(request,context)=>{
      if(f.children.length===1){
        const first=f.children[0],row=await database.db.selectFrom('tasks').select('status').where('id','=',first.id).executeTakeFirstOrThrow();
        if(row.status==='failed'){
          const created=await database.db.transaction().execute(tx=>context.dispatchChild(tx,{binding:first.binding,input:{},attempt:2,idempotencyKey:`skill:${first.binding.runId}:${first.binding.nodeId}:attempt:2`}));
          f.children.push({id:created.id,binding:first.binding});return {kind:'pending',runId:first.binding.runId,childTaskIds:[created.id]};
        }
      }
      return original(request,context);
    };
    let calls=0;f.options.executeNode=async context=>{await context.assertActive();if(++calls===1)throw new Error('Fixture safe retry decision occurs in scheduler');return {kind:'node_evidence',nodeId:context.binding.nodeId};};
    const runtime=new Runtime(database.db,{skillRuntime:f.options,maxAttempts:1}),parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    await runtime.approve(owner,f.children[0].id);await runtime.tick();await runtime.tick();expect(f.children).toHaveLength(2);expect(f.children[1].id).not.toBe(f.children[0].id);
    expect((await runtime.detail(owner,f.children[1].id)).task.status).toBe('waiting_approval');expect(await runtime.tick()).toBeNull();expect(calls).toBe(1);
    await runtime.approve(owner,f.children[1].id);await runtime.tick();await runtime.tick();expect(calls).toBe(2);expect((await runtime.detail(owner,parent.id)).task).toMatchObject({status:'completed',attempt:1});
    const keys=await database.db.selectFrom('tasks').select('idempotency_key').where('capability_id','=','skill.node').orderBy('created_at').execute();expect(keys[1].idempotency_key).toBe(`${keys[0].idempotency_key}:attempt:2`);
  });

  it.each(['verified','rejected','denied'] as const)('routes mapped browser children through Gateway before execution and after independent verification (%s)',async mode=>{
    const url='https://example.org/',f=fixture(1,{kind:'tool',tool:'browser.open',input:{url}}),order:string[]=[];
    f.options.mapChild=()=>({title:'قراءة صفحة محددة',goal:'اقرأ الصفحة المحددة واحفظ المشاهدة.',capabilityId:'browser.open',autonomy:'assisted',browserInput:{url}});
    f.options.beforeMappedExecute=async context=>{await context.assertActive();order.push('gateway_claim');if(mode==='denied')throw new Error('Gateway denied fresh authority');};
    f.options.recordChildResult=async(_raw,context)=>{await context.assertActive();expect((await database.db.selectFrom('tasks').select('status').where('id','=',context.taskId).executeTakeFirstOrThrow()).status).toBe('verifying');order.push('gateway_receipt');};
    f.options.recordChildFailure=async()=>{order.push('gateway_failure');};
    const result={kind:'browser_open' as const,outcome:'opened' as const,sessionId:randomUUID(),observationId:randomUUID(),url,title:'Fixture',observedAt:new Date().toISOString(),summary:'An independently verified observation.',screenshotAvailable:false,screenshotUrl:null,contentHash:'d'.repeat(64),screenshotHash:null};
    const runtime=new Runtime(database.db,{skillRuntime:f.options,moduleAvailability:{browser:true},openBrowser:async()=>{order.push('browser_execute');return result;},verifyBrowser:async()=>{order.push('browser_verify');return mode==='rejected'?null:result;}});
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    const child=f.children[0];expect((await runtime.detail(owner,child.id)).task.capabilityId).toBe('browser.open');
    await runtime.approve(owner,child.id);expect(await runtime.tick()).toMatchObject({id:child.id,status:mode==='verified'?'completed':'failed'});
    expect(order).toEqual(mode==='denied'?['gateway_claim','gateway_failure']:['gateway_claim','browser_execute','browser_verify',mode==='verified'?'gateway_receipt':'gateway_failure']);
  });

  it('keeps exact bindings stable through JSON storage and rejects tampering before approval',async()=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});
    const request=input();request.skillInput!.values={options:{z:2,a:1}};
    const parent=await runtime.createTask(owner,request,randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    const child=f.children[0];
    await database.db.updateTable('tasks').set({skill_binding:JSON.stringify({...child.binding,inputsHash:'c'.repeat(64)})}).where('id','=',child.id).execute();
    await expect(runtime.approve(owner,child.id)).rejects.toMatchObject({code:'SKILL_BINDING_INVALID'});
    expect(f.effects).toBe(0);
  });

  it('recovers a mapped receipt through both verifiers without repeating dispatch or receipt creation',async()=>{
    const url='https://example.org/',f=fixture(1,{kind:'tool',tool:'browser.open',input:{url}}),order:string[]=[];
    f.options.mapChild=()=>({title:'قراءة صفحة محددة',goal:'اقرأ الصفحة المحددة واحفظ المشاهدة.',capabilityId:'browser.open',autonomy:'assisted',browserInput:{url}});
    f.options.beforeMappedExecute=async()=>{order.push('dispatch');};f.options.recordChildResult=async()=>{order.push('receipt');};
    const raw={kind:'browser_open' as const,outcome:'opened' as const,sessionId:randomUUID(),observationId:randomUUID(),url,title:'Fixture',observedAt:new Date().toISOString(),summary:'Saved verified observation.',screenshotAvailable:false,screenshotUrl:null,contentHash:'d'.repeat(64),screenshotHash:null};
    f.options.recoverNode=async(_tx,context)=>({kind:'confirmed',result:raw,receiptLeaseToken:context.leaseToken});
    f.options.verifyRecoveredNode=async(result,context)=>{await context.assertActive();expect(context.verificationOnly).toBe(true);order.push('gateway_verify');return result as Record<string,unknown>;};
    const runtime=new Runtime(database.db,{skillRuntime:f.options,moduleAvailability:{browser:true},openBrowser:async()=>{order.push('execute');return raw;},verifyBrowser:async(_raw,context)=>{if(context.verificationOnly){expect(context.leaseToken).not.toBe(context.receiptLeaseToken);await context.assertActive!();}order.push('native_verify');return raw;}});
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    const child=f.children[0];await runtime.approve(owner,child.id);await runtime.tick();
    const old=(await database.db.selectFrom('approvals').select('consumed_lease_token').where('task_id','=',child.id).executeTakeFirstOrThrow()).consumed_lease_token;
    await database.db.updateTable('tasks').set({status:'running',result:null,lease_token:old,lease_expires_at:new Date(0)}).where('id','=',child.id).execute();
    expect(await runtime.tick()).toMatchObject({id:child.id,status:'completed',attempt:1});
    expect(order).toEqual(['dispatch','execute','native_verify','receipt','native_verify','gateway_verify']);
    expect((await runtime.detail(owner,child.id)).task.result).toEqual(raw);
  });

  it('keeps rollback approval bound to server-prepared review data and never retries it',async()=>{
    const request={runId:randomUUID(),preimageId:randomUUID(),sourceReceiptId:randomUUID(),preimageHash:'a'.repeat(64),expectedAfterHash:'b'.repeat(64)};
    const review={root:'C:/owned-fixture',path:'report.txt',beforeHash:null,afterHash:request.expectedAfterHash,deletedOnRestore:true,bytes:0};let effects=0;
    const runtime=new Runtime(database.db,{rollback:{prepare:async(_owner,input)=>({input,title:'استعادة تقرير محدد',goal:'احذف التقرير المنشأ بعد فحص بصمته الحالية.',review}),execute:async(_input,context)=>{await context.assertActive();effects++;return {kind:'skill_rollback',restored:true};},verify:async(raw,_input,context)=>{await context.assertActive();return raw as Record<string,unknown>;}}});
    const input={title:'طلب استعادة ملف',goal:'أعد الصورة المحفوظة للتقرير المحدد.',capabilityId:'skill.rollback' as const,autonomy:'assisted' as const,skillRollbackInput:request};
    await expect(runtime.createTask(owner,{...input,autonomy:'scoped'},randomUUID())).rejects.toMatchObject({code:'INVALID_INPUT'});
    const task=await runtime.createTask(owner,input,randomUUID());expect(task).toMatchObject({status:'waiting_approval',maxAttempts:1,skillRollbackReview:review});await runtime.tick();expect(effects).toBe(0);
    await database.db.updateTable('tasks').set({skill_rollback_review:JSON.stringify({...review,path:'changed.txt'})}).where('id','=',task.id).execute();
    await expect(runtime.approve(owner,task.id)).rejects.toMatchObject({code:'SKILL_ROLLBACK_CHANGED'});
    await database.db.updateTable('tasks').set({skill_rollback_review:JSON.stringify(review)}).where('id','=',task.id).execute();
    await runtime.approve(owner,task.id);expect(await runtime.tick()).toMatchObject({status:'completed',attempt:1});expect(effects).toBe(1);expect(await runtime.tick()).toBeNull();
  });

  it.each(['expired','cancelled','revoked_grant'] as const)('refuses recovered verification after %s authority',async mode=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});let verifications=0;
    const original=f.options.verifyNode;f.options.verifyNode=async(...args)=>{verifications++;return original(...args);};
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    const child=f.children[0];await runtime.approve(owner,child.id);await runtime.tick();
    const approval=await database.db.selectFrom('approvals').selectAll().where('task_id','=',child.id).executeTakeFirstOrThrow();
    f.options.recoverNode=async()=>({kind:'confirmed',result:{kind:'node_evidence',nodeId:child.binding.nodeId},receiptLeaseToken:approval.consumed_lease_token!});
    await database.db.updateTable('tasks').set({status:'running',result:null,lease_token:approval.consumed_lease_token,lease_expires_at:new Date(0),cancellation_requested:mode==='cancelled'}).where('id','=',child.id).execute();
    if(mode==='expired')await database.db.updateTable('approvals').set({expires_at:new Date(0)}).where('id','=',approval.id).execute();
    if(mode==='revoked_grant')f.options.validateBinding=async()=>false;
    await runtime.tick();expect((await runtime.detail(owner,child.id)).task.status).toBe(mode==='cancelled'?'cancelled':'failed');expect(f.effects).toBe(1);expect(verifications).toBe(1);
  });

  it('rolls back child creation when the scheduler transaction cannot persist its wave',async()=>{
    const f=fixture();f.rollbackDispatch=true;const runtime=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    expect(await database.db.selectFrom('tasks').select('id').where('id','!=',parent.id).execute()).toEqual([]);
    expect(f.effects).toBe(0);
  });

  it('makes an expired paused workflow approvable without dispatching or polling an extra attempt',async()=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    await runtime.approve(owner,f.children[0].id);
    await sql`UPDATE approvals SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE task_id=${parent.id}`.execute(database.db);
    await runtime.tick();expect((await runtime.detail(owner,parent.id)).task).toMatchObject({status:'waiting_approval',attempt:1});
    await expect(runtime.approve(owner,f.children[0].id)).rejects.toMatchObject({code:'SKILL_BINDING_INVALID'});expect(f.effects).toBe(0);
    await runtime.approve(owner,parent.id);expect(await runtime.tick()).toMatchObject({status:'paused',attempt:2});
    expect(f.children).toHaveLength(1);
    expect((await runtime.detail(owner,f.children[0].id)).task.status).toBe('waiting_approval');
    await runtime.approve(owner,f.children[0].id);await runtime.tick();await runtime.tick();
    expect((await runtime.detail(owner,parent.id)).task.status).toBe('completed');
  });

  it('fences a late child result when another Runtime cancels the parent',async()=>{
    const f=fixture();let started!:()=>void,release!:()=>void;
    const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    f.options.executeNode=async context=>{await context.assertActive();started();await gate;return {kind:'node_evidence',nodeId:context.binding.nodeId};};
    const first=new Runtime(database.db,{skillRuntime:f.options}),second=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await first.createTask(owner,input(),randomUUID());await first.approve(owner,parent.id);await first.tick();
    const child=f.children[0];await first.approve(owner,child.id);const running=first.tick();await began;
    await second.cancel(owner,parent.id);release();await running;
    expect(f.cancelled).toBe(true);expect((await second.detail(owner,parent.id)).task.status).toBe('cancelled');
    expect((await second.detail(owner,child.id)).task).toMatchObject({status:'cancelled',result:null});
    expect(await second.tick()).toBeNull();
  });

  it('cancels persisted workflow state and children while execution is disabled',async()=>{
    const f=fixture(),enabled=new Runtime(database.db,{skillRuntime:f.options});
    const request=input(),parent=await enabled.createTask(owner,request,randomUUID());
    await enabled.approve(owner,parent.id);await enabled.tick();
    const child=f.children[0];await enabled.approve(owner,child.id);
    await skillsMigration(database.db);
    await database.db.insertInto('skill_runs').values({id:child.binding.runId,owner_id:owner,parent_task_id:parent.id,input_hash:hashSkillData(request.skillInput),plan:JSON.stringify(request.skillInput!.plan),input_values:'{}',pinned_versions:'[]',status:'waiting_children'}).execute();
    const scheduler=createSkillScheduler(database.db,{validateComposition:async()=>{throw new Error('Maintenance must never plan or execute');}});
    const disabled=new Runtime(database.db,{cancelSkillRun:scheduler.cancelRun});
    await expect(disabled.createTask(owner,input(),randomUUID())).rejects.toMatchObject({code:'CAPABILITY_UNAVAILABLE'});
    expect(await disabled.cancel(owner,parent.id)).toMatchObject({status:'cancelled'});
    expect((await disabled.detail(owner,child.id)).task).toMatchObject({status:'cancelled',cancellationRequested:true});
    expect((await database.db.selectFrom('skill_runs').select('status').where('id','=',child.binding.runId).executeTakeFirstOrThrow()).status).toBe('cancelled');
    expect(await database.db.selectFrom('approvals').select('id').where('task_id','=',child.id).where('revoked_at','is',null).execute()).toEqual([]);
    expect(await disabled.tick()).toBeNull();expect(f.effects).toBe(0);
  });

  it('does not redispatch an expired child whose external outcome is unknown',async()=>{
    const f=fixture(),runtime=new Runtime(database.db,{skillRuntime:f.options});
    const parent=await runtime.createTask(owner,input(),randomUUID());await runtime.approve(owner,parent.id);await runtime.tick();
    const child=f.children[0];await runtime.approve(owner,child.id);
    await database.db.updateTable('tasks').set({status:'running',attempt:1,lease_token:randomUUID(),lease_expires_at:new Date(0)}).where('id','=',child.id).execute();
    await runtime.tick();expect((await runtime.detail(owner,child.id)).task.status).toBe('failed');expect(f.effects).toBe(0);
  });
});
