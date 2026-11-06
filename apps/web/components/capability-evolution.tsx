"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Spinner } from '@chakra-ui/react';
import { z } from 'zod';
import { SkillGapPageSchema, SkillGraphSnapshotSchema, SkillPortfolioSchema, SkillSandboxDiagnosticSchema,
  type SkillGraphSnapshot, type SkillPortfolio, type SkillSandboxDiagnostic } from '@mohassan/contracts';
import { skillDate, skillErrorText, skillRequest, type SkillResponseSchema } from './skill-client';
import styles from './capability-evolution.module.css';

type GapPage = z.infer<typeof SkillGapPageSchema>;
type Source = 'portfolio' | 'graph' | 'gaps' | 'sandbox';
const sourceNames: Record<Source, string> = { portfolio: 'سجل التطور', graph: 'علاقات المهارات', gaps: 'فجوات القدرات', sandbox: 'حالة العزل' };
const relations = { depends_on: 'تعتمد على', conflicts_with: 'تتعارض مع', requires_tool: 'تحتاج أداة', implemented_by: 'تنفذها قدرة', verified_outcome: 'لها نتيجة خطوة متحققة' };
const categories: Record<string, string> = { missing_skill: 'مهارة غير متاحة', missing_tool: 'أداة غير متاحة', missing_permission: 'إذن مطلوب', model_limitation: 'حدود النموذج', invalid_plan: 'خطة غير صالحة', stale_data: 'بيانات قديمة', environment_failure: 'تعثر البيئة', sandbox_restriction: 'قيد العزل' };
const runStates: Record<string, string> = { pending: 'في الانتظار', queued: 'في الانتظار', running: 'قيد التنفيذ', succeeded: 'نجح', completed: 'مكتمل', failed: 'تعثر', cancelled: 'ملغى', unknown: 'أثر غير محسوم — يحتاج مراجعة', waiting_approval: 'بانتظار الموافقة', recovering: 'جارٍ التعافي', verifying: 'جارٍ التحقق' };

async function boundedRequest<T>(path: string, schema: SkillResponseSchema<T>, parent: AbortSignal, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent.aborted) controller.abort(); else parent.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15000);
  try { return await skillRequest(path, schema, { ...options, signal: controller.signal }); }
  catch (error) { if (controller.signal.aborted && !parent.aborted) throw new Error('انتهت مهلة قراءة الأدلة. حدّثها يدويًا؛ لم تُعَد أي عملية.'); throw error; }
  finally { clearTimeout(timeout); parent.removeEventListener('abort', abort); }
}

