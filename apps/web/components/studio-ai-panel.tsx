"use client";

import { useEffect,useRef,useState,type FormEvent } from 'react';
import { CheckCheck,ImagePlus,ShieldCheck,Sparkles,Upload,X } from 'lucide-react';
import { StudioChangeResultSchema,type StudioSession,type Task } from '@mohassan/contracts';
import styles from './studio-ai-panel.module.css';

async function request(path:string,options:RequestInit={}){const response=await fetch(path,{...options,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json().catch(()=>null);if(!response.ok)throw new Error(body?.error?.message??'تعذر إكمال طلب الاستوديو.');return body;}
const post=(path:string,input:unknown)=>request(path,{method:'POST',body:JSON.stringify(input)});
type Status={available:boolean;visionAvailable:boolean;model:string|null;visionModel:string|null;message:string};
type ImageReference={id:string;url:string;width:number;height:number;bytes:number};

export function StudioAiPanel({session,selectedElementId,offline,onTaskCreated}:{session:Pick<StudioSession,'id'|'revision'|'name'>;selectedElementId?:string;offline:boolean;onTaskCreated:(task:Task)=>void}){
  const [status,setStatus]=useState<Status|null>(null),[goal,setGoal]=useState(''),[mode,setMode]=useState('assisted'),[image,setImage]=useState<ImageReference|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const retry=useRef<{fingerprint:string;key:string}|null>(null);
  useEffect(()=>{let active=true;request('/api/studio/ai/status').then(value=>{if(active)setStatus(value);}).catch(caught=>{if(active)setError(caught instanceof Error?caught.message:'تعذر تحميل حالة النموذج.');});return()=>{active=false;};},[session.id,offline]);
  useEffect(()=>{setImage(null);setGoal('');setError('');retry.current=null;},[session.id]);
  async function upload(file:File){
    if(offline||busy||!status?.visionAvailable)return;if(file.size>1048576||!['image/png','image/jpeg'].includes(file.type)){setError('اختر PNG أو JPEG بحجم حتى1MB وأبعاد من32×32 إلى1600×1600.');return;}
    setBusy('image');setError('');
    try{const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>typeof reader.result==='string'?resolve(reader.result.split(',')[1]):reject(new Error('تعذر قراءة الصورة.'));reader.onerror=()=>reject(new Error('تعذر قراءة الصورة.'));reader.readAsDataURL(file);});setImage(await post('/api/studio/images',{mimeType:file.type,data}));}
    catch(caught){setError(caught instanceof Error?caught.message:'تعذر رفع الصورة.');}finally{setBusy('');}
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(offline||busy||!status?.available)return;
    const input={title:`تعديل بصري: ${session.name}`.slice(0,120),goal:goal.trim(),capabilityId:'studio.change',autonomy:mode,studioInput:{sessionId:session.id,revision:session.revision,...(selectedElementId?{elementId:selectedElementId}:{}),...(image?{imageId:image.id}:{})}};
    const fingerprint=JSON.stringify(input);if(retry.current?.fingerprint!==fingerprint)retry.current={fingerprint,key:crypto.randomUUID()};
    setBusy('task');setError('');try{const task=await request('/api/tasks',{method:'POST',headers:{'Idempotency-Key':retry.current.key},body:fingerprint});retry.current=null;onTaskCreated(task);}catch(caught){setError(caught instanceof Error?caught.message:'تعذر إنشاء المهمة.');}finally{setBusy('');}
  }
  return <section className={styles.panel} aria-label="تعديل الاستوديو بالذكاء"><div className={styles.heading}><Sparkles size={19}/><div><h3>صف التغيير، ثم راجعه.</h3><p>طلب مرتبط بهذا المشروع وإصداره{selectedElementId?' والعنصر المحدد':''}.</p></div><span><ShieldCheck size={13}/>موافقة محددة</span></div>
    <form className={styles.form} onSubmit={submit}><label>ما التغيير البصري المطلوب؟<textarea aria-label="ما التغيير البصري المطلوب؟" required minLength={5} maxLength={4000} rows={3} value={goal} onChange={event=>setGoal(event.target.value)} disabled={offline||Boolean(busy)} placeholder="مثال: اجعل العنوان أوضح، وغيّر لون الزر مع الحفاظ على بقية الصفحة."/></label><div className={styles.controls}><label className={styles.upload}><ImagePlus size={16}/>{busy==='image'?'جارٍ رفع الصورة…':'إرفاق تصميم مرجعي'}<input aria-label="الصورة المرجعية للتصميم" type="file" accept="image/png,image/jpeg" disabled={offline||Boolean(busy)||!status?.visionAvailable} onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);event.target.value='';}}/></label><label className={styles.mode}>وضع الطلب<select aria-label="وضع تعديل الاستوديو" value={mode} onChange={event=>setMode(event.target.value)} disabled={offline||Boolean(busy)}><option value="assisted">طلب تعديل بعد موافقتي</option><option value="shadow">محاكاة المسار فقط</option></select></label><button className={styles.primary} type="submit" disabled={offline||Boolean(busy)||!status?.available}><Upload size={15}/>{busy==='task'?'جارٍ حفظ المهمة…':'إنشاء مهمة التعديل'}</button></div></form>
    {image?<div className={styles.uploaded}><img src={image.url} alt="التصميم المرجعي المرفق"/><div><strong>صورة محفوظة لهذا الطلب</strong><small>{image.width}×{image.height} · {Math.ceil(image.bytes/1024)}KB</small></div><button aria-label="إزالة الصورة من الطلب" onClick={()=>setImage(null)} disabled={Boolean(busy)}><X size={15}/></button></div>:null}
    <p className={styles.disclosure}>بعد موافقة المهمة فقط، يُرسل وصف التغيير وسياق الملفات{image?' والصورة المرفقة':''} إلى النموذج، وقد يستهلك توكنات. ستُختبر نسخة مستقلة وتُعرض مقارنة المصدر والصور قبل تطبيق النتيجة.</p>
    {!status?.visionAvailable?<p className={styles.hint}>إرفاق الصور يحتاج نموذج رؤية مجهزًا على الخادم. التعديل النصي يستخدم الاتصال المتاح.</p>:null}{status&&!status.available?<p className={styles.hint}>{status.message}</p>:null}{error?<p className={styles.error} role="alert">{error}</p>:null}
  </section>;
}

