import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createMemoryControl, MemoryFeedbackSchema, memoryMigration } from '@mohassan/memory';
import { ExperienceFeedbackError, ExperienceFeedbackSchema, experienceSourceKinds, recordExperienceFeedback } from '@mohassan/learning';
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
  app.post('/api/memory/feedback', async request => {
    const ownerId = (await owner(request)).id;
    const input = MemoryFeedbackSchema.parse(request.body);
    const feedback = await memory.feedback(ownerId, input);
    if (input.rating !== undefined) {
      try {
        await recordExperienceFeedback(db, {ownerId, sourceKind: 'runtime_task', sourceId: input.taskId,
          submissionKey: `memory:${feedback.id}`, memoryFeedbackId: feedback.id});
      } catch (error) {
        // A rating can be given before a terminal record exists. Its saved
        // memory feedback ID can be linked when the experience is available.
        if (!(error instanceof ExperienceFeedbackError) || error.code !== 'EXPERIENCE_NOT_FOUND') throw error;
      }
    }
    return feedback;
  });
  app.get('/api/learning/experiences', async request => {
    const ownerId = (await owner(request)).id;
    const items = await db.selectFrom('experiences as e')
      .select(['source_kind as sourceKind', 'source_id as sourceId', 'parent_run_id as parentRunId', 'goal', 'category', 'attempt',
        'terminal_status as terminalStatus', 'outcome', 'evidence_kind as evidenceKind', 'updated_at as updatedAt'])
      .select(eb => eb.fn.coalesce(
        eb.selectFrom('experience_feedback as f').select('f.rating').whereRef('f.owner_id', '=', 'e.owner_id')
          .whereRef('f.source_kind', '=', 'e.source_kind').whereRef('f.source_id', '=', 'e.source_id')
          .whereRef('f.attempt', '=', 'e.attempt').where('f.rating', 'is not', null).orderBy('f.created_at', 'desc').limit(1),
        // A rating submitted while the Runtime task was active still belongs to that task.
        eb.selectFrom('memory_feedback as f').select('f.rating').whereRef('f.owner_id', '=', 'e.owner_id')
          .whereRef('f.task_id', '=', 'e.source_id').where('e.source_kind', '=', 'runtime_task')
          .where('f.rating', 'is not', null).orderBy('f.created_at', 'desc').limit(1),
      ).as('rating'))
      .where('e.owner_id', '=', ownerId).orderBy('e.updated_at', 'desc').limit(50).execute();
    return {items};
  });
  app.post<{Params: {kind: string; id: string}}>('/api/learning/experiences/:kind/:id/feedback', async request => {
    const ownerId = (await owner(request)).id;
    const sourceKind = z.enum(experienceSourceKinds).parse(request.params.kind);
    const sourceId = z.uuid().parse(request.params.id);
    const input = ExperienceFeedbackSchema.parse(request.body);
    return recordExperienceFeedback(db, {ownerId, sourceKind, sourceId, ...input});
  });
  app.post('/api/memory/skills',async request=>memory.createSkill((await owner(request)).id,request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/test',async request=>memory.evaluateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body,'sandbox'));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/benchmark',async request=>memory.evaluateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body,'benchmark'));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/activate',async request=>memory.activateSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/revoke',async request=>memory.revokeSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  app.post<{Params:{id:string}}>('/api/memory/skills/:id/run',async request=>memory.runSkill((await owner(request)).id,z.uuid().parse(request.params.id),request.body));
  return memory;
}
