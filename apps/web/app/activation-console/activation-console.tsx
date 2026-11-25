'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ACTIVATION_DEFAULT_DAYS, ACTIVATION_GATE_MAX_BYTES, ACTIVATION_MAX_DAYS, ACTIVATION_REASON_MAX_LENGTH,
  ActivationActionResultSchema, ActivationConsoleSnapshotSchema, ActivationLabelSchema,
  type ActivationConsoleSnapshot, type ActivationLabel, type ActivationReviewInput, type ActivationStateInput,
} from '@mohassan/contracts';
import { SkillApiError, skillErrorText, skillPost, skillRequest } from '../../components/skill-client';
import styles from './activation-console.module.css';

const endpoint = '/api/activation-console';
const number = new Intl.NumberFormat('ar', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ar', { style: 'percent', maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });
const labels: Record<ActivationLabel, string> = { better: 'أفضل', worse: 'أسوأ', same: 'مماثل' };
const categoryLabels = new Map(Object.entries({
  route: 'مسار الطلب', scope: 'نطاق الطلب', resolution: 'تفسير الطلب', abstention: 'الامتناع عن الإجابة',
  new_answer: 'إجابة جديدة', source: 'مصدر الإجابة', quote: 'الاقتباس', not_needed: 'لا يلزم البحث',
  single_source: 'مصدر واحد', confirmed: 'تأكيد المصادر', conflict: 'تعارض المصادر', send: 'إرسال الرد',
  fix: 'تصحيح الرد', withhold: 'حجب الرد', note: 'ملاحظة', contradiction: 'تناقض', coverage: 'اكتمال الرد',
  commitments: 'الالتزامات', corrections: 'التصحيحات', preferences: 'التفضيلات', repetition: 'التكرار',
  entity: 'الجهة المقصودة', date: 'التاريخ', account: 'الحساب', file: 'الملف', turn_type: 'نوع الرسالة',
  standalone: 'استقلال الطلب عن السياق', handler: 'طريقة المعالجة', decision: 'القرار',
}));

type Capability = ActivationConsoleSnapshot['capabilities'][number];
type Sample = ActivationConsoleSnapshot['samples'][number];
type Audit = ActivationConsoleSnapshot['audit'];

function Time({ value }: { value: string }) {
  return <time dateTime={value}>{date.format(new Date(value))}</time>;
}

function Metrics({ capability }: { capability: Capability }) {
  const { eventCount, comparedCount, disagreements, disagreementRate, latency, errors, categories } = capability;
  const unavailable = 'غير مقاس';
  return <section aria-label="قياسات القدرة" className={styles.panel}>
    <dl className={styles.metrics}>
      <div><dt>أحداث الظل</dt><dd>{number.format(eventCount)}<small>{number.format(comparedCount)} مقارنة قابلة للقياس</small></dd></div>
      <div><dt>نسبة الاتفاق</dt><dd>{disagreementRate === null ? unavailable : percent.format(1 - disagreementRate)}</dd></div>
      <div><dt>نسبة الاختلاف</dt><dd>{disagreementRate === null ? unavailable : percent.format(disagreementRate)}<small>{number.format(disagreements)} اختلاف</small></dd></div>
      <div><dt>متوسط الزمن المضاف</dt><dd>{latency.meanMs === null ? unavailable : `${number.format(latency.meanMs)} مللي ثانية`}<small>{number.format(latency.count)} قياس</small></dd></div>
      <div><dt>الأخطاء</dt><dd>{number.format(errors)}</dd></div>
    </dl>
    {categories.length > 0 && <div className={styles.categories}>
      <h3>أبرز أنواع الاختلاف</h3>
      <ul>{categories.map(({ category, count }) => <li key={category}><bdi>{categoryLabels.get(category) ?? category}</bdi><strong>{number.format(count)}</strong></li>)}</ul>
    </div>}
  </section>;
}

function ActivationDecision({ capability, minimumReviews, busy, onSave }: {
  capability: Capability;
  minimumReviews: number;
  busy: boolean;
  onSave: (input: ActivationStateInput) => Promise<void>;
}) {
  const [validation, setValidation] = useState('');
  const { better, worse, same } = capability.reviews;
  const total = better + worse + same;

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setValidation('');
    const values = new FormData(event.currentTarget);
    const reason = String(values.get('reason') ?? '').trim();
    if (!reason) { setValidation('أدخل سبب التفعيل.'); return; }
    const input: ActivationStateInput = { capabilityId: capability.id, enabled: true, reason };
    if (capability.gateRequired) {
      const file = values.get('record');
      const sha256 = String(values.get('sha256') ?? '').trim();
      if (!(file instanceof File) || file.size === 0 || file.size > ACTIVATION_GATE_MAX_BYTES) {
        setValidation('اختر ملف سجل بوابة صالحًا لا يزيد حجمه على ٦٤ كيلوبايت.');
        return;
      }
      if (!/^[a-f0-9]{64}$/i.test(sha256)) { setValidation('أدخل بصمة SHA-256 من ٦٤ خانة سداسية عشرية.'); return; }
      try {
        const record = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
        input.gate = { record, sha256 };
      } catch {
        setValidation('تعذرت قراءة سجل البوابة بترميز UTF-8.');
        return;
      }
    }
    await onSave(input);
  }

  return <section className={styles.panel} aria-labelledby="activation-evidence">
    <div className={styles.sectionHeader}>
      <div>
        <h3 id="activation-evidence">أدلة التفعيل</h3>
        <p>يُراجع المالك {number.format(minimumReviews)} عينة على الأقل، ويجب أن يكون عدد تقييمات «أفضل» مساويًا لعدد «أسوأ» أو أكبر منه.</p>
      </div>
      {capability.enabled && <button className={styles.disable} type="button" disabled={busy} onClick={() => void onSave({ capabilityId: capability.id, enabled: false })}>إيقاف القدرة</button>}
    </div>
    <dl className={styles.reviewTotals}>
      <div><dt>العينات المراجعة</dt><dd>{number.format(total)} / {number.format(minimumReviews)}</dd></div>
      {ActivationLabelSchema.options.map(label => <div key={label}><dt>{labels[label]}</dt><dd>{number.format(capability.reviews[label])}</dd></div>)}
    </dl>
    <div className={styles.gateStatus}>
      <strong>بوابة التحقق</strong>
      <p>{capability.gateRequired ? 'يلزم سجل اجتياز مختوم وبصمة SHA-256 مثبتة.' : 'لا توجد بوابة مطلوبة لهذه القدرة.'}</p>
      {capability.gateSha256 && <div>بصمة آخر تفعيل <code dir="ltr">{capability.gateSha256}</code></div>}
    </div>
    {!capability.enabled && !capability.runtimeReady && <p className={styles.notice}>لم يُربط تشغيل هذه القدرة باللوحة بعد.</p>}
    {!capability.enabled && capability.runtimeReady && !capability.canEnable && <p className={styles.notice}>أكمل شرط المراجعة للمتابعة إلى التفعيل.</p>}
    {!capability.enabled && capability.canEnable && <form className={styles.activationForm} onSubmit={activate}>
      <fieldset disabled={busy}>
        <label>سبب التفعيل<textarea name="reason" rows={2} maxLength={ACTIVATION_REASON_MAX_LENGTH} required /></label>
        {capability.gateRequired && <>
          <label>ملف سجل قرار البوابة<input name="record" type="file" accept=".json,application/json" required /></label>
          <label>بصمة SHA-256 المثبتة<input name="sha256" type="text" dir="ltr" spellCheck={false} autoComplete="off" maxLength={64} pattern="[a-fA-F0-9]{64}" required /></label>
        </>}
        {validation && <p className={styles.error} role="alert">{validation}</p>}
        <button className={styles.primary} type="submit">تفعيل القدرة</button>
      </fieldset>
    </form>}
  </section>;
}

