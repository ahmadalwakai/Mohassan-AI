import type { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: {params: Promise<{path:string[]}>}) {
  const {path} = await context.params;
  if (path.some(part=>!(/^[a-zA-Z0-9._~-]+$/).test(part) || part==='..')) return Response.json({error:{code:'INVALID_PATH',message:'مسار غير صالح.'}},{status:400});
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return Response.json({error:{code:'NOT_CONFIGURED',message:'ابدأ الخدمة من أمر تشغيل المشروع.'}},{status:503});
  const target = new URL(`/api/${path.map(encodeURIComponent).join('/')}`,process.env.MOHASSAN_SERVER_URL || 'http://127.0.0.1:4000');
  target.search=request.nextUrl.search;
  const headers=new Headers({'x-mohassan-internal':secret});
  for(const key of ['cookie','origin','content-type','user-agent','idempotency-key']) {
    const value=request.headers.get(key); if(value)headers.set(key,value);
  }
  try {
    const limit=path.length===2&&path[0]==='studio'&&path[1]==='images'?1500000:16384;
    const tooLarge=()=>Response.json({error:{code:'PAYLOAD_TOO_LARGE',message:'حجم الطلب أكبر من المسموح.'}},{status:413});
    if (Number(request.headers.get('content-length') || '0') > limit) return tooLarge();
    let body:Uint8Array|undefined;
    if(!['GET','HEAD'].includes(request.method)&&request.body){
      const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit){await reader.cancel();return tooLarge();}parts.push(item.value);}}finally{reader.releaseLock();}
      body=new Uint8Array(size);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.byteLength;}
    }
    const response=await fetch(target,{method:request.method,headers,body:body as BodyInit|undefined,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(path[0]==='studio'&&request.method==='POST'?360000:['research','browser','google-ads'].includes(path[0]??'')?60000:15000)});
    const output=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const contentType=response.headers.get('content-type');if(contentType)output.set('content-type',contentType);
    for(const key of ['retry-after','x-retry-after']){const value=response.headers.get(key);if(value&&/^\d{1,6}$/.test(value))output.set(key,value);}
    for(const cookie of response.headers.getSetCookie())output.append('set-cookie',cookie);
    // Only a path on this site: the service must never send a visitor elsewhere through the proxy.
    const location=response.headers.get('location');if(path[0]==='google-ads'&&location?.startsWith('/')&&!location.startsWith('//'))output.set('location',location);
    return new Response(response.body,{status:response.status,headers:output});
  } catch {
    return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'تعذر الاتصال بخدمة المهام. تحقق من تشغيلها وأعد المحاولة.'}},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
export {forward as GET,forward as POST};
