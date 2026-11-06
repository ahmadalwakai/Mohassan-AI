/** Owned loopback browser -> persisted observation -> process crash -> file fixture. */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { SkillContractSchema, type SkillRunInput } from '@mohassan/contracts';
import { Runtime } from '@mohassan/runtime';
import { createSkillControl, skillsMigration, skillContentHash, sha256 } from '@mohassan/skills';
import { createBrowserResearchControl, migrateBrowser } from '@mohassan/browser';
import { createSkillRuntime } from '../../apps/server/src/skill-runtime.ts';
import { migrateAuth } from '../../apps/server/src/auth.ts';

const [rawDirectory,phase,origin]=process.argv.slice(2),directory=resolve(rawDirectory??''),url=new URL(origin);
if(!directory.startsWith(resolve(tmpdir())+sep)||!basename(directory).startsWith('mohassan-crash-')||!['start','resume'].includes(phase)||url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.origin!==origin||!process.send)throw new Error('Only a disposable local fixture is allowed');
const owner='browser-crash-owner',root=join(directory,'files');await mkdir(root,{recursive:true});
const store=await createDatabase({dataDir:join(directory,'database')});await migrateAuth(store.db);await migrate(store.db);await skillsMigration(store.db);await migrateBrowser(store.db);
const browser=createBrowserResearchControl(store.db,{testOrigins:[origin]});
const skills=createSkillControl(store.db,{allowedRoots:[root],environment:()=>({capabilities:[{id:'browser.open',name:'Controlled browser fixture',version:'1.0.0',description:'Owned loopback fixture only',status:'active',risk:'low',requiredScopes:['browser:read']}],gatewayTools:['browser.open','file.write'],modelReady:false,visionReady:false,executableReady:false})});
const stack=createSkillRuntime(store.db,{skills,browser,memory:{} as any,testOrigins:[origin]});
const execute=stack.runtimeOptions.executeNode;
stack.runtimeOptions.executeNode=async context=>{if(context.binding.tool==='file.write')await appendFile(join(directory,'dispatches.txt'),'write\n');return execute(context);};
const runtime=new Runtime(store.db,{skillRuntime:stack.runtimeOptions,leaseMs:30000,maxAttempts:1});
process.on('message',message=>{if(message==='cleanup')void browser.shutdown().then(()=>process.send?.({kind:'cleanup-ready'}));});
try{
if(phase==='start'){
  await store.db.insertInto('user').values({id:owner,name:'Browser crash fixture',email:'browser-crash@example.test'}).execute();
  const field=(name:string,type:string)=>({name,type,description:`Fixture ${name}`});
  const contract=SkillContractSchema.parse({slug:'browser-crash-report',name:'Browser crash report',description:'Read a local controlled page and save its verified report after restart.',version:'1.0.0',category:'research',level:'tool',inputs:[field('url','url'),field('root','file'),field('path','file'),field('expectedHash','json')],outputs:[field('hash','string')],requires:{tools:['browser.open','file.write'],paths:['report.txt']},sideEffects:'write_local',rollback:{mode:'restore_preimage'},verification:'Independent persisted browser observation and file hash.',steps:[{id:'open',kind:'tool',title:'Read local page',tool:'browser.open',inputs:{url:'input.url'},outputs:[field('text','string')]},{id:'write',kind:'tool',title:'Write observed report',tool:'file.write',dependsOn:['open'],inputs:{root:'input.root',path:'input.path',expectedHash:'input.expectedHash',content:'open.text'},outputs:[field('hash','string')]}]});
  const id=randomUUID(),family=randomUUID(),instructions='Read only the approved local fixture and write its observed report.',hash=skillContentHash(contract,[{path:'SKILL.md',content:instructions}]);
  await store.db.insertInto('skill_families').values({id:family,owner_id:owner,slug:contract.slug}).execute();
  await store.db.insertInto('skill_versions').values({id,family_id:family,owner_id:owner,version:contract.version,sequence:1,name:contract.name,description:contract.description,category:contract.category,level:contract.level,origin:'custom',status:'quarantined',contract:JSON.stringify(contract),content_hash:hash}).execute();
  await store.db.insertInto('skill_files').values({version_id:id,path:'SKILL.md',kind:'instructions',content:instructions,content_hash:sha256(instructions),size_bytes:Buffer.byteLength(instructions)}).execute();
  const inspected=await skills.inspect(owner,id,{expectedRevision:1}),active=await skills.activate(owner,id,{expectedRevision:inspected.skill.revision,approve:true,acknowledgeFindings:true});
  await skills.createGrant(owner,id,{expectedRevision:active.skill.revision,approve:true,tools:['browser.open','file.write'],roots:[root],durationHours:1});
  const input:SkillRunInput={plan:{inputs:contract.inputs,nodes:[{id:'report',skillId:id,dependsOn:[],inputs:Object.fromEntries(contract.inputs.map(field=>[field.name,`input.${field.name}`]))}]},values:{url:`${origin}/fixture`,root,path:'report.txt',expectedHash:null}};
  const parent=await runtime.createTask(owner,{title:'Read and write across restart',goal:'Read the owned fixture then write its observed text.',capabilityId:'skill.run',autonomy:'assisted',skillInput:input},'browser-crash-workflow');await runtime.approve(owner,parent.id);await runtime.tick();
  const child=await store.db.selectFrom('tasks').selectAll().where('capability_id','=','skill.node').executeTakeFirstOrThrow();await runtime.approve(owner,child.id);await runtime.tick();
  const saved=await store.db.selectFrom('tasks').select('status').where('id','=',child.id).executeTakeFirstOrThrow();if(saved.status!=='completed')throw new Error('Browser fixture did not complete');
  // Close Chromium and all owned sessions BEFORE advertising a safe kill point.
  await browser.shutdown();await sql`CHECKPOINT`.execute(store.db);
  process.send!({kind:'checkpoint',stage:'browser-completed-before-report',pid:process.pid,browserClosed:true});await new Promise<void>(()=>{});
}else{
  for(let n=0;n<8;n++){
    await runtime.tick();
    const waiting=await store.db.selectFrom('tasks').select('id').where('owner_id','=',owner).where('capability_id','=','skill.node').where('status','=','waiting_approval').execute();
    for(const task of waiting)await runtime.approve(owner,task.id);
  }
  const parent=await store.db.selectFrom('tasks').select(['status','result','attempt']).where('capability_id','=','skill.run').executeTakeFirstOrThrow();
  const receipts=await store.db.selectFrom('skill_evidence').select(['node_id','status','attempt']).execute(),content=await readFile(join(root,'report.txt'),'utf8');
  await browser.shutdown();await store.close();process.send!({kind:'result',parent,receipts,content,hash:sha256(content),writes:(await readFile(join(directory,'dispatches.txt'),'utf8')).trim().split('\n').length});process.disconnect();
}
}catch(error){await browser.shutdown();await store.close();throw error;}
