import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../apps/server/src/app.js';

/**
 * Live planning check against the owner's local model on this computer. The test owner,
 * task and health row live only in an in-memory database; DATABASE_URL is refused.
 *   npx tsx scripts/check-ai.ts --live [--model qwen3.5:9b-q4_K_M]
 */
if(!process.argv.includes('--live'))throw new Error('أضف --live لإجراء اختبار صريح يستدعي النموذج المحلي.');
if(process.env.DATABASE_URL)throw new Error('LIVE_CHECK_REFUSES_DATABASE_URL: هذا الفحص يعمل على قاعدة مؤقتة فقط.');
const arg=(name:string)=>{const index=process.argv.indexOf(name);return index>0?process.argv[index+1]:undefined;};
async function main(){
  const model=arg('--model')??process.env.LOCAL_MODEL_NAME;if(!model)throw new Error('حدد --model أو LOCAL_MODEL_NAME.');
  const secret=()=>randomBytes(32).toString('hex');const internal=secret(),setupToken=secret();
  const application=await createApplication({authSecret:secret(),internalSecret:internal,setupToken,webOrigin:'http://127.0.0.1:3000',production:false,runWorker:false,localModel:{model,baseUrl:process.env.LOCAL_MODEL_URL}});
  try{
    const health=await application.ai.verify();
    const headers={'x-mohassan-internal':internal,origin:'http://127.0.0.1:3000'};
    const password=secret();
    const setup=await application.app.inject({method:'POST',url:'/api/setup',headers,payload:{name:'اختبار النموذج المحلي المعزول',email:'live-check@example.test',password,setupToken}});
    if(setup.statusCode!==200)throw new Error('تعذر إعداد اختبار المصادقة المعزول.');
    const login=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers,payload:{email:'live-check@example.test',password}});
    if(login.statusCode!==200)throw new Error('تعذر تسجيل الدخول في الاختبار المعزول.');
    const cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
    const created=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'local-live-planning-check'},payload:{title:'خطة مراجعة مشروع — اختبار حي',goal:'أعد خطة من ثلاث خطوات لتنظيم مراجعة مشروع برمجي. حدد معايير النجاح والأدلة المتوقعة والأسئلة اللازمة. لا تنفذ أي أداة.',capabilityId:'plan.draft',autonomy:'assisted'}});
    if(created.statusCode!==200||created.json().status!=='waiting_approval')throw new Error('فشل حفظ مهمة التخطيط أو حماية الموافقة.');
    const task=created.json();
    const approved=await application.app.inject({method:'POST',url:`/api/tasks/${task.id}/approve`,headers:{...headers,cookie},payload:{}});
    if(approved.statusCode!==200)throw new Error('لم تُقبل موافقة الاختبار.');
    const started=Date.now();await application.runtime.tick();
    const detail=await application.runtime.detail(task.ownerId,task.id);
    if(detail.task.status!=='completed'||detail.task.result?.kind!=='plan')throw new Error(`لم تجتز الخطة الحية التحقق؛ الحالة: ${detail.task.status}. ${detail.task.error??''}`);
    if(detail.task.result.executionAllowed!==false||!detail.steps?.length||!detail.modelRuns?.[0]?.resultCommitted)throw new Error('فشل التحقق من حفظ الخطة أو منع تنفيذها.');
    const report={checkedAt:new Date().toISOString(),source:'local-ollama-live',connection:health,seconds:Math.round((Date.now()-started)/1000),taskStatus:detail.task.status,provider:detail.task.result.provider,model:detail.task.result.model,usage:detail.task.result.usage,verification:detail.task.result.verification,executionAllowed:false,savedSteps:detail.steps.length,modelRun:detail.modelRuns[0],plan:detail.task.result.plan};
    await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/live-plan.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({liveCheck:'passed',connection:health.status,provider:report.provider,model:report.model,seconds:report.seconds,usage:report.usage,savedSteps:report.savedSteps,executionAllowed:false,artifact:'artifacts/live-plan.json'}));
  }finally{await application.app.close();}
}
try{await main();}catch(error){console.error(JSON.stringify({liveCheck:'failed',message:error instanceof Error?error.message:'تعذر الاختبار الحي.'}));process.exitCode=1;}
