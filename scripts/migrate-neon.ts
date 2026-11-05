import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase,migrate,sql } from '@mohassan/database';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createAIControl } from '../apps/server/src/ai.js';

dotenv.config({quiet:true,override:true});
if(!process.argv.includes('--activate'))throw new Error('أضف --activate لتهيئة Neon ونقل البيانات المحلية ثم تفعيل الاتصال.');
async function main(){
  const targetUrl=process.env.NEON_DATABASE_URL||process.env.DATABASE_URL;
  if(!targetUrl)throw new Error('اتصال Neon غير مجهز.');
  const localPath=resolve(process.env.DATA_DIR||'.data/postgres');
  const source=await createDatabase({dataDir:localPath});
  const target=await createDatabase({connectionString:targetUrl});
  try{
    await migrateAuth(target.db);await migrate(target.db);await createAIControl(target.db,{});
    await sql`CREATE TABLE IF NOT EXISTS local_import_receipts(id text PRIMARY KEY,source_hash text NOT NULL,counts jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT now())`.execute(target.db);
    const order=['user','account','session','verification','rateLimit','workspace_owner','coding_projects','tasks','task_events','approvals','task_plan_steps','task_plan_dependencies','model_runs','coding_runs','ai_provider_health'];
    const existing=await sql<{table_name:string}>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`.execute(source.db);
    const available=new Set(existing.rows.map(row=>row.table_name));
    const sourceHash=createHash('sha256').update(localPath.toLowerCase()).digest('hex');
    const report=await target.db.transaction().execute(async tx=>{
      await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
      const receipt=await tx.selectFrom('local_import_receipts').selectAll().where('id','=','local-foundation').executeTakeFirst();
      if(receipt){if(receipt.source_hash!==sourceHash)throw new Error('يوجد استيراد سابق من مصدر محلي مختلف.');return {alreadyImported:true,counts:receipt.counts};}
      const counts:Record<string,number>={};
      for(const table of order){
        const targetCount=await tx.selectFrom(table).select(({fn})=>fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
        if(Number(targetCount.count)!==0)throw new Error('قاعدة الهدف تحتوي بيانات تطبيق؛ أُوقف النقل لمنع الكتابة فوقها.');
      }
      for(const table of order){
        if(!available.has(table)){counts[table]=0;continue;}
        const rows=await source.db.selectFrom(table).selectAll().execute();
        const columns=await sql<{column_name:string,data_type:string}>`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=${table}`.execute(source.db);
        const jsonColumns=new Set(columns.rows.filter(column=>['json','jsonb'].includes(column.data_type)).map(column=>column.column_name));
        const prepared=rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,jsonColumns.has(key)&&value!==null?JSON.stringify(value):value])));
        for(let offset=0;offset<prepared.length;offset+=100)await tx.insertInto(table).values(prepared.slice(offset,offset+100)).execute();
        const count=await tx.selectFrom(table).select(({fn})=>fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
        if(Number(count.count)!==rows.length)throw new Error('لم تتطابق أعداد الصفوف بعد النقل.');counts[table]=rows.length;
      }
      await tx.insertInto('local_import_receipts').values({id:'local-foundation',source_hash:sourceHash,counts:JSON.stringify(counts)}).execute();
      return {alreadyImported:false,counts};
    });
    const envPath=resolve('.env');let environment=await readFile(envPath,'utf8');
    const line=`DATABASE_URL=${targetUrl}`;environment=/^DATABASE_URL=.*$/m.test(environment)?environment.replace(/^DATABASE_URL=.*$/m,line):environment+(environment.endsWith('\n')?'':'\n')+line+'\n';
    environment=environment.replace(/^NEON_DATABASE_URL=.*\r?\n?/m,'');await writeFile(envPath,environment,{mode:0o600});
    const result={activated:true,storage:'postgres',verifiedAt:new Date().toISOString(),...report};
    await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/neon-import.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  }finally{await source.close();await target.close();}
}
try{await main();}catch(error){console.error(JSON.stringify({activated:false,message:error instanceof Error&&!/postgres(?:ql)?:\/\//i.test(error.message)?error.message:'تعذر النقل إلى Neon؛ لم تُعرض بيانات الاتصال.'}));process.exitCode=1;}
