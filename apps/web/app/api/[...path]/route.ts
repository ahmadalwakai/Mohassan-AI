import type { NextRequest } from 'next/server';
import { boundedRelayBody, ingressClientIp, secureSitePreview } from './relay-security';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: {params: Promise<{path:string[]}>}) {
  const {path} = await context.params;
  if (path.some(part=>!(/^[a-zA-Z0-9._~-]+$/).test(part) || part==='..')) return Response.json({error:{code:'INVALID_PATH',message:'مسار غير صالح.'}},{status:400});
  if (path[0]==='chat' && path[1]==='conversation-shares' && path[2]==='public') return new Response(null,{status:404,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; sandbox"}});
  const accountExport = path.length === 2 && path[0] === 'member-data' && path[1] === 'export';
  // Fetch Metadata §2.3: https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header (retrieved 2026-11-25).
  const fetchSite = request.headers.get('sec-fetch-site');
  if (accountExport && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return Response.json({error:{code:'ORIGIN_DENIED',message:'مصدر الطلب غير مسموح به.'}},{status:403,headers:{'Cache-Control':'no-store'}});
  }
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return Response.json({error:{code:'NOT_CONFIGURED',message:'ابدأ الخدمة من أمر تشغيل المشروع.'}},{status:503});
  const target = new URL(`/api/${path.map(encodeURIComponent).join('/')}`,process.env.MOHASSAN_SERVER_URL || 'http://127.0.0.1:4000');
  target.search=request.nextUrl.search;
  const headers=new Headers({'x-mohassan-internal':secret});
  for(const key of ['cookie','origin','content-type','user-agent','idempotency-key']) {
    const value=request.headers.get(key); if(value)headers.set(key,value);
  }
  // Vercel supplies this IP header: https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for (retrieved 2026-11-25).
  const clientIp = ingressClientIp(request.headers, process.env.VERCEL);
  if (clientIp) headers.set('x-mohassan-client-ip', clientIp);
  const tooLarge = () => Response.json({error:{code:'PAYLOAD_TOO_LARGE',message:'حجم الطلب أكبر من المسموح.'}},{status:413});
  let relay: ReturnType<typeof boundedRelayBody> | undefined;
  try {
    const fileGrant=path.length===4&&path[0]==='browser'&&path[1]==='files'&&path[3]==='grants'&&request.method==='POST';
    const desktopFiles=path.length===2&&path[0]==='desktop'&&path[1]==='files'&&request.method==='POST';
    const documentUpload=path.length===2&&path[0]==='documents'&&path[1]==='upload'&&request.method==='POST';
    const chatImage=path.length===2&&path[0]==='chat'&&path[1]==='images'&&request.method==='POST';
    const siteImage=path.length===3&&path[0]==='sites'&&path[2]==='images'&&request.method==='POST';
    const siteBrief=path.length===3&&path[0]==='sites'&&path[2]==='brief'&&request.method==='POST';
    // The owner's models page runs one model on a text or an image (apps/server/src/models-routes.ts).
    const modelRun=path.length===3&&path[0]==='models'&&path[2]==='run'&&request.method==='POST';
    const limit=fileGrant?720000:chatImage?7500000:modelRun?7600000:path.length===2&&path[0]==='studio'&&path[1]==='images'?1500000:siteImage?1500000:siteBrief?262144:desktopFiles?2300000:documentUpload?14000000:path.length===1&&path[0]==='documents'&&request.method==='POST'?400000:16384;
    if (Number(request.headers.get('content-length') || '0') > limit) return tooLarge();
    const learningImport=path.length===2&&path[0]==='learning'&&path[1]==='documents'&&request.method==='POST';
    const conversationExport=path.length===4&&path[0]==='chat'&&path[1]==='conversations'&&path[3]==='export'&&request.method==='GET';
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(conversationExport||accountExport?60000:path[0]==='chat'&&request.method==='POST'&&(path.length===1||path[path.length-1]==='messages')?150000:path[0]==='sites'&&path[2]==='publish'&&request.method==='POST'?300000:path[0]==='studio'&&request.method==='POST'?360000:path[0]==='executor'&&request.method==='POST'?180000:modelRun?180000:path[0]==='desktop'?(request.method==='POST'?930000:60000):learningImport?30000:['research','browser','google-ads','search','documents'].includes(path[0]??'')?60000:15000)]);
    relay = boundedRelayBody(request.body, limit, signal);
    const response=await fetch(target,{method:request.method,headers,...relay.request,cache:'no-store',redirect:'manual',signal});
    const output=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const contentType=response.headers.get('content-type');if(contentType)output.set('content-type',contentType);
    secureSitePreview(output, path);
    // Downloads keep their file name and are sandboxed.
    if(conversationExport||(path.length===6&&path[0]==='browser'&&path[1]==='files'&&path[3]==='grants'&&path[5]==='content')||(path.length===3&&path[0]==='documents'&&path[2]==='content')){
      const disposition=response.headers.get('content-disposition');
      if(disposition&&/^attachment; filename="[a-zA-Z0-9][a-zA-Z0-9._ -]{0,99}"; filename\*=UTF-8''[a-zA-Z0-9._% -]{1,1200}$/.test(disposition))output.set('Content-Disposition',disposition);
      output.set('Content-Security-Policy',"default-src 'none'; sandbox");
    }
    if (accountExport && response.ok && contentType === 'application/zip') {
      output.set('Content-Disposition', 'attachment; filename="mohassan-data.zip"');
      output.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    for(const key of ['retry-after','x-retry-after']){const value=response.headers.get(key);if(value&&/^\d{1,6}$/.test(value))output.set(key,value);}
    for(const cookie of response.headers.getSetCookie())output.append('set-cookie',cookie);
    // Only a path on this site: the service must never send a visitor elsewhere through the proxy.
    const location=response.headers.get('location');if(path[0]==='google-ads'&&location?.startsWith('/')&&!location.startsWith('//'))output.set('location',location);
    return new Response(response.body,{status:response.status,headers:output});
  } catch {
    if (relay?.tooLarge()) return tooLarge();
    return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'تعذر الاتصال بخدمة المهام. تحقق من تشغيلها وأعد المحاولة.'}},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
export {forward as GET,forward as POST,forward as DELETE};
export async function PATCH(request: NextRequest, context: Parameters<typeof forward>[1]) {
  const { path } = await context.params;
  if (path.length !== 2 || path[0] !== "reminders") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, POST, DELETE, OPTIONS" } });
  return forward(request, context);
}
