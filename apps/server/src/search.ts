import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BrowserError, type LocalPublicIndex, type SearchCacheStore } from '@mohassan/browser';

/** Only authenticated owner actions can populate the index; there is no model-facing write tool. */
export async function registerSearchRoutes(app:FastifyInstance,{owner,index,store}:{owner:(request:any)=>Promise<{id:string}>;index:LocalPublicIndex;store:SearchCacheStore}){
  const controllers=new Set<AbortController>(),pending=new Set<Promise<unknown>>();let closing=false;
  app.get('/api/search/index',async request=>({documents:await index.list((await owner(request)).id),coverage:'local_only',automaticCrawling:false}));
  app.get('/api/search/index/query',async request=>{
    const ownerId=(await owner(request)).id;
    const query=z.object({question:z.string().trim().min(1).max(500),limit:z.coerce.number().int().min(1).max(20).default(5)}).strict().parse(request.query);
    return {hits:await index.search(query.question,query.limit,undefined,{ownerId}),coverage:'local_only',freshness:'indexed_snapshot',limitations:index.limitations};
  });
  app.post('/api/search/index',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async (request,reply)=>{
    const ownerId=(await owner(request)).id;
    if(closing)throw new BrowserError('SEARCH_SHUTTING_DOWN','الخدمة تتوقف الآن.',503);
    const controller=new AbortController();controllers.add(controller);
    const abort=()=>controller.abort(),disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};request.raw.once('aborted',abort);reply.raw.once('close',disconnected);
    const task=index.indexUrl(ownerId,request.body,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));pending.add(task);
    try{return await task;}finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',disconnected);controllers.delete(controller);pending.delete(task);}
  });
  app.post<{Params:{id:string}}>('/api/search/index/:id/refresh',{config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async(request,reply)=>{
    const ownerId=(await owner(request)).id,id=z.uuid().parse(request.params.id);
    z.object({}).strict().parse(request.body??{});
    if(closing)throw new BrowserError('SEARCH_SHUTTING_DOWN','الخدمة تتوقف الآن.',503);
    const controller=new AbortController();controllers.add(controller);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',disconnected);
    const task=index.refresh(ownerId,id,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));pending.add(task);
    try{return await task;}finally{reply.raw.removeListener('close',disconnected);controllers.delete(controller);pending.delete(task);}
  });
  app.delete<{Params:{id:string}}>('/api/search/index/:id',async request=>{await index.remove((await owner(request)).id,z.uuid().parse(request.params.id));return {ok:true};});
  app.delete('/api/search/cache',async request=>{await store.clear((await owner(request)).id);return {ok:true};});
  let maintenance:Promise<unknown>|undefined;
  const timer=setInterval(()=>{
    if(closing||maintenance)return;
    maintenance=index.pruneExpired().catch(()=>{app.log.warn('search_index_retention_failed');}).finally(()=>{maintenance=undefined;});
  },60_000);timer.unref();
  app.addHook('preClose',async()=>{closing=true;clearInterval(timer);for(const controller of controllers)controller.abort();await Promise.allSettled([...pending,...(maintenance?[maintenance]:[])]);});
}
