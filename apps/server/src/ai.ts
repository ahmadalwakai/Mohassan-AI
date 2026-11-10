import { createHash } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { z } from 'zod';
import { AIStatusSchema,type AIStatus,type PlanningResult,type Capability } from '@mohassan/contracts';
import { PlanningEngine,PlanningError } from '@mohassan/cognitive';
import { ProviderError,type ModelRequest } from '@mohassan/providers';
import { createCapabilities } from '@mohassan/runtime';
import { NOT_CONFIGURED_MESSAGE,type LocalModel } from './local-model.js';

/** Health row id for the owner's local model. Rows saved under 'groq' are history only. */
const HEALTH_ID='ollama';

export interface AIConfig {localModel?:LocalModel|null;capabilities?:Capability[]}
export async function createAIControl(db:Kysely<any>,config:AIConfig) {
  await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS ai_provider_health (
      id text PRIMARY KEY, config_fingerprint text NOT NULL, status text NOT NULL CHECK(status IN ('verified','error')),
      model text NOT NULL, verified_at timestamptz, checked_at timestamptz NOT NULL DEFAULT now(),
      error_code text, input_tokens integer, output_tokens integer
    )`.execute(tx);
  });
  const local=config.localModel??null;
  const model=local?.model??null;
  const fingerprint=createHash('sha256').update(JSON.stringify([HEALTH_ID,model,local?.origin??null])).digest('hex');
  const registry=config.capabilities??createCapabilities(Boolean(local));
  // One local model serves both planning slots; the router's fallback is then the same model.
  const engine=local?new PlanningEngine({providerForModel:()=>local.provider('plan'),models:{fast:local.model,reasoning:local.model},capabilities:registry,maxTokens:4096}):null;
  async function status():Promise<AIStatus> {
    if(!local)return {configured:false,status:'unconfigured',model:null,verifiedAt:null,message:NOT_CONFIGURED_MESSAGE};
    const row=await db.selectFrom('ai_provider_health').selectAll().where('id','=',HEALTH_ID).where('config_fingerprint','=',fingerprint).executeTakeFirst();
    const verifiedAt=row?.verified_at?new Date(row.verified_at).toISOString():null;
    if(row?.status==='error')return {configured:true,status:'error',model:row.model,verifiedAt,message:failureMessage(row.error_code)};
    const age=verifiedAt?Date.now()-new Date(verifiedAt).getTime():Infinity;
    if(row?.status==='verified'&&verifiedAt&&age>=0&&age<86400000)return {configured:true,status:'verified',model:row.model,verifiedAt,message:'أجاب نموذج موحسن المحلي على طلب فعلي على هذا الكمبيوتر. لا يُرسل أي طلب إلى مزود سحابي.'};
    return {configured:true,status:'configured',model,verifiedAt,message:'نموذج موحسن المحلي مضبوط. اختبر الاتصال للتحقق من أنه يعمل الآن.'};
  }
  async function rememberSuccess(result:{model:string;verifiedAt:string;usage:{inputTokens:number;outputTokens:number}}) {
    await db.insertInto('ai_provider_health').values({id:HEALTH_ID,config_fingerprint:fingerprint,status:'verified',model:result.model,verified_at:new Date(result.verifiedAt),checked_at:new Date(),error_code:null,input_tokens:result.usage.inputTokens,output_tokens:result.usage.outputTokens})
      .onConflict(conflict=>conflict.column('id').doUpdateSet({config_fingerprint:fingerprint,status:'verified',model:result.model,verified_at:new Date(result.verifiedAt),checked_at:new Date(),error_code:null,input_tokens:result.usage.inputTokens,output_tokens:result.usage.outputTokens})).execute();
  }
  async function rememberFailure(code:string,usage?:{inputTokens:number;outputTokens:number}) {
    const receipt={input_tokens:usage?.inputTokens??null,output_tokens:usage?.outputTokens??null};
    await db.insertInto('ai_provider_health').values({id:HEALTH_ID,config_fingerprint:fingerprint,status:'error',model:model??'',verified_at:null,checked_at:new Date(),error_code:code,...receipt})
      .onConflict(conflict=>conflict.column('id').doUpdateSet({config_fingerprint:fingerprint,status:'error',model:model??'',verified_at:null,checked_at:new Date(),error_code:code,...receipt})).execute();
  }
  let verification:Promise<AIStatus>|null=null;
  /** One small structured request to the local model. Nothing leaves this computer. */
  function verify():Promise<AIStatus> {
    if(verification)return verification;
    verification=(async()=>{
      if(!local)throw new ProviderError('NOT_CONFIGURED',NOT_CONFIGURED_MESSAGE);
      try{
        const result=await local.provider('chat').generate({goal:'تحقق من الاتصال بإرجاع status بقيمة ok فقط.',system:'Return exactly the requested JSON schema. This is a connectivity check.',maxTokens:64,signal:AbortSignal.timeout(LOCAL_VERIFY_TIMEOUT_MS),structured:{name:'connection_check',schema:{type:'object',properties:{status:{type:'string',enum:['ok']}},required:['status'],additionalProperties:false}}});
        let payload:unknown;try{payload=JSON.parse(result.text);}catch{payload=null;}
        if(!z.object({status:z.literal('ok')}).strict().safeParse(payload).success){const error=new ProviderError('INVALID_RESPONSE','فشل التحقق من استجابة النموذج المحلي.');error.usage=result.usage;throw error;}
        await rememberSuccess({model:result.model,verifiedAt:new Date().toISOString(),usage:result.usage});
        return AIStatusSchema.parse(await status());
      }
      catch(error){await rememberFailure(error instanceof ProviderError?error.code:'VERIFICATION_FAILED',error instanceof ProviderError?error.usage:undefined);throw error;}
    })().finally(()=>{verification=null;});
    return verification;
  }
  async function plan(goal:string,context:{signal:AbortSignal;onProgress?:(stage:string,message:string)=>Promise<void>;memoryContext?:unknown;skillContext?:string}):Promise<PlanningResult> {
    if(!engine)throw new ProviderError('NOT_CONFIGURED',NOT_CONFIGURED_MESSAGE);
    try{const result=await engine.generate(goal,context);await rememberSuccess(result).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));return result;}
    catch(error){
      const code=error instanceof ProviderError?error.code:error instanceof PlanningError?error.providerCode:undefined;
      if(code&&['NETWORK_ERROR','MODEL_UNAVAILABLE'].includes(code))await rememberFailure(code).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));
      throw error;
    }
  }
  /** One provider call. Gateway records the started receipt before this method;
   * unknown responses are never retried by this adapter. */
  async function generateSkill(request: ModelRequest) {
    if (!local) throw new ProviderError('NOT_CONFIGURED',NOT_CONFIGURED_MESSAGE);
    let result;
    try { result = await local.provider('skill').generate(request); }
    catch (error) { if (error instanceof ProviderError) Object.assign(error, {model: local.model}); throw error; }
    await rememberSuccess({...result,verifiedAt:new Date().toISOString()}).catch(()=>console.error(JSON.stringify({level:'error',event:'ai_health_write_failed'})));
    return result;
  }
  return {engine,status,verify,plan,generateSkill};
}
/** The connection check is one short reply, but a cold model must load first. */
const LOCAL_VERIFY_TIMEOUT_MS=90_000;
function failureMessage(code:unknown):string {
  if(code==='NETWORK_ERROR'||code==='ABORTED')return 'تعذر الوصول إلى Ollama على هذا الكمبيوتر. شغّل Ollama ثم أعد الاختبار.';
  if(code==='MODEL_UNAVAILABLE')return 'النموذج المحدد غير مثبت في Ollama. راجع LOCAL_MODEL_NAME.';
  if(code==='MODEL_BUSY')return 'النموذج المحلي كان مشغولًا بطلبات أخرى. أعد الاختبار بعد قليل.';
  return 'لم يكتمل آخر اختبار للنموذج المحلي. أعد الاختبار.';
}
