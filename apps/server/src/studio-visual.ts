import { createHash, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { sql, type Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StudioError } from '@mohassan/studio';

const viewport={width:1024,height:768};
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
type RenderInput={document:string;sourceHash:string};
export async function studioVisualMigration(db:Kysely<any>){
  await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    if(await tx.selectFrom('schema_migrations').select('version').where('version','=','009_studio_visual_reviews').executeTakeFirst())return;
    await sql`CREATE TABLE studio_review_images(id text PRIMARY KEY,owner_id text NOT NULL,session_id text NOT NULL REFERENCES studio_sessions(id),task_id text NOT NULL REFERENCES tasks(id),source_hash text NOT NULL,document_hash text NOT NULL,content_hash text NOT NULL,data_base64 text NOT NULL CHECK(char_length(data_base64)<=5600000),width integer NOT NULL,height integer NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at timestamptz NOT NULL)`.execute(tx);
    await sql`CREATE INDEX studio_review_images_owner_expiry_idx ON studio_review_images(owner_id,expires_at)`.execute(tx);
    await tx.insertInto('schema_migrations').values({version:'009_studio_visual_reviews'}).execute();
  });
}

/** Captures only the already-sanitized, inert preview. No project JavaScript or network is enabled. */
export async function captureStudioPair(baseline:RenderInput,candidate:RenderInput,signal:AbortSignal){
  for(const input of [baseline,candidate])if(input.document.length>500000||!/^[a-f0-9]{64}$/.test(input.sourceHash))throw new StudioError('STUDIO_CAPTURE_INPUT','تعذر إثبات مستند المعاينة.');
  signal.throwIfAborted();
  const browser=await chromium.launch({headless:true});
  const stop=()=>{void browser.close().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  try{
    const context=await browser.newContext({viewport,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false});
    await context.route('**/*',route=>route.abort('blockedbyclient'));
    const images:Buffer[]=[];
    for(const input of [baseline,candidate]){
      signal.throwIfAborted();const page=await context.newPage();page.setDefaultTimeout(10000);
      await page.setContent(input.document,{waitUntil:'load',timeout:10000});
      images.push(await page.screenshot({type:'png',animations:'disabled',timeout:10000}));await page.close();
    }
    signal.throwIfAborted();
    const first=PNG.sync.read(images[0]!),second=PNG.sync.read(images[1]!);
    const changedPixels=pixelmatch(first.data,second.data,undefined,viewport.width,viewport.height,{threshold:0.1,includeAA:false});
    return {baseline:images[0]!,candidate:images[1]!,visualDiff:{changedPixels,totalPixels:viewport.width*viewport.height,ratio:changedPixels/(viewport.width*viewport.height),...viewport}};
  }finally{signal.removeEventListener('abort',stop);await browser.close();}
}

export async function createStudioVisualControl(db:Kysely<any>){
  await studioVisualMigration(db);
  let busy=false;
  async function compare(ownerId:string,sessionId:string,taskId:string,baseline:RenderInput,candidate:RenderInput,signal:AbortSignal){
    if(busy)throw new StudioError('STUDIO_CAPTURE_BUSY','تجري مراجعة بصرية أخرى؛ أعد المحاولة بعد انتهائها.',409);
    busy=true;
    try{
      const task=await db.selectFrom('tasks').select('id').where('id','=',taskId).where('owner_id','=',ownerId).executeTakeFirst();
      const session=await db.selectFrom('studio_sessions').select('id').where('id','=',sessionId).where('owner_id','=',ownerId).executeTakeFirst();
      if(!task||!session)throw new StudioError('STUDIO_CAPTURE_DENIED','تعذر ربط المراجعة بالمهمة والمشروع.',403);
      const capture=await captureStudioPair(baseline,candidate,signal);
      const receipts=await db.transaction().execute(async tx=>{
        const user=await tx.selectFrom('user').select('id').where('id','=',ownerId).forUpdate().executeTakeFirst();
        if(!user)throw new StudioError('UNAUTHORIZED','سجل الدخول للمتابعة.',401);
        await tx.deleteFrom('studio_review_images').where('owner_id','=',ownerId).where('expires_at','<=',new Date()).execute();
        const count=await tx.selectFrom('studio_review_images').select(eb=>eb.fn.countAll().as('n')).where('owner_id','=',ownerId).executeTakeFirstOrThrow();
        if(Number(count.n)>78)throw new StudioError('STUDIO_REVIEW_QUOTA','بلغت حد المراجعات البصرية المحفوظة لسبعة أيام.',409);
        const receipts=[];
        for(const [input,bytes] of [[baseline,capture.baseline],[candidate,capture.candidate]] as const){
          if(bytes.length>4000000)throw new StudioError('STUDIO_CAPTURE_LIMIT','تجاوزت الصورة حد المراجعة.');
          const id=randomUUID(),contentHash=hash(bytes);
          await tx.insertInto('studio_review_images').values({id,owner_id:ownerId,session_id:sessionId,task_id:taskId,source_hash:input.sourceHash,document_hash:hash(input.document),content_hash:contentHash,data_base64:bytes.toString('base64'),...viewport,expires_at:new Date(Date.now()+7*24*3600000)}).execute();
          receipts.push({id,hash:contentHash,url:`/api/studio/reviews/artifacts/${id}`});
        }
        return receipts;
      });
      return {baselineScreenshot:receipts[0]!,candidateScreenshot:receipts[1]!,visualDiff:capture.visualDiff};
    }finally{busy=false;}
  }
  async function image(ownerId:string,id:string){
    const row=await db.selectFrom('studio_review_images').select(['data_base64','content_hash']).where('id','=',id).where('owner_id','=',ownerId).where('expires_at','>',new Date()).executeTakeFirst();
    if(!row)throw new StudioError('STUDIO_REVIEW_NOT_FOUND','لم يُعثر على صورة مراجعة سارية.',404);
    const bytes=Buffer.from(row.data_base64,'base64');if(bytes.length>4000000||hash(bytes)!==row.content_hash)throw new StudioError('STUDIO_REVIEW_CHANGED','تعذر إثبات صورة المراجعة.',409);
    return bytes;
  }
  async function register(app:FastifyInstance,owner:(request:any)=>Promise<{id:string}>){
    app.get<{Params:{id:string}}>('/api/studio/reviews/artifacts/:id',async(request,reply)=>reply.type('image/png').header('Content-Disposition','inline').send(await image((await owner(request)).id,z.uuid().parse(request.params.id))));
  }
  return {compare,image,register};
}