function ReviewSample({ sample, busy, onSave }: { sample: Sample; busy: boolean; onSave: (input: ActivationReviewInput) => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const label = ActivationLabelSchema.safeParse(button?.getAttribute('value'));
    if (busy || !label.success) return;
    const trainingAllowed = new FormData(event.currentTarget).has('trainingAllowed');
    await onSave({ sampleId: sample.id, label: label.data, trainingAllowed });
  }

  return <article className={styles.sample}>
    <header><Time value={sample.occurredAt} />{sample.category && <bdi>{categoryLabels.get(sample.category) ?? sample.category}</bdi>}</header>
    <div className={styles.comparison}>
      <div><h4>{sample.baselineKind === 'reply' ? 'الرد الحالي' : 'قرار المسار الحالي'}</h4><p dir="auto">{sample.baseline}</p></div>
      <div><h4>قرار الظل</h4><p dir="auto">{sample.shadow}</p></div>
    </div>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>كيف تقارن قرار الظل بالمسار الحالي؟</legend>
        <label className={styles.training}><input name="trainingAllowed" type="checkbox" />اسمح باستخدام هذا التقييم في التدريب</label>
        <div className={styles.buttons}>{ActivationLabelSchema.options.map(label => <button key={label} type="submit" value={label}>{labels[label]}</button>)}</div>
      </fieldset>
    </form>
  </article>;
}

