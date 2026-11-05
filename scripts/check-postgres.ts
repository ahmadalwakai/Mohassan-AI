import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase,migrate,sql } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
dotenv.config({quiet:true,override:true});
if(!process.argv.includes('--live'))throw new Error('أضف --live لفحص PostgreSQL الحقيقي.');
async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL غير مجهز.');
  const first=await createDatabase({connectionString:process.env.DATABASE_URL}),second=await createDatabase({connectionString:process.env.DATABASE_URL});
  const owner=`postgres-check-${randomUUID()}`;
  try{
    await migrate(first.db);const a=new Runtime(first.db),b=new Runtime(second.db);
    const input={title:'فحص PostgreSQL المتزامن',goal:'فحص claims والأحداث على اتصالين حقيقيين.',capabilityId:'system.diagnostic' as const,autonomy:'scoped' as const};
    const same=await Promise.all([a.createTask(owner,input,'same-postgres-request'),b.createTask(owner,input,'same-postgres-request')]);
    if(same[0].id!==same[1].id)throw new Error('فشل منع التكرار بين الاتصالين.');
    for(let index=0;index<5;index++)await a.createTask(owner,input,`postgres-request-${index}`);
    for(let index=0;index<4;index++)await Promise.all([a.tick(),b.tick()]);
    const tasks=(await a.snapshot(owner)).tasks;
    if(tasks.length!==6||tasks.some(task=>task.status!=='completed'||task.attempt!==1))throw new Error('فشل استفراد العامل بالمهمة أو إكمالها.');
    for(const task of tasks){const detail=await a.detail(owner,task.id);if(detail.events.length!==4||new Set(detail.events.map(event=>event.sequence)).size!==4)throw new Error('لم تتطابق الأحداث الذرية.');}
    let started!:()=>void,release!:()=>void;const began=new Promise<void>(accept=>started=accept),finish=new Promise<void>(accept=>release=accept);
    const slow=new Runtime(first.db,{executeDiagnostic:async()=>{started();await finish;return {};}});
    const staleTask=await a.createTask(owner,input,'postgres-fencing-request');const stale=slow.tick();await began;
    await sql`UPDATE tasks SET lease_expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE id=${staleTask.id}`.execute(second.db);
    await b.tick();release();await stale;
    const fenced=await a.detail(owner,staleTask.id);if(fenced.task.status!=='completed'||fenced.task.attempt!==2||fenced.events.filter(event=>event.type==='verification_passed').length!==1)throw new Error('فشل منع اعتماد العامل القديم.');
    const report={passed:true,checkedAt:new Date().toISOString(),storage:'postgres',independentPools:2,completedTasks:6,idempotencyAcrossPools:true,atomicEvents:true,staleWorkerFenced:true};
    await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/postgres-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{
    await first.db.deleteFrom('tasks').where('owner_id','=',owner).execute();await first.close();await second.close();
  }
}
try{await main();}catch(error){console.error(JSON.stringify({passed:false,code:(error as any)?.code??'POSTGRES_CHECK_FAILED',message:'لم يكتمل فحص PostgreSQL. راجع سجل الفحص المنقح.'}));process.exitCode=1;}
