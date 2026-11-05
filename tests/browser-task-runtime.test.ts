import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createDatabase,migrate,sql } from '@mohassan/database';
import { BrowserTaskInputSchema,CreateTaskSchema,type BrowserOpenResult } from '@mohassan/contracts';
import { Runtime,createCapabilities,type RuntimeOptions } from '@mohassan/runtime';

const input={title:'فتح موقع Google Ads',goal:'افتح موقع Google Ads في المتصفح، واعرض لي لقطة من الصفحة بعد تحميلها.',capabilityId:'browser.open' as const,autonomy:'scoped' as const,browserInput:{url:'https://ads.google.com/home/'}};
const fixture=(taskId:string,changes:Partial<BrowserOpenResult>={}):BrowserOpenResult=>({kind:'browser_open',outcome:'opened',sessionId:randomUUID(),observationId:randomUUID(),url:input.browserInput.url,title:'Google Ads fixture',observedAt:new Date().toISOString(),summary:'حُمّلت صفحة الاختبار وحُفظ دليلها.',screenshotAvailable:true,screenshotUrl:`/api/browser/tasks/${taskId}/screenshot`,contentHash:'a'.repeat(64),screenshotHash:'b'.repeat(64),...changes});
const configured=(openBrowser:NonNullable<RuntimeOptions['openBrowser']>=async(_goal,context)=>fixture(context.taskId),verifyBrowser:NonNullable<RuntimeOptions['verifyBrowser']>=async raw=>raw as BrowserOpenResult):RuntimeOptions=>({moduleAvailability:{browser:true},openBrowser,verifyBrowser});

