import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createDatabase,migrate,sql} from '@mohassan/database';
import {migrateAuth} from '../apps/server/src/auth.js';
import {migrateBrowser,createBrowserResearchControl} from '../packages/browser/src/index.js';

describe('owned browser audit, one-use approvals and persistent research',()=>{
  let database:Awaited<ReturnType<typeof createDatabase>>,control:ReturnType<typeof createBrowserResearchControl>,server:Server,origin='',writes=0;const owner='browser-owner',other='browser-other';let session:any;
  beforeAll(async()=>{
    server=createServer((request,response)=>{response.setHeader('content-type','text/html');if(request.url==='/submit'&&request.method==='POST'){writes++;response.end('<h1>Accepted local fixture</h1>');return;}if(request.url==='/source'){response.end('<title>Original fixture source</title><p>The source documents project capacity of 10 units. This text was actually read from the local fixture.</p>');return;}response.end('<title>Consent fixture</title><h1>Read before writing</h1><form method="post" action="/submit"><label>Name<input name="name"></label></form>');});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');origin=`http://127.0.0.1:${address.port}`;
    database=await createDatabase();await migrateAuth(database.db);await migrate(database.db);await migrateBrowser(database.db);for(const id of [owner,other])await database.db.insertInto('user').values({id,name:id,email:`${id}@example.test`}).execute();control=createBrowserResearchControl(database.db,{testOrigins:[origin]});
  });
  afterAll(async()=>{await control?.shutdown();await database?.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));});
  it('persists owner scope and audit without revealing another owner session',async()=>{
    session=await control.create(owner,{title:'Owned browser fixture',allowedOrigins:[origin]});expect(session.observation).toBeNull();
    await expect(control.detail(other,session.id)).rejects.toMatchObject({code:'BROWSER_NOT_FOUND',statusCode:404});
    session=await control.action(owner,session.id,{action:'navigate',url:origin,expectedObservationId:null});expect(session.observation.title).toBe('Consent fixture');expect(session.events.length).toBeGreaterThan(1);
    const anotherController=createBrowserResearchControl(database.db,{testOrigins:[origin]});expect((await anotherController.detail(owner,session.id)).observation!.id).toBe(session.observation.id);expect((await anotherController.detail(owner,session.id)).live).toBe(false);await anotherController.shutdown();
    await expect(control.action(owner,session.id,{action:'read',expectedObservationId:null})).rejects.toMatchObject({code:'BROWSER_OBSERVATION_CHANGED'});
  });
  it('consumes exact-observation approval once across concurrent approval attempts',async()=>{
    session=await control.prepare(owner,session.id,{observationId:session.observation.id,formId:'f0',values:{i0:'Alice'}});const approval=session.approvals[0];expect(writes).toBe(0);expect(approval.status).toBe('pending');
    const results=await Promise.allSettled([control.approve(owner,session.id,approval.id),control.approve(owner,session.id,approval.id)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(writes).toBe(1);
    await expect(control.approve(owner,session.id,approval.id)).rejects.toMatchObject({code:'BROWSER_APPROVAL_INVALID'});
    session=await control.detail(owner,session.id);expect(session.observation.text).toContain('Accepted local fixture');expect(session.approvals[0].status).toBe('succeeded');
  });
  it('invalidates pending consent when page observation changes and revokes on close',async()=>{
    session=await control.action(owner,session.id,{action:'navigate',url:origin,expectedObservationId:session.observation.id});session=await control.prepare(owner,session.id,{observationId:session.observation.id,formId:'f0',values:{i0:'Later'}});const pending=session.approvals.find((entry:any)=>entry.status==='pending');
    session=await control.action(owner,session.id,{action:'read',expectedObservationId:session.observation.id});await expect(control.approve(owner,session.id,pending.id)).rejects.toMatchObject({code:'BROWSER_APPROVAL_INVALID'});
    session=await control.close(owner,session.id);expect(session.status).toBe('closed');expect(session.live).toBe(false);expect(session.approvals.find((entry:any)=>entry.id===pending.id).status).toBe('revoked');
    await expect(control.action(owner,session.id,{action:'navigate',url:origin,expectedObservationId:session.observation.id})).rejects.toMatchObject({code:'BROWSER_SESSION_CLOSED'});
  });
  it('continues background source reading and restores the evidence report by owner',async()=>{
    const started=await control.research(owner,{question:'What is project capacity?',sourceBudget:1,maxDepth:1,sourceUrls:[origin+'/source']});expect(['running','completed']).toContain(started.status);
    await expect.poll(async()=>(await control.researchDetail(owner,started.id)).status).toBe('completed');
    const result=await control.researchDetail(owner,started.id);expect(result.report?.sources[0].title).toBe('Original fixture source');expect(result.report?.sources[0].url).toBe(origin+'/source');expect(result.report?.sources[0].quote).toContain('10');
    await expect(control.researchDetail(other,started.id)).rejects.toMatchObject({code:'RESEARCH_NOT_FOUND'});
    const restored=createBrowserResearchControl(database.db,{testOrigins:[origin]});expect((await restored.researchDetail(owner,started.id)).report).toEqual(result.report);await restored.shutdown();
  });
  it('does not expose another owner activity through resource-lock errors and bounds history',async()=>{
    await database.db.insertInto('browser_locks').values({resource_key:session.id,token:'fixture-lock',expires_at:new Date(Date.now()+60000)}).execute();
    await expect(control.action(other,session.id,{action:'read',expectedObservationId:session.observation.id})).rejects.toMatchObject({code:'BROWSER_NOT_FOUND',statusCode:404});
    await database.db.deleteFrom('browser_locks').where('resource_key','=',session.id).execute();
    const history=await control.observations(owner,session.id,{limit:50});expect(history.observations.length).toBeGreaterThan(1);expect(history.observations[0].data.screenshot).toBeNull();
    await expect(control.observations(other,session.id)).rejects.toMatchObject({code:'BROWSER_NOT_FOUND'});await expect(control.observations(owner,session.id,{limit:9999})).rejects.toThrow();
  });
  it('cancels pending research without fabricating a report and recovers abandoned leases',async()=>{
    const pending=createBrowserResearchControl(database.db,{searchProvider:{name:'blocking fixture',search:async(_question,_limit,signal)=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))}});
    const started=await pending.research(owner,{question:'Cancel this fixture research',sourceBudget:1,maxDepth:1});const cancelled=await pending.cancelResearch(owner,started.id);expect(cancelled.status).toBe('cancelled');expect(cancelled.report).toBeNull();
    const abandoned=await pending.research(owner,{question:'Abandoned fixture research',sourceBudget:1,maxDepth:1});await database.db.updateTable('research_runs').set({lease_expires_at:new Date(Date.now()-1000)}).where('id','=',abandoned.id).execute();
    expect((await pending.researchDetail(owner,abandoned.id)).status).toBe('failed');await pending.shutdown();
  });
});
