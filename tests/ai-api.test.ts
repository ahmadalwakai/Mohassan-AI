import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { createMockGroq } from './fixtures/planning.js';
import { fixtureLocalModel } from './fixtures/local-model.js';
const origin='http://127.0.0.1:3000';const secret='isolated-ai-api-internal-fixture-secret-0001';
const headers={'x-mohassan-internal':secret,origin};
describe('authenticated AI connection and planning flow',()=>{
  let application:Awaited<ReturnType<typeof createApplication>>,cookie='';const transport=createMockGroq();
  beforeAll(async()=>{
    application=await createApplication({authSecret:'isolated-ai-api-auth-fixture-secret-0001',internalSecret:secret,setupToken:'isolated-ai-api-setup-fixture-token-0001',webOrigin:origin,production:false,runWorker:false,...fixtureLocalModel(transport.fetch)});
    const setup=await application.app.inject({method:'POST',url:'/api/setup',headers,payload:{name:'مالك اختبار التخطيط',email:'ai-owner@example.test',password:'Planning-Only-Fixture-Password-42',setupToken:'isolated-ai-api-setup-fixture-token-0001'}});expect(setup.statusCode).toBe(200);
    const signin=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers,payload:{email:'ai-owner@example.test',password:'Planning-Only-Fixture-Password-42'}});expect(signin.statusCode).toBe(200);
    cookie=(Array.isArray(signin.headers['set-cookie'])?signin.headers['set-cookie']:[signin.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
  });
  afterAll(async()=>{await application?.app.close();});
  it('does not call the model on snapshot and reports configured instead of verified',async()=>{
    const response=await application.app.inject({url:'/api/workspace',headers:{...headers,cookie}});
    expect(response.statusCode).toBe(200);expect(response.json().ai.status).toBe('configured');expect(transport.requests).toHaveLength(0);
    expect(response.body).not.toContain('fixture-key-never-in-HTTP');
  });
  it('protects model verification with the session and Origin',async()=>{
    expect((await application.app.inject({method:'POST',url:'/api/ai/verify',headers,payload:{}})).statusCode).toBe(401);
    expect((await application.app.inject({method:'POST',url:'/api/ai/verify',headers:{...headers,cookie,origin:'https://untrusted.example'},payload:{}})).statusCode).toBe(403);
    expect(transport.requests).toHaveLength(0);
  });
  it('verifies live-shaped generation and persists timestamp without credentials',async()=>{
    const response=await application.app.inject({method:'POST',url:'/api/ai/verify',headers:{...headers,cookie},payload:{}});
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({configured:true,status:'verified'});expect(response.json().verifiedAt).toBeTruthy();
    // One small structured request to the local model; there is no model list to fetch.
    expect(transport.requests).toHaveLength(1);expect(transport.requests[0]?.body.response_format.json_schema.name).toBe('connection_check');
  });
  it('stores a verified plan and usage receipt without executing its proposed steps',async()=>{
    const response=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'isolated-planning-request-01'},payload:{title:'خطة مراجعة المشروع',goal:'أعد خطة موجزة لمراجعة المشروع دون تنفيذ أي أداة.',capabilityId:'plan.draft',autonomy:'assisted'}});
    expect(response.statusCode).toBe(200);const task=response.json();expect(task.status).toBe('waiting_approval');
    const before=transport.requests.length;await application.runtime.tick();expect(transport.requests).toHaveLength(before);
    await application.app.inject({method:'POST',url:`/api/tasks/${task.id}/approve`,headers:{...headers,cookie},payload:{}});
    await application.runtime.tick();
    const detail=await application.app.inject({url:`/api/tasks/${task.id}`,headers:{...headers,cookie}});expect(detail.statusCode).toBe(200);
    const body=detail.json();expect(body.task.status).toBe('completed');expect(body.task.result.executionAllowed).toBe(false);
    expect(body.task.result.verification.scope).toBe('structure_and_policy');expect(body.steps).toHaveLength(2);expect(body.modelRuns[0]).toMatchObject({status:'succeeded',resultCommitted:true,inputTokens:700,outputTokens:240});
    expect(body.task.result.plan.steps[0].requiredScopes).toEqual(['diagnostic:read']);expect(JSON.stringify(body)).not.toContain('fixture-key-never-in-HTTP');
  });
  it('does not send a provider request or create a usage receipt for shadow planning',async()=>{
    const before=transport.requests.length;
    const response=await application.app.inject({method:'POST',url:'/api/tasks',headers:{...headers,cookie,'idempotency-key':'isolated-shadow-request-01'},payload:{title:'محاكاة خطة المشروع',goal:'محاكاة التخطيط دون أي اتصال خارجي.',capabilityId:'plan.draft',autonomy:'shadow'}});
    expect(response.statusCode).toBe(200);await application.runtime.tick();
    const detail=await application.runtime.detail(response.json().ownerId,response.json().id);
    expect(detail.task.status).toBe('completed');expect(detail.task.result?.kind).toBe('shadow');expect(detail.modelRuns).toEqual([]);expect(transport.requests).toHaveLength(before);
  });
});