export function StudioAiResult({result,offline=false,onApplied}:{result:Record<string,unknown>;offline?:boolean;onApplied?:()=>void}){
  const parsed=StudioChangeResultSchema.safeParse(result),proposal=parsed.success?parsed.data:null;
  const [busy,setBusy]=useState(false),[applied,setApplied]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;if(proposal)request(`/api/studio/proposals/${proposal.proposalId}`).then(response=>{if(active)setApplied(response.status==='applied');}).catch(()=>{});return()=>{active=false;};},[proposal?.proposalId]);
  if(!proposal)return <p className={styles.error}>تعذر قراءة مقترح الاستوديو.</p>;
  async function apply(){if(!proposal||busy||offline)return;setBusy(true);setError('');try{await post(`/api/studio/proposals/${proposal.proposalId}/apply`,{revision:proposal.baseRevision});setApplied(true);onApplied?.();}catch(caught){setError(caught instanceof Error?caught.message:'تعذر تطبيق المقترح.');}finally{setBusy(false);}}
  return <section className={`${styles.panel} ${styles.result}`} aria-label="مقترح الاستوديو المتحقق"><div className={styles.heading}><CheckCheck size={21}/><div><h3>{proposal.outcome==='ready_for_review'?'التعديل البصري جاهز للمراجعة':'المقترح محفوظ ويحتاج مراجعة'}</h3><p>{proposal.summary}</p></div></div>
    <div className={styles.evidence}><span>مزود التحقق <code>{proposal.verification.provider}</code></span><span>نقطة المراجعة <code title={proposal.checkpoint??''}>{proposal.checkpoint?.slice(0,12)??'لم تُعتمد'}</code></span><span>النموذج <code>{proposal.model}</code></span><span>التوكنات {proposal.usage.inputTokens} إدخال · {proposal.usage.outputTokens} إخراج</span></div>
    {proposal.baselineImageId&&proposal.candidateImageId?<div className={styles.comparison}><figure><figcaption>قبل التعديل</figcaption><img src={`/api/studio/reviews/artifacts/${proposal.baselineImageId}`} alt="المعاينة قبل التعديل"/></figure><figure><figcaption>المقترح المختبر</figcaption><img src={`/api/studio/reviews/artifacts/${proposal.candidateImageId}`} alt="معاينة المقترح بعد الاختبار"/></figure></div>:null}
    {proposal.visualDiff?<p className={styles.metric}>المقارنة البصرية: تغيرت {(proposal.visualDiff.ratio*100).toFixed(2)}% من البكسلات ({proposal.visualDiff.changedPixels.toLocaleString('ar')} من {proposal.visualDiff.totalPixels.toLocaleString('ar')}). هذه مقارنة تغير، وليست حكمًا آليًا على جودة التصميم.</p>:null}
    <ul className={styles.checks}>{proposal.review.checks.map(check=><li key={check.id} className={check.passed?styles.passed:styles.failed}>{check.passed?'✓':'×'} {check.message}</li>)}</ul>
    <details open><summary>فرق المصدر ({proposal.changes.length} ملفات)</summary><pre className={styles.diff} dir="ltr">{proposal.diff}</pre></details>
    {error?<p className={styles.error} role="alert">{error}</p>:null}{applied?<p className={styles.applied} role="status">طُبق المقترح على نسخة المراجعة.</p>:<div className={styles.apply}><p>راجع المصدر والصورتين. التطبيق يحدّث نسخة الاستوديو عند تطابق إصدارها مع هذا المقترح.</p><button className={styles.primary} disabled={offline||busy||proposal.outcome!=='ready_for_review'} onClick={()=>void apply()}>{busy?'جارٍ التطبيق…':'تطبيق المقترح على نسخة المراجعة'}</button></div>}
  </section>;
}
