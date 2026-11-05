import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { StudioPreviewSchema, StudioSessionSchema, StudioWorkspaceSchema } from '@mohassan/contracts';

describe('studio authenticated HTTP boundary', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let cookie = '';
  const secret = 'studio-api-internal-fixture-secret-0001';
  const origin = 'http://127.0.0.1:3000';
  const headers = () => ({'x-mohassan-internal':secret, origin, cookie});
  beforeAll(async () => {
    application = await createApplication({authSecret:'studio-api-auth-fixture-secret-0001',internalSecret:secret,setupToken:'studio-fixture-setup-token-isolated-0001',webOrigin:origin,production:false,runWorker:false});
    expect((await application.app.inject({method:'POST',url:'/api/setup',headers:headers(),payload:{name:'Studio fixture',email:'studio-api@example.test',password:'Studio-Password-Fixture-42',setupToken:'studio-fixture-setup-token-isolated-0001'}})).statusCode).toBe(200);
    const login = await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:headers(),payload:{email:'studio-api@example.test',password:'Studio-Password-Fixture-42'}});
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  });
  afterAll(async () => {await application?.app.close();});

  it('requires both service authentication and owner session', async () => {
    expect((await application.app.inject({url:'/api/studio/sessions'})).statusCode).toBe(401);
    expect((await application.app.inject({url:'/api/studio/sessions',headers:{'x-mohassan-internal':secret}})).statusCode).toBe(401);
  });
  it('rejects null-origin and foreign-origin writes including preview messages sent as HTTP', async () => {
    for (const value of ['null','https://untrusted.example']) {
      expect((await application.app.inject({method:'POST',url:'/api/studio/sessions/demo',headers:{...headers(),origin:value},payload:{}})).statusCode).toBe(403);
    }
  });
  it('serves owner-private JSON previews and persists only bounded explicit edits', async () => {
    const response = await application.app.inject({method:'POST',url:'/api/studio/sessions/demo',headers:headers(),payload:{}});
    expect(response.statusCode).toBe(200);
    const session = StudioSessionSchema.parse(response.json());
    const render = await application.app.inject({url:`/api/studio/sessions/${session.id}/preview`,headers:headers()});
    expect(render.statusCode).toBe(200); expect(render.headers['cache-control']).toBe('no-store');
    expect(render.headers['content-type']).toContain('application/json');
    const preview = StudioPreviewSchema.parse(render.json());
    const element = preview.elements.find(item => item.editableText)!;
    const url = `/api/studio/sessions/${session.id}/edits`;
    for (const input of [
      {revision:session.revision,elementId:element.id,text:'مرفوض',path:'../.env'},
      {revision:session.revision,elementId:element.id,styles:{color:'url(https://untrusted.example)'}},
      {revision:session.revision,elementId:element.id,styles:{fontSize:10000}},
    ]) expect((await application.app.inject({method:'POST',url,headers:headers(),payload:input})).statusCode).toBe(400);
    const input = {revision:session.revision,elementId:element.id,text:'حُفظ في SQL'};
    const saved = await application.app.inject({method:'POST',url,headers:headers(),payload:input});
    expect(saved.statusCode).toBe(200); expect(StudioSessionSchema.parse(saved.json()).revision).not.toBe(session.revision);
    expect((await application.app.inject({method:'POST',url,headers:headers(),payload:input})).statusCode).toBe(409);
    const list = await application.app.inject({url:'/api/studio/sessions',headers:headers()});
    expect(StudioWorkspaceSchema.parse(list.json()).sessions).toHaveLength(1);
    expect(list.body).not.toContain('حُفظ في SQL');
    expect((await application.app.inject({url:'/api/studio/sessions/invalid/preview',headers:headers()})).statusCode).toBe(400);
  });
});
