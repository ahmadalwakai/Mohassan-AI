import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('durable browser recovery in the authenticated conversation',()=>{
  let origin:string,profile:string,reads=0;
  const requests:Array<{path:string;cookie:string}>=[];
  let store:Awaited<ReturnType<typeof createDatabase>>;
  let control:Awaited<ReturnType<typeof createCommandChatControl>>;
  const server=createServer((req,res)=>{
    reads++;
    const url=new URL(req.url!,'http://fixture');
    requests.push({path:url.pathname,cookie:req.headers.cookie??''});
    res.writeHead(url.pathname==='/missing'?404:200,{'content-type':'text/html',...(url.pathname==='/set'?{'set-cookie':'account=work; Path=/; Max-Age=600'}:{})});
    res.end(`<html><head><title>${url.pathname==='/missing'?'Not found':'Recovery fixture'}</title></head><body><h1>${req.headers.cookie??'no account'}</h1><p>Current page</p></body></html>`);
  });
  beforeAll(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(async()=>{profile=await mkdtemp(join(tmpdir(),'mohassan-recovery-'));store=await createDatabase();await migrate(store.db);reads=0;requests.length=0;});
  afterEach(async()=>{await control?.shutdown();await store.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});});
  async function start(){control=await createCommandChatControl(store.db,{models:{fast:[],deep:[],vision:'none'},browser:new AgentBrowser({profileDir:profile,channel:null,testOrigins:[origin]})});}
  async function settled(id:string){await control.settled(id);return control.detail('owner',id);}
  it('persists account identity, preserves a ready checkpoint across shutdown, and restores by fresh readback',async()=>{
    await start();const {id}=await control.create('owner',{goal:`افتح ${origin}/`,browserAccount:'work'});
    expect((await settled(id)).browserAccount).toBe('work');
    const before=await store.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id','=',id).executeTakeFirstOrThrow();
    expect(before.browser_checkpoint).toMatchObject({status:'ready',ownerId:'owner',accountId:'work',resumeUrl:`${origin}/`});
    expect(JSON.stringify(before.browser_checkpoint)).not.toContain('Current page');
    await control.shutdown();await start();
    // Simulate a crash between durable checkpoint and the display snapshot.
    await store.db.updateTable('chat_conversations').set({browser_state:null}).where('id','=',id).execute();
    expect((await control.detail('owner',id)).browser).toMatchObject({live:false,recovery:'available'});
    const priorReads=reads;
    await expect(control.restoreBrowser('different-owner',id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
    expect(reads).toBe(priorReads);
    await control.restoreBrowser('owner',id);
    const restored=await settled(id);
    expect(restored.browser?.live,restored.error??'').toBe(true);
    expect(reads).toBeGreaterThan(priorReads);
    expect(restored.messages.at(-1)?.text).toContain('أعدت قراءة');
    expect(restored.messages.at(-1)?.text).toContain('لم تُستأنف');
  },120000);
  it('does not replay unresolved effects and keeps their review fence during an explicit fresh read',async()=>{
    await start();const {id}=await control.create('owner',{goal:`افتح ${origin}/`});await settled(id);await control.shutdown();
    const row=await store.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id','=',id).executeTakeFirstOrThrow();
    await store.db.updateTable('chat_conversations').set({browser_checkpoint:JSON.stringify({...row.browser_checkpoint,status:'effect_pending',actionKind:'click'})}).where('id','=',id).execute();
    await start();const priorReads=reads;await control.restoreBrowser('owner',id);const result=await settled(id);
    expect(result.browser).toMatchObject({live:false,recovery:'review_required'});expect(reads).toBe(priorReads);
    expect(result.messages.at(-1)?.text).toContain('لم أكرر');
    await control.send('owner',id,{text:`افتح ${origin}/`});
    expect((await settled(id)).browser?.recovery).toBe('review_required');
    const readbackRequests=reads;
    const token=(await control.detail('owner',id)).browser!.recoveryToken;
    await expect(control.reviewBrowser('owner',id,{reviewed:false})).rejects.toThrow();
    await expect(control.reviewBrowser('different-owner',id,{reviewed:true,checkpointToken:token})).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
    await expect(control.reviewBrowser('owner',id,{reviewed:true,checkpointToken:'f'.repeat(64)})).rejects.toMatchObject({code:'CHAT_REVIEW_CHANGED'});
    await control.reviewBrowser('owner',id,{reviewed:true,checkpointToken:token});
    const reviewed=await settled(id);expect(reviewed.messages.at(-1)?.text).toContain('سجّلت مراجعتك');expect(reads).toBe(readbackRequests);
  },120000);
  it('does not claim that opening a 404 page completed the requested task',async()=>{
    await start();const {id}=await control.create('owner',{goal:`افتح ${origin}/missing`});const result=await settled(id);
    const run=await store.db.selectFrom('chat_runs').select('status').where('conversation_id','=',id).executeTakeFirstOrThrow();
    expect(run.status).toBe('partial');expect(result.messages.at(-1)?.text).toContain('لم أتحقق');
  },120000);
  it('separates named account cookies while reusing the same selected account',async()=>{
    await start();
    const a=await control.create('owner',{goal:`افتح ${origin}/set`,browserAccount:'work'});await settled(a.id);
    const b=await control.create('owner',{goal:`افتح ${origin}/`,browserAccount:'personal'});await settled(b.id);
    const c=await control.create('owner',{goal:`افتح ${origin}/`,browserAccount:'work'});await settled(c.id);
    const accountPages=await store.db.selectFrom('chat_conversations').select(['id','browser_account']).execute();
    expect(accountPages.find(row=>row.id===b.id)?.browser_account).toBe('personal');
    expect(requests.filter(row=>row.path==='/').map(row=>row.cookie)).toEqual(['','account=work']);
    const workCheckpoint=await store.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id','=',c.id).executeTakeFirstOrThrow();
    const personalCheckpoint=await store.db.selectFrom('chat_conversations').select('browser_checkpoint').where('id','=',b.id).executeTakeFirstOrThrow();
    expect(workCheckpoint.browser_checkpoint.pageHash).not.toBe(personalCheckpoint.browser_checkpoint.pageHash);
    await control.shutdown();await start();
    const d=await control.create('owner',{goal:`افتح ${origin}/`,browserAccount:'work'});await settled(d.id);
    expect(requests.filter(row=>row.path==='/').at(-1)?.cookie).toBe('account=work');
    await expect(control.create('owner',{browserAccount:'../escape'})).rejects.toThrow();
  },120000);
  it('rejects new work after shutdown before creating an unowned run',async()=>{
    await start();const {id}=await control.create('owner');await control.shutdown();
    await expect(control.send('owner',id,{text:'مرحبا'})).rejects.toMatchObject({code:'CHAT_SHUTTING_DOWN'});
    await expect(control.create('owner',{goal:'مرحبا'})).rejects.toMatchObject({code:'CHAT_SHUTTING_DOWN'});
    expect(await store.db.selectFrom('chat_runs').select('id').execute()).toHaveLength(0);
  },120000);
});