export function CapabilityEvolution({ offline, onOpenSkill, onOpenTask, refreshKey = 0 }: {
  offline: boolean; onOpenSkill(id: string): void; onOpenTask(id: string): void; refreshKey?: number;
}) {
  const [portfolio, setPortfolio] = useState<SkillPortfolio | null>(null), [graph, setGraph] = useState<SkillGraphSnapshot | null>(null);
  const [gaps, setGaps] = useState<GapPage | null>(null), [sandbox, setSandbox] = useState<SkillSandboxDiagnostic | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({}), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const [portfolioOffset, setPortfolioOffset] = useState(0), [gapOffset, setGapOffset] = useState(0), [relationOffset, setRelationOffset] = useState(0);
  const [rebuilding, setRebuilding] = useState(false), [notice, setNotice] = useState(''), [lastRead, setLastRead] = useState<string | null>(null);
  const action = useRef<AbortController | null>(null), pageSize = 10;
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    if (offline) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setErrors({});
    void Promise.allSettled([
      boundedRequest(`/api/skills/portfolio?limit=${pageSize}&offset=${portfolioOffset}`, SkillPortfolioSchema, controller.signal),
      boundedRequest('/api/skills/graph', SkillGraphSnapshotSchema, controller.signal),
      boundedRequest(`/api/skills/gaps?limit=${pageSize}&offset=${gapOffset}`, SkillGapPageSchema, controller.signal),
      boundedRequest('/api/skills/sandbox', SkillSandboxDiagnosticSchema, controller.signal),
    ]).then(([p, g, f, s]) => {
      if (controller.signal.aborted) return;
      const next: Partial<Record<Source, string>> = {};
      if (p.status === 'fulfilled') setPortfolio(p.value); else { setPortfolio(null); next.portfolio = skillErrorText(p.reason); }
      if (g.status === 'fulfilled') { setGraph(g.value); setRelationOffset(value => value >= g.value.edges.length ? 0 : value); } else { setGraph(null); next.graph = skillErrorText(g.reason); }
      if (f.status === 'fulfilled') setGaps(f.value); else { setGaps(null); next.gaps = skillErrorText(f.reason); }
      if (s.status === 'fulfilled') setSandbox(s.value); else { setSandbox(null); next.sandbox = skillErrorText(s.reason); }
      setErrors(next); setLastRead(new Date().toISOString()); setLoading(false);
    });
    return () => controller.abort();
  }, [offline, portfolioOffset, gapOffset, revision, refreshKey]);

  const events = useMemo(() => portfolio?.items.flatMap(skill => skill.quality.evaluations.map(evaluation => ({ skill, evaluation })))
    .sort((a, b) => b.evaluation.createdAt.localeCompare(a.evaluation.createdAt)).slice(0, 20) ?? [], [portfolio]);
  const labels = useMemo(() => new Map(graph?.nodes.map(node => [node.key, node.label]) ?? []), [graph]);
  const disabled = offline || loading || rebuilding;
  async function rebuild() {
    if (disabled || action.current) return;
    const controller = new AbortController(); action.current = controller; setRebuilding(true); setNotice('');
    try {
      const result = await boundedRequest('/api/skills/graph/rebuild', SkillGraphSnapshotSchema, controller.signal, { method: 'POST', body: '{}' });
      if (!controller.signal.aborted) { setGraph(result); setNotice('حُدثت العلاقات من السجلات المحفوظة.'); setRevision(value => value + 1); }
    } catch (error) { if (!controller.signal.aborted) setErrors(value => ({ ...value, graph: skillErrorText(error) })); }
    finally { if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setRebuilding(false); } }
  }
  return <section className={styles.root} aria-labelledby="evolution-heading" aria-busy={loading}>
    <header className={styles.header}><div><h2 id="evolution-heading">تطور القدرات والأدلة</h2><p>قياسات محفوظة وعلاقات معلنة؛ لا ترقية تلقائية أو صلاحيات ضمنية.</p></div>
      <Button variant="outline" disabled={disabled} onClick={() => setRevision(value => value + 1)}>تحديث الأدلة</Button></header>
    {offline ? <p className={styles.warning} role="status">الاتصال منقطع. البيانات المعروضة آخر قراءة؛ الإجراءات متوقفة.</p> : null}
    {loading ? <p className={styles.status} role="status"><Spinner size="sm" />جارٍ تحميل أدلة التطور…</p> : null}
    {lastRead ? <p className={styles.meta}>آخر محاولة قراءة: {skillDate(lastRead)}</p> : null}
    {Object.entries(errors).map(([source, message]) => <p className={styles.error} role="alert" key={source}>{sourceNames[source as Source]}: {message}</p>)}
    {notice ? <p role="status">{notice}</p> : null}
    <details className={styles.panel} open><summary>القياسات وتاريخ التنفيذ</summary>
      {portfolio ? <>
        <p className={styles.meta}>النافذة المحللة: {portfolio.analysisWindow.versions} إصدارًا من حد {portfolio.analysisWindow.versionLimit}، و{portfolio.analysisWindow.runs} تشغيلًا من حد {portfolio.analysisWindow.runLimit}. عدد الإصدارات المسجلة: {portfolio.total}. يعرض الخط الزمني أحدث 20 قياسًا للإصدارات في الصفحة.</p>
        {portfolio.truncated || portfolio.analysisWindow.runsTruncated || portfolio.analysisWindow.filesTruncated ? <p className={styles.warning}>التحليل مقتطع؛ لا يمثل جميع السجلات التاريخية.</p> : null}
        {!events.length ? <p className={styles.empty}>لا توجد بيانات قياس كافية للإصدارات في هذه الصفحة.</p> : <ol className={styles.timeline}>{events.map(({ skill, evaluation }) => <li key={`${skill.id}-${evaluation.evaluationId}`}>
          <div className={styles.row}><Button variant="plain" onClick={() => onOpenSkill(skill.id)}>{skill.name} · {skill.version}</Button><Badge>{evaluation.evaluationStatus === 'completed' ? 'قياس مكتمل' : runStates[evaluation.evaluationStatus] ?? evaluation.evaluationStatus}</Badge></div>
          <time dateTime={evaluation.createdAt}>{skillDate(evaluation.createdAt)}</time><p>{evaluation.measuredScope}</p>
          <p>النجاح المرصود للمرشح: {evaluation.candidate.success.denominator ? `${evaluation.candidate.success.numerator} / ${evaluation.candidate.success.denominator}` : 'لا توجد بيانات كافية'}؛ حالات مجهولة: {evaluation.candidate.success.unknown}؛ تراجعات مرصودة: {evaluation.regressions.count} من {evaluation.regressions.comparableCases} أزواج قابلة للمقارنة.</p>
          <p className={styles.meta}>تجربة محلية معزولة. الجودة الدلالية والتكلفة المالية غير مقاستين.</p>
          <details><summary>حدود القياس</summary><ul>{evaluation.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>
        </li>)}</ol>}
        <div className={styles.pager}><Button variant="outline" disabled={disabled || portfolioOffset === 0} onClick={() => setPortfolioOffset(value => Math.max(0, value - pageSize))}>إصدارات سابقة</Button><span>صفحة {Math.floor(portfolioOffset / pageSize) + 1}</span><Button variant="outline" disabled={disabled || portfolioOffset + pageSize >= portfolio.total} onClick={() => setPortfolioOffset(value => value + pageSize)}>إصدارات تالية</Button></div>
        <h3>آخر تشغيلات المالك</h3>
        {!portfolio.recentRuns.length ? <p className={styles.empty}>لا توجد تشغيلات محفوظة بعد.</p> : <ul className={styles.cards}>{portfolio.recentRuns.map(run => <li key={run.id}><Badge>{runStates[run.status] ?? run.status}</Badge><p>{skillDate(run.createdAt)} · {run.evidenceIds.length} إيصالًا{run.evidenceTruncated ? ' ضمن عرض مقتطع' : ''}</p><code dir="ltr">{run.id}</code><Button variant="outline" onClick={() => onOpenTask(run.parentTaskId)}>عرض مهمة التشغيل</Button></li>)}</ul>}
        <details><summary>ملاحظات المحفظة ({portfolio.suggestions.length})</summary><p className={styles.meta}>اقتراحات للمراجعة داخل النافذة المحددة. غياب الملاحظة ليس دليلًا على عدم الحاجة إلى أداة أو اعتماد.</p>
          {portfolio.suggestions.slice(0, 20).map((suggestion, index) => <div className={styles.card} key={`${suggestion.kind}-${index}`}><p>{suggestion.kind === 'duplicate_file_set' ? 'محتويات ملفات متطابقة تستحق المراجعة' : suggestion.kind === 'declared_tools_not_observed' ? 'أدوات معلنة لم تظهر في عينة التنفيذ' : 'اعتمادات معلنة لم تظهر في عينة التنفيذ'}</p><p>{suggestion.tools.join('، ')} {suggestion.dependencies.join('، ')}</p><p>عينة: {suggestion.sampleRuns} تشغيلات. لا حذف تلقائي.</p>{suggestion.versionIds.slice(0, 5).map(id => <Button key={id} variant="plain" onClick={() => onOpenSkill(id)}>مراجعة الإصدار {id.slice(0, 8)}</Button>)}</div>)}
          {!portfolio.suggestions.length ? <p>لا توجد اقتراحات محفوظة ضمن هذه النافذة.</p> : portfolio.suggestions.length > 20 ? <p>يعرض أول 20 اقتراحًا من {portfolio.suggestions.length}.</p> : null}
        </details>
        {portfolio.legacyChecklist.items.length ? <p className={styles.meta}>توجد {portfolio.legacyChecklist.items.length} قوائم فحص قديمة في نطاق قياس مستقل. تُراجع من تبويب الذاكرة، ولا تُمزج مع نتائج محرك المهارات.</p> : null}
      </> : !loading && !errors.portfolio ? <p className={styles.empty}>لا توجد بيانات كافية.</p> : null}
    </details>
    <details className={styles.panel}><summary>علاقات المهارات والتركيب</summary>
      <p className={styles.meta}>السهم من المهارة إلى اعتمادها أو أداتها أو نتيجتها. هذه العلاقات لا تمنح إذن التنفيذ.</p>
      <Button variant="outline" disabled={disabled} onClick={() => void rebuild()}>{rebuilding ? 'جارٍ تحديث العلاقات…' : 'إعادة بناء العلاقات المحفوظة'}</Button>
      {graph ? <>{graph.truncated || !graph.rebuilt ? <p className={styles.warning}>الرسم ناقص أو قديم؛ التوصيات غير متاحة حتى اكتمال التحديث.</p> : null}<p className={styles.meta}>{graph.nodes.length} عقدة، {graph.edges.length} علاقة، حد التوسع {graph.limits.depth}.</p>
        {!graph.edges.length ? <p className={styles.empty}>لا توجد علاقات موثقة بعد.</p> : <ul className={styles.relations}>{graph.edges.slice(relationOffset, relationOffset + 12).map(edge => <li key={edge.id}><span>{labels.get(edge.from) ?? edge.from}</span><strong>← {relations[edge.relation]} ←</strong><span>{labels.get(edge.to) ?? edge.to}</span><small>{edge.provenance === 'verified_receipt' ? 'دليل خطوة تاريخي متحقق' : edge.provenance === 'declared_contract' ? 'عقد المهارة' : 'ربط أداة معتمد'}</small></li>)}</ul>}
        <div className={styles.pager}><Button variant="outline" disabled={disabled || relationOffset === 0} onClick={() => setRelationOffset(value => Math.max(0, value - 12))}>علاقات سابقة</Button><span>{Math.floor(relationOffset / 12) + 1}</span><Button variant="outline" disabled={disabled || relationOffset + 12 >= graph.edges.length} onClick={() => setRelationOffset(value => value + 12)}>علاقات تالية</Button></div>
      </> : null}
    </details>
    <details className={styles.panel}><summary>الفجوات والتعثرات المسجلة</summary>
      {gaps ? <>{!gaps.items.length ? <p className={styles.empty}>لا توجد فجوات مسجلة في هذه الصفحة. هذا لا يثبت توفر جميع القدرات.</p> : <ul className={styles.cards}>{gaps.items.map(gap => <li key={gap.id}><Badge>{gap.category ? categories[gap.category] : 'سبب غير محسوم'}</Badge><p>{gap.action.label}</p><code dir="ltr">{gap.reason}</code><time dateTime={gap.createdAt}>{skillDate(gap.createdAt)}</time>{gap.signal?.taskId ? <Button variant="outline" onClick={() => onOpenTask(gap.signal!.taskId!)}>مراجعة المهمة المرتبطة</Button> : null}<p className={styles.meta}>مراجعة بشرية{gap.action.requiresApproval ? ' وموافقة مطلوبة' : ''}؛ لا إجراء تلقائي.</p></li>)}</ul>}
        <div className={styles.pager}><Button variant="outline" disabled={disabled || gapOffset === 0} onClick={() => setGapOffset(value => Math.max(0, value - pageSize))}>فجوات سابقة</Button><span>{gapOffset + gaps.items.length} / {gaps.total}</span><Button variant="outline" disabled={disabled || gapOffset + pageSize >= gaps.total} onClick={() => setGapOffset(value => value + pageSize)}>فجوات تالية</Button></div>
      </> : null}
    </details>
    <details className={styles.panel}><summary>ضمانات العزل الفعلية</summary>
      {sandbox ? <><p className={styles.warning}>المهارات التنفيذية غير متاحة. جميع بوابات العزل إلزامية.</p><p>المزوّد: <bdi>{sandbox.readiness.provider}</bdi> · القبول الأساسي: {sandbox.readiness.baselineVerified ? 'متحقق' : 'غير متحقق'}.</p><ul className={styles.cards}>{sandbox.readiness.gates.map(gate => <li key={gate.id}><div className={styles.row}><h3><bdi>{gate.id}</bdi> · {gate.name}</h3><Badge>{gate.status === 'verified' ? 'متحقق ضمن الدليل' : 'محجوب'}</Badge></div><p>{gate.reason}</p>{gate.evidence.length ? <details><summary>دليل البوابة</summary><ul>{gate.evidence.map(item => <li key={item}>{item}</li>)}</ul></details> : <p className={styles.meta}>لا يوجد دليل قبول محفوظ لهذه البوابة.</p>}</li>)}</ul></> : null}
    </details>
  </section>;
}
