import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { OllamaProvider } from '@mohassan/providers';
import { chromium } from '@playwright/test';
import { createDatabase, migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { StudioChangeResultSchema } from '@mohassan/contracts';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createStudioControl } from '../apps/server/src/studio.js';
import { createStudioAiControl } from '../apps/server/src/studio-ai.js';

if(!process.argv.includes('--live'))throw new Error('أضف --live لإجراء طلب رؤية حي واحد إلى النموذج المحلي على نسخة اختبار مستقلة.');

const receiptPath=resolve('.data/verification/studio-vision-flow.json');
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const assert=(condition:unknown,code:string)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const report:Record<string,unknown>={checkedAt:new Date().toISOString(),fixtureOnly:true,database:'ephemeral-pglite',realOwnerChanges:false,modelRequestLimit:1,paidRequests:0,passed:false};
let directory='',database:Awaited<ReturnType<typeof createDatabase>>|undefined,runtime:Runtime|undefined,taskId:string|undefined,ownerId:string|undefined;

async function main(){
  const visionModel=process.env.LOCAL_MODEL_NAME;assert(visionModel,'LOCAL_MODEL_NOT_CONFIGURED');
  assert(process.env.NODE_ENV!=='production','LIVE_FIXTURE_REQUIRES_LOCAL_ENVIRONMENT');
  report.model=visionModel;
  let paidRequests=0;
  const countedFetch:typeof fetch=async(input,init)=>{
    const address=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    assert(address.href===`${(process.env.LOCAL_MODEL_URL||'http://127.0.0.1:11434').replace(/\/$/,'')}/api/chat`&&init?.method==='POST','LIVE_PROVIDER_ENDPOINT_DENIED');
    assert(paidRequests===0,'LIVE_PAID_REQUEST_LIMIT');paidRequests++;report.paidRequests=paidRequests;
    const response=await fetch(input,{...init,redirect:'error'});report.providerHttpStatus=response.status;
    const retryAfter=response.headers.get('retry-after');if(retryAfter&&/^\d{1,6}(?:\.\d{1,3})?$/.test(retryAfter))report.retryAfterSeconds=Number(retryAfter);
    if(!response.ok){
      try{const raw=await response.clone().text();if(Buffer.byteLength(raw)<32768){const upstream=JSON.parse(raw)?.error??{},metadata:Record<string,unknown>={};for(const key of ['code','type','param'])if(typeof upstream[key]==='string'&&/^[A-Za-z0-9_.\/[\]-]{1,100}$/.test(upstream[key]))metadata[key]=upstream[key];const message=typeof upstream.message==='string'?upstream.message:'';if(response.status===429){metadata.tokensPerMinute=/tokens per minute|\bTPM\b/i.test(message);for(const key of ['limit','used','requested']){const value=new RegExp('\\b'+key+'\\s*[:=]?\\s*(\\d+)','i').exec(message);if(value)metadata[key]=Number(value[1]);}const wait=/try again in\s*([\d.]+)\s*(ms|s|m)\b/i.exec(message);if(wait)metadata.retryHint={value:Number(wait[1]),unit:wait[2]};}if(response.status===400){metadata.schemaMentioned=/schema|response_format/i.test(message);metadata.unsupportedParameter=/unsupported|not supported|invalid parameter/i.test(message);}report.providerErrorMetadata=metadata;}}catch{/* Never persist an upstream error body or identifiers. */}
    }
    return response;
  };
  directory=await mkdtemp(join(tmpdir(),'mohassan-studio-vision-live-'));
  const source=join(directory,'source');await mkdir(source);
  const title='عنوان ثابت للاختبار';
  const originalFiles={
    'index.html':`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head><body><main class="card"><h1>${title}</h1><p>بطاقة مرئية لاختبار الصورة فقط.</p></main></body></html>`,
    'styles.css':'*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4f0;font-family:Arial,sans-serif;color:#172d23}.card{width:360px;min-height:200px;padding:32px;border-radius:12px;background:#ffffff}h1{font-size:24px;margin:0 0 16px}p{font-size:14px;margin:0}',
  };
  for(const [path,content]of Object.entries(originalFiles))await writeFile(join(source,path),content,{flag:'wx'});
  // DATABASE_URL is intentionally never passed: no connection to Neon or owner data.
  database=await createDatabase();assert(database.mode==='embedded','LIVE_FIXTURE_DATABASE_MISMATCH');
  await migrateAuth(database.db);await migrate(database.db);
  ownerId=randomUUID();await database.db.insertInto('user').values({id:ownerId,name:'Studio vision isolated fixture',email:`${ownerId}@vision-fixture.example.test`}).execute();
  const studio=await createStudioControl(database.db,{allowedRoots:[source]});
  const session=await studio.create(ownerId,{name:'تجربة رؤية مستقلة',path:source,entryPath:'index.html',framework:'static'});
  const imageColor={r:27,g:112,b:67};
  const png=await sharp({create:{width:64,height:64,channels:3,background:imageColor}}).png().toBuffer();
  const ai=await createStudioAiControl(database.db,{dataDir:join(directory,'proposals'),model:{name:visionModel!,vision:true,provider:()=>new OllamaProvider({model:visionModel!,baseUrl:process.env.LOCAL_MODEL_URL,fetch:countedFetch,vision:true,timeoutMs:180000,imageTimeoutMs:180000})},studio,validateCandidate:studio.validateCandidate,applyCandidate:studio.applyCandidate});
  const image=await ai.uploadImage(ownerId,{mimeType:'image/png',data:png.toString('base64')});
  report.image={width:image.width,height:image.height,bytes:image.bytes,hash:image.hash};
  runtime=new Runtime(database.db,{studioChange:async(goal,context)=>{try{return await ai.execute(goal,context);}catch(error){const code=(error as {code?:unknown}).code,status=(error as {httpStatus?:unknown}).httpStatus;if(typeof code==='string'&&/^[A-Z_]{2,80}$/.test(code))report.providerFailureCode=code;if(typeof status==='number'&&status>=400&&status<=599)report.providerHttpStatus=status;throw error;}},verifyStudioChange:ai.verify});
  const task=await runtime.createTask(ownerId,{title:'مطابقة البطاقة بالصورة — اختبار حي مستقل',goal:`اجعل لون خلفية البطاقة .card مطابقًا للون الوحيد الظاهر في الصورة المرفقة. حافظ على النص «${title}» وبقية النصوص والمقاسات والتخطيط والخلفية الخارجية كما هي. عدل styles.css فقط، ولا تعدل HTML أو تضف ملفات أو موارد شبكة.`,capabilityId:'studio.change',autonomy:'scoped',studioInput:{sessionId:session.id,revision:session.revision,imageId:image.id}},'single-live-studio-vision-request');taskId=task.id;
  assert(task.status==='waiting_approval'&&paidRequests===0,'LIVE_APPROVAL_NOT_ENFORCED');report.mandatoryApproval=true;
  await runtime.approve(ownerId,task.id);
  // Exactly one execution tick; failures or uncertain responses are never retried.
  await runtime.tick();
  const detail=await runtime.detail(ownerId,task.id);report.taskStatus=detail.task.status;if(detail.task.error)report.taskError=detail.task.error;
  report.tokenLedger=(detail.modelRuns??[]).map(row=>({model:row.model,status:row.status,inputTokens:row.inputTokens,outputTokens:row.outputTokens,usageKnown:row.usageKnown,resultCommitted:row.resultCommitted}));
  assert(detail.task.status==='completed','LIVE_VISION_TASK_NOT_COMPLETED');
  const result=StudioChangeResultSchema.parse(detail.task.result);
  assert(result.outcome==='ready_for_review'&&result.review.passed&&result.verification.passed&&result.checkpoint,'LIVE_VISION_PROPOSAL_NOT_VERIFIED');
  assert(result.model===visionModel&&paidRequests===1,'LIVE_VISION_PROVIDER_MISMATCH');
  assert(result.changes.length===1&&result.changes[0]?.path==='styles.css','LIVE_VISION_EDIT_SCOPE_MISMATCH');
  assert(result.visualDiff&&result.visualDiff.changedPixels>0&&result.baselineImageId&&result.candidateImageId,'LIVE_VISION_VISUAL_EVIDENCE_MISSING');
  assert((await studio.detail(ownerId,session.id)).revision===session.revision,'LIVE_VISION_APPLIED_WITHOUT_REVIEW');
  const before=await studio.reviews.image(ownerId,result.baselineImageId!),after=await studio.reviews.image(ownerId,result.candidateImageId!);
  report.visual={...result.visualDiff,beforeHash:digest(before),afterHash:digest(after)};report.git={checkpoint:result.checkpoint,diffHash:result.diffHash,changedPaths:result.changes.map(change=>change.path)};
  await ai.apply(ownerId,result.proposalId,{revision:session.revision});
  const applied=await studio.detail(ownerId,session.id);assert(applied.revision!==session.revision&&applied.historyCount===1,'LIVE_VISION_APPLY_FAILED');
  const preview=await studio.preview(ownerId,session.id),browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1024,height:768},javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});await context.route('**/*',route=>route.abort('blockedbyclient'));
    const page=await context.newPage();await page.setContent(preview.document,{waitUntil:'load',timeout:10000});
    const background=await page.locator('.card').evaluate(element=>getComputedStyle(element).backgroundColor),heading=await page.locator('h1').innerText(),bounds=await page.locator('.card').boundingBox();
    const channels=background.match(/[\d.]+/g)?.slice(0,3).map(Number);assert(channels?.length===3,'LIVE_VISION_COLOR_UNREADABLE');
    const distance=Math.sqrt(channels!.reduce((sum,value,index)=>sum+(value-[imageColor.r,imageColor.g,imageColor.b][index]!)**2,0));
    report.renderedColor={css:background,targetRgb:[imageColor.r,imageColor.g,imageColor.b],distance};
    assert(distance<=50&&channels![1]!>channels![0]!+15&&channels![1]!>channels![2]!+10,'LIVE_VISION_COLOR_MISMATCH');
    assert(heading.trim()===title&&bounds&&bounds.width>=300&&bounds.height>=180&&await page.locator('h1').isVisible(),'LIVE_VISION_CONTENT_CHANGED');
  }finally{await browser.close();}
  const restored=await studio.undo(ownerId,session.id,{revision:applied.revision});assert(JSON.stringify(restored.files)===JSON.stringify(session.files)&&restored.revision!==session.revision,'LIVE_VISION_UNDO_FAILED');
  for(const [path,content]of Object.entries(originalFiles))assert(await readFile(join(source,path),'utf8')===content,'LIVE_VISION_ORIGINAL_FILES_CHANGED');
  report.appliedToFixture=true;report.undoRestored=true;report.originalFilesUnchanged=true;report.passed=true;
}

