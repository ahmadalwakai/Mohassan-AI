import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { createDatabase,type DatabaseHandle } from '@mohassan/database';
import { createAIControl } from '../apps/server/src/ai.js';
import { createMockGroq } from './fixtures/planning.js';
describe('AI health evidence and configuration identity',()=>{
  let database:DatabaseHandle;
  beforeEach(async()=>{database=await createDatabase();});
  afterEach(async()=>{vi.restoreAllMocks();await database.close();});
  it('invalidates old connection proof when the credential changes',async()=>{
    const mock=createMockGroq();const first=await createAIControl(database.db,{apiKey:'first-fixture-key',fetch:mock.fetch});
    await first.verify();expect((await first.status()).status).toBe('verified');
    const second=await createAIControl(database.db,{apiKey:'second-fixture-key',fetch:mock.fetch});expect((await second.status()).status).toBe('configured');
    expect(JSON.stringify(await second.status())).not.toContain('second-fixture-key');
  });
  it('does not trust verification timestamps from the future or older than a day',async()=>{
    const mock=createMockGroq();const ai=await createAIControl(database.db,{apiKey:'fixture-key',fetch:mock.fetch});await ai.verify();
    await database.db.updateTable('ai_provider_health').set({verified_at:new Date(Date.now()+60000)}).execute();expect((await ai.status()).status).toBe('configured');
    await database.db.updateTable('ai_provider_health').set({verified_at:new Date(Date.now()-86401000)}).execute();expect((await ai.status()).status).toBe('configured');
  });
  it('marks wrapped planning authentication rejection as an error instead of retaining verified',async()=>{
    const mock=createMockGroq();let reject=false;
    const ai=await createAIControl(database.db,{apiKey:'fixture-key',fetch:async(input,init)=>reject?new Response('never-expose-raw-key',{status:401}):mock.fetch(input,init)});
    await ai.verify();reject=true;
    await expect(ai.plan('خطة مراجعة مشروع واضحة',{signal:new AbortController().signal})).rejects.toMatchObject({providerCode:'AUTHENTICATION_FAILED'});
    const status=await ai.status();expect(status.status).toBe('error');expect(JSON.stringify(status)).not.toContain('never-expose-raw-key');
  });
  it('preserves a valid paid plan even when writing optional health status fails',async()=>{
    const mock=createMockGroq();const ai=await createAIControl(database.db,{apiKey:'fixture-key',fetch:mock.fetch});
    await database.db.schema.dropTable('ai_provider_health').execute();const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const result=await ai.plan('خطة مراجعة مشروع واضحة',{signal:new AbortController().signal});expect(result.usage).toEqual({inputTokens:700,outputTokens:240});expect(log).toHaveBeenCalledOnce();
  });
  it('retains known token usage when a paid connectivity response is invalid',async()=>{
    const ai=await createAIControl(database.db,{apiKey:'fixture-key',fetch:async input=>String(input).endsWith('/models')?Response.json({data:[{id:'openai/gpt-oss-20b'}]}):Response.json({model:'openai/gpt-oss-20b',choices:[{message:{content:'{"status":"unexpected"}'},finish_reason:'stop'}],usage:{prompt_tokens:31,completion_tokens:9}})});
    await expect(ai.verify()).rejects.toMatchObject({code:'INVALID_RESPONSE',usage:{inputTokens:31,outputTokens:9}});
    const row=await database.db.selectFrom('ai_provider_health').selectAll().executeTakeFirstOrThrow();expect(row).toMatchObject({status:'error',input_tokens:31,output_tokens:9});
  });
});
