import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import Fastify from 'fastify';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import http from 'node:http';
import {chromium} from 'playwright';
import {createDatabase,migrate} from '@mohassan/database';
import {migrateAuth} from '../apps/server/src/auth.js';
import {createStudioLiveControl} from '../apps/server/src/studio-live.js';
import {instrumentReactSnapshot,reactSourceHash,type ReactStudioSnapshot} from '@mohassan/studio-react';
import {StudioError} from '@mohassan/studio';

const secret='studio-live-unit-gateway-secret-000000001',owner='live-owner',sessionId=randomUUID();
const source:ReactStudioSnapshot={framework:'next',entryPath:'app/page.tsx',files:[{path:'app/page.tsx',content:'export default function Page(){return <main><h1>Live source title</h1><button>0</button></main>}'},{path:'app/globals.css',content:'h1{color:#123456}'}]};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

describe('isolated Next gateway client and capability-bound live proxy',()=>{
  let store:Awaited<ReturnType<typeof createDatabase>>,live:Awaited<ReturnType<typeof createStudioLiveControl>>,app:ReturnType<typeof Fastify>,revision='a'.repeat(64),url='',state:any,parentServer:http.Server,parentOrigin='';let posts=0;
  const created=new Map<string,{cap:string;files:{path:string;content:string}[]}>(),stopped:string[]=[],forwarded:any[]=[];
  const fakeFetch:typeof fetch=async(input,init)=>{
    expect(String(input)).toBe('https://gateway.example/api/control');const headers=new Headers(init?.headers),body=String(init?.body??''),stamp=headers.get('x-studio-time')!;
    expect(headers.get('x-studio-signature')).toBe(createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex'));expect(Math.abs(Date.now()-Number(stamp))).toBeLessThan(30000);
    const request=JSON.parse(body);forwarded.push(request);
    if(request.op==='create'){created.set(request.name,{cap:request.cap,files:request.files});return Response.json({name:request.name,ready:true,isolation:'microvm',network:'denied',sourceHash:digest(JSON.stringify(request.files)),expiresAt:new Date(Date.now()+600000).toISOString()});}
    if(request.op==='stop'){stopped.push(request.name);return Response.json({stopped:true});}
    const project=created.get(request.name);if(!project)return Response.json({error:{code:'NOT_FOUND'}},{status:404});
    if(request.path.endsWith('/redirect'))return Response.json({status:302,headers:{'content-type':'text/html',location:'https://outside.example/steal'},body:''});
    if(request.method==='POST'){posts++;return Response.json({status:200,headers:{'content-type':'application/json','set-cookie':'must-not-reach-browser'},body:Buffer.from(JSON.stringify({accepted:posts})).toString('base64')});}
    if(request.path.endsWith('.css'))return Response.json({status:200,headers:{'content-type':'text/css'},body:Buffer.from('h1{color:#123456}').toString('base64')});
    const mapped=instrumentReactSnapshot(source).elements,h1=mapped.find(element=>element.tag==='h1')!,button=mapped.find(element=>element.tag==='button')!;
    const html=`<!doctype html><html><head><link rel="stylesheet" href="/p/${project.cap}/_next/static/main.css"></head><body><main><h1 data-mohassan-source-id="${h1.id}">Live source title</h1><button id="counter" data-mohassan-source-id="${button.id}">0</button></main><script>document.getElementById('counter').addEventListener('click',event=>event.currentTarget.textContent=String(Number(event.currentTarget.textContent)+1));</script></body></html>`;
    return Response.json({status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(html).toString('base64')});
  };
  const getSession=async(actor:string,id:string)=>{if(actor!==owner||id!==sessionId)throw new StudioError('STUDIO_NOT_FOUND','Not found',404);return {id:sessionId,revision,...source};};
  function proxyRequest(path:string,options:{method?:string;origin?:string;requestId?:string;body?:string;cookie?:string;authorization?:string;host?:string}={}):Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}>{
    const parsed=new URL(url),headers:Record<string,string>={host:options.host??parsed.host};if(options.origin)headers.origin=options.origin;if(options.requestId)headers['x-studio-request-id']=options.requestId;if(options.cookie)headers.cookie=options.cookie;if(options.authorization)headers.authorization=options.authorization;if(options.body)headers['content-type']='text/plain';
    return new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:parsed.port,path,method:options.method??'GET',headers},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers,body}));});request.on('error',reject);request.end(options.body);});
  }
  beforeAll(async()=>{store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);await store.db.insertInto('user').values({id:owner,name:'Live fixture',email:'live@example.test'}).execute();
    parentServer=http.createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(`<iframe sandbox="allow-scripts" src="${url}"></iframe>`);});await new Promise<void>(resolve=>parentServer.listen(0,'127.0.0.1',resolve));const address=parentServer.address();if(!address||typeof address==='string')throw new Error('parent fixture');parentOrigin=`http://127.0.0.1:${address.port}`;
    live=await createStudioLiveControl(store.db,{gatewayUrl:'https://gateway.example/api/control',gatewaySecret:secret,webOrigin:parentOrigin,production:false,previewPort:0,getSession,fetch:fakeFetch});app=Fastify();app.setErrorHandler((error:any,_request:any,reply:any)=>reply.code(error.statusCode??500).send({error:{code:error.code,message:error.message}}));await live.register(app,async request=>({id:request.headers['x-test-owner']??owner}));await app.ready();
  });
  afterAll(async()=>{await live?.close();await app?.close();await store?.close();await new Promise<void>(resolve=>parentServer?.close(()=>resolve()));});

  it('builds an inert artifact with verified source hash, then stops compute without retaining a raw cap',async()=>{
    const artifact=await live.build(source);expect(artifact.sourceHash).toBe(reactSourceHash(source));expect(artifact.verification.isolation).toBe('microvm');expect(artifact.verification.network).toBe('denied');expect(artifact.html).not.toContain('<script');expect(artifact.css).toContain('color:#123456');expect(stopped).toContain(artifact.cloud!.name);
    const cap=created.get(artifact.cloud!.name)!.cap;expect(JSON.stringify(artifact)).not.toContain(cap);expect((artifact.cloud as any).cap).toBeUndefined();
  });
  it('starts a scoped background preview and stores only the capability digest',async()=>{
    const started=await app.inject({method:'POST',url:`/api/studio/sessions/${sessionId}/live`,payload:{revision}});expect(started.statusCode).toBe(202);
    await expect.poll(async()=>{state=(await app.inject({url:`/api/studio/sessions/${sessionId}/live`})).json();return state.status;}).toBe('active');url=state.url;
    const cap=new URL(url).hostname.split('.')[0],row=await store.db.selectFrom('studio_live_sessions').selectAll().where('id','=',state.id).executeTakeFirstOrThrow();expect(row.cap_hash).toBe(digest(cap));expect(JSON.stringify(row)).not.toContain(cap);expect(row).not.toHaveProperty('cap');
    expect((await app.inject({url:`/api/studio/sessions/${sessionId}/live`,headers:{'x-test-owner':'other'}})).statusCode).toBe(404);
    const worker=await createStudioLiveControl(store.db,{gatewayUrl:'https://gateway.example/api/control',gatewaySecret:secret,webOrigin:'http://127.0.0.1:3100',production:false,fetch:fakeFetch});await worker.close();expect((await app.inject({url:`/api/studio/sessions/${sessionId}/live`})).json().status).toBe('active');
  });
  it('confines host, cap, redirects and origin and strips owner credentials from every proxy call',async()=>{
    const path=new URL(url).pathname,result=await proxyRequest(path,{cookie:'owner-session=must-not-forward',authorization:'Bearer must-not-forward'});expect(result.status).toBe(200);expect(result.body).toContain('mohassan:studio:select');expect(result.headers['content-security-policy']).toContain("frame-src 'none'");
    const remote=forwarded.at(-1);expect(remote.headers.cookie).toBeUndefined();expect(remote.headers.authorization).toBeUndefined();expect(result.headers['set-cookie']).toBeUndefined();
    expect((await proxyRequest(path,{host:'127.0.0.1'})).status).toBe(404);expect((await proxyRequest(path+'/../escape')).status).toBe(404);expect((await proxyRequest(path+'/redirect')).status).toBe(502);
    expect((await proxyRequest(path,{method:'POST',origin:'http://127.0.0.1:3100',requestId:'b'.repeat(32),body:'data'})).status).toBe(403);
  });
  it('deduplicates a server action before RPC and rejects a changed body or missing request identity',async()=>{
    const path=new URL(url).pathname,requestId='c'.repeat(32),before=posts;
    expect((await proxyRequest(path,{method:'POST',origin:'null',body:'same',requestId})).status).toBe(200);
    expect((await proxyRequest(path,{method:'POST',origin:'null',body:'same',requestId})).status).toBe(200);expect(posts).toBe(before+1);
    expect((await proxyRequest(path,{method:'POST',origin:'null',body:'different',requestId})).status).toBe(409);expect(posts).toBe(before+1);
    expect((await proxyRequest(path,{method:'POST',origin:'null',body:'new'})).status).toBe(400);
  });
  it('allows actual browser interaction and authenticated source selection inside an opaque iframe',async()=>{
    const browser=await chromium.launch({headless:true});const page=await browser.newPage();try{
      await page.goto(parentOrigin);
      const frame=page.frameLocator('iframe');await expect.poll(()=>frame.locator('#counter').textContent()).toBe('0');await frame.locator('#counter').click();await expect.poll(()=>frame.locator('#counter').textContent()).toBe('1');
      await page.evaluate(input=>{(window as any).__selection=null;window.addEventListener('message',event=>{if(event.origin==='null'&&event.data?.type==='mohassan:studio:select')(window as any).__selection=event.data;});document.querySelector('iframe')!.contentWindow!.postMessage({type:'mohassan:studio:mode',nonce:input.nonce,revision:input.revision,selecting:true},'*');},{nonce:state.nonce,revision});
      await frame.locator('h1').click();await expect.poll(()=>page.evaluate(()=>(window as any).__selection?.elementId)).toBe(instrumentReactSnapshot(source).elements.find(element=>element.tag==='h1')!.id);
    }finally{await browser.close();}
  });
  it('invalidates a live capability immediately after the source revision changes',async()=>{
    revision='b'.repeat(64);expect((await proxyRequest(new URL(url).pathname)).status).toBe(410);expect((await app.inject({url:`/api/studio/sessions/${sessionId}/live`})).json().status).toBe('stale');
  });
  it('reports missing cloud configuration and performs no network or compute',async()=>{
    const unconfigured=await createStudioLiveControl(store.db,{webOrigin:'http://127.0.0.1:3100',production:false,getSession});expect(unconfigured.available).toBe(false);await expect(unconfigured.build(source)).rejects.toMatchObject({code:'STUDIO_LIVE_NOT_CONFIGURED',statusCode:503});await unconfigured.close();
  });
});