try{await main();}catch(error){
  const code=(error as {code?:unknown})?.code;report.errorCode=typeof code==='string'&&/^[A-Z_]{2,80}$/.test(code)?code:'LIVE_VISION_FLOW_FAILED';
  if(database&&runtime&&taskId&&ownerId){try{const detail=await runtime.detail(ownerId,taskId);report.taskStatus=detail.task.status;report.tokenLedger=(detail.modelRuns??[]).map(row=>({model:row.model,status:row.status,inputTokens:row.inputTokens,outputTokens:row.outputTokens,usageKnown:row.usageKnown,resultCommitted:row.resultCommitted}));}catch{/* Keep the small, nonsecret failure receipt already collected. */}}
  process.exitCode=1;
}finally{
  try{await runtime?.stop();}catch{report.cleanupError=true;process.exitCode=1;}
  try{await database?.close();}catch{report.cleanupError=true;process.exitCode=1;}
  if(directory){try{const base=await realpath(tmpdir()),target=await realpath(directory),inside=relative(base,target);assert(isAbsolute(target)&&inside.startsWith('mohassan-studio-vision-live-')&&!inside.startsWith('..')&&!isAbsolute(inside),'LIVE_FIXTURE_CLEANUP_SCOPE');await rm(target,{recursive:true,force:true});report.temporaryFilesRemoved=true;}catch{report.cleanupError=true;process.exitCode=1;}}
  if(report.cleanupError)report.passed=false;
  await mkdir(resolve('.data/verification'),{recursive:true});await writeFile(receiptPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,model:report.model,paidRequests:report.paidRequests,providerHttpStatus:report.providerHttpStatus,providerFailureCode:report.providerFailureCode,taskStatus:report.taskStatus,tokenLedger:report.tokenLedger,changedPixels:(report.visual as {changedPixels?:number}|undefined)?.changedPixels,errorCode:report.errorCode,fixtureOnly:true,receipt:'.data/verification/studio-vision-flow.json'}));
}
