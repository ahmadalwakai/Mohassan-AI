import 'dotenv/config';
import { createDatabase, migrate } from '@mohassan/database';
import { createCapabilities, Runtime } from '@mohassan/runtime';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import { createSkillControl, skillsMigration } from '@mohassan/skills';
import { createAIControl } from '../../server/src/ai.js';
import { createCodingControl } from '../../server/src/coding.js';
import { getConfig } from '../../server/src/config.js';
import { createStudioControl } from '../../server/src/studio.js';
import { createStudioAiControl } from '../../server/src/studio-ai.js';
import { createStudioLiveControl } from '../../server/src/studio-live.js';
import { createBrowserResearchControl,SearchEngine,SafeNetwork,SqlSearchStore,LocalPublicIndex,migrateSearch } from '@mohassan/browser';
import { createBrowserTaskControl } from '../../server/src/browser-task.js';
import { createSkillRuntime, skillGatewayTools } from '../../server/src/skill-runtime.js';
import { createLocalModel } from '../../server/src/local-model.js';
import { createSkillRollbackControl } from '../../../packages/skills/src/rollback.js';

const config = getConfig();
if (!config.databaseUrl) throw new Error('العامل المستقل يحتاج DATABASE_URL؛ مخزن التطوير تديره خدمة واحدة.');
const database = await createDatabase({connectionString: config.databaseUrl});
await migrate(database.db);
await memoryMigration(database.db);
await skillsMigration(database.db);
const memory = createMemoryControl(database.db);
// A standalone worker has its own queue; on one GPU run the model work in one process only.
const localModel = createLocalModel(config.localModel);
const coding = await createCodingControl(database.db, {dataDir:config.codingDataDir,allowedRoots:config.codingAllowedRoots,sandbox:config.sandboxRunner,...(localModel?{model:{name:localModel.model,provider:()=>localModel.provider('coding')}}:{})});
// Construction migrates/configures the adapter only. The API owns registration
// of the separate preview listener; a standalone worker never binds that port.
const live = await createStudioLiveControl(database.db, {gatewayUrl:config.studioGatewayUrl,gatewaySecret:config.studioGatewaySecret,webOrigin:config.webOrigin,production:config.production});
const studio = await createStudioControl(database.db, {allowedRoots:config.codingAllowedRoots??[],sandbox:coding.sandbox,buildNext:live.available?((snapshot,signal)=>live.build(snapshot,signal)):undefined});
const studioAi = await createStudioAiControl(database.db, {dataDir:config.studioAiDataDir,...(localModel?{model:{name:localModel.model,vision:localModel.vision,provider:()=>localModel.provider('studio')}}:{}),studio,validateCandidate:studio.validateCandidate,applyCandidate:studio.applyCandidate});
await migrateSearch(database.db);
const searchNetwork=new SafeNetwork(config.browser);
const searchStore=new SqlSearchStore(database.db);
const searchProvider=config.browser?.searchProvider??new SearchEngine(searchNetwork,{store:searchStore,localIndex:new LocalPublicIndex(database.db,searchNetwork),admission:searchStore});
const browser=createBrowserResearchControl(database.db,{...config.browser,searchProvider});
const browserTask=await createBrowserTaskControl(database.db,{browser,networkPolicy:config.browser});
const moduleAvailability={studioVisual:true,memory:true,browser:true};
const scriptsReady=(await coding.sandbox.executableReadiness?.())?.enabled===true;
const skills = createSkillControl(database.db,{allowedRoots:config.codingAllowedRoots??[],enabled:config.skillEngineEnabled,executableReady:async()=>scriptsReady,
  environment:()=>({capabilities:createCapabilities(Boolean(localModel),coding.available,studioAi.available,moduleAvailability,true,config.skillEngineEnabled),modelReady:Boolean(localModel),visionReady:Boolean(localModel?.vision),executableReady:scriptsReady,
    gatewayTools:skillGatewayTools({enabled:config.skillEngineEnabled,coding:coding.available,studio:studioAi.available,vision:Boolean(localModel?.vision)})})});
const ai = await createAIControl(database.db, {localModel,capabilities:createCapabilities(Boolean(localModel),coding.available,studioAi.available,moduleAvailability,true,config.skillEngineEnabled)});
const skillExecutionSupport=createSkillRuntime(database.db,{skills,browser,memory,sandbox:coding.sandbox,testOrigins:config.browser?.testOrigins,
  ...(ai.engine?{modelGenerate:ai.generateSkill}:{}),
  ...(localModel?.vision?{vision:{provider:localModel.provider('vision'),image:studioAi.image}}:{}),
});
const skillExecution=config.skillEngineEnabled?skillExecutionSupport:undefined;
const skillRollback=createSkillRollbackControl(database.db);
const runtime = new Runtime(database.db, {
  cancelSkillRun:skillExecutionSupport.scheduler.cancelRun,
  recoverSkillRollbacks:skillRollback.recoverExpired,
  ...(skillExecution?{skillRuntime:skillExecution.runtimeOptions,rollback:skillRollback}:{}),
  moduleAvailability,
  openBrowser:browserTask.execute,verifyBrowser:browserTask.verify,
  plan:ai.engine?(async(goal,context)=>{
    const task=await database.db.selectFrom('tasks').select('owner_id').where('id','=',context.taskId).executeTakeFirstOrThrow();
    const [memoryContext,guidance]=await Promise.all([memory.context(task.owner_id,goal,context.taskId),skills.context(task.owner_id,goal,{budgetChars:4000})]);
    return ai.plan(goal,{...context,memoryContext,...(guidance.text?{skillContext:guidance.text}:{})});
  }):undefined,
  code:coding.available?coding.execute:undefined,verifyCode:coding.available?coding.verify:undefined,
  studioChange:studioAi.available?studioAi.execute:undefined,verifyStudioChange:studioAi.available?studioAi.verify:undefined,
  onTaskSettled:async ownerId=>{await memory.sync(ownerId);},
  onError:()=>console.error(JSON.stringify({level:'error',event:'worker_tick_failed'})),
});
runtime.start();
console.log('Mohassan worker ready');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  if(stopping)return;stopping=true;
  let failed=false;
  // A failed native/VM cleanup must not leave the worker's SQL pool open, and
  // closing that pool must happen after the adapter has finished its own writes.
  for(const close of [()=>runtime.stop(),()=>browser.shutdown(),()=>live.close(),()=>database.close()]){
    try{await close();}catch{failed=true;}
  }
  if(failed)console.error(JSON.stringify({level:'error',event:'worker_shutdown_failed'}));
  process.exit(failed?1:0);
});
