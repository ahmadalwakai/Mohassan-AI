import type { RawCognitivePlan } from '@mohassan/contracts';
export const rawPlanFixture:RawCognitivePlan={
  summary:'خطة اختبار واضحة للمراجعة قبل التنفيذ.',
  goal:{objective:'تنظيم مراجعة المشروع بأدلة قابلة للتحقق.',successCriteria:[{id:'criterion_1',description:'اكتمال مراجعة واضحة موثقة.',evidence:'تقرير مراجعة ومعايير قبول مكتوبة.'}],constraints:['عدم تعديل ملفات أو تشغيل أدوات أثناء إعداد الخطة.'],assumptions:['تفاصيل المشروع تحتاج فحصًا لاحقًا.'],clarifyingQuestions:[]},
  steps:[
    {id:'inspect',title:'جمع الأدلة الأولية',description:'تحديد ما يجب فحصه داخل المشروع.',dependsOn:[],capabilityId:'system.diagnostic',requiredScopes:['untrusted:grant'],requiresApproval:false,acceptanceCriteria:['قائمة أدلة محددة للمراجعة.']},
    {id:'review',title:'مراجعة النتيجة',description:'مراجعة المعايير قبل تنفيذ أي تغيير.',dependsOn:['inspect'],capabilityId:null,requiredScopes:[],requiresApproval:false,acceptanceCriteria:['مراجعة بشرية مستقلة للنتيجة.']},
  ],
  uncertainties:[],confidence:0.85,
};
/** The assistant's browser journey against the local fixture site. */
function scriptedDecision(prompt:string):Record<string,unknown>{
  const ref=(label:string)=>new RegExp(`(e\\d+) \\w+ "${label}`).exec(prompt)?.[1]??null;
  if(prompt.includes('Account deleted'))return {tool:'answer',text:'تم حذف الحساب كما طلبت.',outcome:'done'};
  if(prompt.includes('Balance: 1250'))return {tool:'click',ref:ref('Delete account'),sensitive:true};
  if(prompt.includes('حسابي التجريبي'))return {tool:'open',url:'http://127.0.0.1:4201/account'};
  if(prompt.includes('اختر طريقة'))return prompt.includes('user chose')?{tool:'answer',text:'اخترت **الأولى**.',outcome:'done'}:{tool:'ask_user',text:'أي طريقة تفضل؟',options:['الأولى','الثانية']};
  return {tool:'answer',text:'أهلًا! هذه **إجابة** تجريبية:\n\n- نقطة أولى\n- نقطة ثانية',outcome:'done'};
}

/** Test-only dependency injection: no HTTP server, key or external request is used. */
export function createMockGroq(){
  const requests:{url:string;body:any}[]=[];
  const fetch:typeof globalThis.fetch=async(input,init)=>{
    const url=String(input);let body:any={};if(init?.body)body=JSON.parse(String(init.body));requests.push({url,body});
    if(url.endsWith('/models'))return Response.json({data:[{id:'openai/gpt-oss-20b',active:true},{id:'openai/gpt-oss-120b',active:true},{id:'qwen/qwen3.8-27b',active:true}]});
    const verification=body.response_format?.json_schema?.name==='connection_check';
    const coding=body.response_format?.json_schema?.name==='coding_edits';
    const studio=body.response_format?.json_schema?.name==='studio_edits';
    const decision=body.response_format?.json_schema?.name==='decision';
    let result:unknown=verification?{status:'ok'}:rawPlanFixture;
    if(coding){const context=JSON.parse(body.messages.at(-1).content);const file=context.files.find((item:any)=>item.editable);result={summary:'إصلاح دالة الجمع دون تعديل الاختبارات أو إعدادات المشروع.',edits:[{path:file.path,content:'export function sum(a, b) { return a + b; }\n'}]};}
    if(studio){const content=body.messages.at(-1).content;const context=JSON.parse(typeof content==='string'?content:content.find((part:any)=>part.type==='text').text);const file=context.files.find((item:any)=>/<h1\b/.test(item.content));if(!file)throw new Error('Isolated studio fixture requires an h1 source file');result={summary:'تغيير عنوان المعاينة داخل نسخة مراجعة اختبارية.',edits:[{path:file.path,content:file.content.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/,'<h1$1>مقترح الاستوديو الاختباري</h1>')}]};}
    if(decision)result={thought:null,plan:null,note:null,url:null,ref:null,text:null,submit:null,options:null,sensitive:null,outcome:null,...scriptedDecision(body.messages.at(-1).content)};
    return Response.json({model:body.model??'openai/gpt-oss-20b',choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{prompt_tokens:verification?30:coding?900:700,completion_tokens:verification?8:coding?100:240}});
  };
  return {fetch,requests};
}
