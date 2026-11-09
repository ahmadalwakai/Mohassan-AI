import { parseTokenKey } from '@mohassan/google-ads';

/** Configuration inspection only: never opens SQL, requests OAuth, or calls Google. */
export function googleAdsSetupReport(env: Record<string,string|undefined>) {
  const required=['GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_TOKEN_KEY'] as const;
  const missing=required.filter(key=>!env[key]?.trim());
  const invalid:string[]=[];
  if(env.GOOGLE_ADS_CLIENT_ID&&!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_ADS_CLIENT_ID))invalid.push('GOOGLE_ADS_CLIENT_ID');
  if(env.GOOGLE_ADS_CLIENT_SECRET&&(env.GOOGLE_ADS_CLIENT_SECRET.length<8||/\s/.test(env.GOOGLE_ADS_CLIENT_SECRET)))invalid.push('GOOGLE_ADS_CLIENT_SECRET');
  if(env.GOOGLE_ADS_TOKEN_KEY){try{parseTokenKey(env.GOOGLE_ADS_TOKEN_KEY);}catch{invalid.push('GOOGLE_ADS_TOKEN_KEY');}}
  let redirectUri:string|null=null;
  try{
    const url=new URL(env.WEB_ORIGIN??'http://127.0.0.1:3000');
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||env.WEB_ORIGIN!==undefined&&env.WEB_ORIGIN!==url.origin||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('origin');
    redirectUri=`${url.origin}/api/google-ads/oauth/callback`;
  }catch{invalid.push('WEB_ORIGIN');}
  return {
    configured:missing.length===0&&invalid.length===0,missing,invalid,redirectUri,
    developerTokenRequired:false,legacyDeveloperTokenPresent:Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN),
    databaseConfigured:Boolean(env.DATABASE_URL),publishingEnabled:env.GOOGLE_ADS_PUBLISHING_ENABLED==='true',
    liveVerified:false,productionAccess:'unverified',
    nextSteps:[
      'فعّل Google Ads API في مشروع Google Cloud الذي يملك OAuth client، واطلب Explorer للوصول للحساب الحقيقي.',
      'أضف redirectUri المعروض إلى OAuth Web application، واحفظ Client ID وClient Secret في إعدادات الخادم الخاصة.',
      'اضبط WEB_ORIGIN على أصل الموقع فقط بلا مسار أو / أخيرة، مثل https://example.com.',
      'احتفظ بمفتاح GOOGLE_ADS_TOKEN_KEY الحالي؛ تغييره يفقد القدرة على فك التفويضات المحفوظة.',
      'بعد إعادة تشغيل الخدمة بالإعدادات، اربط حسابك واختره من قسم Google Ads ثم نفذ npm run ads:check -- --live؛ يلزم DATABASE_URL وجدول الربط الموجود مسبقًا، وعند تعدد المالكين أضف --owner-id بالمعرّف المقصود.',
      'لا يفعّل فحص الإعداد أو فحص القراءة نشر الحملات أو تشغيلها؛ تبقى بوابات الحساب والتحقق والموافقة مطبقة.',
    ],
    documentation:'https://developers.google.com/google-ads/api/docs/api-policy/developer-token',
  };
}
