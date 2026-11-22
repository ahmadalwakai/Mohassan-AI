import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
// --local-lab: an owner-only local experiment on an empty embedded database. The root .env
// points DATABASE_URL at the tunnel to production, so this mode pins it empty BEFORE .env is
// read and reads .env without override; the server's own dotenv import never overrides either.
const localLab = process.argv.includes('--local-lab');
// --built-web: serve the web app from its production build (`npm run build` first) instead of the dev server.
// The dev server adds ~10 ms per request and compiles pages on first use (plan §5.2 P7).
const builtWeb = process.argv.includes('--built-web');
if (localLab && production) throw new Error('--local-lab is for local experiments only, never production.');
if (localLab) {
  // MOHASSAN_LAB_DIR: a second, separate lab (own embedded database and profiles) so two labs never share one PGlite folder.
  const lab = process.env.MOHASSAN_LAB_DIR ? path.resolve(root, process.env.MOHASSAN_LAB_DIR) : path.join(root,'.data','local-lab');
  // A named lab gets its own Next build folder: Next 16 keeps one dev lock per distDir (apps/web/<distDir>/dev/lock),
  // so a second `next dev` in apps/web only starts when its distDir differs from the running one's. Not for
  // --built-web (`next start` serves the production build in .next) or the isolated e2e run (.next-e2e).
  if (process.env.MOHASSAN_LAB_DIR && !builtWeb && process.env.MOHASSAN_ISOLATED_TEST !== 'true' && !process.env.NEXT_DIST_DIR) process.env.NEXT_DIST_DIR = `.next-${path.basename(lab)}`;
  Object.assign(process.env, {
    MOHASSAN_LOCAL_LAB: '1', DATABASE_URL: '', DATA_DIR: path.join(lab,'postgres'), BROWSER_PROFILE_DIR: path.join(lab,'browser-profile'),
    MOHASSAN_MIND: process.env.MOHASSAN_MIND ?? '0',
    CODING_DATA_DIR: path.join(lab,'coding'), STUDIO_AI_DATA_DIR: path.join(lab,'studio-ai'),
    GOOGLE_ADS_PUBLISHING_ENABLED: 'false', WINDOWS_REMOTE_ENABLED: 'false',
    EXECUTOR_EXPERIMENT: 'uncontained-local',
    // exec-c40m: the registry entry and the independent evaluation report both name this
    // inference checkpoint's identity (bfd7f686…); it failed the promotion gate and is experimental.
    EXECUTOR_CHECKPOINT: process.env.EXECUTOR_CHECKPOINT || 'artifacts/execution-model-runs/run-2026-11-12-c/inference-train-40m',
    EXECUTOR_REGISTRY_ENTRY: process.env.EXECUTOR_REGISTRY_ENTRY || 'artifacts/execution-model-runs/registry/exec-c40m-2026-11-12.json',
    EXECUTOR_EVALUATION_REPORT: process.env.EXECUTOR_EVALUATION_REPORT || 'artifacts/execution-model-runs/run-2026-11-12-c/evaluation/report.json',
    // The Ads model (34M, words-v1 tokenizer, names-v1 hint): checker gate 186/300 on unseen cities.
    ADS_MODEL_RUN: process.env.ADS_MODEL_RUN || 'artifacts/execution-model-runs/text-b2-2026-11-12',
  });
  await mkdir(lab,{recursive:true});
  // Optional lab-only settings (git-ignored with .data/). Read before .env and without override, so
  // its keys win over .env here and nowhere else. Used to point the lab's chat at the FreeLLMAPI
  // desktop gateway on this computer instead of the maintenance tunnel to the cloud gateway:
  //   FREELLMAPI_BASE_URL=http://127.0.0.1:31415/v1
  //   FREELLMAPI_API_KEY=<the desktop app's unified key>
  // DATABASE_URL is refused below whatever this file says.
  dotenv.config({path:path.join(lab,'lab.env'),quiet:true,override:false});
}
if(process.env.MOHASSAN_ISOLATED_TEST!=='true')dotenv.config({path:path.join(root,'.env'),quiet:true,override:!production&&!localLab});
if (localLab && process.env.DATABASE_URL !== '') throw new Error('--local-lab refused: DATABASE_URL is not empty.');
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
// The first AppContainer proof waits about 25 seconds for the OS network verdict on every interface.
const readyDeadline=Date.now()+180000;
while(!shuttingDown&&Date.now()<readyDeadline){
  try{const response=await fetch(`${env.MOHASSAN_SERVER_URL}/health`,{signal:AbortSignal.timeout(700)});await response.body?.cancel();if(response.ok){apiReady=true;break;}}catch{/* The API is still starting. */}
  await delay(250);
}
if(apiReady&&!shuttingDown&&builtWeb&&!production){
  try{await readFile(path.join(root,'apps/web/.next/BUILD_ID'),'utf8');}
  catch{console.error('لا توجد نسخة مبنية من الواجهة. شغّل أولًا: npm run build');stop(1);}
}
if(apiReady&&!shuttingDown){
  const serveBuilt=production||builtWeb;
  // `next start` insists on NODE_ENV=production for the web process alone; the API keeps its own setting.
  const webEnv=serveBuilt&&!production?{...env,NODE_ENV:'production'}:env;
  const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),serveBuilt?'start':'dev',...(!serveBuilt?['--webpack']:[]),'--hostname','127.0.0.1','--port',webPort],{cwd:path.join(root,'apps/web'),env:webEnv,stdio:'inherit',windowsHide:true});
  children.push(child);
  child.on('error',()=>stop(1));
  child.on('exit',code=>{if(!shuttingDown)stop(code??1);});
  console.log(`افتح ${env.WEB_ORIGIN || 'http://127.0.0.1:3000'} — رمز الإعداد في .data/setup-token`);
}else if(!shuttingDown){console.error('لم تصبح خدمة المهام جاهزة خلال مهلة التشغيل. راجع إعداد الاتصال وأعد التشغيل.');stop(1);}
