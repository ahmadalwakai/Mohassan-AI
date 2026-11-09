import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createKnowledgeControl, createLessonControl, knowledgeMigration, lessonMigration,
  KnowledgeImportSchema, LessonCandidateSchema, LearningContentError, auditTrainingReadiness, prepareRoutingTrainingDataset, serializeLearningContext,lessonContextEntry,knowledgeContextEntry,type LearningContentEvaluator, type ExperienceCategory } from '@mohassan/learning';

export interface LearningConfig { allowedRoots?: string[]; evaluate?: LearningContentEvaluator; stopEvaluation?:()=>void }
const empty = z.object({}).strict();
function category(goal:string): ExperienceCategory {
  if (/برمج|كود|code|program|\bfix\b/i.test(goal)) return 'coding';
  if (/كمبيوتر|حاسوب|computer|window/i.test(goal)) return 'computer';
  if (/ابحث|بحث|search|research/i.test(goal)) return 'research';
  if (/افتح|متصفح|موقع|open|browser|website|https?:/i.test(goal)) return 'browser';
  return 'conversation';
}
export async function registerLearningRoutes(app:FastifyInstance, options:{db:Kysely<any>;owner:(request:any)=>Promise<{id:string}>;config?:LearningConfig}) {
  const {db,owner}=options, config=options.config??{};
  await lessonMigration(db);await knowledgeMigration(db);
  const lessons=createLessonControl(db,{evaluate:config.evaluate});
  const knowledge=createKnowledgeControl(db,{allowedRoots:config.allowedRoots??[],evaluate:config.evaluate});
  const running=new Map<string,Promise<unknown>>();
  const imports=new Set<AbortController>(),pendingImports=new Set<Promise<unknown>>();let closing=false;
  app.addHook('preClose',async()=>{closing=true;config.stopEvaluation?.();for(const controller of imports)controller.abort();await Promise.allSettled([...running.values(),...pendingImports]);});
  app.get('/api/learning/content',async request=>{
    const ownerId=(await owner(request)).id;
    const [lessonRows,documentRows,evaluations]=await Promise.all([lessons.list(ownerId),knowledge.list(ownerId),db.selectFrom('learning_content_evaluations').select(['id','subject_kind','subject_id','status','report','created_at','completed_at']).where('owner_id','=',ownerId).orderBy('created_at','desc').limit(40).execute()]);
    return {lessons:lessonRows,documents:documentRows,evaluations,evaluationAvailable:Boolean(config.evaluate),importsAvailable:Boolean(config.allowedRoots?.length)};
  });
  app.get('/api/learning/training-readiness',async request=>auditTrainingReadiness(db,(await owner(request)).id));
  app.post('/api/learning/training-export',{config:{rateLimit:{max:2,timeWindow:'1 minute'}}},async(request,reply)=>{
    const ownerId=(await owner(request)).id;empty.parse(request.body??{});
    const result=await prepareRoutingTrainingDataset(db,ownerId);reply.header('Cache-Control','no-store');
    if(result.status==='blocked')return reply.code(409).send({...result,error:{code:'TRAINING_DATA_NOT_READY',message:result.readiness.complete?`يلزم ${result.readiness.requiredUnique} مثالًا مؤهلًا؛ المتاح ${result.readiness.roles.routing.eligibleUnique}.`:'لم يكتمل تدقيق كل التجارب؛ التصدير محجوب.'}});
    return result;
  });
  app.post('/api/learning/lessons',async request=>lessons.candidate((await owner(request)).id,LessonCandidateSchema.parse(request.body)));
  app.post('/api/learning/documents',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(request,reply)=>{
    const ownerId=(await owner(request)).id,input=KnowledgeImportSchema.parse(request.body);
    if(closing)throw new LearningContentError('LEARNING_SHUTTING_DOWN','الخدمة تتوقف الآن.',503);
    const controller=new AbortController();imports.add(controller);
    const abort=()=>controller.abort(),disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',disconnected);
    const task=knowledge.ingest(ownerId,input,controller.signal);pendingImports.add(task);
    try{return await task;}finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',disconnected);imports.delete(controller);pendingImports.delete(task);}
  });
  for(const [kind,control] of [['lessons',lessons],['documents',knowledge]] as const) {
    for(const action of ['evaluate','activate','retire'] as const) {
      app.post<{Params:{id:string}}>(`/api/learning/${kind}/:id/${action}`,{config:{rateLimit:{max:action==='evaluate'?2:20,timeWindow:'1 minute'}}},async (request,reply)=>{
        const ownerId=(await owner(request)).id;empty.parse(request.body??{});
        const id=z.uuid().parse(request.params.id);
        if(action!=='evaluate')return control[action](ownerId,id);
        if(!config.evaluate)throw new LearningContentError('LEARNING_EVALUATOR_UNAVAILABLE','يلزم تجهيز فاحص مستقل قبل بدء التقييم.',409);
        const table=kind==='lessons'?'learning_lessons':'learning_documents';
        const row=await db.selectFrom(table).select(['id','status']).where('owner_id','=',ownerId).where('id','=',id).executeTakeFirst();
        if(!row)throw new LearningContentError('LEARNING_NOT_FOUND','العنصر غير متاح.',404);
        if(row.status==='retired')throw new LearningContentError('LEARNING_RETIRED','العنصر مسحوب.',409);
        const key=JSON.stringify([ownerId,kind,id]);
        if(running.has(key))return reply.code(202).send({status:'running',subjectId:id});
        let signalStarted!:(id:string)=>void;
        const started=new Promise<string>(resolve=>{signalStarted=resolve;});
        const evaluation=control.evaluate(ownerId,id,signalStarted);
        const tracked=evaluation.catch(()=>undefined).finally(()=>running.delete(key));
        running.set(key,tracked);
        const receiptId=await Promise.race([started,evaluation.then(result=>result.id)]);
        return reply.code(202).send({status:'running',subjectId:id,receiptId});
      });
    }
  }
  app.post('/api/learning/search',async request=>{
    const ownerId=(await owner(request)).id;
    const {query}=z.object({query:z.string().trim().min(1).max(500)}).strict().parse(request.body);
    const [lessonRows,documents]=await Promise.all([lessons.retrieve(ownerId,{category:category(query),text:query,limit:4}),knowledge.retrieve(ownerId,query,4)]);
    return {lessons:lessonRows,documents};
  });
  return {lessons,knowledge,async context(ownerId:string,goal:string,observed?:{site?:string;tool?:string}) {
    const [lessonRows,documents]=await Promise.all([lessons.retrieve(ownerId,{category:category(goal),text:goal,limit:3,...observed}),knowledge.retrieve(ownerId,goal,3)]);
    return serializeLearningContext([...lessonRows.map(lessonContextEntry),...documents.map(knowledgeContextEntry)]);
  }};
}
