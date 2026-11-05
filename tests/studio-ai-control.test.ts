import { randomUUID } from 'node:crypto';
import { mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute,join,relative } from 'node:path';
import sharp from 'sharp';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createDatabase,migrate } from '@mohassan/database';
import { Runtime } from '@mohassan/runtime';
import { StudioAiError,studioManifestHash } from '@mohassan/studio-ai';
import { migrateAuth } from '../apps/server/src/auth.ts';
import { createStudioControl } from '../apps/server/src/studio.ts';
import { createStudioAiControl,type StudioAiConfig } from '../apps/server/src/studio-ai.ts';

describe('studio AI worktrees, visual verification and explicit SQL application',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>,studio:Awaited<ReturnType<typeof createStudioControl>>,directory:string;
  const owner='studio-ai-owner-fixture';
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'mohassan-studio-ai-test-'));store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);await store.db.insertInto('user').values({id:owner,name:'Studio AI fixture',email:'studio-ai@example.test'}).execute();studio=await createStudioControl(store.db,{allowedRoots:[]});});
  afterEach(async()=>{await store?.close();if(directory){const base=await realpath(tmpdir()),target=await realpath(directory),inside=relative(base,target);if(isAbsolute(inside)||inside.startsWith('..')||!inside.startsWith('mohassan-studio-ai-test-'))throw new Error('Unsafe test cleanup');await rm(target,{recursive:true,force:true});}});
  async function configured(extra:Partial<StudioAiConfig>={}){
    const control=await createStudioAiControl(store.db,{dataDir:directory,studio,validateCandidate:studio.validateCandidate,applyCandidate:studio.applyCandidate,generate:async request=>{const file=request.files.find(file=>file.path==='index.html')!;return {text:JSON.stringify({summary:'مقترح مضبوط للمراجعة، باستعمال نموذج fixture فقط.',edits:[{path:file.path,content:file.content.replace(/<h1>(.*?)<\/h1>/s,'<h1>مقترح استوديو موثق</h1>')}]}),model:'fixture-model',usage:{inputTokens:53,outputTokens:17}};},...extra});
    const runtime=new Runtime(store.db,{studioChange:control.execute,verifyStudioChange:control.verify});const session=await studio.demo(owner);return {control,runtime,session};
  }
  async function run(context:Awaited<ReturnType<typeof configured>>,imageId?:string){const {runtime,session}=context;const task=await runtime.createTask(owner,{title:'مقترح استوديو اختبار',goal:'غيّر عنوان الصفحة مع الحفاظ على النطاق وأنتج مراجعة بصرية.',capabilityId:'studio.change',autonomy:'scoped',studioInput:{sessionId:session.id,revision:session.revision,...(imageId?{imageId}:{})}},randomUUID());expect(task.status).toBe('waiting_approval');await runtime.approve(owner,task.id);await runtime.tick();return runtime.detail(owner,task.id);}
  it('round-trips a real Git/SQL proposal with actual Chromium images before explicit CAS apply and undo',async()=>{
    const context=await configured(),detail=await run(context);
    expect(detail.task.status).toBe('completed');expect(detail.task.result?.kind).toBe('studio_change');expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:53,outputTokens:17,resultCommitted:true});
    const result=detail.task.result!;expect(result.applied).toBe(false);expect(result.visualDiff).toEqual(expect.objectContaining({totalPixels:1024*768}));expect((result.visualDiff as any).changedPixels).toBeGreaterThan(0);
    expect((await studio.detail(owner,context.session.id)).files).toEqual(context.session.files);
    const stored=await context.control.proposal(owner,String(result.proposalId));expect(studioManifestHash(stored.payload)).toBe(stored.row.payload_hash);expect(stored.payload.result.diff).toContain('مقترح استوديو موثق');
    expect((await studio.reviews.image(owner,String(result.baselineImageId))).subarray(1,4).toString()).toBe('PNG');
    await expect(context.control.proposal('other-owner',String(result.proposalId))).rejects.toMatchObject({code:'STUDIO_PROPOSAL_NOT_FOUND'});
    await expect(context.control.apply(owner,String(result.proposalId),{revision:'0'.repeat(64)})).rejects.toMatchObject({code:'STUDIO_REVISION_CONFLICT'});
    const applied=await context.control.apply(owner,String(result.proposalId),{revision:context.session.revision}) as {applied:boolean;revision:string};expect(applied.applied).toBe(true);expect(applied.revision).not.toBe(context.session.revision);
    expect((await studio.preview(owner,context.session.id)).document).toContain('مقترح استوديو موثق');
    expect(await context.control.apply(owner,String(result.proposalId),{revision:context.session.revision})).toMatchObject({applied:true,revision:applied.revision});
    const undone=await studio.undo(owner,context.session.id,{revision:applied.revision});expect(undone.files).toEqual(context.session.files);
  });
  it('rejects a proposal after its worktree changes and never writes the current review source',async()=>{
    const context=await configured(),detail=await run(context),result=detail.task.result!;
    expect(detail.task.status).toBe('completed');const stored=await context.control.proposal(owner,String(result.proposalId));await writeFile(join(stored.payload.worktree,'index.html'),'<h1>Unreviewed local change</h1>');
    await expect(context.control.apply(owner,String(result.proposalId),{revision:context.session.revision})).rejects.toMatchObject({code:'STUDIO_REVIEW_CHANGED'});expect((await studio.detail(owner,context.session.id)).revision).toBe(context.session.revision);
  });
  it('preserves source and paid usage when candidate rendering fails without auto-applying',async()=>{
    const context=await configured({validateCandidate:async()=>{throw new StudioAiError('REACT_RENDER_FAILED','Explicit render failure fixture',422);}}),detail=await run(context);
    expect(detail.task.status).toBe('failed');expect(detail.task.result).toMatchObject({kind:'studio_change',outcome:'tests_failed',checkpoint:null,applied:false});expect(detail.task.result?.diff).toContain('مقترح استوديو موثق');expect(detail.modelRuns?.[0]).toMatchObject({usageKnown:true,inputTokens:53,outputTokens:17});expect((await studio.detail(owner,context.session.id)).revision).toBe(context.session.revision);
    await expect(context.control.apply(owner,String(detail.task.result?.proposalId),{revision:context.session.revision})).rejects.toMatchObject({code:'STUDIO_APPLY_DENIED'});
  });
  it('binds a normalized owner image to the approved task and passes it only during the model request',async()=>{
    let sentImage=false;
    const context=await configured({visionModel:'fixture-vision',generate:async request=>{sentImage=Boolean(request.image);expect(request.image?.mimeType).toBe('image/png');const file=request.files.find(file=>file.path==='index.html')!;return {text:JSON.stringify({summary:'Screenshot fixture proposal',edits:[{path:file.path,content:file.content.replace(/<h1>(.*?)<\/h1>/s,'<h1>تصميم من صورة fixture</h1>')}]}),model:'fixture-vision',usage:{inputTokens:71,outputTokens:22}};}});
    const data=(await sharp({create:{width:64,height:48,channels:3,background:'#356b4f'}}).png().toBuffer()).toString('base64');const image=await context.control.uploadImage(owner,{mimeType:'image/png',data});expect(image).toMatchObject({width:64,height:48});
    expect(sentImage).toBe(false);await expect(context.control.image('other-owner',image.id)).rejects.toMatchObject({code:'STUDIO_IMAGE_NOT_FOUND'});
    const detail=await run(context,image.id);expect(detail.task.status).toBe('completed');expect(sentImage).toBe(true);expect(detail.task.studioInput?.imageId).toBe(image.id);
    await expect(context.control.uploadImage(owner,{mimeType:'image/jpeg',data})).rejects.toMatchObject({code:'STUDIO_IMAGE_INVALID'});
  });
});
