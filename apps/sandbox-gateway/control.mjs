import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const allowedPath=/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const forbidden=/(?:^|\/)(?:\.env[^/]*|node_modules|\.git|\.data|\.next|secrets?|credentials)(?:\/|$)|\.(?:pem|key|pfx|p12)$/i;
const namePattern=/^mohassan-studio-[a-f0-9]{32}$/;
const tokenPattern=/^[a-f0-9]{48}$/;
const cwd='/vercel/sandbox/project',runtime='/vercel/sandbox/runtime';
const packages=['next@16.4.5','react@19.3.1','react-dom@19.3.1','typescript@5.9.3','@types/react@19.2.2','@types/node@24.10.0'];
const hash=value=>createHash('sha256').update(value).digest('hex');
function fault(code,status=400){return Object.assign(new Error(code),{code,status});}
export function validateInput(value){
  if(!value||typeof value!=='object'||!['create','proxy','stop','status'].includes(value.op)||!namePattern.test(value.name))throw fault('INVALID_REQUEST');
  if(value.op==='create'){
    if(!tokenPattern.test(value.cap)||!Array.isArray(value.files)||!value.files.length||value.files.length>100||!['react','next'].includes(value.framework))throw fault('INVALID_SOURCE');
    const paths=new Set();let total=0;
    for(const file of value.files){
      if(!file||typeof file.path!=='string'||!allowedPath.test(file.path)||file.path.length>180||forbidden.test(file.path)||file.path.split('/').some(x=>x==='.'||x==='..'||x.endsWith('.'))||!/\.(?:js|jsx|ts|tsx|mjs|css|json)$/.test(file.path)||typeof file.content!=='string'||file.content.includes('\0')||Buffer.byteLength(file.content)>128000||paths.has(file.path.toLowerCase()))throw fault('INVALID_SOURCE');
      paths.add(file.path.toLowerCase());total+=Buffer.byteLength(file.content);
    }
    if(total>512000)throw fault('SOURCE_TOO_LARGE');
    if(typeof value.entryPath!=='string'||!allowedPath.test(value.entryPath)||!paths.has(value.entryPath.toLowerCase())||!/[.](?:jsx|tsx|js|ts)$/.test(value.entryPath))throw fault('INVALID_ENTRY');
  }
  if(value.op==='proxy'){
    if(typeof value.path!=='string'||value.path.length>4096||!value.path.startsWith('/p/')||value.path.startsWith('//')||/[\\\r\n\0]/.test(value.path)||!['GET','HEAD','POST','OPTIONS'].includes(value.method??'GET')||typeof(value.body??'')!=='string'||(value.body??'').length>1500000)throw fault('INVALID_PROXY_REQUEST');
  }
  return value;
}
const proxyScript=`const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const headers={};for(const key of ['content-type','accept','rsc','next-action','next-router-state-tree','next-router-prefetch','next-url'])if(typeof input.headers?.[key]==='string')headers[key]=input.headers[key];headers.origin='http://127.0.0.1:3000';headers.host='127.0.0.1:3000';const response=await fetch('http://127.0.0.1:3000'+input.path,{method:input.method||'GET',headers,body:input.body?Buffer.from(input.body,'base64'):undefined,redirect:'manual',signal:AbortSignal.timeout(20000)});const reader=response.body?.getReader(),chunks=[];let size=0;if(reader)while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>3000000){await reader.cancel();throw Error('response limit')}chunks.push(Buffer.from(p.value))}console.log(JSON.stringify({status:response.status,headers:{'content-type':response.headers.get('content-type')||'application/octet-stream',location:response.headers.get('location')},body:Buffer.concat(chunks).toString('base64')}));`;

