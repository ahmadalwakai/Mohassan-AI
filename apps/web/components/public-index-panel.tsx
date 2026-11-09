"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import styles from './browser-workspace.module.css';

type Document={id:string;url:string;title:string;fetchedAt:string;expiresAt:string};
type Hit={url:string;title:string;snippet:string;fetchedAt:string;expiresAt:string};
const date=(value:string)=>new Intl.DateTimeFormat('ar',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
async function api(path:string,method='GET',body?:unknown){
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw new Error(data?.error?.message??'تعذر تحديث الفهرس.');return data;
}
export function PublicIndexPanel({offline}:{offline:boolean}) {
  const [open,setOpen]=useState(false),[documents,setDocuments]=useState<Document[]>([]),[hits,setHits]=useState<Hit[]|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const sequence=useRef(0),mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++;};},[]);
  const load=useCallback(async()=>{const token=++sequence.current;const result=await api('/api/search/index');if(mounted.current&&token===sequence.current)setDocuments(result.documents);},[]);
  useEffect(()=>{if(!open||offline)return;let active=true;void load().catch(error=>{if(active)setError(error.message);});return()=>{active=false;sequence.current++;};},[open,offline,load]);
  async function act(work:()=>Promise<void>,success:string|(()=>string)){if(busy||offline)return;setBusy(true);setError('');setNotice('');try{await work();await load();if(mounted.current)setNotice(typeof success==='function'?success():success);}catch(error){await load().catch(()=>{});if(mounted.current){setHits(null);setError(error instanceof Error?error.message:'تعذر تحديث الفهرس.');}}finally{if(mounted.current)setBusy(false);}}
  function add(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,data=new FormData(form);let duplicate=false;void act(async()=>{const result=await api('/api/search/index','POST',{url:data.get('url'),ttlHours:Number(data.get('ttlHours'))});duplicate=result.duplicate;form.reset();setHits(null);},()=>duplicate?'هذا المحتوى موجود في فهرسك؛ بقي وقت قراءة المصدر الأصلي دون تجديد.':'حُفظت قراءة المصدر في فهرسك.');}
  function search(event:FormEvent<HTMLFormElement>){event.preventDefault();const query=String(new FormData(event.currentTarget).get('query'));void act(async()=>{const result=await api(`/api/search/index/query?question=${encodeURIComponent(query)}&limit=5`);setHits(result.hits);},'اكتمل البحث في النسخ المحفوظة.');}
  return <details className={styles.panel} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>فهرسي المحلي للمصادر العامة</summary>
    {open?<div className={styles.form} aria-busy={busy}>
      <p className={styles.muted}>احفظ رابطًا عامًا تختاره للبحث في نصه لاحقًا. هذه نسخ محدودة بتاريخ قراءتها، ولا تتحدث تلقائيًا. إضافة الرابط نفسه تعيد قراءته.</p>
      {error?<p className={styles.error} role="alert">{error}</p>:null}{notice?<p className={styles.success} role="status">{notice}</p>:null}
      <form className={styles.form} onSubmit={add}>
        <label>رابط المصدر للفهرس<input name="url" type="url" dir="ltr" required maxLength={2500} placeholder="https://example.com/guide" disabled={busy||offline}/></label>
        <label>مدة الاحتفاظ<select name="ttlHours" defaultValue="24" disabled={busy||offline}><option value="24">يوم واحد</option><option value="72">ثلاثة أيام</option><option value="168">أسبوع</option></select></label>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy||offline}>قراءة الرابط وحفظه في فهرسي</button>
      </form>
      <form className={styles.form} onSubmit={search}><label>ابحث في فهرسي<input name="query" required maxLength={500} disabled={busy||offline}/></label><button type="submit" className={styles.button} disabled={busy||offline}>بحث في النسخ المحفوظة</button></form>
      {hits?.length===0?<p className={styles.muted}>لا توجد نتيجة مطابقة في فهرسك.</p>:null}
      {hits?.map(hit=><article key={hit.url} className={styles.source}><h3>{hit.title}</h3><a href={hit.url} target="_blank" rel="noopener noreferrer">{hit.url}</a><p className={styles.reading}>{hit.snippet}</p><p className={styles.muted}>نسخة محفوظة · قُرئت {date(hit.fetchedAt)} · تنتهي {date(hit.expiresAt)}</p></article>)}
      <h3>المصادر المحفوظة ({documents.length})</h3>
      {documents.length===0?<p className={styles.muted}>لم تضف مصدرًا بعد.</p>:null}
      {documents.map(document=><article className={styles.source} key={document.id}>
        <h3>{document.title}</h3><a href={document.url} target="_blank" rel="noopener noreferrer">{document.url}</a>
        <p className={styles.muted}>قُرئ {date(document.fetchedAt)} · تنتهي صلاحية النسخة: {date(document.expiresAt)}</p>
        <button type="button" className={styles.button} disabled={busy||offline} onClick={()=>void act(async()=>{await api(`/api/search/index/${document.id}/refresh`,'POST',{});setHits(null);},'أُعيدت قراءة المصدر وفحصه وتحديث نسخته.')}>تحديث قراءة المصدر</button>
        <button type="button" className={styles.button} disabled={busy||offline} onClick={()=>void act(async()=>{await api(`/api/search/index/${document.id}`,'DELETE');setHits(null);},'حُذف المصدر من فهرسك.')}>حذف المصدر من فهرسي</button>
      </article>)}
      <button type="button" className={styles.button} disabled={busy||offline} onClick={()=>void act(async()=>{await api('/api/search/cache','DELETE');},'مُسحت نتائج البحث المؤقتة لحسابك.')}>مسح نتائج البحث المؤقتة</button>
    </div>:null}
  </details>;
}
