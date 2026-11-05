import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createApplication } from '../apps/server/src/app.js';
dotenv.config({quiet:true,override:true});
if(!process.argv.includes('--live'))throw new Error('أضف --live لتشغيل اختبار برمجة حقيقي مع Groq وبيئة العزل.');
async function main(){
  if(!process.env.GROQ_API_KEY)throw new Error('مفتاح Groq غير مجهز.');
  const dataDir=await mkdtemp(join(tmpdir(),'mohassan-coding-live-')),secret=()=>randomBytes(32).toString('hex');
  const internal=secret(),setupToken=secret(),password=secret();
  const application=await createApplication({authSecret:secret(),internalSecret:internal,setupToken,webOrigin:'http://127.0.0.1:3000',production:false,runWorker:false,groqApiKey:process.env.GROQ_API_KEY,groqModel:process.env.GROQ_MODEL,groqReasoningModel:process.env.GROQ_REASONING_MODEL,codingDataDir:dataDir,codingAllowedRoots:[dataDir]});
  try{
    const sandbox=await application.coding.sandbox.available();if(!sandbox.available)throw new Error(sandbox.message);
    const headers={'x-mohassan-internal':internal,origin:'http://127.0.0.1:3000'};
    const setup=await application.app.inject({method:'POST',url:'/api/setup',headers,payload:{name:'اختبار برمجة معزول',email:'coding-live@example.test',password,setupToken}});if(setup.statusCode!==200)throw new Error('فشل إعداد حساب الاختبار المعزول.');
    const login=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers,payload:{email:'coding-live@example.test',password}});if(login.statusCode!==200)throw new Error('فشلت مصادقة الاختبار.');
    const cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
    const demo=await application.app.inject({method:'POST',url:'/api/coding/projects/demo',headers:{...headers,cookie},payload:{}});if(demo.statusCode!==200)throw new Error('فشل إنشاء مستودع التجربة.');
    const project=demo.json();
    const created=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'coding-live-request'},payload:{title:'إصلاح الجمع — اختبار حي معزول',goal:'أصلح دالة sum لتعيد جمع العددين بصورة صحيحة، مع بقاء الاختبارات والإعدادات دون تعديل.',capabilityId:'coding.change',projectId:project.id,autonomy:'scoped'}});
    if(created.statusCode!==200||created.json().status!=='waiting_approval')throw new Error('فشل فرض الموافقة على الكتابة والتشغيل.');
    const task=created.json();const approved=await application.app.inject({method:'POST',url:`/api/tasks/${task.id}/approve`,headers:{...headers,cookie},payload:{}});if(approved.statusCode!==200)throw new Error('فشلت موافقة البرمجة.');
    await application.runtime.tick();
    const detail=await application.runtime.detail(task.ownerId,task.id);const result=detail.task.result;
    if(detail.task.status!=='completed'||result?.kind!=='coding'||result.outcome!=='ready_for_review'){
      const codingRuns=await application.database.db.selectFrom('coding_runs').select(['status','error_code']).where('task_id','=',task.id).execute();
      await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/live-coding-failure.json'),JSON.stringify({dataDir,detail,codingRuns},null,2));
      console.error(JSON.stringify({failedStage:detail.events.at(-2)?.type,codingRuns,modelRuns:detail.modelRuns,retainedDataDir:dataDir}));
      throw new Error(`لم تجتز البرمجة الحية التحقق. الحالة ${detail.task.status}. ${detail.task.error??''}`);
    }
    const report={checkedAt:new Date().toISOString(),source:'groq-live-and-native-appcontainer',taskStatus:detail.task.status,result,events:detail.events,modelRuns:detail.modelRuns};
    await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/live-coding.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,provider:(result.tests as any)?.provider,baselineExitCode:(result.baselineTests as any)?.exitCode,finalExitCode:(result.tests as any)?.exitCode,checkpoint:result.checkpoint,sourceUnchanged:result.sourceUnchanged,merged:result.merged,usage:result.usage,retainedDataDir:dataDir,artifact:'artifacts/live-coding.json'}));
  }finally{await application.app.close();}
}
try{await main();}catch(error){console.error(JSON.stringify({passed:false,message:error instanceof Error&&!/postgres(?:ql)?:\/\//.test(error.message)?error.message:'فشل فحص البرمجة المنقح.'}));process.exitCode=1;}
