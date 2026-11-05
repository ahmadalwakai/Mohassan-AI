import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({quiet:true,override:true});
const connectionString=process.env.NEON_DATABASE_URL||process.env.DATABASE_URL;
if(!connectionString)throw new Error('لم يُضبط اتصال Neon.');
const pool=new pg.Pool({connectionString,connectionTimeoutMillis:15000,max:1,enableChannelBinding:true});
try{
  const client=await pool.connect();
  try{
    const tables=await client.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log(JSON.stringify({connected:true,tls:Boolean((client as any).connection.stream.encrypted),existingPublicTables:tables.rowCount,existingAppTables:tables.rows.filter(row=>['user','tasks','schema_migrations'].includes(row.table_name)).map(row=>row.table_name)}));
  }finally{client.release();}
}catch(error){console.error(JSON.stringify({connected:false,code:typeof(error as any)?.code==='string'?(error as any).code:'CONNECTION_FAILED'}));process.exitCode=1;}
finally{await pool.end();}
