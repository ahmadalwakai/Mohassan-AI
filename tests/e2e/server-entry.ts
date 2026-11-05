import { createApplication } from '../../apps/server/src/app.js';
import { getConfig } from '../../apps/server/src/config.js';
import { createMockGroq } from '../fixtures/planning.js';
if(process.env.MOHASSAN_ISOLATED_TEST!=='true')throw new Error('This entry point is only for isolated browser tests.');
const mock=createMockGroq();
/** Set only by hand to try the real model against disposable data. */
const liveKey=process.env.MOHASSAN_LIVE_GROQ_KEY;
const {app}=await createApplication({...getConfig(),testRequestLimit:1000,browser:{testOrigins:['http://127.0.0.1:4201']},groqApiKey:liveKey??'isolated-browser-fixture-not-a-real-key',groqModel:'openai/gpt-oss-20b',groqReasoningModel:'openai/gpt-oss-120b',...(liveKey?{}:{aiFetch:mock.fetch})});
await app.listen({port:Number(process.env.SERVER_PORT??4100),host:'127.0.0.1'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await app.close();process.exit(0);});