async function current(Sandbox,name){
  const sandbox=await Sandbox.get({name,resume:false});
  if(sandbox.status!=='running')throw fault('SANDBOX_EXPIRED',410);
  return sandbox;
}
async function create(Sandbox,input){
  const sandbox=await Sandbox.create({name:input.name,persistent:false,image:'vercel/sandbox/node:24',region:'lhr1',resources:{vcpus:1},timeout:600000,networkPolicy:{allow:['registry.npmjs.org']},ports:[],tags:{application:'mohassan-studio'}});
  try{
    await sandbox.mkDir(runtime);await sandbox.mkDir(cwd);
    await sandbox.writeFiles([{path:runtime+'/package.json',content:Buffer.from('{"private":true,"type":"module"}')}]);
    const install=await sandbox.runCommand({cmd:'npm',args:['install','--ignore-scripts','--no-audit','--no-fund','--save-exact',...packages],cwd:runtime,env:{NEXT_TELEMETRY_DISABLED:'1'},timeoutMs:150000});
    if(install.exitCode!==0)throw fault('TRUSTED_DEPENDENCIES_FAILED',502);
    // No user source exists in the VM while package registry access is enabled.
    await sandbox.update({networkPolicy:'deny-all'});
    await sandbox.runCommand({cmd:'node',args:['-e',`require('node:fs').symlinkSync(${JSON.stringify(runtime+'/node_modules')},${JSON.stringify(cwd+'/node_modules')},'dir')`],cwd,timeoutMs:5000});
    const files=input.files.filter(file=>file.path!=='package.json'&&!/(?:^|\/)(?:next|vite|webpack|babel|postcss|eslint|tailwind)\.config\./.test(file.path));
    const basePath='/p/'+input.cap;
    if(input.framework==='react'){
      files.push({path:'app/page.tsx',content:`'use client';\nimport App from '../${input.entryPath.replace(/\.[^.]+$/,'')}';export default function Page(){return <App/>}`});
    }
    const appRoot=input.framework==='next'&&input.entryPath.startsWith('src/app/')?'src/app':'app';
    if(!files.some(file=>new RegExp('^'+appRoot+'/layout[.][jt]sx?$').test(file.path)))files.push({path:appRoot+'/layout.tsx',content:'export default function Layout({children}){return <html><body>{children}</body></html>}'});
    files.push({path:'package.json',content:'{"private":true,"type":"module"}'},{path:'next.config.mjs',content:`export default {basePath:${JSON.stringify(basePath)},poweredByHeader:false,images:{unoptimized:true},experimental:{cpus:1},typescript:{ignoreBuildErrors:true},devIndicators:false}`});
    await sandbox.writeFiles(files.map(file=>({path:cwd+'/'+file.path,content:Buffer.from(file.content)})));
    const compile=await sandbox.runCommand({cmd:'node',args:[runtime+'/node_modules/next/dist/bin/next','build','--webpack'],cwd,env:{NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=1536'},timeoutMs:180000});
    if(compile.exitCode!==0)throw fault('NEXT_BUILD_FAILED',422);
    const server=await sandbox.runCommand({cmd:'node',args:[runtime+'/node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],cwd,env:{NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production'},detached:true,timeoutMs:600000});
    const probe=await sandbox.runCommand({cmd:'node',args:['--input-type=module','-e',`let ok=false;for(let n=0;n<20;n++){try{const r=await fetch('http://127.0.0.1:3000${basePath}',{redirect:'manual'});if(r.status<500){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}if(!ok)process.exit(1);console.log('ready')`],cwd,timeoutMs:15000});
    if(probe.exitCode!==0)throw fault('NEXT_NOT_READY',502);
    return {name:sandbox.name,expiresAt:sandbox.expiresAt?.toISOString()??new Date(Date.now()+600000).toISOString(),serverCommandId:server.cmdId,isolation:'microvm',network:'denied',sourceHash:hash(JSON.stringify(input.files)),ready:true};
  }catch(error){await sandbox.stop().catch(()=>{});throw error;}
}

export function createGatewayHandler({Sandbox,secret=()=>process.env.STUDIO_GATEWAY_SECRET,now=()=>Date.now()}){
  return async function handle(request){
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    try{
      const key=secret(),stamp=request.headers.get('x-studio-time')??'',signature=request.headers.get('x-studio-signature')??'';
      if(!key||key.length<32||!/^\d{13}$/.test(stamp)||Math.abs(now()-Number(stamp))>30000||!/^\w{64}$/.test(signature))throw fault('UNAUTHORIZED',401);
      if(Number(request.headers.get('content-length')??0)>1800000)throw fault('REQUEST_TOO_LARGE',413);
      const reader=request.body?.getReader();let size=0;const chunks=[];
      if(reader)while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>1800000){await reader.cancel();throw fault('REQUEST_TOO_LARGE',413)}chunks.push(Buffer.from(p.value));}
      const raw=Buffer.concat(chunks).toString('utf8'),expected=createHmac('sha256',key).update(stamp+'\n'+raw).digest('hex');
      if(!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw fault('UNAUTHORIZED',401);
      const input=validateInput(JSON.parse(raw));let result;
      if(input.op==='create')result=await create(Sandbox,input);
      else{
        const sandbox=await current(Sandbox,input.name);
        if(input.op==='stop'){await sandbox.stop();result={stopped:true};}
        else if(input.op==='status')result={status:sandbox.status,expiresAt:sandbox.expiresAt?.toISOString()};
        else{
          const response=await sandbox.runCommand({cmd:'node',args:['--input-type=module','-e',proxyScript,Buffer.from(JSON.stringify(input)).toString('base64')],cwd,timeoutMs:25000});
          if(response.exitCode!==0)throw fault('PREVIEW_REQUEST_FAILED',502);
          const output=await response.stdout();if(output.length>4100000)throw fault('PREVIEW_RESPONSE_TOO_LARGE',502);
          result=JSON.parse(output);
        }
      }
      return Response.json(result,{headers});
    }catch(error){const status=Number.isInteger(error?.status)?error.status:502;const code=/^[A-Z_]{2,60}$/.test(error?.code??'')?error.code:'GATEWAY_FAILED';return Response.json({error:{code,message:code}},{status,headers});}
  };
}
