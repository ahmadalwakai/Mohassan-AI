import {describe,it,expect,vi} from 'vitest';
import {GroqProvider} from './index.js';
describe('Groq provider boundary',()=>{
  it('enforces token limits before making a paid call',async()=>{
    const transport=vi.fn();const provider=new GroqProvider({apiKey:'not-a-real-key',model:'test',fetch:transport});
    await expect(provider.generate({goal:'اختبار تخطيط مهمة',maxTokens:99999})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('normalizes validated results without exposing credentials',async()=>{
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({model:'test',choices:[{message:{content:'خطة قابلة للمراجعة'}}],usage:{prompt_tokens:20,completion_tokens:10}}));
    const provider=new GroqProvider({apiKey:'secret-test',model:'test',fetch:transport});
    const result=await provider.generate({goal:'خطة تشخيص للمشروع'});
    expect(result.usage).toEqual({inputTokens:20,outputTokens:10});expect(JSON.stringify(result)).not.toContain('secret-test');
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).not.toHaveProperty('tools');
  });
  it('redacts provider errors instead of forwarding response text',async()=>{
    const provider=new GroqProvider({apiKey:'private-key',model:'test',fetch:async()=>new Response('private-key leaked by provider',{status:429})});
    await expect(provider.generate({goal:'خطة اختبار للواجهة'})).rejects.toMatchObject({code:'RATE_LIMITED',retryable:true});
  });
  it('rejects unverifiable provider responses',async()=>{
    const provider=new GroqProvider({apiKey:'key',model:'test',fetch:async()=>Response.json({choices:[{message:{content:'success'}}]})});
    await expect(provider.generate({goal:'خطة تشخيص للمشروع'})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('transmits a bounded reference image explicitly and never drops it from the request',async()=>{
    const transport=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({model:'vision-fixture',choices:[{message:{content:'{}'},finish_reason:'stop'}],usage:{prompt_tokens:50,completion_tokens:2}}));
    const provider=new GroqProvider({apiKey:'private-fixture-key',model:'vision-fixture',fetch:transport});
    const image={mimeType:'image/png' as const,data:Buffer.from('owned-image-fixture').toString('base64')};
    await provider.generate({goal:'اقترح واجهة من الصورة المرجعية',image});
    const body=JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(body.messages[1].content[1]).toEqual({type:'image_url',image_url:{url:`data:image/png;base64,${image.data}`}});
    expect(provider.supportsImages).toBe(true);expect(body).not.toHaveProperty('tools');
  });
  it('rejects oversized image data before any paid request',async()=>{
    const transport=vi.fn();const provider=new GroqProvider({apiKey:'fixture-key',model:'vision-fixture',fetch:transport});
    await expect(provider.generate({goal:'صورة اختبار محدودة',image:{mimeType:'image/png',data:Buffer.alloc(1048577).toString('base64')}})).rejects.toMatchObject({code:'IMAGE_TOO_LARGE'});
    expect(transport).not.toHaveBeenCalled();
  });
});
