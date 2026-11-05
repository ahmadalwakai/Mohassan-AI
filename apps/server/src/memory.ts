import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createMemoryControl,memoryMigration } from '@mohassan/memory';
export { memoryMigration } from '@mohassan/memory';

export async function registerMemoryRoutes(app:FastifyInstance,{db,owner}: {db:Kysely<any>;owner:(request:any)=>Promise<{id:string}>;config?:unknown}){
  await memoryMigration(db);const memory=createMemoryControl(db);
  app.get('/api/memory',async request=>memory.workspace((await owner(request)).id));
  app.post('/api/memory/search',async request=>memory.search((await owner(request)).id,request.body));
  app.post('/api/memory/items',async request=>memory.create((await owner(request)).id,request.body));
  app.get<{Params:{id:string}}>('/api/memory/items/:id',async request=>memory.detail((await owner(request)).id,z.uuid().parse(request.params.id)));
  app.post<{Params:{id:string}}>('/api/memory/items/:id/correct',async request=>memory.correct((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/items/:id/revoke',async request=>memory.revoke((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/items/:id/delete',async request=>memory.remove((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post('/api/memory/sync',async request=>{z.object({}).strict().parse(request.body??{});return memory.sync((await owner(request)).id);});
  app.post('/api/memory/feedback',async request=>memory.feedback((await owner(request)).id,request.body));
  app.post('/api/memory/skills',async request=>memory.createSkill((await owner(request)).id,request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/test',async request=>memory.evaluateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body,'sandbox'));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/benchmark',async request=>memory.evaluateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body,'benchmark'));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/activate',async request=>memory.activateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/revoke',async request=>memory.revokeSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/run',async request=>memory.runSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  return memory;
}
