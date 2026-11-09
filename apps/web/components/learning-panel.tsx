"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './memory-workspace.module.css';

type Entry={id:string;status:'candidate'|'verified'|'active'|'retired';text?:string;title?:string;version:number};
type Experience={sourceKind:'chat_run'|'runtime_task';sourceId:string;attempt:number;goal:string;category:string;outcome:string};
type Content={lessons:Entry[];documents:Entry[];evaluations:{subject_id:string;status:string;report?:{passed:boolean;caseCount:number;regressions:number}}[];evaluationAvailable:boolean;importsAvailable:boolean};
type TrainingReadiness={requiredUnique:number;complete:boolean;roles:{routing:{eligibleUnique:number;ready:boolean}}};
const labels={candidate:'بانتظار التقييم',verified:'اجتاز التقييم',active:'نشط',retired:'مسحوب'};
async function request(path:string,body?:unknown,signal?:AbortSignal) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok) throw new Error(result?.error?.message??'تعذر إكمال الطلب.');
  return result;
}
export function LearningPanel({offline}:{offline:boolean}) {
  const [open,setOpen]=useState(false),[content,setContent]=useState<Content|null>(null),[experiences,setExperiences]=useState<Experience[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [training,setTraining]=useState<TrainingReadiness|null>(null),[importing,setImporting]=useState(false);
  const loadSequence=useRef(0),mounted=useRef(false);
  const importController=useRef<AbortController|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadSequence.current++;importController.current?.abort();};},[]);
  const load=useCallback(async(canApply:()=>boolean=()=>true)=>{
    const sequence=++loadSequence.current;
    const [data,records,readiness]=await Promise.all([request('/api/learning/content'),request('/api/learning/experiences'),request('/api/learning/training-readiness')]);
    if(mounted.current&&sequence===loadSequence.current&&canApply()){setContent(data);setExperiences(records.items);setTraining(readiness);}
  },[]);
  useEffect(()=>{
    if(!open||offline)return;
    let active=true;setBusy(true);
    void load(()=>active).catch(error=>{if(active)setError(error.message);}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[open,offline,load]);
  const hasRunning=content?.evaluations?.some(item=>item.status==='running')??false;
  useEffect(()=>{
    if(!open||offline||!hasRunning)return;
    let active=true,inFlight=false;
    const timer=setInterval(()=>{if(inFlight||document.hidden)return;inFlight=true;void load(()=>active).catch(()=>{if(active)setError('تعذر تحديث نتيجة التقييم.');}).finally(()=>{inFlight=false;});},2000);
    return()=>{active=false;clearInterval(timer);};
  },[open,offline,hasRunning,load]);
  const action=async(work:()=>Promise<unknown>,success:string)=>{
    setBusy(true);setError('');setNotice('');
    try{await work();await load();if(mounted.current)setNotice(success);}catch(error){if(mounted.current)setError(error instanceof Error?(error.name==='AbortError'?'أُلغي استيراد المستند.':error.message):'تعذر إكمال الطلب.');}finally{if(mounted.current)setBusy(false);}
  };
  const disabled=offline||busy;
  const reference=(record:Experience)=>({sourceKind:record.sourceKind,sourceId:record.sourceId,attempt:record.attempt});
  async function addDocument(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=event.currentTarget,values=new FormData(form),controller=new AbortController();
    importController.current=controller;setImporting(true);
    try{await action(async()=>{await request('/api/learning/documents',{path:values.get('path'),...(values.get('title')?{title:values.get('title')}:{})},controller.signal);form.reset();},'أضيف المستند للمراجعة والتقييم.');}
    finally{if(importController.current===controller)importController.current=null;if(mounted.current)setImporting(false);}
  }
  async function exportTraining() {
    await action(async()=>{
      const result=await request('/api/learning/training-export',{});
      const url=URL.createObjectURL(new Blob([JSON.stringify(result.dataset,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='mohassan-routing-dataset.json';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    },'نُزّلت بيانات توجيه الفئة. لم يبدأ تدريب أي نموذج.');
  }
  async function addLesson(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=event.currentTarget,values=new FormData(form);
    const success=experiences.find(row=>`${row.sourceKind}:${row.sourceId}`===values.get('success'));
    const failure=experiences.find(row=>`${row.sourceKind}:${row.sourceId}`===values.get('failure'));
    if(!success||!failure)return;
    await action(async()=>{await request('/api/learning/lessons',{text:values.get('text'),scope:{category:success.category,keywords:String(values.get('keywords')??'').split(/[,،]/).map(value=>value.trim()).filter(Boolean)},success:reference(success),failure:reference(failure)});form.reset();},'حُفظ الدرس للمراجعة. لا يُستخدم قبل التقييم والتفعيل.');
  }
  const successes=experiences.filter(row=>row.outcome==='verified_success'),failures=experiences.filter(row=>row.outcome==='verified_failure');
  return <details className={styles.panel} open={open} onToggle={event=>{setOpen(event.currentTarget.open);if(!event.currentTarget.open)importController.current?.abort();}}>
    <summary>الدروس الموثقة ومعرفة الملفات</summary>
    {open?<div className={styles.form} aria-busy={busy}>
      <p className={styles.hint}>تُستخدم الدروس المدعومة بتجارب مؤكدة، والوثائق التي اجتازت التقييم. سحب مصدر أو تغييره يوقف استخدام نسخته القديمة.</p>
      {error?<p className={styles.error} role="alert">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {!content?.evaluationAvailable?<p className={styles.hint}>التقييم المستقل غير مهيأ حاليًا؛ يمكنك إضافة مرشحين للمراجعة، وسيبقى تفعيلهم مغلقًا.</p>:null}
      {hasRunning?<p role="status">يعمل التقييم في الخلفية؛ تظهر نتيجته هنا عند اكتماله.</p>:null}
      <div className={styles.columns}>
        <form className={styles.form} onSubmit={event=>void addDocument(event)}>
          <h3>إضافة معرفة</h3>
          <label>عنوان المستند<input name="title" maxLength={200}/></label>
          <label>مسار ملف النص أو Markdown أو PDF<input name="path" required maxLength={2000} dir="ltr" placeholder="C:\Documents\guide.pdf"/></label>
          <p className={styles.hint}>اختر ملفًا داخل المجلدات المسموحة على جهاز الخادم. استورد ملفات SKILL.md من مكتبة المهارات.</p>
          <p className={styles.hint}>PDF نصي غير مشفر حتى 10 ميغابايت و100 صفحة. استخراج النص محدود بـ256 كيلوبايت؛ ملفات الصور تحتاج OCR غير المتاح حاليًا.</p>
          <button type="submit" disabled={disabled||!content?.importsAvailable}>إضافة المستند</button>
          {importing?<button type="button" onClick={()=>importController.current?.abort()}>إلغاء الاستيراد</button>:null}
        </form>
        <form className={styles.form} onSubmit={event=>void addLesson(event)}>
          <h3>درس من تجربة</h3>
          <label>ما الذي نجح بعد الإخفاق؟<textarea name="text" required minLength={8} maxLength={4000} rows={3}/></label>
          <label>تجربة النجاح<select name="success" required><option value="">اختر تجربة مؤكدة</option>{successes.map(row=><option key={`${row.sourceKind}:${row.sourceId}`} value={`${row.sourceKind}:${row.sourceId}`}>{row.goal.slice(0,100)}</option>)}</select></label>
          <label>إخفاق سابق للهدف نفسه<select name="failure" required><option value="">اختر إخفاقًا مؤكدًا</option>{failures.map(row=><option key={`${row.sourceKind}:${row.sourceId}`} value={`${row.sourceKind}:${row.sourceId}`}>{row.goal.slice(0,100)}</option>)}</select></label>
          <label>كلمات تحدد متى يُستخدم الدرس<input name="keywords" placeholder="كلمة، كلمة أخرى" maxLength={500}/></label>
          <button type="submit" disabled={disabled||!successes.length||!failures.length}>حفظ درس مرشح</button>
        </form>
      </div>
      <section className={styles.card} aria-label="بيانات التدريب">
        <h3>بيانات توجيه الفئة</h3>
        <p className={styles.hint}>التصدير يجهّز أحدث 2000 مثال مؤهل كحد أقصى لتوجيه الطلب إلى فئته، ولا يبدأ التدريب. تُستبعد الأسرار والتكرارات وتجارب التقييم والنتائج غير المكتملة.</p>
        {training?<p>{training.roles.routing.eligibleUnique} من {training.requiredUnique} مثالًا مؤهلًا للتصدير.</p>:null}
        {training&&!training.roles.routing.ready?<p className={styles.hint}>{training.complete?'التصدير محجوب حتى اكتمال العدد المطلوب من التجارب الموثقة.':'التصدير محجوب لأن تدقيق التجارب لم يكتمل.'}</p>:null}
        <button type="button" disabled={disabled||!training?.roles.routing.ready} onClick={()=>void exportTraining()}>تنزيل بيانات التوجيه</button>
      </section>
      {(['lessons','documents'] as const).map(kind=><div key={kind} className={styles.list}>
        <h3>{kind==='lessons'?'الدروس':'المستندات'}</h3>
        {content?.[kind].length===0?<p className={styles.hint}>لا توجد عناصر بعد.</p>:null}
        {content?.[kind].map(row=><article className={styles.card} key={row.id}>
          <span className={styles.badge}>{labels[row.status]} · الإصدار {row.version}</span><p className={styles.content}>{row.title??row.text}</p>
          <div className={styles.actions}>
            {row.status!=='retired'?<button disabled={disabled||hasRunning||!content.evaluationAvailable} onClick={()=>void action(()=>request(`/api/learning/${kind}/${row.id}/evaluate`,{}),'بدأ التقييم المستقل. التفعيل يبقى خطوة منفصلة بعد نجاحه.')}>تقييم</button>:null}
            {row.status==='verified'?<button disabled={disabled} onClick={()=>void action(()=>request(`/api/learning/${kind}/${row.id}/activate`,{}),'فُعّل هذا الإصدار للمساعد.')}>تفعيل للمساعد</button>:null}
            {row.status!=='retired'?<button disabled={disabled} onClick={()=>void action(()=>request(`/api/learning/${kind}/${row.id}/retire`,{}),'سُحب الإصدار من سياق المساعد.')}>سحب</button>:null}
          </div>
          {content.evaluations?.find(item=>item.subject_id===row.id)?.status==='failed'?<p className={styles.hint}>لم يجتز آخر تقييم. راجع المحتوى وأدلته قبل إعادة المحاولة.</p>:null}
          {content.evaluations?.find(item=>item.subject_id===row.id)?.status==='unknown'?<p className={styles.hint}>انقطع آخر تقييم ولم تُعتمد نتيجته.</p>:null}
        </article>)}
      </div>)}
    </div>:null}
  </details>;
}
