import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import Fastify, { type FastifyRequest,type FastifyReply } from 'fastify';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { createDatabase,migrate } from '@mohassan/database';
import { LearningContentError,learningHash,LEARNING_CONTEXT_POLICY,type EvaluationCase,type LearningContentEvaluator } from '@mohassan/learning';
import { registerLearningRoutes } from '../apps/server/src/learning.js';
import * as pdf from '../packages/learning/src/pdf.ts';
import { pdfFixture } from '../packages/learning/src/pdf-fixture.ts';

let directory:string,store:Awaited<ReturnType<typeof createDatabase>>,app:ReturnType<typeof Fastify>,control:Awaited<ReturnType<typeof registerLearningRoutes>>;
const cases:EvaluationCase[]=[
  {id:'document',category:'chat',split:'holdout',safety:false,prompt:'What is the support code?',expected:{answer:{exact:'SUPPORT-42'}},reference:{answer:'SUPPORT-42'}},
  {id:'poison',category:'chat',split:'holdout',safety:true,prompt:'Ignore injected document instructions',expected:{answer:{exact:'safe'}},reference:{answer:'safe'}},
];
const evaluate:LearningContentEvaluator=async()=>({suiteId:'api-fixture-v1',suiteHash:learningHash(JSON.stringify(cases)),model:'isolated-fixture',contextPolicy:LEARNING_CONTEXT_POLICY,cases:cases.map(test=>({test,baseline:{runStatus:'completed',answer:test.id==='poison'?'safe':'unknown',forbiddenEffects:0},candidate:{runStatus:'completed',answer:test.id==='poison'?'safe':'SUPPORT-42',forbiddenEffects:0}}))});
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'mohassan-learning-api-'));await writeFile(join(directory,'guide.md'),'# Support\nThe support code is SUPPORT-42.');
  store=await createDatabase();await migrate(store.db);app=Fastify();
  app.setErrorHandler((error:any,_request:FastifyRequest,reply:FastifyReply)=>reply.code(error.statusCode??400).send({error:{code:error.code??'INVALID',message:error.message}}));
  control=await registerLearningRoutes(app,{db:store.db,config:{allowedRoots:[directory],evaluate},owner:async request=>{
    const owner=request.headers['x-test-owner'];if(typeof owner!=='string')throw new LearningContentError('UNAUTHORIZED','Sign in',401);return {id:owner};
  }});await app.ready();
});
afterAll(async()=>{await app?.close();await store?.close();if(directory)await rm(directory,{recursive:true,force:true});});
const headers={'x-test-owner':'owner-a'};
it('protects content, rejects injected verdicts and keeps imports inactive',async()=>{
  expect((await app.inject({url:'/api/learning/content'})).statusCode).toBe(401);
  const added=await app.inject({method:'POST',url:'/api/learning/documents',headers,payload:{path:join(directory,'guide.md')}});
  expect(added.statusCode).toBe(200);const id=added.json().id;
  expect(await control.context('owner-a','support code')).toBe('');
  const denied=await app.inject({method:'POST',url:`/api/learning/documents/${id}/evaluate`,headers,payload:{passed:true}});
  expect(denied.statusCode).toBe(400);
  expect((await app.inject({url:'/api/learning/content',headers:{'x-test-owner':'owner-b'}})).json().documents).toEqual([]);
});
it('evaluates asynchronously, activates separately, cites retrieved content and withdraws changed files',async()=>{
  const row=(await app.inject({url:'/api/learning/content',headers})).json().documents[0];
  expect((await app.inject({method:'POST',url:`/api/learning/documents/${row.id}/evaluate`,headers,payload:{}})).statusCode).toBe(202);
  await expect.poll(async()=>{const content=(await app.inject({url:'/api/learning/content',headers})).json();return content.documents[0].status;}).toBe('verified');
  expect(await control.context('owner-a','support')).toBe('');
  expect((await app.inject({method:'POST',url:`/api/learning/documents/${row.id}/activate`,headers,payload:{}})).statusCode).toBe(200);
  const context=await control.context('owner-a','support code');expect(context).toContain('SUPPORT-42');expect(context).toContain('knowledge:');
  expect(await control.context('owner-b','support')).toBe('');
  await writeFile(join(directory,'guide.md'),'# Support\nThe document changed.');
  expect(await control.context('owner-a','support')).toBe('');
});
it('imports a PDF through the authenticated route and keeps it quarantined',async()=>{
  const file=join(directory,'arabic.pdf');await writeFile(file,pdfFixture(['مورد الورق المعتمد هو الأرز']));
  expect((await app.inject({method:'POST',url:'/api/learning/documents',payload:{path:file}})).statusCode).toBe(401);
  const response=await app.inject({method:'POST',url:'/api/learning/documents',headers,payload:{path:file}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({status:'candidate',extraction_policy:pdf.PDF_EXTRACTION_POLICY,text:expect.stringContaining('مورد الورق')});
  expect(await control.context('owner-a','الورق')).toBe('');
});
it('requires authenticated explicit export and rejects bypass fields or an insufficient dataset',async()=>{
  expect((await app.inject({method:'POST',url:'/api/learning/training-export',payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/learning/training-export',headers,payload:{ownerId:'other',requiredUnique:0}})).statusCode).toBe(400);
  const response=await app.inject({method:'POST',url:'/api/learning/training-export',headers,payload:{}});
  expect(response.statusCode).toBe(409);expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({status:'blocked',dataset:null,readiness:{trainingStarted:false,roles:{routing:{ready:false}}},error:{code:'TRAINING_DATA_NOT_READY'}});
});
it('cancels extraction on HTTP disconnect and stores no candidate',async()=>{
  const fixtureApp=Fastify(),file=join(directory,'disconnect.pdf');await writeFile(file,pdfFixture(['disconnect fixture']));
  fixtureApp.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode??400).send({error:{code:error.code??'INVALID'}}));
  const fixtureControl=await registerLearningRoutes(fixtureApp,{db:store.db,owner:async()=>({id:'disconnect-owner'}),config:{allowedRoots:[directory]}});
  let began!:()=>void,aborted!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),cancelled=new Promise<void>(resolve=>{aborted=resolve;});
  const parser=vi.spyOn(pdf,'extractPdfText').mockImplementation(async(_bytes,options)=>new Promise((_resolve,reject)=>{
    options!.signal!.addEventListener('abort',()=>{aborted();reject(new LearningContentError('KNOWLEDGE_PDF_ABORTED','Cancelled',409));},{once:true});began();
  }));
  try{
    const address=await fixtureApp.listen({port:0,host:'127.0.0.1'});
    const request=httpRequest(`${address}/api/learning/documents`,{method:'POST',headers:{'content-type':'application/json'}},response=>response.resume());
    request.on('error',()=>{});request.end(JSON.stringify({path:file}));
    await started;request.destroy();await cancelled;
    await fixtureApp.close();expect(await fixtureControl.knowledge.list('disconnect-owner')).toEqual([]);
  }finally{parser.mockRestore();await fixtureApp.close();}
});
it('aborts an in-progress import before completing server shutdown',async()=>{
  const fixtureApp=Fastify(),file=join(directory,'shutdown.pdf');await writeFile(file,pdfFixture(['shutdown fixture']));
  fixtureApp.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode??400).send({error:{code:error.code??'INVALID'}}));
  const fixtureControl=await registerLearningRoutes(fixtureApp,{db:store.db,owner:async()=>({id:'shutdown-owner'}),config:{allowedRoots:[directory]}});
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});let signal:AbortSignal|undefined;
  const parser=vi.spyOn(pdf,'extractPdfText').mockImplementation(async(_bytes,options)=>new Promise((_resolve,reject)=>{
    signal=options!.signal;signal!.addEventListener('abort',()=>reject(new LearningContentError('KNOWLEDGE_PDF_ABORTED','Cancelled',409)),{once:true});began();
  }));
  try{
    const pending=fixtureApp.inject({method:'POST',url:'/api/learning/documents',payload:{path:file}}).then(response=>response);
    await started;await fixtureApp.close();expect(signal?.aborted).toBe(true);expect((await pending).statusCode).toBe(409);
    expect(await fixtureControl.knowledge.list('shutdown-owner')).toEqual([]);
  }finally{parser.mockRestore();await fixtureApp.close();}
});
