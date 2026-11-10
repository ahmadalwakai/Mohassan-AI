import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { createDatabase,type DatabaseHandle } from '@mohassan/database';
import { createAIControl } from '../apps/server/src/ai.js';
import { createLocalModel } from '../apps/server/src/local-model.js';
import { createMockGroq } from './fixtures/planning.js';
import { asOllama } from './fixtures/local-model.js';
const local=(transport:typeof fetch,model='fixture-model:local')=>createLocalModel({model,fetch:asOllama(transport,model)});
describe('local model health evidence and configuration identity',()=>{
  let database:DatabaseHandle;
  beforeEach(async()=>{database=await createDatabase();});
  afterEach(async()=>{vi.restoreAllMocks();await database.close();});
  it('invalidates old connection proof when the configured model changes',async()=>{
    const mock=createMockGroq();const first=await createAIControl(database.db,{localModel:local(mock.fetch,'first-model:q4')});
    await first.verify();expect((await first.status()).status).toBe('verified');
    const second=await createAIControl(database.db,{localModel:local(mock.fetch,'second-model:q4')});expect((await second.status()).status).toBe('configured');
  });
  it('reports the local model as unconfigured, never a cloud provider, when no model is set',async()=>{
    const ai=await createAIControl(database.db,{localModel:null});
    expect(await ai.status()).toMatchObject({configured:false,status:'unconfigured',model:null});
    await expect(ai.verify()).rejects.toMatchObject({code:'NOT_CONFIGURED'});
    await expect(ai.plan('خطة مراجعة مشروع واضحة',{signal:new AbortController().signal})).rejects.toMatchObject({code:'NOT_CONFIGURED'});
  });
  it('does not trust verification timestamps from the future or older than a day',async()=>{
    const mock=createMockGroq();const ai=await createAIControl(database.db,{localModel:local(mock.fetch)});await ai.verify();
    await database.db.updateTable('ai_provider_health').set({verified_at:new Date(Date.now()+60000)}).execute();expect((await ai.status()).status).toBe('configured');
    await database.db.updateTable('ai_provider_health').set({verified_at:new Date(Date.now()-86401000)}).execute();expect((await ai.status()).status).toBe('configured');
  });
  it('marks planning as an error when Ollama stops answering, instead of retaining verified',async()=>{
    const mock=createMockGroq();let down=false;
    const ai=await createAIControl(database.db,{localModel:createLocalModel({model:'fixture-model:local',fetch:async(input,init)=>{if(down)throw new TypeError('connect ECONNREFUSED 127.0.0.1:11434');return asOllama(mock.fetch,'fixture-model:local')(input,init);}})});
    await ai.verify();down=true;
    await expect(ai.plan('خطة مراجعة مشروع واضحة',{signal:new AbortController().signal})).rejects.toMatchObject({providerCode:'NETWORK_ERROR'});
    const status=await ai.status();expect(status.status).toBe('error');expect(status.message).toContain('Ollama');expect(JSON.stringify(status)).not.toContain('ECONNREFUSED');
  });
  it('preserves a valid plan even when writing optional health status fails',async()=>{
    const mock=createMockGroq();const ai=await createAIControl(database.db,{localModel:local(mock.fetch)});
    await database.db.schema.dropTable('ai_provider_health').execute();const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const result=await ai.plan('خطة مراجعة مشروع واضحة',{signal:new AbortController().signal});expect(result).toMatchObject({provider:'ollama',usage:{inputTokens:700,outputTokens:240}});expect(log).toHaveBeenCalledOnce();
  });
  it('retains known token usage when a connectivity response is invalid',async()=>{
    const ai=await createAIControl(database.db,{localModel:local(async(_input,init)=>Response.json({model:JSON.parse(String(init?.body)).model,choices:[{message:{content:'{"status":"unexpected"}'},finish_reason:'stop'}],usage:{prompt_tokens:31,completion_tokens:9}}))});
    await expect(ai.verify()).rejects.toMatchObject({code:'INVALID_RESPONSE',usage:{inputTokens:31,outputTokens:9}});
    const row=await database.db.selectFrom('ai_provider_health').selectAll().executeTakeFirstOrThrow();expect(row).toMatchObject({id:'ollama',status:'error',input_tokens:31,output_tokens:9});
  });
});
