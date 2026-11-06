'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Box, Button, Dialog, Input, Portal, Spinner, Textarea } from '@chakra-ui/react';
import { BookOpen, FileText, Layers, Play, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import { SkillActivateSchema, SkillCategorySchema, SkillCompositionRequestSchema, SkillCompositionResultSchema, SkillDetailSchema, SkillEvidencePageSchema, SkillFileContentSchema, SkillForgeStatusSchema, SkillGrantCreateSchema,
  SkillImportResultSchema, SkillLevelSchema, SkillRegistryResultSchema, SkillRunRequestSchema, SkillRunSummarySchema, SkillStatusSchema, SkillGrantSchema, TaskSchema,
  type SkillCompositionRequest, type SkillCompositionResult, type SkillDetail, type SkillFileContent, type SkillRunSummary, type SkillVersion } from '@mohassan/contracts';
import { SkillExperiments } from './skill-experiments';
import { CapabilityEvolution } from './capability-evolution';
import { SkillApiError, skillCategories, skillDate, skillErrorText, skillLevels, skillPost, skillRequest, skillStatuses } from './skill-client';
import styles from './skill-library.module.css';

type Registry = z.infer<typeof SkillRegistryResultSchema>;
type Evidence = z.infer<typeof SkillEvidencePageSchema>;
type Review = { title: string; description: string; facts: string[]; perform(): Promise<void> };
type ComposerNode = { id: string; detail: SkillDetail; inputs: Record<string, string>; dependsOn: string[] };
const RunCreated = z.object({ task: TaskSchema, runId: z.uuid().nullable() }).strict();
const RunCancelled = z.object({ task: TaskSchema, run: SkillRunSummarySchema }).strict();
const Ok = z.object({ ok: z.literal(true) }).strict();
const PAGE = 12;
const verdicts: Record<string, string> = { pass: 'اجتاز الفحص', review: 'يحتاج مراجعة الملاحظات', fail: 'لم يجتز الفحص', incompatible: 'غير متوافق' };
const runStatuses: Record<string, string> = { running: 'جارٍ التشغيل', waiting_children: 'بانتظار الخطوات أو الموافقات', succeeded: 'نجح مع دليل محفوظ', failed: 'فشل', cancelled: 'أُلغي', unknown: 'أثر غير محسوم', pending: 'بانتظار الجدولة', queued: 'في الطابور', started: 'بدأت المحاولة' };
const shortHash = (hash: string) => `${hash.slice(0, 12)}…${hash.slice(-8)}`;
function Level({ level }: { level: SkillVersion['level'] }) { return <Badge colorPalette={level === 'executable' ? 'orange' : level === 'tool' ? 'teal' : 'gray'}>{skillLevels[level]}</Badge>; }

export function SkillLibrary({ offline, onOpenLegacy, onOpenTask }: { offline: boolean; onOpenLegacy(): void; onOpenTask(id: string): void }) {
  const [tab, setTab] = useState<'library' | 'compose' | 'experiments'>('library');
  const [registry, setRegistry] = useState<Registry | null>(null), [loading, setLoading] = useState(false), [listError, setListError] = useState('');
  const [queryDraft, setQueryDraft] = useState(''), [query, setQuery] = useState(''), [category, setCategory] = useState(''), [level, setLevel] = useState(''), [status, setStatus] = useState(''), [offset, setOffset] = useState(0), [refreshKey, setRefreshKey] = useState(0);
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<SkillDetail | null>(null), [detailLoading, setDetailLoading] = useState(false);
  const [source, setSource] = useState<SkillFileContent | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [review, setReview] = useState<Review | null>(null), [acknowledged, setAcknowledged] = useState(false), [reason, setReason] = useState(''), [evaluationId, setEvaluationId] = useState('');
  const [grantTools, setGrantTools] = useState<string[]>([]), [grantScopes, setGrantScopes] = useState<string[]>([]), [grantRoots, setGrantRoots] = useState(''), [durationHours, setDurationHours] = useState(1);
  const [nodes, setNodes] = useState<ComposerNode[]>([]), [validation, setValidation] = useState<SkillCompositionResult | null>(null), [validationFingerprint, setValidationFingerprint] = useState(''), [valuesText, setValuesText] = useState('{}');
  const [runId, setRunId] = useState(''), [run, setRun] = useState<SkillRunSummary | null>(null), [evidence, setEvidence] = useState<Evidence | null>(null), [evidenceOffset, setEvidenceOffset] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null), sourceAbort = useRef<AbortController | null>(null), runAbort = useRef<AbortController | null>(null), selectedRef = useRef(selectedId), actionInFlight = useRef(false), nodeSequence = useRef(0), taskRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const compositionFingerprint = JSON.stringify(nodes.map(node => ({ id: node.id, skillId: node.detail.skill.id, revision: node.detail.skill.revision, inputs: node.inputs, dependsOn: node.dependsOn })));
  const compositionRef = useRef(compositionFingerprint); compositionRef.current = compositionFingerprint;
  const currentValidation = validationFingerprint === compositionFingerprint ? validation : null;
  selectedRef.current = selectedId;
  const disabled = offline || Boolean(busy), changed = useCallback(() => setRefreshKey(value => value + 1), []);
  const openSkill = useCallback((id: string) => { setSelectedId(id); setTab('library'); setError(''); setNotice(''); }, []);

  useEffect(() => {
    if (offline) return;
    const controller = new AbortController(); setLoading(true); setListError('');
    const params = new URLSearchParams({ q: query, limit: String(PAGE), offset: String(offset) });
    if (category) params.set('category', category); if (level) params.set('level', level); if (status) params.set('status', status);
    void skillRequest(`/api/skills?${params}`, SkillRegistryResultSchema, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRegistry(value); }).catch(caught => { if (!controller.signal.aborted) setListError(skillErrorText(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offline, query, category, level, status, offset, refreshKey]);
  useEffect(() => {
    if (offline) return; const controller = new AbortController();
    void skillRequest('/api/skills/forge/status', SkillForgeStatusSchema, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setEnabled(value.enabled); }).catch(() => { if (!controller.signal.aborted) setEnabled(false); });
    return () => controller.abort();
  }, [offline, refreshKey]);
  useEffect(() => {
    sourceAbort.current?.abort(); setBusy(value => value === 'source' ? '' : value); setSource(null); setReason(''); setEvaluationId(''); setGrantTools([]); setGrantScopes([]); setGrantRoots('');
    if (!selectedId || offline) { if (!selectedId) setDetail(null); return; }
    const controller = new AbortController(); setDetail(null); setDetailLoading(true);
    void skillRequest(`/api/skills/${selectedId}`, SkillDetailSchema, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(caught => { if (!controller.signal.aborted) setError(skillErrorText(caught)); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, offline, refreshKey]);
  useEffect(() => () => { sourceAbort.current?.abort(); sourceAbort.current = null; }, []);
  useEffect(() => { if (offline) runAbort.current?.abort(); return () => runAbort.current?.abort(); }, [offline]);
  useEffect(() => {
    if (!detail?.skill.id) return;
    detailHeading.current?.focus({ preventScroll: true });
    detailHeading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [detail?.skill.id]);

  async function action(name: string, perform: () => Promise<void>, message: string) {
    if (disabled || actionInFlight.current) return; actionInFlight.current = true; setBusy(name); setError(''); setNotice('');
    try { await perform(); setNotice(message); }
    catch (caught) { if (caught instanceof DOMException && caught.name === 'AbortError') return; setError(skillErrorText(caught)); if (caught instanceof SkillApiError && caught.status === 409) setNotice('حدّث التفاصيل وراجع المراجعة والصلاحيات قبل إرسال طلب جديد.'); }
    finally { actionInFlight.current = false; setBusy(''); }
  }
  function ask(next: Review) { setAcknowledged(false); setReview(next); setError(''); }
  async function confirmReview() {
    if (!review || !acknowledged || disabled) return; const current = review;
    await action('confirm', async () => { await current.perform(); setReview(null); changed(); }, 'حُفظت العملية بعد موافقتك.');
  }
  async function importSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const path = String(new FormData(event.currentTarget).get('path') ?? '');
    await action('import', async () => { const imported = await skillPost('/api/skills/import', { path }, SkillImportResultSchema); openSkill(imported.skill.id); changed(); }, 'حُفظ المصدر للمراجعة. الاستيراد لا يفعّل المهارة.');
  }
  async function readSource(path: string) {
    if (!detail || offline) return; sourceAbort.current?.abort(); const controller = new AbortController(); sourceAbort.current = controller; const id = detail.skill.id;
    setBusy('source'); setError(''); setSource(null);
    try { const result = await skillRequest(`/api/skills/${id}/file?${new URLSearchParams({ path })}`, SkillFileContentSchema, { signal: controller.signal }); if (!controller.signal.aborted && sourceAbort.current === controller && selectedRef.current === id) setSource(result); }
    catch (caught) { if (!controller.signal.aborted) setError(skillErrorText(caught)); }
    finally { if (sourceAbort.current === controller) { sourceAbort.current = null; setBusy(value => value === 'source' ? '' : value); } }
  }
  function lifecycle(kind: 'activate' | 'revoke' | 'rollback', target = detail?.skill) {
    if (!detail || !target) return;
    if ((kind === 'revoke' || kind === 'rollback') && reason.trim().length < 3) { setError('اكتب سببًا واضحًا من ثلاثة أحرف على الأقل.'); return; }
    const body = { expectedRevision: target.revision, ...(kind !== 'revoke' ? { approve: true, ...(evaluationId ? { evaluationId } : {}) } : {}), ...(kind === 'activate' ? { acknowledgeFindings: true } : { reason: reason.trim() }) };
    try { if (kind === 'activate') SkillActivateSchema.parse(body); } catch { setError('معرف القياس غير صالح. اختر قياسًا محفوظًا من لوحة التجارب.'); return; }
    ask({ title: kind === 'activate' ? 'مراجعة تفعيل المهارة' : kind === 'rollback' ? 'مراجعة استعادة الإصدار' : 'مراجعة إلغاء التفعيل',
      description: kind === 'revoke' ? 'سيتوقف استخدام هذا الإصدار وتُلغى منحته الحالية.' : 'ستتغير النسخة النشطة في العائلة. صلاحيات الأدوات تحتاج منحة مستقلة.',
      facts: [`${target.name} · الإصدار ${target.version}`, `المراجعة المتوقعة: ${target.revision}`, `بصمة المحتوى: ${target.contentHash}`, ...(evaluationId ? [`القياس المحدد: ${evaluationId}`] : []), ...(reason ? [`السبب: ${reason}`] : []),
        ...(kind === 'activate' ? detail.inspection?.findings.map(finding => `ملاحظة فحص: ${finding.severity} · ${finding.code} · ${finding.message}${finding.path ? ` (${finding.path})` : ''}`) ?? [] : [])],
      perform: async () => { await skillPost(`/api/skills/${target.id}/${kind}`, body, SkillDetailSchema); openSkill(target.id); } });
  }
  function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    const raw = { expectedRevision: detail.skill.revision, approve: true, tools: grantTools, scopes: grantScopes, roots: grantRoots.split(/\r?\n/).map(value => value.trim()).filter(Boolean), durationHours };
    const parsed = SkillGrantCreateSchema.safeParse(raw); if (!parsed.success) { setError('راجع الأدوات والنطاقات والجذور ومدة المنحة.'); return; }
    const id = detail.skill.id;
    ask({ title: 'مراجعة منح الصلاحيات', description: 'تُمنح فقط العناصر والجذور المدرجة أدناه، لهذا الإصدار وبصمته، لمدة محددة.',
      facts: [`المهارة: ${detail.skill.name} · ${detail.skill.version}`, `الأدوات: ${grantTools.join('، ') || 'لا توجد'}`, `النطاقات: ${grantScopes.join('، ') || 'لا توجد'}`, `الجذور: ${parsed.data.roots.join('، ') || 'لا توجد'}`, `المدة: ${durationHours} ساعة`],
      perform: async () => { await skillPost(`/api/skills/${id}/grants`, parsed.data, SkillGrantSchema); } });
  }
  function addToComposition() {
    if (!detail) return;
    if (nodes.length >= 12) { setError('الحد الأقصى 12 عقدة في التركيب.'); return; }
    const id = `node${++nodeSequence.current}`;
    setNodes(previous => [...previous, { id, detail, inputs: Object.fromEntries(detail.contract.inputs.map(field => [field.name, `input.${field.name}`])), dependsOn: [] }]); setValidation(null); setTab('compose');
  }
  function composition(): SkillCompositionRequest {
    const fields = new Map<string, SkillDetail['contract']['inputs'][number]>(); for (const node of nodes) for (const field of node.detail.contract.inputs) if (Object.values(node.inputs).includes(`input.${field.name}`) && !fields.has(field.name)) fields.set(field.name, field);
    return SkillCompositionRequestSchema.parse({ inputs: [...fields.values()], nodes: nodes.map(node => ({ id: node.id, skillId: node.detail.skill.id, inputs: node.inputs, dependsOn: node.dependsOn })) });
  }
  async function validateComposition() {
    const fingerprint = compositionFingerprint;
    await action('compose', async () => {
      const result = await skillPost('/api/skills/compose/validate', composition(), SkillCompositionResultSchema);
      if (compositionRef.current !== fingerprint) throw new Error('تغير التركيب أثناء التحقق. أعد التحقق من الخطة الحالية.');
      setValidationFingerprint(fingerprint); setValidation(result);
    }, 'حُفظ عرض التحقق الحالي. التحقق لا يشغّل أدوات.');
  }
  function requestRun(composed: boolean) {
    if (composed && !currentValidation?.valid) { setError('تحقق من التركيب الحالي قبل طلب تشغيله.'); return; }
    const target = composed ? nodes.find(node => node.detail.skill.level === 'tool')?.detail : detail; if (!target) { setError('اختر مهارة أدوات مفعّلة للتشغيل.'); return; }
    try {
      const body = SkillRunRequestSchema.parse({ expectedRevision: target.skill.revision, values: JSON.parse(valuesText), ...(composed ? { plan: composition() } : {}) });
      const fingerprint = JSON.stringify({ id: target.skill.id, body }); if (taskRequest.current?.fingerprint !== fingerprint) taskRequest.current = { fingerprint, key: crypto.randomUUID() }; const key = taskRequest.current.key;
      ask({ title: 'مراجعة طلب تشغيل المهارة', description: 'سينشئ الطلب مهمة تنتظر موافقتك في لوحة المهام. كل خطوة مؤثرة تتبع صلاحيات Runtime.',
        facts: [...(composed ? nodes : [{ id: 'المهارة', detail: target, inputs: {}, dependsOn: [] }]).flatMap(node => [
          `${node.id}: ${node.detail.skill.name} · الإصدار ${node.detail.skill.version} · المراجعة ${node.detail.skill.revision}`,
          `بصمة المحتوى: ${node.detail.skill.contentHash}`,
          `الأدوات: ${node.detail.contract.requires.tools.join('، ') || 'لا توجد'} · النطاقات: ${node.detail.contract.requires.scopes.join('، ') || 'لا توجد'}`,
          `المسارات المعلنة: ${node.detail.contract.requires.paths.join('، ') || 'لا توجد'} · الأثر: ${node.detail.contract.sideEffects}`,
          ...(composed ? [`الاعتمادات: ${node.dependsOn.join('، ') || 'لا توجد'} · ربط المدخلات: ${JSON.stringify(node.inputs)}`] : []),
        ]), `المدخلات: ${JSON.stringify(body.values)}`, `مفتاح الطلب: ${key}`],
        perform: async () => { const result = await skillPost(`/api/skills/${target.skill.id}/run`, body, RunCreated, { key }); if (taskRequest.current?.key === key) taskRequest.current = null; if (result.runId) setRunId(result.runId); onOpenTask(result.task.id); } });
    } catch { setError('المدخلات أو التركيب ليست JSON صالحة محدودة. راجع أسماء الحقول وأنواعها.'); }
  }
  async function readRun(id = runId, page = 0) {
    if (!z.uuid().safeParse(id).success) { setError('أدخل معرف تشغيل صالحًا.'); return; }
    await action('history', async () => {
      runAbort.current?.abort(); const controller = new AbortController(); runAbort.current = controller;
      try {
        const [summary, proof] = await Promise.all([skillRequest(`/api/skills/runs/${id}`, SkillRunSummarySchema, { signal: controller.signal }), skillRequest(`/api/skills/runs/${id}/evidence?limit=5&offset=${page}`, SkillEvidencePageSchema, { signal: controller.signal })]);
        controller.signal.throwIfAborted();
        if (runAbort.current !== controller) throw new DOMException('تم استبدال قراءة السجل.', 'AbortError');
        setRunId(id); setRun(summary); setEvidence(proof); setEvidenceOffset(page);
      } finally { if (runAbort.current === controller) runAbort.current = null; }
    }, 'قُرئ سجل التشغيل والأدلة المحفوظة.');
  }

  return <section className={styles.root} aria-label="مكتبة المهارات" dir="rtl">
    <header className={styles.hero}><div><span className={styles.eyebrow}>مهارات لها عقد ودليل</span><h2>مكتبة المهارات</h2><p>راجع ما تضيفه للوكيل، وكيف يعمل، وما تسمح له بتنفيذه.</p></div><div className={styles.actions}><Button variant="outline" onClick={onOpenLegacy}><BookOpen size={16}/>قوائم الفحص السابقة</Button><Button variant="outline" disabled={disabled} onClick={changed}><RefreshCw size={16}/>تحديث المكتبة</Button></div></header>
    {offline ? <p className={styles.warning} role="status">غير متصل. البيانات المعروضة من آخر قراءة، والعمليات متوقفة حتى عودة الاتصال.</p> : !enabled ? <p className={styles.warning}>محرك تشغيل المهارات غير مفعّل. يمكنك مراجعة المكتبة ومصادرها؛ التشغيل والتجارب والتوليد متوقفة.</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    <nav className={styles.tabs} aria-label="أقسام مكتبة المهارات">{([['library', 'المكتبة والمراجعة'], ['compose', 'تركيب وتشغيل'], ['experiments', 'التجارب وForge']] as const).map(([id, title]) => <Button key={id} variant={tab === id ? 'solid' : 'outline'} colorPalette="teal" aria-pressed={tab === id} onClick={() => setTab(id)}>{title}</Button>)}</nav>

    {tab === 'library' ? <>
      <form className={styles.filters} aria-label="تصفية المهارات" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); setOffset(0); }}>
        <label className={styles.search}>البحث في المهارات<Input aria-label="البحث في المهارات" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} maxLength={200} placeholder="اسم، وصف، أو معرف…"/></label>
        <label>الفئة<select aria-label="تصفية الفئة" value={category} onChange={event => { setCategory(event.target.value); setOffset(0); }}><option value="">كل الفئات</option>{SkillCategorySchema.options.map(value => <option key={value} value={value}>{skillCategories[value]}</option>)}</select></label>
        <label>المستوى<select aria-label="تصفية المستوى" value={level} onChange={event => { setLevel(event.target.value); setOffset(0); }}><option value="">كل المستويات</option>{SkillLevelSchema.options.map(value => <option key={value} value={value}>{skillLevels[value]}</option>)}</select></label>
        <label>الحالة<select aria-label="تصفية الحالة" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">كل الحالات</option>{SkillStatusSchema.options.map(value => <option key={value} value={value}>{skillStatuses[value]}</option>)}</select></label>
        <Button type="submit" disabled={offline}><Search size={15}/>بحث</Button>
      </form>
      <div className={styles.columns}><aside className={styles.list} aria-busy={loading}>
        <details className={styles.panel}><summary>استيراد مهارة محلية</summary><form className={styles.form} onSubmit={importSkill}><label>مسار مجلد المهارة<Input aria-label="مسار مجلد المهارة" name="path" required minLength={3} maxLength={1000} dir="ltr" disabled={disabled}/></label><p className={styles.hint}>يلزم SKILL.md داخل أحد جذور الخادم المسموح بها. تبقى الملفات في الحجر بعد الاستيراد.</p><Button type="submit" disabled={disabled}>استيراد للمراجعة</Button></form></details>
        {listError ? <p role="alert" className={styles.error}>{listError}</p> : null}
        {loading ? <p className={styles.empty} role="status"><Spinner size="sm"/> جارٍ تحميل المهارات…</p> : null}
        {!loading && registry?.items.length === 0 ? <Box className={styles.empty}><BookOpen/><h3>لا توجد مهارات مطابقة</h3><p>غيّر المرشحات أو استورد مصدرًا محليًا للمراجعة.</p></Box> : null}
        {registry?.items.map(skill => <Box as="article" className={`${styles.skillCard} ${selectedId === skill.id ? styles.selected : ''}`} key={skill.id} data-testid={`skill-card-${skill.id}`}>
          <div className={styles.badges}><Level level={skill.level}/><Badge colorPalette={skill.active ? 'green' : 'gray'}>{skillStatuses[skill.status]}</Badge>{skill.readOnly ? <Badge>للقراءة فقط</Badge> : null}</div>
          <h3>{skill.name}</h3><p>{skill.description}</p><small>{skillCategories[skill.category]} · الإصدار {skill.version}</small><Button variant="outline" size="sm" onClick={() => openSkill(skill.id)} aria-label={`عرض ${skill.name}`}>عرض التفاصيل</Button>
        </Box>)}
        {registry ? <div className={styles.pagination}><Button size="sm" variant="outline" disabled={offline || offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - PAGE))}>السابق</Button><span>{offset + (registry.items.length ? 1 : 0)}–{offset + registry.items.length} من {registry.total}</span><Button size="sm" variant="outline" disabled={offline || offset + PAGE >= registry.total || loading} onClick={() => setOffset(value => value + PAGE)}>التالي</Button></div> : null}
      </aside>
      <div className={styles.detail} aria-busy={detailLoading}>
        {detailLoading ? <p className={styles.empty} role="status"><Spinner/> جارٍ قراءة النسخة ومصادرها…</p> : !detail ? <Box className={styles.empty}><ShieldCheck size={32}/><h3>اختر مهارة للمراجعة</h3><p>ستظهر هنا العقود، المصادر، الفحوص والمنح الفعلية لهذه النسخة.</p></Box> : <>
          <section className={styles.panel} aria-label="تفاصيل المهارة"><div className={styles.badges}><Level level={detail.skill.level}/><Badge>{skillStatuses[detail.skill.status]}</Badge></div><h3 ref={detailHeading} tabIndex={-1}>تفاصيل المهارة: {detail.skill.name}</h3><p>{detail.skill.description}</p>
            <dl className={styles.metadata}><div><dt>الإصدار والمراجعة</dt><dd>{detail.skill.version} · {detail.skill.revision}</dd></div><div><dt>المصدر</dt><dd>{detail.source?.kind ?? 'غير موثق'}</dd></div><div><dt>الأثر المعلن</dt><dd dir="ltr">{detail.contract.sideEffects}</dd></div><div><dt>آخر تحديث</dt><dd>{skillDate(detail.skill.updatedAt)}</dd></div></dl>
            <p className={styles.hash}>بصمة النسخة <code dir="ltr">{detail.skill.contentHash}</code></p>{detail.source ? <p className={styles.hint}>المصدر المسجل: <bdi>{detail.source.locator}</bdi> · {detail.source.fileCount} ملفات · {detail.source.totalBytes} بايت</p> : null}
            {detail.skill.level === 'executable' ? <p className={styles.warning}>بوابات العزل الإلزامية غير مكتملة. هذه النسخة غير متاحة للتشغيل أو الترقية التنفيذية.</p> : null}
            {detail.skill.readOnly ? <Button onClick={onOpenLegacy} variant="outline">فتح قوائم الفحص السابقة</Button> : <div className={styles.actions}><Button disabled={disabled} onClick={() => void action('inspect', async () => { await skillPost(`/api/skills/${detail.skill.id}/inspect`, { expectedRevision: detail.skill.revision }, SkillDetailSchema); changed(); }, 'حُفظ تقرير الفحص لهذه البصمة.')}><ShieldCheck size={15}/>فحص المهارة</Button><Button variant="outline" disabled={disabled || detail.skill.level === 'executable' || !['inspected', 'tested', 'benchmarked'].includes(detail.skill.status)} onClick={() => lifecycle('activate')}>مراجعة التفعيل</Button><Button variant="outline" disabled={disabled || detail.skill.status === 'revoked'} onClick={() => lifecycle('revoke')}>إلغاء التفعيل</Button><Button variant="outline" disabled={disabled || !detail.skill.active} onClick={addToComposition}><Layers size={15}/>إضافة إلى التركيب</Button></div>}
            {!detail.skill.readOnly ? <div className={styles.form}><label>سبب الإلغاء أو استعادة الإصدار<Input aria-label="سبب الإلغاء أو استعادة الإصدار" value={reason} onChange={event => setReason(event.target.value)} maxLength={500}/></label>{detail.skill.origin === 'forge' || detail.versions.some(version => version.origin === 'forge') ? <label>معرف قياس Forge للموافقة<Input aria-label="معرف قياس Forge للموافقة" dir="ltr" value={evaluationId} onChange={event => setEvaluationId(event.target.value)} maxLength={36}/><small>يلزم قياس مطابق حالي؛ اختيار المعرف وحده لا يجيز التفعيل.</small></label> : null}</div> : null}
          </section>
          <section className={styles.panel}><h3>الفحص والثقة</h3>{detail.inspection ? <><Badge colorPalette={detail.inspection.verdict === 'pass' ? 'green' : 'orange'}>{verdicts[detail.inspection.verdict]}</Badge><p className={styles.hint}>{detail.inspection.inspectorVersion} · {skillDate(detail.inspection.createdAt)}</p><ul className={styles.findings}>{detail.inspection.findings.map((finding, index) => <li key={`${finding.code}-${index}`}><strong>{finding.severity} · {finding.code}</strong><p>{finding.message}</p>{finding.path ? <small><bdi>{finding.path}</bdi>{finding.line ? `:${finding.line}` : ''}</small> : null}</li>)}</ul>{detail.inspection.findings.length === 0 ? <p>لا توجد ملاحظات في هذا الفحص المحفوظ.</p> : null}</> : <p className={styles.hint}>لا يوجد فحص محفوظ لهذه البصمة. افحص النسخة قبل مراجعة تفعيلها.</p>}</section>
          <section className={styles.panel}><h3><FileText size={17}/>ملفات المصدر</h3><p className={styles.hint}>عرض نصي للمراجعة. مطابقة البصمة تخص سلامة المحتوى؛ التشغيل له موافقات مستقلة.</p><div className={styles.fileList}>{detail.files.map(file => <div key={file.path}><span><bdi>{file.path}</bdi><small>{file.kind} · {file.sizeBytes} بايت · {shortHash(file.contentHash)}</small></span><Button variant="outline" size="sm" disabled={disabled || detail.skill.readOnly} onClick={() => void readSource(file.path)} aria-label={`قراءة ${file.path}`}>قراءة المصدر</Button></div>)}</div>{source ? <section aria-label="نص مصدر المهارة"><p><bdi>{source.file.path}</bdi> · بصمة مطابقة</p><pre className={styles.code} dir="ltr">{source.file.content}</pre><code className={styles.hash} dir="ltr">{source.file.contentHash}</code></section> : null}</section>
          <details className={styles.panel}><summary>العقد: المدخلات والأدوات وحدود التنفيذ</summary><p>الأدوات: {detail.contract.requires.tools.join('، ') || 'لا توجد أدوات معلنة'}</p><p>النطاقات: {detail.contract.requires.scopes.join('، ') || 'لا توجد نطاقات معلنة'}</p><p>المسارات المعلنة: {detail.contract.requires.paths.join('، ') || 'لا توجد'}</p><pre className={styles.code} dir="ltr">{JSON.stringify(detail.contract, null, 2)}</pre></details>
          {!detail.skill.readOnly ? <section className={styles.panel}><h3>الصلاحيات والمنح</h3><p className={styles.hint}>التفعيل مستقل عن منح أدوات التنفيذ. الجذور والمسارات المطلوبة يُعاد التحقق منها على الخادم.</p>
            <form className={styles.form} aria-label="منح صلاحيات محددة" onSubmit={grant}><fieldset><legend>أدوات هذه النسخة</legend>{detail.contract.requires.tools.length ? detail.contract.requires.tools.map(tool => <label className={styles.check} key={tool}><input type="checkbox" checked={grantTools.includes(tool)} disabled={disabled} onChange={event => setGrantTools(previous => event.target.checked ? [...previous, tool] : previous.filter(value => value !== tool))}/><bdi>{tool}</bdi></label>) : <p>لا توجد أدوات تحتاج منحة.</p>}</fieldset><fieldset><legend>النطاقات المعلنة</legend>{detail.contract.requires.scopes.map(scope => <label className={styles.check} key={scope}><input type="checkbox" checked={grantScopes.includes(scope)} disabled={disabled} onChange={event => setGrantScopes(previous => event.target.checked ? [...previous, scope] : previous.filter(value => value !== scope))}/><bdi>{scope}</bdi></label>)}</fieldset>
              <label>جذور الملفات المسموح بها<Textarea aria-label="جذور الملفات المسموح بها" dir="ltr" value={grantRoots} onChange={event => setGrantRoots(event.target.value)} rows={3} maxLength={4003} placeholder="جذر مطلق لكل سطر، حتى أربعة جذور" disabled={disabled}/></label><label>مدة المنحة بالساعات<Input aria-label="مدة المنحة بالساعات" type="number" min={1} max={720} value={durationHours} onChange={event => setDurationHours(Number(event.target.value))} disabled={disabled}/></label><Button type="submit" variant="outline" disabled={disabled || !detail.skill.active || !grantTools.length && !grantScopes.length}>مراجعة منح الصلاحيات</Button>
            </form>{detail.grants.length ? detail.grants.map(item => <article className={styles.grant} key={item.id}><Badge colorPalette={item.revokedAt || new Date(item.expiresAt).getTime() <= Date.now() ? 'gray' : 'green'}>{item.revokedAt ? 'ملغاة' : new Date(item.expiresAt).getTime() <= Date.now() ? 'منتهية' : 'منحة سارية زمنيًا'}</Badge><p><bdi>{item.tools.join('، ') || 'بلا أدوات'}</bdi> · <bdi>{item.scopes.join('، ') || 'بلا نطاقات'}</bdi></p><p className={styles.hint}>{item.roots.map(root => <bdi key={root}>{root} </bdi>)} · تنتهي {skillDate(item.expiresAt)}</p>{!item.revokedAt ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => ask({ title: 'مراجعة إلغاء المنحة', description: 'ستُرفض العمليات التالية التي تعتمد على هذه المنحة.', facts: [item.id, ...item.tools, ...item.scopes, ...item.roots], perform: async () => { await skillPost(`/api/skills/${detail.skill.id}/grants/${item.id}/revoke`, { reason: 'إلغاء صريح من المستخدم بعد مراجعة النطاق في المكتبة.' }, Ok); } })}>إلغاء هذه المنحة</Button> : null}</article>) : <p className={styles.hint}>لا توجد منح محفوظة لهذه النسخة.</p>}
          </section> : null}
          <section className={styles.panel}><h3>إصدارات العائلة</h3>{detail.versions.map(version => <div className={styles.version} key={version.id}><span>{version.version} · {skillStatuses[version.status]}{version.active ? ' · النشط حاليًا' : ''}<small>{shortHash(version.contentHash)}</small></span><div className={styles.actions}><Button size="sm" variant="outline" onClick={() => openSkill(version.id)}>عرض الإصدار {version.version}</Button>{!detail.skill.readOnly && version.status === 'deprecated' ? <Button size="sm" variant="outline" disabled={disabled || version.level === 'executable'} onClick={() => lifecycle('rollback', version)}>استعادة {version.version}</Button> : null}</div></div>)}</section>
          <details className={styles.panel}><summary>سجل التدقيق ({detail.audit.length})</summary>{detail.audit.map(event => <article className={styles.audit} key={event.id}><strong>{event.event}</strong><small>{skillDate(event.createdAt)}</small><pre className={styles.code} dir="ltr">{JSON.stringify(event.detail, null, 2)}</pre></article>)}</details>
        </>}
      </div></div>
    </> : null}

    {tab === 'compose' ? <section className={styles.panel} aria-label="تركيب المهارات"><h3>تركيب بصلاحيات معلنة</h3><p className={styles.hint}>أضف المهارات المفعّلة من تفاصيل المكتبة، ثم اربط الحقول وحدد الاعتمادات صراحة. عقد التعليمات يضيف سياقًا ولا ينتج مخرجات أدوات.</p>
      {!nodes.length ? <p className={styles.empty}>لا توجد عقد بعد. افتح مهارة مفعّلة واختر «إضافة إلى التركيب».</p> : <div className={styles.nodeGrid}>{nodes.map(node => <article className={styles.node} key={node.id}><header><h4><bdi>{node.id}</bdi> · {node.detail.skill.name}</h4><Level level={node.detail.skill.level}/></header><p className={styles.hint}>الإصدار {node.detail.skill.version} · {shortHash(node.detail.skill.contentHash)}</p>{node.detail.contract.inputs.map(field => <label key={field.name}><bdi>{field.name}</bdi> · {field.type}{field.required ? ' (مطلوب)' : ''}<Input dir="ltr" aria-label={`ربط ${node.id}.${field.name}`} disabled={disabled} value={node.inputs[field.name] ?? ''} onChange={event => { setNodes(previous => previous.map(item => item.id === node.id ? { ...item, inputs: { ...item.inputs, [field.name]: event.target.value } } : item)); setValidation(null); }}/></label>)}<fieldset><legend>يعتمد على</legend>{nodes.filter(item => item.id !== node.id).map(other => <label className={styles.check} key={other.id}><input type="checkbox" checked={node.dependsOn.includes(other.id)} disabled={disabled} onChange={event => { setNodes(previous => previous.map(item => item.id === node.id ? { ...item, dependsOn: event.target.checked ? [...item.dependsOn, other.id] : item.dependsOn.filter(id => id !== other.id) } : item)); setValidation(null); }}/><bdi>{other.id}</bdi> · {other.detail.skill.name}</label>)}</fieldset><Button variant="outline" size="sm" disabled={disabled} onClick={() => { setNodes(previous => previous.filter(item => item.id !== node.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== node.id) }))); setValidation(null); }}>إزالة {node.id}</Button></article>)}</div>}
      <div className={styles.actions}><Button disabled={disabled || !nodes.length} onClick={() => void validateComposition()}>التحقق من التركيب</Button><Button variant="outline" onClick={() => setTab('library')}>العودة للمكتبة</Button></div>
      {currentValidation ? <section className={currentValidation.valid ? styles.notice : styles.warning} aria-label="نتيجة تحقق التركيب"><strong>{currentValidation.valid ? 'التركيب صالح وفق الحالة المقروءة' : 'التركيب يحتاج تصحيحًا'}</strong>{currentValidation.batches.length ? <ol>{currentValidation.batches.map((batch, index) => <li key={index}>دفعة {index + 1}: <bdi>{batch.join(' ← ')}</bdi></li>)}</ol> : null}<ul>{currentValidation.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.code} · {issue.message}</li>)}</ul></section> : null}
    </section> : null}

    {tab === 'experiments' ? <SkillExperiments offline={offline} selected={detail} onChanged={changed} onOpenSkill={openSkill}/> : null}
    {tab !== 'experiments' ? <details className={styles.panel}><summary>طلب تشغيل مدخلات محددة</summary><p className={styles.hint}>التشغيل متاح لمهارات الأدوات المفعّلة فقط، ويُنشئ مهمة تنتظر الموافقة. التعليمات فقط تُحمّل في سياق المحادثة.</p><label className={styles.form}>مدخلات التشغيل JSON<Textarea aria-label="مدخلات التشغيل JSON" dir="ltr" spellCheck={false} rows={5} maxLength={64000} value={valuesText} onChange={event => setValuesText(event.target.value)}/></label><Button disabled={disabled || !enabled || (tab === 'compose' ? !currentValidation?.valid : !detail?.skill.active || detail.skill.level !== 'tool')} onClick={() => requestRun(tab === 'compose')}><Play size={15}/>مراجعة طلب التشغيل</Button></details> : null}

    <details className={styles.panel}><summary>سجل التشغيل والأدلة</summary><form className={styles.inlineForm} onSubmit={event => { event.preventDefault(); void readRun(); }}><label>معرف التشغيل<Input aria-label="معرف التشغيل" dir="ltr" disabled={disabled} value={runId} onChange={event => { setRunId(event.target.value); setRun(null); setEvidence(null); }} maxLength={36} required/></label><Button type="submit" disabled={disabled}>قراءة السجل</Button></form>
      {run ? <><p className={styles.hash}>السجل المعروض: <code dir="ltr">{run.id}</code></p><div className={styles.actions}><Badge colorPalette={run.status === 'unknown' ? 'orange' : 'gray'}>{runStatuses[run.status]}</Badge><Button variant="outline" onClick={() => onOpenTask(run.parentTaskId)}>فتح المهمة والموافقات</Button>{['running', 'waiting_children'].includes(run.status) ? <Button variant="outline" disabled={disabled} onClick={() => ask({ title: 'مراجعة إلغاء التشغيل', description: 'سيُطلب إيقاف العمل وإلغاء الخطوات المتبقية. الأثر المكتمل أو المجهول يبقى في السجل للمراجعة.', facts: [run.id], perform: async () => { const result = await skillPost(`/api/skills/runs/${run.id}/cancel`, {}, RunCancelled); setRun(result.run); } })}>إلغاء التشغيل</Button> : null}</div>{run.errorCode ? <p className={styles.warning}>{run.errorCode}{run.status === 'unknown' ? ' · لا تُكرر العملية قبل مراجعة الأثر.' : ''}</p> : null}<div className={styles.nodeGrid}>{run.nodes.map(node => <article className={styles.node} key={node.id}><strong><bdi>{node.id}</bdi></strong><p>{runStatuses[node.status] ?? node.status} · {node.tool ?? node.kind}</p><p className={styles.hint}>محاولة التنفيذ {node.executionAttempt}{node.retryNotBefore ? ` · الموعد التالي ${skillDate(node.retryNotBefore)}` : ''}</p>{node.errorCode ? <code className={styles.hash}>{node.errorCode}</code> : null}{node.childTaskId ? <Button size="sm" variant="outline" onClick={() => onOpenTask(node.childTaskId!)}>فتح مهمة الخطوة</Button> : null}</article>)}</div></> : <p className={styles.hint}>أدخل معرف تشغيل محفوظ. معرفات تجارب القياس المعزولة ليست تشغيلات حية هنا.</p>}
      {evidence ? <section aria-label="أدلة التشغيل"><h3>إيصالات المحاولات ({evidence.total})</h3>{evidence.items.map(item => <details className={styles.evidence} key={item.id}><summary><bdi>{item.nodeId}</bdi> · محاولة {item.attempt} · {runStatuses[item.status] ?? item.status}</summary><code className={styles.hash}>{item.id}</code><p className={styles.hint}>إدخال: <bdi>{item.inputsHash}</bdi><br/>إخراج: <bdi>{item.outputHash ?? 'لا يوجد دليل مكتمل'}</bdi></p><pre className={styles.code} dir="ltr">{JSON.stringify(item.details, null, 2)}</pre></details>)}<div className={styles.pagination}><Button size="sm" variant="outline" disabled={disabled || evidenceOffset === 0} onClick={() => void readRun(evidence.runId, Math.max(0, evidenceOffset - 5))}>أدلة سابقة</Button><span>{evidenceOffset + evidence.items.length} / {evidence.total}</span><Button size="sm" variant="outline" disabled={disabled || evidenceOffset + 5 >= evidence.total} onClick={() => void readRun(evidence.runId, evidenceOffset + 5)}>أدلة تالية</Button></div></section> : null}
    </details>
    <details className={styles.panel}><summary>تطور القدرات والمحفظة</summary><CapabilityEvolution offline={offline} onOpenSkill={openSkill} onOpenTask={onOpenTask} refreshKey={refreshKey}/></details>

    <Dialog.Root open={Boolean(review)} onOpenChange={event => { if (!event.open && !busy) setReview(null); }} placement="center" closeOnInteractOutside={false}>
      <Portal><Dialog.Backdrop/><Dialog.Positioner padding="16px"><Dialog.Content className={styles.dialog} dir="rtl"><Dialog.Header><Dialog.Title>{review?.title}</Dialog.Title></Dialog.Header><Dialog.Body><p>{review?.description}</p><ul className={styles.reviewFacts}>{review?.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul><label className={styles.check}><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)}/>راجعت النطاق وأوافق على هذه العملية</label>{error ? <p className={styles.error} role="alert">{error}</p> : null}</Dialog.Body><Dialog.Footer><Button colorPalette="teal" disabled={disabled || !acknowledged} onClick={() => void confirmReview()}>تأكيد العملية</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => setReview(null)}>رجوع</Button></Dialog.Footer></Dialog.Content></Dialog.Positioner></Portal>
    </Dialog.Root>
  </section>;
}
