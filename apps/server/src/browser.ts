import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { migrateBrowser, createBrowserResearchControl, type BrowserConfig } from '@mohassan/browser';

export async function registerBrowserRoutes(app:FastifyInstance,{db,owner,config={},managedLifecycle=true}:{db:Kysely<any>;owner:(request:any)=>Promise<{id:string}>;config?:BrowserConfig;managedLifecycle?:boolean}){
  await migrateBrowser(db);
  const control=createBrowserResearchControl(db,config);
  const id=(value:string)=>z.uuid().parse(value);
  app.get('/api/browser/workspace',async request=>control.workspace((await owner(request)).id));
  app.post('/api/browser/sessions',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>control.create((await owner(request)).id,request.body));
  app.get<{Params:{id:string}}>('/api/browser/sessions/:id',async request=>control.detail((await owner(request)).id,id(request.params.id)));
  app.get<{Params:{id:string}}>('/api/browser/sessions/:id/observations',async request=>control.observations((await owner(request)).id,id(request.params.id),request.query));
  app.post<{Params:{id:string}}>('/api/browser/sessions/:id/actions',async request=>control.action((await owner(request)).id,id(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/browser/sessions/:id/prepare-submit',async request=>control.prepare((await owner(request)).id,id(request.params.id),request.body));
  app.post<{Params:{id:string;approvalId:string}}>('/api/browser/sessions/:id/approvals/:approvalId/approve',async request=>{z.object({}).strict().parse(request.body??{});return control.approve((await owner(request)).id,id(request.params.id),id(request.params.approvalId));});
  app.post<{Params:{id:string;approvalId:string}}>('/api/browser/sessions/:id/approvals/:approvalId/revoke',async request=>{z.object({}).strict().parse(request.body??{});return control.revoke((await owner(request)).id,id(request.params.id),id(request.params.approvalId));});
  app.post<{Params:{id:string}}>('/api/browser/sessions/:id/close',async request=>{z.object({}).strict().parse(request.body??{});return control.close((await owner(request)).id,id(request.params.id));});
  app.post('/api/research/runs',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async request=>control.research((await owner(request)).id,request.body));
  app.get<{Params:{id:string}}>('/api/research/runs/:id',async request=>control.researchDetail((await owner(request)).id,id(request.params.id)));
  app.get<{Params:{id:string}}>('/api/research/runs/:id/report',async(request,reply)=>{const result=await control.researchDetail((await owner(request)).id,id(request.params.id));return result.report??reply.code(result.status==='running'?202:409).send({status:result.status,error:result.error});});
  app.post<{Params:{id:string}}>('/api/research/runs/:id/cancel',async request=>{z.object({}).strict().parse(request.body??{});return control.cancelResearch((await owner(request)).id,id(request.params.id));});
  if(managedLifecycle)app.addHook('onClose',async()=>control.shutdown());
  return control;
}
