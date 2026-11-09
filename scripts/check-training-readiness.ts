import { readFile,mkdir,writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';
import { Kysely,PostgresDialect,sql } from 'kysely';
import { auditTrainingReadiness } from '@mohassan/learning';

// Explicit inspection only. No application bootstrap, migrations, exports, or training.
if(!process.argv.includes('--live-readonly'))throw new Error('Use --live-readonly to inspect the configured SQL database without writes.');
let local:Record<string,string>={};try{local=dotenv.parse(await readFile('.env'));}catch(error:any){if(error?.code!=='ENOENT')throw new Error('تعذرت قراءة الإعداد الخاص.');}
const connectionString=process.env.DATABASE_URL??local.DATABASE_URL;
let report:Record<string,unknown>={checkedAt:new Date().toISOString(),scope:'read_only_readiness',trainingStarted:false,exported:false};
if(!connectionString){report={...report,available:false,reason:'DATABASE_NOT_CONFIGURED'};}
else{
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,options:'-c default_transaction_read_only=on -c statement_timeout=15000'});
  pool.on('error',()=>{});
  const db=new Kysely<any>({dialect:new PostgresDialect({pool})});
  try{
    const result=await db.transaction().execute(async tx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const {rows}=await sql<{table:string|null}>`SELECT to_regclass('public.experiences')::text AS "table"`.execute(tx);
      if(!rows[0]?.table)return {available:false,reason:'EXPERIENCE_SCHEMA_NOT_DEPLOYED'};
      const ownerArgument=process.argv.indexOf('--owner-id'),requestedOwner=ownerArgument>=0?process.argv[ownerArgument+1]:undefined;
      if(ownerArgument>=0&&(!requestedOwner||requestedOwner.length>200))return {available:false,reason:'OWNER_ARGUMENT_INVALID'};
      const owners=requestedOwner?[{owner_id:requestedOwner}]:await tx.selectFrom('experiences').select('owner_id').distinct().limit(2).execute();
      if(owners.length>1)return {available:false,reason:'OWNER_SELECTION_REQUIRED'};
      if(!owners.length)return {available:true,totalExperiences:0,eligibleUnique:0,requiredUnique:500,ready:false,reason:'NO_RECORDED_EXPERIENCES'};
      return {available:true,readiness:await auditTrainingReadiness(tx,owners[0].owner_id)};
    });
    report={...report,...result};
  }catch(error:any){report={...report,available:false,reason:typeof error?.code==='string'&&/^[A-Z0-9_]{2,40}$/.test(error.code)?error.code:'READ_ONLY_CHECK_UNAVAILABLE'};}
  finally{await db.destroy();}
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/training-readiness-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!report.available)process.exitCode=1;
