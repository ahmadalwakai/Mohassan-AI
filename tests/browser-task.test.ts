import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createDatabase,migrate} from '@mohassan/database';
import type {BrowserObservation} from '@mohassan/browser';
import {migrateAuth} from '../apps/server/src/auth.js';
import {createBrowserTaskControl,type BrowserTaskExecutionContext} from '../apps/server/src/browser-task.js';

describe('task-bound browser execution and independent screenshot evidence',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>,image:string;
  const owner='browser-task-owner',url='https://example.com/';
  beforeEach(async()=>{
    store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);
    await store.db.insertInto('user').values({id:owner,name:'Browser task fixture',email:'browser-task@example.test'}).execute();
    image='data:image/jpeg;base64,'+(await sharp({create:{width:64,height:48,channels:3,background:'#236347'}}).jpeg().toBuffer()).toString('base64');
  });
  afterEach(async()=>{await store?.close();});

  async function fixture(options:{withoutScreenshot?:boolean;afterAction?:()=>void;forge?:boolean}={}){
    let sessionId:string|undefined,sequence=0;
    const browser={
      create:vi.fn(async(ownerId:string,input:any)=>{
        sessionId=randomUUID();await store.db.insertInto('browser_sessions').values({id:sessionId,owner_id:ownerId,title:input.title,allowed_origins:JSON.stringify(input.allowedOrigins),expires_at:new Date(Date.now()+1800000)}).execute();return {id:sessionId};
      }),
      action:vi.fn(async(ownerId:string,id:string,_input:any)=>{
        const observation:BrowserObservation={id:randomUUID(),url,title:'Public fixture page',text:'The public fixture page was read by the isolated browser service.',links:[],forms:[],observedAt:new Date().toISOString(),warnings:[],screenshot:options.withoutScreenshot?null:image};
        await store.db.updateTable('browser_sessions').set({observation:JSON.stringify(observation),sequence:++sequence}).where('id','=',id).where('owner_id','=',ownerId).execute();
        await store.db.insertInto('browser_observations').values({id:observation.id,session_id:id,sequence,data:JSON.stringify({...observation,screenshot:null})}).execute();
        options.afterAction?.();
        return {id,observation:options.forge?{...observation,title:'Forged return value'}:observation};
      }),
      detail:vi.fn(),
      close:vi.fn(async(ownerId:string,id:string)=>{await store.db.updateTable('browser_sessions').set({status:'closed'}).where('id','=',id).where('owner_id','=',ownerId).execute();return {id};}),
    };
    const control=await createBrowserTaskControl(store.db,{browser:browser as any});
    const taskId=randomUUID(),leaseToken=randomUUID(),browserInput={url};
    await store.db.insertInto('tasks').values({id:taskId,owner_id:owner,title:'Browser fixture task',goal:'Open a public fixture and show its screenshot.',capability_id:'browser.open',autonomy:'scoped',status:'running',input_hash:'fixture',idempotency_key:randomUUID(),lease_token:leaseToken,lease_expires_at:new Date(Date.now()+120000),browser_input:JSON.stringify(browserInput)}).execute();
    const context:BrowserTaskExecutionContext={taskId,ownerId:owner,leaseToken,browserInput,signal:new AbortController().signal};
    return {control,browser,context,session:()=>sessionId};
  }

  it('persists a real JPEG bound to the owner, task, input and original saved observation',async()=>{
    const {control,browser,context}=await fixture(),result=await control.execute('Open the fixture.',context);
    expect(result).toMatchObject({kind:'browser_open',outcome:'opened',url,screenshotAvailable:true,screenshotUrl:`/api/browser/tasks/${context.taskId}/screenshot`});
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);expect(result.screenshotHash).toMatch(/^[a-f0-9]{64}$/);expect(browser.action).toHaveBeenCalledTimes(1);
    expect(await control.verify(result,context)).toEqual(result);
    const saved=await control.screenshot(owner,context.taskId);expect(saved.bytes.toString('base64')).toBe(image.split(',')[1]);expect(saved.hash).toBe(result.screenshotHash);
    // The receipt remains tied to its observation after a later manual navigation.
    await store.db.updateTable('browser_sessions').set({observation:JSON.stringify({id:randomUUID(),title:'Later navigation'})}).where('id','=',result.sessionId).execute();
    const restored=await createBrowserTaskControl(store.db,{browser:browser as any});expect(await restored.verify(result,context)).toEqual(result);expect((await restored.screenshot(owner,context.taskId)).hash).toBe(result.screenshotHash);
    await expect(control.screenshot('another-owner',context.taskId)).rejects.toMatchObject({code:'BROWSER_TASK_SCREENSHOT_NOT_FOUND',statusCode:404});
  });

  it('rejects forged results, other owners, altered scope and changed stored evidence',async()=>{
    const {control,context}=await fixture(),result=await control.execute('Open the fixture.',context);
    expect(await control.verify({...result,title:'Forged page title'},context)).toBeNull();
    expect(await control.verify(result,{...context,ownerId:'another-owner'})).toBeNull();
    expect(await control.verify(result,{...context,taskId:randomUUID()})).toBeNull();
    expect(await control.verify(result,{...context,browserInput:{url:'https://other.example/'}})).toBeNull();
    const history=await store.db.selectFrom('browser_observations').select('data').where('id','=',result.observationId).executeTakeFirstOrThrow();
    await store.db.updateTable('browser_observations').set({data:JSON.stringify({...history.data,text:'Changed after execution'})}).where('id','=',result.observationId).execute();
    expect(await control.verify(result,context)).toBeNull();await expect(control.screenshot(owner,context.taskId)).rejects.toMatchObject({statusCode:404});
  });

  it('never opens without a current task lease and refuses duplicate execution',async()=>{
    const {control,browser,context}=await fixture();
    await expect(control.execute('Open the fixture.',{...context,leaseToken:randomUUID()})).rejects.toMatchObject({code:'BROWSER_TASK_LEASE_DENIED'});expect(browser.create).not.toHaveBeenCalled();
    const aborted=new AbortController();aborted.abort();await expect(control.execute('Open the fixture.',{...context,signal:aborted.signal})).rejects.toMatchObject({code:'BROWSER_TASK_CANCELLED'});expect(browser.create).not.toHaveBeenCalled();
    await control.execute('Open the fixture.',context);await expect(control.execute('Open again.',context)).rejects.toMatchObject({code:'BROWSER_TASK_ATTEMPT_EXISTS'});expect(browser.create).toHaveBeenCalledTimes(1);
  });

  it('verifies an original receipt under a fenced recovery lease without opening another page',async()=>{
    const {control,browser,context}=await fixture(),result=await control.execute('Open the fixture.',context),lease=randomUUID();
    const assertActive=vi.fn(async()=>{}),recovery={...context,leaseToken:lease,verificationOnly:true as const,receiptLeaseToken:context.leaseToken,assertActive};
    expect(await control.verify(result,recovery)).toBeNull();
    await store.db.updateTable('tasks').set({status:'verifying',verification_only:true,verification_source_lease:context.leaseToken,lease_token:lease,lease_expires_at:new Date(Date.now()+60000)}).where('id','=',context.taskId).execute();
    expect(await control.verify(result,recovery)).toEqual(result);expect(assertActive).toHaveBeenCalledTimes(2);
    expect(await control.verify(result,{...recovery,receiptLeaseToken:randomUUID()})).toBeNull();
    expect(await control.verify(result,{...recovery,leaseToken:randomUUID()})).toBeNull();
    await expect(control.execute('Never execute during recovery.',recovery)).rejects.toMatchObject({code:'BROWSER_TASK_LEASE_DENIED'});
    expect(browser.create).toHaveBeenCalledTimes(1);expect(browser.action).toHaveBeenCalledTimes(1);
  });

  it('closes only its browser session and records failure when cancellation arrives during navigation',async()=>{
    const abort=new AbortController(),{control,browser,context,session}=await fixture({afterAction:()=>abort.abort()});
    await expect(control.execute('Open the fixture.',{...context,signal:abort.signal})).rejects.toMatchObject({code:'BROWSER_TASK_CANCELLED'});
    expect(browser.close).toHaveBeenCalledWith(owner,session());
    expect(await store.db.selectFrom('browser_task_receipts').select(['status','result']).where('task_id','=',context.taskId).executeTakeFirst()).toEqual({status:'failed',result:null});
  });

  it('reports a missing image honestly after one retry and exposes no screenshot URL',async()=>{
    const {control,browser,context}=await fixture({withoutScreenshot:true}),result=await control.execute('Open the fixture.',context);
    expect(browser.action).toHaveBeenCalledTimes(2);expect(result).toMatchObject({screenshotAvailable:false,screenshotHash:null,screenshotUrl:null});expect(await control.verify(result,context)).toEqual(result);
    await expect(control.screenshot(owner,context.taskId)).rejects.toMatchObject({code:'BROWSER_TASK_SCREENSHOT_NOT_FOUND'});
  });

  it('refuses a callback observation that disagrees with the independent browser history',async()=>{
    const {control,browser,context}=await fixture({forge:true});await expect(control.execute('Open the fixture.',context)).rejects.toMatchObject({code:'BROWSER_TASK_EVIDENCE_CHANGED'});expect(browser.close).toHaveBeenCalled();
  });
});
