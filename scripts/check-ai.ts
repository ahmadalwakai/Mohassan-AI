import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '@mohassan/database';
import { createAIControl } from '../apps/server/src/ai.js';
import { createApplication } from '../apps/server/src/app.js';

if(!process.argv.includes('--live'))throw new Error('أضف --live لإجراء اختبار صريح يستدعي Groq.');
dotenv.config({path:resolve('.env'),override:process.env.NODE_ENV!=='production',quiet:true});
async function main(){
  const apiKey=process.env.GROQ_API_KEY;if(!apiKey)throw new Error('GROQ_API_KEY غير مجهز.');
  const aiConfig={apiKey,model:process.env.GROQ_MODEL,reasoningModel:process.env.GROQ_REASONING_MODEL};
  // Verify the actual configured provider and persist its health in the user's SQL store.
  // The test owner and task below live only in a separate, in-memory SQL instance.
  const store=await createDatabase({connectionString:process.env.DATABASE_URL||undefined,dataDir:process.env.DATA_DIR||resolve('.data/postgres')});
  let health;
  try{health=await(await createAIControl(store.db,aiConfig)).verify();}finally{await store.close();}
  const secret=()=>randomBytes(32).toString('hex');const internal=secret(),setupToken=secret();
  const application=await createApplication({authSecret:secret(),internalSecret:internal,setupToken,webOrigin:'http://127.0.0.1:3000',production:false,runWorker:false,groqApiKey:apiKey,groqModel:aiConfig.model,groqReasoningModel:aiConfig.reasoningModel});
  try{
    const headers={'x-mohassan-internal':internal,origin:'http://127.0.0.1:3000'};
    const password=secret();
    const setup=await application.app.inject({method:'POST',url:'/api/setup',headers,payload:{name:'اختبار Groq المعزول',email:'live-check@example.test',password,setupToken}});
    if(setup.statusCode!==200)throw new Error('تعذر إعداد اختبار المصادقة المعزول.');
    const login=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers,payload:{email:'live-check@example.test',password}});
    if(login.statusCode!==200)throw new Error('تعذر تسجيل الدخول في الاختبار المعزول.');
    const cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
    const created=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'groq-live-planning-check'},payload:{title:'خطة مراجعة مشروع — اختبار حي',goal:'أعد خطة من ثلاث خطوات لتنظيم مراجعة مشروع برمجي. حدد معايير النجاح والأدلة المتوقعة والأسئلة اللازمة. لا تنفذ أي أداة.',capabilityId:'plan.draft',autonomy:'assisted'}});
    if(created.statusCode!==200||created.json().status!=='waiting_approval')throw new Error('فشل حفظ مهمة التخطيط أو حماية الموافقة.');
    const task=created.json();
    const approved=await application.app.inject({method:'POST',url:`/api/tasks/${task.id}/approve`,headers:{...headers,cookie},payload:{}});
    if(approved.statusCode!==200)throw new Error('لم تُقبل موافقة الاختبار.');
    await application.runtime.tick();
    const detail=await application.runtime.detail(task.ownerId,task.id);
    if(detail.task.status!=='completed'||detail.task.result?.kind!=='plan')throw new Error(`لم تجتز الخطة الحية التحقق؛ الحالة: ${detail.task.status}. ${detail.task.error??''}`);
    if(detail.task.result.executionAllowed!==false||!detail.steps?.length||!detail.modelRuns?.[0]?.resultCommitted)throw new Error('فشل التحقق من حفظ الخطة أو منع تنفيذها.');
    const report={checkedAt:new Date().toISOString(),source:'groq-live',connection:health,taskStatus:detail.task.status,model:detail.task.result.model,usage:detail.task.result.usage,verification:detail.task.result.verification,executionAllowed:false,savedSteps:detail.steps.length,modelRun:detail.modelRuns[0],plan:detail.task.result.plan};
    await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/live-plan.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({liveCheck:'passed',connection:health.status,model:report.model,usage:report.usage,savedSteps:report.savedSteps,executionAllowed:false,artifact:'artifacts/live-plan.json'}));
  }finally{await application.app.close();}
}
try{await main();}catch(error){console.error(JSON.stringify({liveCheck:'failed',message:error instanceof Error?error.message:'تعذر الاختبار الحي.'}));process.exitCode=1;}
