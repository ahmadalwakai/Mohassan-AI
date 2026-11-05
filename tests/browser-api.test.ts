import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createApplication} from '../apps/server/src/app.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

describe('browser authenticated API integration',()=>{
  let application:Awaited<ReturnType<typeof createApplication>>,server:Server,origin='',cookie='';const webOrigin='http://127.0.0.1:3000',secret='browser-api-fixture-internal-secret-0001';const headers=()=>({'x-mohassan-internal':secret,origin:webOrigin,cookie});
  beforeAll(async()=>{
    server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<title>API browser fixture</title><h1>Actual browser read through authenticated API</h1>');});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');origin=`http://127.0.0.1:${address.port}`;
    application=await createApplication({authSecret:'browser-api-fixture-auth-secret-000001',internalSecret:secret,setupToken:'browser-api-fixture-setup-token-000001',webOrigin,production:false,runWorker:false,browser:{testOrigins:[origin]}});
    expect((await application.app.inject({method:'POST',url:'/api/setup',headers:headers(),payload:{name:'Browser API fixture',email:'browser-api@example.test',password:'Browser-API-Password-Fixture-42',setupToken:'browser-api-fixture-setup-token-000001'}})).statusCode).toBe(200);
    const login=await application.app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:headers(),payload:{email:'browser-api@example.test',password:'Browser-API-Password-Fixture-42'}});
    cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
  });
  afterAll(async()=>{await application?.app.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));});
  it('rejects missing authentication, foreign origins and execution-shaped input',async()=>{
    expect((await application.app.inject({url:'/api/browser/workspace'})).statusCode).toBe(401);
    expect((await application.app.inject({method:'POST',url:'/api/browser/sessions',headers:{...headers(),origin:'null'},payload:{title:'Denied fixture',allowedOrigins:[origin]}})).statusCode).toBe(403);
    expect((await application.app.inject({method:'POST',url:'/api/browser/sessions',headers:headers(),payload:{title:'Denied fixture',allowedOrigins:[origin],testOrigins:[origin]}})).statusCode).toBe(400);
  });
  it('creates, navigates and persists a real browser observation through the registered routes',async()=>{
    const created=await application.app.inject({method:'POST',url:'/api/browser/sessions',headers:headers(),payload:{title:'Browser API actual fixture',allowedOrigins:[origin]}});expect(created.statusCode).toBe(200);const session=created.json();
    const navigation=await application.app.inject({method:'POST',url:`/api/browser/sessions/${session.id}/actions`,headers:headers(),payload:{action:'navigate',url:origin,expectedObservationId:null}});
    expect(navigation.statusCode).toBe(200);expect(navigation.json().observation.title).toBe('API browser fixture');
    const detail=await application.app.inject({url:`/api/browser/sessions/${session.id}`,headers:headers()});expect(detail.json().observation.id).toBe(navigation.json().observation.id);
    expect((await application.app.inject({method:'POST',url:`/api/browser/sessions/${session.id}/actions`,headers:headers(),payload:{action:'execute',script:'arbitrary'}})).statusCode).toBe(400);
  });
  it('works under the actual tsx development runner without serialized host closure helpers',async()=>{
    const code=`process.env.NODE_ENV='development';const {BrowserEngine}=await import('./packages/browser/src/index.ts');const engine=new BrowserEngine({testOrigins:[${JSON.stringify(origin)}]});try{await engine.open('actual-tsx',[${JSON.stringify(origin)}]);const observation=await engine.navigate('actual-tsx',${JSON.stringify(origin)});console.log(JSON.stringify({title:observation.title,text:observation.text}));}finally{await engine.close();}`;
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',code],{cwd:process.cwd(),windowsHide:true,timeout:15000,maxBuffer:100000});
    expect(JSON.parse(result.stdout.trim())).toMatchObject({title:'API browser fixture',text:'Actual browser read through authenticated API'});
  });
});
