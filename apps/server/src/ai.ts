import { createHash } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { AIStatusSchema,type AIStatus,type PlanningResult,type Capability } from '@mohassan/contracts';
import { PlanningEngine,PlanningError,ModelRouter } from '@mohassan/cognitive';
import { GroqProvider,ProviderError,type ModelRequest } from '@mohassan/providers';
import { createCapabilities } from '@mohassan/runtime';

export interface AIConfig {apiKey?:string;model?:string;reasoningModel?:string;fetch?:typeof fetch;capabilities?:Capability[]}
export async function createAIControl(db:Kysely<any>,config:AIConfig) {
  await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS ai_provider_health (
      id text PRIMARY KEY, config_fingerprint text NOT NULL, status text NOT NULL CHECK(status IN ('verified','error')),
      model text NOT NULL, verified_at timestamptz, checked_at timestamptz NOT NULL DEFAULT now(),
      error_code text, input_tokens integer, output_tokens integer
    )`.execute(tx);
  });
  const model=config.model||'openai/gpt-oss-20b',reasoningModel=config.reasoningModel||'openai/gpt-oss-120b';
  const fingerprint=createHash('sha256').update(JSON.stringify([config.apiKey??'',model,reasoningModel])).digest('hex');
  const providerForModel=(selected:string)=>new GroqProvider({apiKey:config.apiKey??'',model:selected,fetch:config.fetch,timeoutMs:30000});
  const registry=config.capabilities??createCapabilities(Boolean(config.apiKey));
  const engine=config.apiKey?new PlanningEngine({providerForModel,models:{fast:model,reasoning:reasoningModel},capabilities:registry,maxTokens:4096}):null;
  async function status():Promise<AIStatus> {
    if(!config.apiKey)return {configured:false,status:'unconfigured',model:null,verifiedAt:null,message:'لم يُجهّز مفتاح Groq على الخادم.'};
    const row=await db.selectFrom('ai_provider_health').selectAll().where('id','=','groq').where('config_fingerprint','=',fingerprint).executeTakeFirst();
    const verifiedAt=row?.verified_at?new Date(row.verified_at).toISOString():null;
    if(row?.status==='error')return {configured:true,status:'error',model:row.model,verifiedAt,message:failureMessage(row.error_code)};
    const age=verifiedAt?Date.now()-new Date(verifiedAt).getTime():Infinity;
    if(row?.status==='verified'&&verifiedAt&&age>=0&&age<86400000)return {configured:true,status:'verified',model:row.model,verifiedAt,message:'نجح طلب فعلي إلى Groq. التخطيط متاح، وتنفيذ الأدوات يبقى منفصلًا.'};
    return {configured:true,status:'configured',model,verifiedAt,message:'إعداد Groq موجود. اختبر الاتصال أو أنشئ مهمة تخطيط للتحقق منه.'};
  }
  async function rememberSuccess(result:{model:string;verifiedAt:string;usage:{inputTokens:number;outputTokens:number}}) {
    await db.insertInto('ai_provider_health').values({id:'groq',config_fingerprint:fingerprint,status:'verified',model:result.model,verified_at:new Date(result.verifiedAt),checked_at:new Date(),error_code:null,input_tokens:result.usage.inputTokens,output_tokens:result.usage.outputTokens})
      .onConflict(conflict=>conflict.column('id').doUpdateSet({config_fingerprint:fingerprint,status:'verified',model:result.model,verified_at:new Date(result.verifiedAt),checked_at:new Date(),error_code:null,input_tokens:result.usage.inputTokens,output_tokens:result.usage.outputTokens})).execute();
  }
  async function rememberFailure(code:string,usage?:{inputTokens:number;outputTokens:number}) {
    const receipt={input_tokens:usage?.inputTokens??null,output_tokens:usage?.outputTokens??null};
    await db.insertInto('ai_provider_health').values({id:'groq',config_fingerprint:fingerprint,status:'error',model,verified_at:null,checked_at:new Date(),error_code:code,...receipt})
      .onConflict(conflict=>conflict.column('id').doUpdateSet({config_fingerprint:fingerprint,status:'error',model,verified_at:null,checked_at:new Date(),error_code:code,...receipt})).execute();
  }
  let verification:Promise<AIStatus>|null=null;
  function verify():Promise<AIStatus> {
    if(verification)return verification;
    verification=(async()=>{
      if(!engine)throw new ProviderError('NOT_CONFIGURED','جهّز مفتاح Groq على الخادم أولًا.');
      try{const result=await providerForModel(model).verifyConnection(AbortSignal.timeout(12000));await rememberSuccess(result);return AIStatusSchema.parse(await status());}
      catch(error){await rememberFailure(error instanceof ProviderError?error.code:'VERIFICATION_FAILED',error instanceof ProviderError?error.usage:undefined);throw error;}
    })().finally(()=>{verification=null;});
    return verification;
  }
  async function plan(goal:string,context:{signal:AbortSignal;onProgress?:(stage:string,message:string)=>Promise<void>;memoryContext?:unknown;skillContext?:string}):Promise<PlanningResult> {
    if(!engine)throw new ProviderError('NOT_CONFIGURED','التخطيط يحتاج مفتاح Groq.');
    try{const result=await engine.generate(goal,context);await rememberSuccess(result).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));return result;}
    catch(error){
      const code=error instanceof ProviderError?error.code:error instanceof PlanningError?error.providerCode:undefined;
      if(code&&['AUTHENTICATION_FAILED','PERMISSION_DENIED','MODEL_UNAVAILABLE'].includes(code))await rememberFailure(code).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));
      throw error;
    }
  }
  /** One provider call. Gateway records the started receipt before this method;
   * unknown or paid responses are never retried by this adapter. */
  async function generateSkill(request: ModelRequest) {
    if (!engine) throw new ProviderError('NOT_CONFIGURED','خطوة النموذج تحتاج إعداد Groq.');
    const route = new ModelRouter({fast:model,reasoning:reasoningModel}).route(request.goal);
    let result;
    try { result = await providerForModel(route.model).generate(request); }
    catch (error) { if (error instanceof ProviderError) Object.assign(error, {model: route.model}); throw error; }
    await rememberSuccess({...result,verifiedAt:new Date().toISOString()}).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));
    return result;
  }
  return {engine,status,verify,plan,generateSkill};
}
function failureMessage(code:unknown):string {
  if(code==='AUTHENTICATION_FAILED')return 'رفض Groq مفتاح الاتصال؛ حدّث إعداد الخادم.';
  if(code==='PERMISSION_DENIED'||code==='MODEL_UNAVAILABLE')return 'النموذج المحدد غير متاح للحساب. راجع إعداد النموذج.';
  if(code==='RATE_LIMITED')return 'بلغ اتصال Groq حد الطلبات. يمكن إعادة الاختبار لاحقًا.';
  return 'لم يكتمل آخر اختبار للاتصال. راجع الاتصال أو أعد الاختبار.';
}
