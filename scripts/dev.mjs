import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
if(process.env.MOHASSAN_ISOLATED_TEST!=='true')dotenv.config({path:path.join(root,'.env'),quiet:true,override:!production});
const dataDir = process.env.DATA_DIR ?? path.join(root,'.data','postgres');
async function localSecret(name) {
  const target = path.join(root,'.data',name);
  try {return (await readFile(target,'utf8')).trim();}
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    await writeFile(target,value+'\n',{mode:0o600,flag:'wx'});
    return value;
  }
}
await mkdir(path.join(root,'.data'),{recursive:true});
if (production && (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET || !process.env.INTERNAL_API_SECRET || !process.env.WEB_ORIGIN?.startsWith('https://'))) {
  throw new Error('اضبط DATABASE_URL وBETTER_AUTH_SECRET وINTERNAL_API_SECRET وWEB_ORIGIN HTTPS قبل تشغيل الإنتاج.');
}
const env = {...process.env, NODE_ENV:production?'production':'development',DATA_DIR:dataDir,
  BETTER_AUTH_SECRET:process.env.BETTER_AUTH_SECRET || await localSecret('auth-secret'),
  INTERNAL_API_SECRET:process.env.INTERNAL_API_SECRET || await localSecret('server-secret'),
  SETUP_TOKEN:production?'':process.env.SETUP_TOKEN || await localSecret('setup-token'),
  MOHASSAN_SERVER_URL:`http://127.0.0.1:${process.env.SERVER_PORT || '4000'}`,
};
const webPort = process.env.PORT || new URL(env.WEB_ORIGIN || 'http://127.0.0.1:3000').port || '3000';
const children = [];
let shuttingDown = false;
function stop(code=0) {
  if(shuttingDown)return;
  shuttingDown=true;
  for(const child of children) {
    if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    else child.kill('SIGTERM');
  }
  process.exitCode=code;
}
function launch(args,cwd) {
  const child = spawn(process.execPath,args,{cwd,env,stdio:'inherit',windowsHide:true});
  children.push(child);
  child.on('error',()=>stop(1));
  child.on('exit',code=>{if(!shuttingDown)stop(code??1);});
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop());
launch(['--import','tsx',process.env.MOHASSAN_ISOLATED_TEST==='true'?'tests/e2e/server-entry.ts':'apps/server/src/index.ts'],root);
// Do not expose a ready web page while SQL migrations/auth/API are still starting.
let apiReady=false;
const readyDeadline=Date.now()+60000;
while(!shuttingDown&&Date.now()<readyDeadline){
  try{const response=await fetch(`${env.MOHASSAN_SERVER_URL}/health`,{signal:AbortSignal.timeout(700)});await response.body?.cancel();if(response.ok){apiReady=true;break;}}catch{/* The API is still starting. */}
  await delay(250);
}
if(apiReady&&!shuttingDown){
  launch([path.join(root,'node_modules/next/dist/bin/next'),production?'start':'dev',...(!production?['--webpack']:[]),'--hostname','127.0.0.1','--port',webPort],path.join(root,'apps/web'));
  console.log(`افتح ${env.WEB_ORIGIN || 'http://127.0.0.1:3000'} — رمز الإعداد في .data/setup-token`);
}else if(!shuttingDown){console.error('لم تصبح خدمة المهام جاهزة خلال مهلة التشغيل. راجع إعداد الاتصال وأعد التشغيل.');stop(1);}
