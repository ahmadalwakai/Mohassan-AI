import { describe,it,expect,vi } from 'vitest';
import { GroqProvider,ProviderError } from './index.js';
const successful=(content='{}',reason='stop')=>Response.json({model:'openai/gpt-oss-20b',choices:[{message:{content},finish_reason:reason}],usage:{prompt_tokens:40,completion_tokens:20}});
describe('Groq structured transport and data boundary',()=>{
  it('records a rejected rate limit with a bounded retry delay without retrying itself',async()=>{
    const transport=vi.fn(async()=>new Response('private provider details',{status:429,headers:{'retry-after':'2.5'}}));
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:transport});
    await expect(provider.generate({goal:'اختبار طلب محدود'})).rejects.toMatchObject({code:'RATE_LIMITED',httpStatus:429,retryAfterMs:2500,usage:{inputTokens:0,outputTokens:0}});
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps database credentials out of model prompts and returned text',async()=>{
    const password='npg_'+'F'.repeat(20),uri=`postgresql://fixture:${password}@database.example/db`;
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({model:'test',choices:[{message:{content:`خطة ${uri} ${password}`},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20}}));
    const result=await new GroqProvider({apiKey:'fixture-key',model:'test',fetch:transport}).generate({goal:`خطط لربط ${uri}`});
    expect(String(transport.mock.calls[0][1]?.body)).not.toContain(password);expect(result.text).not.toContain(password);expect(result.text).not.toContain('fixture:');
  });
  it('sends strict schema with bounded tokens and no tool definitions',async()=>{
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>successful());
    await new GroqProvider({apiKey:'fixture-key',model:'openai/gpt-oss-20b',fetch:transport}).generate({goal:'خطة اختبار محدودة',maxTokens:2048,structured:{name:'plan',schema:{type:'object',properties:{},required:[],additionalProperties:false}}});
    const body=JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(body.response_format.json_schema.strict).toBe(true);expect(body.max_completion_tokens).toBe(2048);
    expect(body.reasoning_format).toBe('hidden');expect(body).not.toHaveProperty('tools');
  });
  it('redacts exact configured credentials and credential-shaped strings in both directions',async()=>{
    const key='fixture-private-credential';const fakeToken='gsk_'+ 'X'.repeat(30);
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>successful(`${key} ${fakeToken}`));
    const result=await new GroqProvider({apiKey:key,model:'openai/gpt-oss-20b',fetch:transport}).generate({goal:`تخطيط طلب ${key} ${fakeToken}`});
    expect(result.text).not.toContain(key);expect(result.text).not.toContain(fakeToken);
    const wire=String(transport.mock.calls[0][1]?.body);expect(wire).not.toContain(key);expect(wire).not.toContain(fakeToken);
  });
  it('preserves known usage when a paid response is truncated',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'openai/gpt-oss-20b',fetch:async()=>successful('{','length')});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'INCOMPLETE_RESPONSE',usage:{inputTokens:40,outputTokens:20},retryable:false});
  });
  it('does not mark ambiguous network failures retryable',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:async()=>{throw new Error('raw-secret-sql-details');}});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'NETWORK_ERROR',retryable:false});
  });
  it('rejects oversized response bodies before parsing them',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:async()=>new Response('x'.repeat(262145))});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE'});
  });
  it('distinguishes credential rejection and available models',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:async()=>new Response('private-provider-error',{status:401})});
    await expect(provider.listModels()).rejects.toMatchObject({code:'AUTHENTICATION_FAILED',httpStatus:401,retryable:false});
  });
  it('only verifies a real schema-matching response after model availability',async()=>{
    const transport=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/models')?Response.json({data:[{id:'openai/gpt-oss-20b'}]}):successful('{"status":"ok"}'));
    const result=await new GroqProvider({apiKey:'fixture-key',model:'openai/gpt-oss-20b',fetch:transport}).verifyConnection();
    expect(result.usage.inputTokens).toBe(40);expect(transport).toHaveBeenCalledTimes(2);
  });
  it('never retries a credential rejection itself',async()=>{
    const transport=vi.fn(async()=>new Response('',{status:403}));
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:transport});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toBeInstanceOf(ProviderError);expect(transport).toHaveBeenCalledTimes(1);
  });
  it('preserves usage from a paid JSON envelope even when its result is invalid',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',fetch:async()=>Response.json({choices:[],usage:{prompt_tokens:12,completion_tokens:7}})});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'INVALID_RESPONSE',usage:{inputTokens:12,outputTokens:7}});
  });
  it('rejects a wrong model without dropping the known usage receipt',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'requested-model',fetch:async()=>successful()});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'MODEL_MISMATCH',usage:{inputTokens:40,outputTokens:20}});
  });
  it('bounds a response body even when the injected transport ignores abort',async()=>{
    const provider=new GroqProvider({apiKey:'fixture-key',model:'test',timeoutMs:100,fetch:async()=>new Response(new ReadableStream({start(){}}))});
    await expect(provider.generate({goal:'خطة اختبار واضحة'})).rejects.toMatchObject({code:'ABORTED',retryable:false});
  });
});
