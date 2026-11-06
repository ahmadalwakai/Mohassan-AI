/** Trusted disposable crash fixture. Never imports app config, dotenv or a provider. */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { SkillContractSchema, type SkillRunInput } from '@mohassan/contracts';
import { Runtime, hasActiveSkillWorkflowApproval, type SkillRuntimeOptions } from '@mohassan/runtime';
import { createSkillControl, createSkillScheduler, createToolGateway, createFileToolAdapters, skillsMigration, skillContentHash, sha256, hashSkillData } from '@mohassan/skills';
import { readSkillExecutionAuthority } from '../../packages/skills/src/execution-authority.ts';
import { migrateAuth } from '../../apps/server/src/auth.ts';

const [rawDirectory, mode, phase] = process.argv.slice(2);
const directory=resolve(rawDirectory??'');
if(!directory.startsWith(resolve(tmpdir())+sep)||!basename(directory).startsWith('mohassan-crash-')||!['confirmed','unknown'].includes(mode)||!['start','resume','resume-pause'].includes(phase)||!process.send)throw new Error('Only a controlled disposable test worker is allowed');
const owner='owned-crash-fixture', root=join(directory,'files');
await mkdir(root,{recursive:true});
const store=await createDatabase({dataDir:join(directory,'database')});
await migrateAuth(store.db);await migrate(store.db);await skillsMigration(store.db);
const skills=createSkillControl(store.db,{allowedRoots:[root],environment:()=>({capabilities:[],gatewayTools:['file.write'],modelReady:false,visionReady:false,executableReady:false})});
const scheduler=createSkillScheduler(store.db,{validateComposition:skills.validateComposition,validateParentAuthority:hasActiveSkillWorkflowApproval});
async function checkpoint(stage:string){
  await sql`CHECKPOINT`.execute(store.db);
  process.send!({kind:'checkpoint',stage,pid:process.pid});
  await new Promise<void>(()=>{});
}
const adapters=createFileToolAdapters().map(adapter=>adapter.id!=='file.write'?adapter:{...adapter,execute:async(input:any,context:any)=>{
  await appendFile(join(directory,'dispatches.txt'),'execute\n');
  const result=await adapter.execute(input,context);
  if(phase==='start'&&mode==='unknown')await checkpoint('effect-with-started-receipt');
  return result;
}});
const gateway=createToolGateway(store.db,{scheduler,adapters});
const options:SkillRuntimeOptions={
  advance:async(input,context)=>{const result=await scheduler.runSkillGraph(input,context);return result.kind==='complete'?{...result,result:{...result.result}}:result;},
  verify:scheduler.verifyRunResult,wakeCandidates:scheduler.wakeCandidates,cancelRun:scheduler.cancelRun,mapChild:()=>null,
  validateBinding:async(tx,context)=>{const stored=await scheduler.readNode(tx,context.ownerId,context.binding.runId,context.binding.nodeId);if(!stored?.binding||stored.node.child_task_id!==context.taskId||hashSkillData(stored.binding)!==hashSkillData(context.binding))return false;try{await readSkillExecutionAuthority(tx,context.ownerId,context.binding,true);return true;}catch{return false;}},
  recoverNode:scheduler.recoverNode,
  executeNode:async context=>{const result=await gateway.executeNode(context);if(phase==='start'&&mode==='confirmed')await checkpoint('successful-receipt-before-runtime-finish');return result;},
  verifyNode:async(raw,context)=>{const result=await gateway.verifyNode(raw,context);if(phase==='resume-pause'&&result)await checkpoint('verification-complete-before-runtime-finish');return result;},
};
const runtime=new Runtime(store.db,{skillRuntime:options,leaseMs:1000,maxAttempts:1});
if(phase==='start'){
  await store.db.insertInto('user').values({id:owner,name:'Owned crash fixture',email:'owned-crash-fixture@example.test'}).execute();
  const field=(name:string,type:string)=>({name,type,description:`Fixture ${name}`});
  const contract=SkillContractSchema.parse({slug:'owned-crash-write',name:'Owned crash write',description:'Write a disposable fixture report.',category:'documents',version:'1.0.0',level:'tool',inputs:[field('root','string'),field('path','string'),field('content','string'),field('expectedHash','json')],outputs:[field('hash','string')],requires:{tools:['file.write'],paths:['report.txt']},sideEffects:'write_local',rollback:{mode:'restore_preimage'},verification:'Verify the disposable output hash.',steps:[{id:'write',kind:'tool',title:'Write fixture',tool:'file.write',inputs:{root:'input.root',path:'input.path',content:'input.content',expectedHash:'input.expectedHash'},outputs:[field('hash','string')]}]});
  const id=randomUUID(),family=randomUUID(),instructions='Write only the approved disposable fixture file.',hash=skillContentHash(contract,[{path:'SKILL.md',content:instructions}]);
  await store.db.insertInto('skill_families').values({id:family,owner_id:owner,slug:contract.slug}).execute();
  await store.db.insertInto('skill_versions').values({id,family_id:family,owner_id:owner,version:contract.version,sequence:1,name:contract.name,description:contract.description,category:contract.category,level:contract.level,origin:'custom',status:'quarantined',contract:JSON.stringify(contract),content_hash:hash}).execute();
  await store.db.insertInto('skill_files').values({version_id:id,path:'SKILL.md',kind:'instructions',content:instructions,content_hash:sha256(instructions),size_bytes:Buffer.byteLength(instructions)}).execute();
  const inspected=await skills.inspect(owner,id,{expectedRevision:1}),active=await skills.activate(owner,id,{expectedRevision:inspected.skill.revision,approve:true,acknowledgeFindings:true});
  await skills.createGrant(owner,id,{expectedRevision:active.skill.revision,approve:true,tools:['file.write'],roots:[root],durationHours:1});
  const input:SkillRunInput={plan:{inputs:contract.inputs,nodes:[{id:'main',skillId:id,dependsOn:[],inputs:Object.fromEntries(contract.inputs.map(field=>[field.name,`input.${field.name}`]))}]},values:{root,path:'report.txt',content:'One approved durable write.',expectedHash:null}};
  const parent=await runtime.createTask(owner,{title:'Disposable crash workflow',goal:'Write and verify one owned temporary report.',capabilityId:'skill.run',autonomy:'assisted',skillInput:input},'owned-crash-parent');
  await runtime.approve(owner,parent.id);await runtime.tick();
  const child=await store.db.selectFrom('tasks').selectAll().where('capability_id','=','skill.node').executeTakeFirstOrThrow();
  await runtime.approve(owner,child.id);await runtime.tick();
  throw new Error('Expected the test process to be killed at a checkpoint');
}else{
  for(let n=0;n<4;n++)await runtime.tick();
  const tasks=await store.db.selectFrom('tasks').select(['id','capability_id','status','attempt','verification_only','verification_source_lease']).execute();
  const receipts=await store.db.selectFrom('skill_evidence').select(['id','task_id','status','attempt','lease_token']).execute();
  const locks=await store.db.selectFrom('skill_resource_locks').select('resource_key').execute();
  const events=await store.db.selectFrom('task_events').select('type').execute();
  process.send!({kind:'result',tasks,receipts,locks:locks.length,events:events.map(row=>row.type),dispatches:(await readFile(join(directory,'dispatches.txt'),'utf8')).trim().split('\n').length,content:await readFile(join(root,'report.txt'),'utf8')});
  await store.close();process.disconnect();
}
