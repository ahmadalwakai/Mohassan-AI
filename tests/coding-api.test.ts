import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,relative,isAbsolute } from 'node:path';
import { createApplication } from '../apps/server/src/app.js';
import { snapshotHash } from '@mohassan/coding';
import { createMockGroq } from './fixtures/planning.js';
describe('coding API scope and project registration',()=>{
  let application:Awaited<ReturnType<typeof createApplication>>,directory='',cookie='';const secret='coding-api-fixture-internal-secret-0001',origin='http://127.0.0.1:3000';const headers={'x-mohassan-internal':secret,origin};let project:any;
  beforeAll(async()=>{
    directory=await mkdtemp(join(tmpdir(),'mohassan-coding-api-'));const mock=createMockGroq();
    application=await createApplication({authSecret:'coding-api-fixture-auth-secret-0001',internalSecret:secret,setupToken:'coding-api-fixture-setup-token-0001',webOrigin:origin,production:false,runWorker:false,groqApiKey:'unit-only-fixture-key',aiFetch:mock.fetch,codingDataDir:directory,codingAllowedRoots:[directory],sandboxRunner:{available:async()=>({available:true,provider:'unit-fixture',message:'injected unit test only'}),run:async request=>({exitCode:request.files.some(file=>file.path==='src/sum.mjs'&&file.content.includes('a - b'))?1:0,stdout:'unit fixture receipt; no project code is executed here',stderr:'',timedOut:false,durationMs:1,provider:'unit-fixture',network:'denied',isolation:'appcontainer',isolationVerified:true,snapshotHash:snapshotHash(request.files)})}});
    await application.app.inject({method:'POST',url:'/api/setup',headers,payload:{name:'مالك اختبار البرمجة',email:'coding-api@example.test',password:'Coding-Fixture-Password-42',setupToken:'coding-api-fixture-setup-token-0001'}});
    const login=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers,payload:{email:'coding-api@example.test',password:'Coding-Fixture-Password-42'}});
    cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
  });
  afterAll(async()=>{await application?.app.close();if(directory){const base=await realpath(tmpdir()),target=await realpath(directory),inside=relative(base,target);if(isAbsolute(inside)||inside.startsWith('..')||!inside.startsWith('mohassan-coding-api-'))throw new Error('Unsafe cleanup path');await rm(target,{recursive:true,force:true});}});
  it('requires a session and trusted Origin before project creation',async()=>{
    expect((await application.app.inject({url:'/api/coding/projects',headers})).statusCode).toBe(401);
    expect((await application.app.inject({method:'POST',url:'/api/coding/projects/demo',headers:{...headers,cookie,origin:'https://untrusted.example'},payload:{}})).statusCode).toBe(403);
  });
  it('creates a real Git demo and registers it idempotently for its owner',async()=>{
    const first=await application.app.inject({method:'POST',url:'/api/coding/projects/demo',headers:{...headers,cookie},payload:{}});expect(first.statusCode).toBe(200);project=first.json();
    expect(project.allowedPaths).toEqual(['src/sum.mjs']);expect(project.baseCommit).toMatch(/^[a-f0-9]{40,64}$/);
    const second=await application.app.inject({method:'POST',url:'/api/coding/projects/demo',headers:{...headers,cookie},payload:{}});expect(second.json().id).toBe(project.id);
  });
  it('rejects registering paths outside the configured roots and protected edit files',async()=>{
    const outside=await application.app.inject({method:'POST',url:'/api/coding/projects',headers:{...headers,cookie},payload:{name:'خارج النطاق',path:tmpdir(),allowedPaths:['src/sum.mjs']}});expect(outside.statusCode).toBe(400);
    const protectedFile=await application.app.inject({method:'POST',url:'/api/coding/projects',headers:{...headers,cookie},payload:{name:'اختبارات محمية',path:project.path,allowedPaths:['test/sum.test.mjs']}});expect(protectedFile.statusCode).toBe(400);
  });
  it('requires a project and approval then serves reviewable changes through the task API',async()=>{
    const request={title:'إصلاح الجمع',goal:'أصلح الجمع دون تعديل الاختبارات المحمية.',capabilityId:'coding.change',autonomy:'scoped'};
    const missing=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'coding-no-project'},payload:request});expect(missing.statusCode).toBe(400);
    const created=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'coding-project-request'},payload:{...request,projectId:project.id}});expect(created.statusCode).toBe(200);expect(created.json().status).toBe('waiting_approval');
    await application.app.inject({method:'POST',url:`/api/tasks/${created.json().id}/approve`,headers:{...headers,cookie},payload:{}});await application.runtime.tick();
    const detail=await application.app.inject({url:`/api/tasks/${created.json().id}`,headers:{...headers,cookie}});expect(detail.statusCode).toBe(200);expect(detail.json().task.status).toBe('completed');expect(detail.json().task.result).toMatchObject({kind:'coding',outcome:'ready_for_review',sourceUnchanged:true,merged:false});expect(detail.json().task.result.diff).toContain('src/sum.mjs');
  });
});