describe('browser opening uses the task ledger, exact URL authority and independent evidence',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>;
  beforeEach(async()=>{store=await createDatabase();await migrate(store.db);});
  afterEach(async()=>{await store.close();});

  it('accepts only explicit public HTTPS read scope and requires browser input on the matching capability',()=>{
    expect(BrowserTaskInputSchema.parse({url:'https://ADS.google.com:443/home/'})).toEqual(input.browserInput);
    for(const url of ['http://ads.google.com/','https://127.0.0.1/','https://[::1]/','https://localhost/','https://service.internal/','https://user:secret@ads.google.com/','https://ads.google.com:8443/','https://ads.google.com/#write'])expect(BrowserTaskInputSchema.safeParse({url}).success,url).toBe(false);
    expect(BrowserTaskInputSchema.safeParse({url:input.browserInput.url,allowedOrigins:['https://google.com']}).success).toBe(false);
    expect(BrowserTaskInputSchema.safeParse({...input.browserInput,script:'fetch(privateEndpoint)'}).success).toBe(false);
    expect(CreateTaskSchema.safeParse({...input,browserInput:undefined}).success).toBe(false);
    expect(CreateTaskSchema.safeParse({...input,capabilityId:'system.diagnostic'}).success).toBe(false);
  });

  it('requires both configured callbacks and module availability without making the research UI executable',async()=>{
    for(const options of [{moduleAvailability:{browser:true}}, {...configured(),verifyBrowser:undefined}, {...configured(),moduleAvailability:{browser:false}}]){
      const runtime=new Runtime(store.db,options);
      expect(runtime.getCapabilities().find(item=>item.id==='browser.open')?.status).toBe('needs_configuration');
      await expect(runtime.createTask('owner',input,randomUUID())).rejects.toMatchObject({code:'CAPABILITY_UNAVAILABLE'});
    }
    expect(createCapabilities(false,false,false,{browser:true}).find(item=>item.id==='browser.research')?.status).toBe('active');
    await expect(new Runtime(store.db,configured()).createTask('owner',{...input,capabilityId:'browser.research'} as any,randomUUID())).rejects.toMatchObject({code:'INVALID_INPUT'});
  });

  it('never completes a page-opening goal through the diagnostic capability',async()=>{
    const runtime=new Runtime(store.db,configured());
    await expect(runtime.createTask('owner',{title:input.title,goal:input.goal,capabilityId:'system.diagnostic',autonomy:'scoped'},randomUUID())).rejects.toMatchObject({code:'CAPABILITY_GOAL_MISMATCH'});
    expect((await runtime.snapshot('owner')).tasks).toEqual([]);
  });

  it('requires assisted approval tied to URL scope and includes the whole input in idempotency',async()=>{
    let calls=0;const runtime=new Runtime(store.db,configured(async(_goal,context)=>{calls++;return fixture(context.taskId);}));
    const task=await runtime.createTask('owner',{...input,autonomy:'assisted'},'browser-assisted-request');
    expect(task.status).toBe('waiting_approval');expect(task.browserInput).toEqual(input.browserInput);
    await runtime.tick();expect(calls).toBe(0);
    await expect(runtime.approve('foreign',task.id)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
    await runtime.approve('owner',task.id);
    expect((await store.db.selectFrom('approvals').select('scope').executeTakeFirstOrThrow()).scope).toMatch(/^browser:read:[a-f0-9]{64}$/);
    await expect(runtime.createTask('owner',{...input,autonomy:'assisted',browserInput:{...input.browserInput,allowedOrigins:['https://ads.google.com','https://www.google.com']}},'browser-assisted-request')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await runtime.tick();expect(calls).toBe(1);expect((await runtime.detail('owner',task.id)).task.status).toBe('completed');
  });

  it('runs an explicitly scoped read with verification and no model ledger',async()=>{
    let verified=0;
    const runtime=new Runtime(store.db,configured(async(goal,context)=>{expect(goal).toBe(input.goal);expect(context.ownerId).toBe('owner');expect(context.browserInput).toEqual(input.browserInput);expect(context.leaseToken).toBeTruthy();await context.onProgress?.('browser_loading','private page text');return fixture(context.taskId);},async(raw,context)=>{verified++;expect(context.ownerId).toBe('owner');return raw as BrowserOpenResult;}));
    const task=await runtime.createTask('owner',input,randomUUID());expect(task.status).toBe('queued');await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('completed');expect(detail.task.result).toMatchObject({kind:'browser_open',outcome:'opened',screenshotAvailable:true});expect(detail.modelRuns).toEqual([]);expect(verified).toBe(1);expect(JSON.stringify(detail)).not.toContain('private page text');
  });

  it('keeps shadow execution local without starting or verifying a browser',async()=>{
    let calls=0;const runtime=new Runtime(store.db,configured(async()=>{calls++;throw new Error('must not launch');},async()=>{calls++;return null;}));
    const task=await runtime.createTask('owner',{...input,autonomy:'shadow'},randomUUID());await runtime.tick();const detail=await runtime.detail('owner',task.id);
    expect(detail.task.status).toBe('completed');expect(detail.task.result).toMatchObject({kind:'shadow',capabilityId:'browser.open',executed:false});expect(detail.modelRuns).toEqual([]);expect(calls).toBe(0);
  });

  it('rejects missing independent evidence, foreign origins and screenshots attached to another task',async()=>{
    const cases:NonNullable<RuntimeOptions['verifyBrowser']>[]=[async()=>null,async(_raw,context)=>fixture(context.taskId,{url:'https://www.google.com/'}),async()=>fixture(randomUUID()),async(_raw,context)=>fixture(context.taskId,{observedAt:new Date(Date.now()-60000).toISOString()}),async(_raw,context)=>fixture(context.taskId,{screenshotAvailable:false,screenshotUrl:null,screenshotHash:null})];
    for(const verify of cases){const runtime=new Runtime(store.db,configured(undefined,verify));const task=await runtime.createTask('owner',input,randomUUID());await runtime.tick();const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('failed');expect(detail.task.result).toBeNull();}
  });

  it('honestly allows a page read without a screenshot only when the goal did not request one',async()=>{
    const runtime=new Runtime(store.db,configured(async(_goal,context)=>fixture(context.taskId,{screenshotAvailable:false,screenshotUrl:null,screenshotHash:null})));
    const task=await runtime.createTask('owner',{...input,goal:'افتح موقع Google Ads واقرأ عنوان الصفحة.'},randomUUID());await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('completed');expect(detail.task.result).toMatchObject({screenshotAvailable:false,screenshotUrl:null,screenshotHash:null});
  });

  it('does not launch after an approval expires or the stored URL scope changes',async()=>{
    let calls=0;const runtime=new Runtime(store.db,configured(async(_goal,context)=>{calls++;return fixture(context.taskId);}));
    const assisted=await runtime.createTask('owner',{...input,autonomy:'assisted'},randomUUID());await runtime.approve('owner',assisted.id);
    await store.db.updateTable('approvals').set({expires_at:new Date(Date.now()-1000)}).where('task_id','=',assisted.id).execute();await runtime.tick();
    expect((await runtime.detail('owner',assisted.id)).task.status).toBe('waiting_approval');
    const scoped=await runtime.createTask('owner',input,randomUUID());await store.db.updateTable('tasks').set({browser_input:JSON.stringify({url:'https://www.google.com/'})}).where('id','=',scoped.id).execute();await runtime.tick();
    expect((await runtime.detail('owner',scoped.id)).task.status).toBe('waiting_approval');expect(calls).toBe(0);
  });

  it('rejects completion when approval expires during the browser operation',async()=>{
    const runtime=new Runtime(store.db,configured(async(_goal,context)=>{await store.db.updateTable('approvals').set({expires_at:new Date(Date.now()-1000)}).where('task_id','=',context.taskId).execute();return fixture(context.taskId);}));
    const task=await runtime.createTask('owner',{...input,autonomy:'assisted'},randomUUID());await runtime.approve('owner',task.id);await runtime.tick();
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('waiting_approval');expect(detail.task.result).toBeNull();expect(detail.modelRuns).toEqual([]);
  });

  it('fences cancellation while independent verification is pending',async()=>{
    let entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const runtime=new Runtime(store.db,configured(undefined,async raw=>{entered();await gate;return raw as BrowserOpenResult;}));
    const task=await runtime.createTask('owner',input,randomUUID());const running=runtime.tick();await enteredPromise;await runtime.cancel('owner',task.id);release();await running;
    const detail=await runtime.detail('owner',task.id);expect(detail.task.status).toBe('cancelled');expect(detail.task.result).toBeNull();expect(detail.events.some(item=>item.type==='verification_passed')).toBe(false);
  });

  it('aborts an in-flight browser signal when its grant is revoked',async()=>{
    let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let aborted=false;
    const runtime=new Runtime(store.db,configured(async(_goal,context)=>{entered();return new Promise<BrowserOpenResult>((_resolve,reject)=>{context.signal.addEventListener('abort',()=>{aborted=true;reject(context.signal.reason);},{once:true});});}));
    const task=await runtime.createTask('owner',{...input,autonomy:'assisted'},randomUUID());await runtime.approve('owner',task.id);const running=runtime.tick();await ready;
    await store.db.updateTable('approvals').set({revoked_at:new Date()}).where('task_id','=',task.id).execute();await running;
    const detail=await runtime.detail('owner',task.id);expect(aborted).toBe(true);expect(detail.task.status).toBe('waiting_approval');expect(detail.task.result).toBeNull();
  });

  it('requires a new grant after uncertain failure and after a worker lease expires',async()=>{
    let calls=0;const runtime=new Runtime(store.db,configured(async()=>{calls++;throw new Error('private engine details');}));const task=await runtime.createTask('owner',input,randomUUID());await runtime.tick();await runtime.tick();
    const failed=await runtime.detail('owner',task.id);expect(failed.task.status).toBe('waiting_approval');expect(failed.task.result).toBeNull();expect(failed.modelRuns).toEqual([]);expect(calls).toBe(1);expect(JSON.stringify(failed)).not.toContain('private engine details');
    const stale=await runtime.createTask('owner',input,randomUUID());await store.db.updateTable('tasks').set({status:'running',attempt:1,lease_token:randomUUID(),lease_expires_at:sql`CURRENT_TIMESTAMP - interval '1 minute'`}).where('id','=',stale.id).execute();await runtime.tick();
    const recovered=await runtime.detail('owner',stale.id);expect(recovered.task.status).toBe('waiting_approval');expect(recovered.task.result).toBeNull();expect(calls).toBe(1);
  });
});
