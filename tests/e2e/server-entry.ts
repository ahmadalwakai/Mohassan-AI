import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
if(process.env.MOHASSAN_ISOLATED_TEST!=='true')throw new Error('This entry point is only for isolated browser tests.');
const fixtureRoot=process.env.MOHASSAN_E2E_ROOT;
if(!fixtureRoot||await realpath(process.cwd())!==fixtureRoot||!path.basename(fixtureRoot).startsWith('mohassan-e2e-owned-')||(await lstat(fixtureRoot)).isSymbolicLink()||await realpath(fixtureRoot)!==fixtureRoot||process.env.TEMP!==path.join(fixtureRoot,'tmp'))throw new Error('E2E_ROOT_NOT_OWNED');
for(const key of ['DATA_DIR','CODING_DATA_DIR','CODING_ALLOWED_ROOTS','STUDIO_AI_DATA_DIR','BROWSER_PROFILE_DIR'] as const){
  const target=process.env[key],relative=target?path.relative(fixtureRoot,target):'';
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error(`E2E_PATH_OUTSIDE_FIXTURE:${key}`);
}
if(process.env.DATABASE_URL||process.env.GROQ_API_KEY||process.env.MOHASSAN_LIVE_GROQ_KEY||process.env.STUDIO_GATEWAY_URL||process.env.STUDIO_GATEWAY_SECRET||process.argv.includes('--live'))throw new Error('E2E_LIVE_CONFIGURATION_DENIED');
// Reject invalid direct invocations before importing any config/app module.
const [{createApplication},{getConfig},{createMockGroq}]=await Promise.all([
  import('../../apps/server/src/app.js'),import('../../apps/server/src/config.js'),import('../fixtures/planning.js'),
]);
const mock=createMockGroq();
const {app}=await createApplication({...getConfig(),testRequestLimit:1000,browser:{testOrigins:['http://127.0.0.1:4201']},groqApiKey:'isolated-browser-fixture-not-a-real-key',groqModel:'openai/gpt-oss-20b',groqReasoningModel:'openai/gpt-oss-120b',aiFetch:mock.fetch});
await app.listen({port:Number(process.env.SERVER_PORT??4100),host:'127.0.0.1'});
process.send?.({type:'e2e.ready',root:fixtureRoot});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();process.disconnect?.();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void stop();});
process.on('message',message=>{if((message as {type?:string})?.type==='e2e.shutdown')void stop();});
