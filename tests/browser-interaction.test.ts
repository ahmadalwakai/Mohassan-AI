import {createServer,type Server} from 'node:http';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createDatabase,migrate} from '@mohassan/database';
import {createBrowserResearchControl,migrateBrowser,type BrowserSessionDetail} from '../packages/browser/src/index.js';
import {migrateAuth} from '../apps/server/src/auth.js';

describe('observed controls, fill without submission and exact submitter approval',()=>{
  let server:Server,origin:string,store:Awaited<ReturnType<typeof createDatabase>>,control:ReturnType<typeof createBrowserResearchControl>;
  const owner='browser-interaction-owner',other='browser-interaction-other',sessions:string[]=[],writes:{path:string;body:string}[]=[];
  let mutate='';
  beforeAll(async()=>{
    server=createServer((request,response)=>{
      if(request.method==='POST'){
        let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{writes.push({path:request.url??'',body});response.writeHead(303,{location:'/done'});response.end();});return;
      }
      if(request.url==='/state'){response.setHeader('content-type','text/plain');response.end(mutate);return;}
      response.setHeader('content-type','text/html; charset=utf-8');
      if(request.url==='/done'){response.end('<title>Choice receipt</title><h1>Selected choice received once</h1>');return;}
      if(request.url==='/fill'){
        response.end(`<title>Fill fixture</title><form method="post" action="/autosubmit"><label>Search text<input name="query" oninput="document.getElementById('status').textContent='Typed '+this.value;this.form.requestSubmit();fetch('/event-write',{method:'POST',body:'unapproved'}).catch(()=>{})"></label><input type="hidden" name="csrf" value="private-fill-token"></form><p id="status">Empty</p><input aria-label="Hidden by CSS" style="display:none" value="not-an-observed-control"><label>Password<input type="password" name="password" value="never-expose-password"></label><button type="button" onclick="fetch('/arbitrary-click',{method:'POST'})">Unknown action</button>`);return;
      }
      if(request.url==='/sensitive'){
        response.end('<title>Sensitive fixture</title><form method="post" action="/sensitive-write"><label>Card number<input name="number" autocomplete="cc-number" value="never-expose-card"></label><button>Send payment</button></form>');return;
      }
      if(request.url==='/external'){
        response.end('<title>External submitter fixture</title><form id="choice" method="get" action="/wrong"><input type="hidden" name="csrf" value="private-external-token"></form><button type="submit" form="choice" formaction="/external-choice" formmethod="post" name="decision" value="reject">Reject optional cookies</button>');return;
      }
      if(request.url==='/submit-race'){
        response.end('<title>Submit race fixture</title><form method="post" action="/raced-write" onsubmit="this.elements.csrf.value=\'changed-during-submit\'"><input type="hidden" name="csrf" value="private-original-token"><button name="decision" value="reject">Reject all</button></form>');return;
      }
      if(request.url==='/changing-text'){
        response.end(`<title>Text body binding fixture</title><form method="post" action="/changed-text"><label>Display name<input name="nickname" value="reviewed value"></label><button name="decision" value="reject">Reject all</button></form><p id="status">Original</p><script>setInterval(()=>fetch('/state').then(r=>r.text()).then(value=>{if(value==='text'){document.querySelector('input[name=nickname]').value='unreviewed value';document.getElementById('status').textContent='Changed text field';}}).catch(()=>{}),100);</script>`);return;
      }
      const polling=request.url==='/changing'?`<script>setInterval(()=>fetch('/state').then(r=>r.text()).then(value=>{if(value==='hidden')document.querySelector('input[name=csrf]').value='changed-private-token';if(value==='button')document.querySelector('button[name=decision]').value='accept';}).catch(()=>{}),100);</script>`:'';
      response.end(`<title>Consent choice fixture</title><form method="post" action="/choice"><input type="hidden" name="csrf" value="private-original-token"><button name="decision" value="reject">Reject all</button><button name="decision" value="accept">Accept all</button></form>${polling}`);
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');origin=`http://127.0.0.1:${address.port}`;
    store=await createDatabase();await migrateAuth(store.db);await migrate(store.db);await migrateBrowser(store.db);
    for(const id of [owner,other])await store.db.insertInto('user').values({id,name:id,email:`${id}@example.test`}).execute();
    control=createBrowserResearchControl(store.db,{testOrigins:[origin]});
  });
  beforeEach(()=>{writes.length=0;mutate='';});
  afterEach(async()=>{for(const id of sessions.splice(0))await control.close(owner,id);});
  afterAll(async()=>{await control?.shutdown();await store?.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));});
  async function open(path:string){const created=await control.create(owner,{title:'Observed interaction fixture',allowedOrigins:[origin]});sessions.push(created.id);return control.action(owner,created.id,{action:'navigate',url:origin+path,expectedObservationId:null});}
  const button=(session:BrowserSessionDetail,label:string)=>session.observation!.controls!.find(item=>item.label===label)!;

  it('surfaces rendered control metadata without passwords, hidden values or selectors',async()=>{
    const session=await open('/fill'),observation=session.observation!;
    expect(observation.controls!.some(item=>item.label==='Search text'&&item.kind==='input'&&item.id.match(/^c\d+$/))).toBe(true);
    expect(observation.controls!.some(item=>item.label==='Hidden by CSS')).toBe(false);
    expect(observation.controls!.find(item=>item.label==='Password')).toMatchObject({type:'password',sensitive:true});
    const serialized=JSON.stringify({...observation,screenshot:null});expect(serialized).not.toContain('never-expose-password');expect(serialized).not.toContain('private-fill-token');expect(serialized).not.toContain('not-an-observed-control');
    expect(observation.controls!.every(item=>!('value'in item)&&!('evidence'in item))).toBe(true);
  });

  it('fills an observed non-sensitive field, captures state and blocks event-driven writes/autosubmits',async()=>{
    const session=await open('/fill'),field=button(session,'Search text');
    const filled=await control.fill(owner,session.id,{observationId:session.observation!.id,controlId:field.id,value:'fixture search'});
    expect(filled.observation!.text).toContain('Typed fixture search');expect(filled.observation!.screenshot).toMatch(/^data:image\/jpeg;base64,/);expect(writes).toEqual([]);
    expect(filled.observation!.warnings.some(warning=>warning.includes('موافقة'))).toBe(true);
    await expect(control.fill(owner,session.id,{observationId:session.observation!.id,controlId:field.id,value:'stale'})).rejects.toMatchObject({code:'BROWSER_OBSERVATION_CHANGED'});
    await expect(control.fill(other,session.id,{observationId:filled.observation!.id,controlId:field.id,value:'wrong owner'})).rejects.toMatchObject({code:'BROWSER_NOT_FOUND'});
  });

  it('rejects sensitive fields, free selectors and arbitrary non-submit buttons without clicking',async()=>{
    const session=await open('/fill'),password=button(session,'Password'),unknown=button(session,'Unknown action');
    await expect(control.fill(owner,session.id,{observationId:session.observation!.id,controlId:password.id,value:'not-allowed'})).rejects.toMatchObject({code:'BROWSER_SENSITIVE_FORM'});
    await expect(control.fill(owner,session.id,{observationId:session.observation!.id,controlId:'input[name=query]',value:'not-selector'})).rejects.toThrow();
    await expect(control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:unknown.id})).rejects.toMatchObject({code:'BROWSER_BUTTON_DENIED'});expect(writes).toEqual([]);
    const sensitive=await open('/sensitive');await expect(control.prepareButton(owner,sensitive.id,{observationId:sensitive.observation!.id,controlId:button(sensitive,'Send payment').id})).rejects.toMatchObject({code:'BROWSER_SENSITIVE_FORM'});
  });

  it('prepares both choices without sending, then submits only the selected immutable FormData once',async()=>{
    const session=await open('/choice'),reject=button(session,'Reject all'),accept=button(session,'Accept all');
    const first=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:reject.id});
    const second=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:accept.id});
    const rejectApproval=second.approvals.find(item=>item.request.submitter?.controlId===reject.id)!,acceptApproval=second.approvals.find(item=>item.request.submitter?.controlId===accept.id)!;
    expect(first.approvals[0].request).toMatchObject({method:'POST',submitter:{label:'Reject all',formId:'f0'}});expect(rejectApproval.request.payloadHash).not.toBe(acceptApproval.request.payloadHash);expect(JSON.stringify(second.approvals)).not.toContain('private-original-token');expect(writes).toEqual([]);
    const approvals=await Promise.allSettled([control.approve(owner,session.id,rejectApproval.id),control.approve(owner,session.id,rejectApproval.id)]);
    expect(approvals.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/choice');expect([...new URLSearchParams(writes[0].body)]).toEqual([['csrf','private-original-token'],['decision','reject']]);
    expect((await control.detail(owner,session.id)).observation!.title).toBe('Choice receipt');
    await control.revoke(owner,session.id,acceptApproval.id);await expect(control.approve(owner,session.id,acceptApproval.id)).rejects.toMatchObject({code:'BROWSER_APPROVAL_INVALID'});expect(writes).toHaveLength(1);
  });

  it('binds an external submitter and its destination/method overrides before approval',async()=>{
    const session=await open('/external'),target=button(session,'Reject optional cookies');
    expect(target.formId).toBe('f0');const prepared=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:target.id}),approval=prepared.approvals[0];
    expect(approval.request).toMatchObject({action:origin+'/external-choice',method:'POST'});await control.approve(owner,session.id,approval.id);
    expect(writes).toHaveLength(1);expect(writes[0].path).toBe('/external-choice');expect(new URLSearchParams(writes[0].body).get('decision')).toBe('reject');
  });

  for(const change of ['hidden','button'])it(`rejects ${change} data changing after preparation without authorizing a replacement payload`,async()=>{
    const session=await open('/changing'),target=button(session,'Reject all'),prepared=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:target.id}),approval=prepared.approvals[0];
    mutate=change;await expect.poll(async()=>(await control.engine.observe(session.id)).forms[0].fingerprint,{timeout:5000}).not.toBe(session.observation!.forms[0].fingerprint);
    await expect(control.approve(owner,session.id,approval.id)).rejects.toMatchObject({code:'BROWSER_OBSERVATION_CHANGED'});expect(writes).toEqual([]);
  });

  it('binds existing visible values in the immutable body even when the form structure stays unchanged',async()=>{
    const session=await open('/changing-text'),prepared=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:button(session,'Reject all').id});
    mutate='text';await expect.poll(async()=>(await control.engine.observe(session.id)).text,{timeout:5000}).toContain('Changed text field');
    expect((await control.engine.observe(session.id)).forms[0].fingerprint).toBe(session.observation!.forms[0].fingerprint);
    await expect(control.approve(owner,session.id,prepared.approvals[0].id)).rejects.toMatchObject({code:'BROWSER_FORM_CHANGED'});expect(writes).toEqual([]);
  });

  it('blocks an onsubmit handler that changes the reviewed body after the one-use permit is installed',async()=>{
    const session=await open('/submit-race'),prepared=await control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:button(session,'Reject all').id});
    await expect(control.approve(owner,session.id,prepared.approvals[0].id)).rejects.toMatchObject({code:'BROWSER_SUBMIT_FAILED'});expect(writes).toEqual([]);
    expect((await store.db.selectFrom('browser_approvals').select('receipt').where('id','=',prepared.approvals[0].id).executeTakeFirstOrThrow()).receipt).toMatchObject({code:'BROWSER_SUBMIT_FAILED',diagnostics:{requestAttempted:false,responseStatus:null,failureCode:'BROWSER_SUBMIT_DENIED'}});
  });

  it('does not insert a late prepared approval after close has revoked the session',async()=>{
    const session=await open('/choice'),original=control.engine.prepareButton.bind(control.engine);let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const spy=vi.spyOn(control.engine,'prepareButton').mockImplementation(async(...args)=>{const prepared=await original(...args);entered();await gate;return prepared;});
    try{
      const preparing=control.prepareButton(owner,session.id,{observationId:session.observation!.id,controlId:button(session,'Reject all').id});
      await ready;await control.close(owner,session.id);release();await expect(preparing).rejects.toMatchObject({code:'BROWSER_SESSION_CLOSED'});
      expect(await store.db.selectFrom('browser_approvals').select('id').where('session_id','=',session.id).where('status','=','pending').execute()).toEqual([]);expect(writes).toEqual([]);
    }finally{release();spy.mockRestore();}
  });
});