function AuditLog({ audit }: { audit: Audit }) {
  return <section className={styles.panel} aria-labelledby="activation-audit">
    <h3 id="activation-audit">سجل التغييرات</h3>
    {audit.length === 0 ? <p className={styles.notice}>لا توجد قرارات تفعيل أو إيقاف مسجّلة.</p> : <div className={styles.tableWrap} tabIndex={0} role="region" aria-labelledby="activation-audit">
      <table>
        <thead><tr><th scope="col">القرار</th><th scope="col">التوقيت</th><th scope="col">صاحب القرار</th><th scope="col">السبب</th><th scope="col">التقييمات وقت القرار</th><th scope="col">بصمة البوابة</th></tr></thead>
        <tbody>{audit.map(item => <tr key={`${item.at}:${item.actorId}:${item.enabled}`}>
          <td>{item.enabled ? 'تفعيل' : 'إيقاف'}</td>
          <td><Time value={item.at} /></td>
          <td><bdi>{item.actorId}</bdi></td>
          <td dir="auto">{item.reason}</td>
          <td>{ActivationLabelSchema.options.map(label => `${labels[label]} ${number.format(item.evidence[label])}`).join('، ')}. الحد الأدنى {number.format(item.evidence.minimumReviews)}.</td>
          <td>{item.gateSha256 ? <code dir="ltr">{item.gateSha256}</code> : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

export function ActivationConsole() {
  const [days, setDays] = useState(ACTIVATION_DEFAULT_DAYS);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<ActivationConsoleSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const posting = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const query = `${endpoint}?days=${days}`;
    setLoading(true);
    setLoadError('');
    void skillRequest(query, ActivationConsoleSnapshotSchema, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setSnapshot(data);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSnapshot(null);
      setLoadError(skillErrorText(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, revision]);

  async function save(path: '/reviews' | '/state', body: ActivationReviewInput | ActivationStateInput, feedback: string) {
    if (loading || posting.current) return;
    posting.current = true;
    setSaving(true);
    setSaved('');
    setActionError('');
    try {
      await skillPost(`${endpoint}${path}`, body, ActivationActionResultSchema);
      setLoading(true);
      setSaved(feedback);
      setRevision(value => value + 1);
    } catch (error) {
      if (error instanceof SkillApiError && (error.status === 401 || error.status === 403)) setSnapshot(null);
      setActionError(skillErrorText(error));
    } finally {
      posting.current = false;
      setSaving(false);
    }
  }

  const capability = snapshot?.capabilities.find(item => item.id === selectedId) ?? snapshot?.capabilities[0];
  const busy = loading || saving;
  const samples = snapshot?.samples.filter(sample => sample.capabilityId === capability?.id) ?? [];
  const audit = snapshot?.audit.filter(item => item.capabilityId === capability?.id) ?? [];

  return <main className={styles.console} dir="rtl" lang="ar">
    <header className={styles.header}>
      <Link href="/" prefetch={false}>العودة إلى موحسن</Link>
      <div className={styles.headerContent}>
        <div><h1>تفعيل القدرات</h1><p>قارن ما كان سيحدث في وضع الظل بالمسار الحالي، وراجع الأدلة قبل التفعيل.</p></div>
        <a href={`${endpoint}?days=${snapshot?.window.days ?? days}`}>عرض JSON للقراءة فقط</a>
      </div>
    </header>

    <form className={styles.filters} onSubmit={event => {
      event.preventDefault();
      setActionError('');
      setSaved('');
      setDays(Number(new FormData(event.currentTarget).get('days')));
      setRevision(value => value + 1);
    }}>
      <label>الفترة بالأيام<input name="days" type="number" min={1} max={ACTIVATION_MAX_DAYS} step={1} defaultValue={days} required /></label>
      <button type="submit" disabled={busy}>تحديث القياسات</button>
      {snapshot && <span>من <Time value={snapshot.window.from} /> إلى <Time value={snapshot.window.to} /></span>}
    </form>

    {(loadError || actionError) && <p className={styles.error} role="alert">{loadError || actionError}</p>}
    {(busy || saved) && <p className={styles.status} role="status">{saving ? 'جارٍ حفظ القرار…' : loading ? 'جارٍ تحميل أدلة التفعيل…' : saved}</p>}
    {snapshot && !capability && <p className={styles.panel}>لا توجد أحداث ظل مسجّلة ضمن هذه الفترة.</p>}

    {snapshot && capability && <div className={styles.layout} aria-busy={busy}>
      <aside className={styles.capabilityList}>
        <h2>القدرات المرصودة</h2>
        <nav aria-label="القدرات المرصودة">{snapshot.capabilities.map(item => <button key={item.id} type="button" aria-pressed={item.id === capability.id} onClick={() => {
          setSelectedId(item.id); setActionError(''); setSaved('');
        }}>
          <span>{item.nameAr}</span><span>{item.enabled ? 'مفعّلة' : 'متوقفة'}</span>
        </button>)}</nav>
      </aside>

      <div className={styles.workspace}>
        <div className={styles.capabilityHeading}>
          <h2>{capability.nameAr}</h2>
          {capability.flag && <code dir="ltr">{capability.flag}</code>}
        </div>
        <Metrics capability={capability} />
        <ActivationDecision key={capability.id} capability={capability} minimumReviews={snapshot.minimumReviews} busy={busy}
          onSave={input => save('/state', input, input.enabled ? 'تم تفعيل القدرة.' : 'تم إيقاف القدرة.')} />
        <section className={styles.panel} aria-labelledby="activation-queue">
          <h3 id="activation-queue">عينات الاختلاف للمراجعة</h3>
          {!samples.length ? <p className={styles.notice}>لا توجد عينات متاحة للمراجعة ضمن هذه الفترة.</p> : <div className={styles.samples}>
            {samples.map(sample => <ReviewSample key={sample.id} sample={sample} busy={busy} onSave={input => save('/reviews', input, 'تم حفظ التقييم.')} />)}
          </div>}
        </section>
        <AuditLog audit={audit} />
      </div>
    </div>}
  </main>;
}
