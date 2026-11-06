"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Box, Button, Flex, Heading, Input, Stack, Text, Textarea } from '@chakra-ui/react';
import { z } from 'zod';
import {
  SkillBenchmarkCatalogSchema, SkillBenchmarkEvaluationSchema, SkillBenchmarkPageSchema,
  SkillDetailSchema, SkillForgeAnalysisSchema, SkillForgeGenerationSchema, SkillForgePageSchema,
  SkillForgeStatusSchema, SkillQualityDetailSchema, SkillRegistryResultSchema,
  type SkillBenchmarkEvaluation, type SkillDetail, type SkillForgeGeneration, type SkillQualitySnapshot,
} from '@mohassan/contracts';
import { SkillApiError, skillDate, skillErrorText, skillPercent, skillPost, skillRequest } from './skill-client';

type Props = { offline: boolean; selected: SkillDetail | null; onChanged: () => void; onOpenSkill: (id: string) => void };
type Resource<T> = { path: string | null; data: T | null; error: string; loading: boolean; stopped: boolean };
const running = (value: { status: string }) => value.status === 'running';
const pendingKey = 'mohassan.skill-experiment.pending.v1';
const PendingSchema = z.object({ key: z.uuid(), action: z.enum(['generate', 'benchmark', 'promote']), at: z.string() }).strict();
type Pending = z.infer<typeof PendingSchema>;
const panel = { bg: '#fff', border: '1px solid #e0e8e2', borderRadius: '14px', p: { base: '4', md: '5' }, minW: '0' } as const;
const fieldStyle = { width: '100%', minWidth: 0, minHeight: 44, border: '1px solid #6d8176', borderRadius: 7, padding: '8px 10px', background: '#fff', color: '#172d2b' };
const statusLabels: Record<string, string> = { running: 'قيد التنفيذ', succeeded: 'حُفظ المرشح', completed: 'مكتمل', failed: 'فشل', unknown: 'غير محسوم', passed: 'نجح', blocked: 'محجوب' };
const actionLabels: Record<string, string> = { review_generation_failure: 'راجع سبب تعذر التوليد', inspect_candidate: 'افحص المرشح من مكتبة المهارات', review_inspection: 'راجع ملاحظات الفحص', run_benchmark: 'شغّل قياسًا مقارنًا', review_training_failure: 'راجع حالات التدريب غير الناجحة' };

/** GETs only. One request at a time, a finite polling window, and no retries after an error. */
function useSkillResource<T>(path: string | null, schema: z.ZodType<T>, revision: string | number, offline: boolean, shouldPoll?: (value: T) => boolean) {
  const [state, setState] = useState<Resource<T>>({ path: null, data: null, error: '', loading: false, stopped: false });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requests = 0;
    setState({ path, data: null, error: '', loading: Boolean(path && !offline), stopped: false });
    if (!path || offline) return () => controller.abort();
    async function read() {
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      controller.signal.addEventListener('abort', abortRequest, { once: true });
      const deadline = setTimeout(abortRequest, 15000);
      try {
        const data = await skillRequest(path!, schema, { signal: requestController.signal });
        if (controller.signal.aborted) return;
        const more = Boolean(shouldPoll?.(data));
        requests += 1;
        setState({ path, data, error: '', loading: false, stopped: more && requests >= 100 });
        if (more && requests < 100) timer = setTimeout(() => void read(), 3000);
      } catch (error) {
        if (!controller.signal.aborted) setState(old => ({ ...old, path, loading: false, error: requestController.signal.aborted ? 'انتهت مهلة قراءة السجل. حدّثه يدويًا؛ لم تُعَد أي عملية.' : skillErrorText(error) }));
      } finally {
        clearTimeout(deadline); controller.signal.removeEventListener('abort', abortRequest);
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [path, schema, revision, offline, shouldPoll]);
  return state.path === path ? state : { path, data: null, error: '', loading: Boolean(path), stopped: false };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <Box as="label" display="grid" gap="2" minW="0" fontWeight="600" fontSize="sm">{label}{children}</Box>;
}
function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <Flex as="label" gap="3" align="start" fontSize="sm" lineHeight="1.8" cursor={disabled ? 'not-allowed' : 'pointer'}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} style={{ width: 20, height: 20, marginTop: 3, flexShrink: 0, accentColor: '#196b56' }} />{children}</Flex>;
}
function Pager({ offset, total, step, disabled, onChange }: { offset: number; total: number; step: number; disabled: boolean; onChange: (value: number) => void }) {
  return <Flex gap="3" align="center" wrap="wrap"><Button variant="outline" size="sm" disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - step))}>السابق</Button><Text fontSize="sm">{total ? `${offset + 1}–${Math.min(offset + step, total)} من ${total}` : 'لا سجلات'}</Text><Button variant="outline" size="sm" disabled={disabled || offset + step >= total} onClick={() => onChange(offset + step)}>التالي</Button></Flex>;
}
function VersionNote({ detail, onOpen }: { detail: SkillDetail | null; onOpen: (id: string) => void }) {
  if (!detail) return null;
  return <Stack gap="1" fontSize="sm" minW="0"><Text>{detail.skill.name} · {detail.skill.version} · مراجعة {detail.skill.revision}</Text><Text color="#526860">الفحص: {detail.inspection?.verdict ?? 'لم يُفحص'} · {detail.skill.level}</Text><Text dir="ltr" overflowWrap="anywhere" fontFamily="mono" fontSize="xs">{detail.skill.contentHash}</Text><Button variant="plain" alignSelf="start" color="#196b56" onClick={() => onOpen(detail.skill.id)}>مراجعة المصدر والفحص</Button></Stack>;
}
function Quality({ quality }: { quality: SkillQualitySnapshot | undefined }) {
  if (!quality) return <Text color="#526860">لا توجد خلاصة جودة محفوظة لهذا القياس ضمن نافذة النتائج الحالية.</Text>;
  const rates = [['النجاح', 'success'], ['التحقق المستقل', 'verification'], ['السلامة ضمن المجموعة', 'safety'], ['الاستعادة المقاسة', 'recovery'], ['حالات التحقق المحجوبة عن التوليد', 'holdout']] as const;
  return <Stack gap="3"><Text fontWeight="600">{quality.reviewReady ? 'القياس جاهز للمراجعة البشرية' : 'القياس لا يحقق شروط الترقية'}</Text><Text>{quality.measuredScope}</Text>
    {rates.map(([label, key]) => <Box key={key} p="3" border="1px solid #e0e8e2" borderRadius="8px"><Text fontWeight="600">{label}</Text>{(['baseline', 'candidate'] as const).map(arm => { const rate = quality[arm][key]; return <Text key={arm} fontSize="sm">{arm === 'baseline' ? 'الأساس' : 'المرشح'}: {skillPercent(rate.observedRate)} · {rate.passed} ناجح / {rate.denominator} مقاس · {rate.unknown} غير معلوم · {rate.notApplicable} لا ينطبق</Text>; })}</Box>)}
    <Text fontSize="sm">تراجعات مرصودة: {quality.regressions.count} · أزواج غير معلومة: {quality.regressions.unknownPairs}. متوسط زمن المرشح: {quality.candidate.latency.meanMs === null ? 'غير مقاس' : `${Math.round(quality.candidate.latency.meanMs)} ms`}.</Text>
    <Text fontSize="sm">التكلفة المالية: غير معلومة. جودة المحتوى الدلالية: غير مقاسة. القياس يخص هذه المجموعة وحدها.</Text>
    {quality.reviewReasons.length > 0 && <Text fontSize="sm" overflowWrap="anywhere">أسباب المراجعة: {quality.reviewReasons.join('، ')}</Text>}
    <Box as="ul" ps="5" fontSize="sm" color="#526860">{quality.limitations.map(item => <li key={item}>{item}</li>)}</Box>
  </Stack>;
}
function Evidence({ evaluation }: { evaluation: SkillBenchmarkEvaluation }) {
  return <Stack gap="3"><Text fontSize="sm">أدلة تجربة معزولة (isolated_experiment). معرّفات التشغيل والمهام أدناه تخص قاعدة الاختبار الخاصة، ولا تمثل مهام عملك الحية.</Text>
    <Text fontSize="sm">المتحقق: {evaluation.suite.verifierVersion} · الفصل المستقل لحالات التحقق: {evaluation.suite.independentHoldout ? 'نعم' : 'غير مثبت'}.</Text>
    <Box as="details"><summary>بصمات النسختين والمجموعة</summary><Box as="pre" whiteSpace="pre-wrap" overflowWrap="anywhere" fontSize="xs" dir="ltr">{JSON.stringify({ baseline: evaluation.baseline, candidate: evaluation.candidate, suiteHash: evaluation.suite.suiteHash, configHash: evaluation.suite.configHash }, null, 2)}</Box></Box>
    {evaluation.cases.map(item => <Box as="details" key={`${item.arm}:${item.caseId}`} p="3" border="1px solid #e0e8e2" borderRadius="8px" minW="0"><summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>{item.arm === 'baseline' ? 'الأساس' : 'المرشح'} · {item.caseId} · {statusLabels[item.status]} · {item.split === 'training' ? 'تدريب' : 'تحقق مستقل'}</summary><Stack gap="2" mt="3" fontSize="sm"><Text>المدة الفعلية: {Math.round(item.durationMs)} ms · السبب: {item.reasonCode ?? 'لا يوجد'}</Text><Text>الاستعادة: {item.metrics.recovery === null ? (item.notApplicable.includes('recovery') ? 'لا تنطبق' : 'غير مقاسة') : item.metrics.recovery ? 'نجحت' : 'فشلت'} · التكلفة: {item.metrics.costUsd === null ? 'غير معلومة' : `${item.metrics.costUsd} USD`}</Text><Box as="pre" whiteSpace="pre-wrap" overflowWrap="anywhere" fontSize="xs" dir="ltr">{JSON.stringify({ inputsHash: item.inputsHash, outputHash: item.outputHash, sourceContentHash: item.sourceContentHash, evidence: item.evidence }, null, 2)}</Box></Stack></Box>)}
    {!evaluation.cases.length && <Text>لم تُحفظ نتائج حالات بعد.</Text>}
  </Stack>;
}

export function SkillExperiments({ offline, selected, onChanged, onOpenSkill }: Props) {
  const [refresh, setRefresh] = useState(0), [versionOffset, setVersionOffset] = useState(0), [generationOffset, setGenerationOffset] = useState(0), [evaluationOffset, setEvaluationOffset] = useState(0);
  const [baselineId, setBaselineId] = useState(selected?.skill.id ?? ''), [candidateId, setCandidateId] = useState(''), [generationId, setGenerationId] = useState(''), [evaluationId, setEvaluationId] = useState('');
  const [suiteId, setSuiteId] = useState('instruction-delivery-v1'), [goal, setGoal] = useState(''), [targetSlug, setTargetSlug] = useState('');
  const [generationApproved, setGenerationApproved] = useState(false), [benchmarkApproved, setBenchmarkApproved] = useState(false), [promotionApproved, setPromotionApproved] = useState(false), [acknowledgeFindings, setAcknowledgeFindings] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [pendingReviewed, setPendingReviewed] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mutation = useRef<AbortController | null>(null), mounted = useRef(true);
  const versions = useSkillResource('/api/skills?limit=100&offset=' + versionOffset, SkillRegistryResultSchema, refresh, offline);
  const status = useSkillResource('/api/skills/forge/status', SkillForgeStatusSchema, refresh, offline);
  const catalog = useSkillResource('/api/skills/benchmarks/suites', SkillBenchmarkCatalogSchema, refresh, offline);
  const baseline = useSkillResource(baselineId ? `/api/skills/${baselineId}` : null, SkillDetailSchema, refresh, offline);
  const candidate = useSkillResource(candidateId ? `/api/skills/${candidateId}` : null, SkillDetailSchema, refresh, offline);
  const generation = useSkillResource(generationId ? `/api/skills/forge/generations/${generationId}` : null, SkillForgeGenerationSchema, refresh, offline, running);
  const generations = useSkillResource(`/api/skills/forge/generations?limit=20&offset=${generationOffset}`, SkillForgePageSchema, `${refresh}:${generation.data?.status}`, offline);
  const analysis = useSkillResource(generationId ? `/api/skills/forge/generations/${generationId}/analysis` : null, SkillForgeAnalysisSchema, `${refresh}:${generation.data?.status}`, offline);
  const evaluation = useSkillResource(evaluationId ? `/api/skills/benchmarks/${evaluationId}` : null, SkillBenchmarkEvaluationSchema, refresh, offline, running);
  const evaluations = useSkillResource(`/api/skills/benchmarks?limit=20&offset=${evaluationOffset}${candidateId ? `&versionId=${candidateId}` : ''}`, SkillBenchmarkPageSchema, `${refresh}:${generation.data?.status}:${evaluation.data?.status}`, offline);
  const quality = useSkillResource(candidateId ? `/api/skills/${candidateId}/quality` : null, SkillQualityDetailSchema, `${refresh}:${evaluation.data?.status}:${evaluation.data?.cases.length}`, offline);
  const allErrors = [versions, status, catalog, baseline, candidate, generations, generation, analysis, evaluations, evaluation, quality].map(item => item.error).filter(Boolean);
  const selectedSuite = catalog.data?.suites.find(item => item.id === suiteId);
  const selectedQuality = quality.data?.evaluations.find(item => item.evaluationId === evaluationId);
  const disabled = offline || Boolean(busy) || Boolean(pending);
  const builtin = baseline.data?.source?.kind === 'builtin';
  const evaluationMatches = Boolean(evaluation.data && candidate.data && generation.data && evaluation.data.candidate.versionId === candidateId && evaluation.data.candidate.contentHash === candidate.data.skill.contentHash && evaluation.data.baseline.versionId === generation.data.baseline.versionId && evaluation.data.baseline.contentHash === generation.data.baseline.contentHash);
  const canPromote = Boolean(status.data?.enabled && generation.data?.status === 'succeeded' && generation.data.candidateId === candidateId && candidate.data && candidate.data.skill.level !== 'executable' && !candidate.data.skill.active && candidate.data.inspection?.contentHash === candidate.data.skill.contentHash && ['pass', 'review'].includes(candidate.data.inspection?.verdict ?? '') && evaluation.data?.status === 'completed' && evaluationMatches && selectedQuality?.reviewReady);

  useEffect(() => {
    mounted.current = true;
    try { const saved = sessionStorage.getItem(pendingKey); if (saved) { const parsed = PendingSchema.safeParse(JSON.parse(saved)); if (parsed.success) setPending(parsed.data); } } catch { /* Storage is optional; in-memory fencing remains. */ }
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);
  useEffect(() => { setGenerationApproved(false); }, [baselineId, baseline.data?.skill.revision, baseline.data?.skill.contentHash, goal, targetSlug]);
  useEffect(() => { setBenchmarkApproved(false); setEvaluationOffset(0); }, [baselineId, candidateId, suiteId, baseline.data?.skill.revision, baseline.data?.skill.contentHash, candidate.data?.skill.revision, candidate.data?.skill.contentHash, selectedSuite?.suiteHash, selectedSuite?.configHash]);
  useEffect(() => { setPromotionApproved(false); setAcknowledgeFindings(false); }, [generationId, evaluationId, candidateId, candidate.data?.skill.revision]);
  useEffect(() => { if (offline) mutation.current?.abort(); }, [offline]);

  function savePending(value: Pending | null) {
    if (mounted.current) { setPending(value); setPendingReviewed(false); }
    try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { /* No credentials or payload are persisted. */ }
  }
  async function mutate<T>(action: Pending['action'], prepare: (signal: AbortSignal) => Promise<{ path: string; body: unknown; schema: z.ZodType<T> }>, complete: (value: T) => void) {
    if (disabled || mutation.current) return;
    const controller = new AbortController(); mutation.current = controller;
    const deadline = setTimeout(() => controller.abort(), 30000);
    setBusy(action); setError(''); setNotice('');
    let submitted = false;
    try {
      const request = await prepare(controller.signal);
      if (controller.signal.aborted) return;
      const key = crypto.randomUUID();
      savePending({ key, action, at: new Date().toISOString() }); submitted = true;
      const result = await skillPost(request.path, request.body, request.schema, { key, signal: controller.signal });
      savePending(null);
      if (!mounted.current) return;
      complete(result); setRefresh(value => value + 1); onChanged();
    } catch (caught) {
      // Validation/auth/conflict responses are conclusive; lost responses and server failures are not replayed.
      const conclusive = caught instanceof SkillApiError && caught.status >= 400 && caught.status < 500;
      if (submitted && conclusive) savePending(null);
      if (mounted.current) setError(submitted && !conclusive ? 'لم تُحسم نتيجة الطلب. احتفظنا بمفتاحه؛ راجع السجل قبل أي طلب جديد. لم نُعد إرساله.' : skillErrorText(caught));
    } finally {
      clearTimeout(deadline);
      mutation.current = null;
      if (mounted.current) { setBusy(''); setGenerationApproved(false); setBenchmarkApproved(false); setPromotionApproved(false); }
    }
  }
  async function current(detail: SkillDetail | null, signal: AbortSignal) {
    if (!detail) throw new Error('اختر النسخة وانتظر تحميل تفاصيلها.');
    const fresh = await skillRequest(`/api/skills/${detail.skill.id}`, SkillDetailSchema, { signal });
    if (fresh.skill.revision !== detail.skill.revision || fresh.skill.contentHash !== detail.skill.contentHash) { setRefresh(value => value + 1); throw new Error('تغيرت النسخة منذ عرضها. راجع التفاصيل المحدثة ثم وافق مجددًا.'); }
    return fresh;
  }
  function generate(event: FormEvent) {
    event.preventDefault(); if (!generationApproved || !status.data?.enabled || !status.data.modelConfigured || !baseline.data || builtin && !targetSlug.trim()) return;
    void mutate('generate', async signal => { const value = await current(baseline.data, signal); return { path: '/api/skills/forge/generations', schema: SkillForgeGenerationSchema, body: { goal: goal.trim(), baselineId: value.skill.id, baselineRevision: value.skill.revision, ...(targetSlug.trim() ? { targetSlug: targetSlug.trim() } : {}), approve: true } }; }, value => { setGenerationId(value.id); setGenerationOffset(0); setNotice('حُفظ طلب التوليد. سيبقى المصدر الجديد في الحجر حتى الفحص والقياس وموافقتك.'); });
  }
  function benchmark(event: FormEvent) {
    event.preventDefault(); if (!benchmarkApproved || !catalog.data?.enabled || !baseline.data || !candidate.data) return;
    void mutate('benchmark', async signal => { const [base, next] = await Promise.all([current(baseline.data, signal), current(candidate.data, signal)]); return { path: '/api/skills/benchmarks', schema: SkillBenchmarkEvaluationSchema, body: { baselineId: base.skill.id, baselineRevision: base.skill.revision, candidateId: next.skill.id, candidateRevision: next.skill.revision, suiteId } }; }, value => { setEvaluationId(value.id); setEvaluationOffset(0); setNotice('بدأ القياس على نسخ معزولة. النتائج تُحفظ تدريجيًا.'); });
  }
  function promote(event: FormEvent) {
    event.preventDefault(); if (!canPromote || !promotionApproved || !generation.data || !candidate.data || candidate.data.inspection?.verdict === 'review' && !acknowledgeFindings) return;
    const id = generation.data.id;
    void mutate('promote', async signal => { const value = await current(candidate.data, signal); return { path: `/api/skills/forge/generations/${id}/promote`, schema: SkillDetailSchema, body: { expectedRevision: value.skill.revision, evaluationId, approve: true, acknowledgeFindings } }; }, value => { setNotice(`فُعّلت النسخة ${value.skill.version} بعد تحقق الخادم من القياس والمراجعة الحالية.`); });
  }
  function chooseGeneration(value: SkillForgeGeneration) { setGenerationId(value.id); setBaselineId(value.baseline.versionId); if (value.candidateId) setCandidateId(value.candidateId); else setCandidateId(''); setEvaluationId(''); }
  function chooseEvaluation(value: SkillBenchmarkEvaluation) { setEvaluationId(value.id); setBaselineId(value.baseline.versionId); setCandidateId(value.candidate.versionId); setSuiteId(value.suite.id); }

  return <Stack gap="5" minW="0" color="#172d2b" dir="rtl" lineHeight="1.8" aria-label="تجارب المهارات وForge">
    <Flex gap="3" align="start" justify="space-between" wrap="wrap"><Box><Heading as="h2" size="lg">من مرشح إلى نسخة مُراجعة</Heading><Text color="#526860">ولّد مصدرًا، افحصه، قارن نسختين، ثم اتخذ قرار التفعيل.</Text></Box><Button variant="outline" disabled={offline || Boolean(busy)} onClick={() => setRefresh(value => value + 1)}>تحديث السجلات</Button></Flex>
    {offline && <Text role="status">الاتصال غير متاح. الإجراءات والقراءات متوقفة حتى يعود الاتصال.</Text>}
    {(error || allErrors.length > 0) && <Box role="alert" bg="#fff3ed" color="#8c3525" border="1px solid #dbaf9e" p="3" borderRadius="8px">{[...new Set([error, ...allErrors].filter(Boolean))].map(item => <Text key={item}>{item}</Text>)}</Box>}
    {notice && <Text role="status" color="#196b56">{notice}</Text>}
    {pending && !busy && <Stack {...panel} bg="#fff8ea" gap="3"><Text fontWeight="600">طلب سابق غير محسوم</Text><Text fontSize="sm">{pending.action} · {skillDate(pending.at)}. راجع سجل التوليد والتجارب والحالة الحالية قبل إزالة هذا التنبيه.</Text><Text as="code" dir="ltr" overflowWrap="anywhere">{pending.key}</Text><Check checked={pendingReviewed} onChange={setPendingReviewed}>راجعت السجل وفهمت أن إرسال طلب جديد قد يكرر عملية سابقة.</Check><Button variant="outline" disabled={!pendingReviewed || offline} onClick={() => { savePending(null); setNotice('أُغلق التنبيه بطلبك. لم يُعَد إرسال العملية السابقة.'); }}>إغلاق التنبيه بعد المراجعة</Button></Stack>}

    <Stack {...panel} gap="4"><Heading as="h3" size="md">1. النسخ المعنية</Heading>{selected && <Flex gap="2" wrap="wrap"><Button variant="outline" size="sm" disabled={disabled} onClick={() => setBaselineId(selected.skill.id)}>المهارة المفتوحة أساسًا</Button><Button variant="outline" size="sm" disabled={disabled} onClick={() => setCandidateId(selected.skill.id)}>المهارة المفتوحة مرشحًا</Button></Flex>}
      <Box display="grid" gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }} gap="5">
        {([{ label: 'نسخة الأساس', id: baselineId, resource: baseline, set: setBaselineId }, { label: 'النسخة المرشحة', id: candidateId, resource: candidate, set: setCandidateId }]).map(slot => <Stack key={slot.label} gap="3" minW="0"><Field label={slot.label}><select aria-label={slot.label} value={slot.id} disabled={disabled || versions.loading} onChange={event => slot.set(event.target.value)} style={fieldStyle}><option value="">اختر نسخة</option>{slot.id && !versions.data?.items.some(item => item.id === slot.id) && <option value={slot.id}>{slot.resource.data?.skill.name ?? 'النسخة المحددة'} · {slot.resource.data?.skill.version ?? slot.id.slice(0, 8)}</option>}{versions.data?.items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version} · {item.active ? 'فعالة' : item.status}</option>)}</select></Field>{slot.resource.loading && <Text role="status">جارٍ تحميل النسخة…</Text>}<VersionNote detail={slot.resource.data} onOpen={onOpenSkill} /></Stack>)}
      </Box><Pager offset={versionOffset} total={versions.data?.total ?? 0} step={100} disabled={disabled || versions.loading} onChange={setVersionOffset} />
    </Stack>

    <Box as="form" onSubmit={generate} {...panel}><Stack gap="4"><Heading as="h3" size="md">2. توليد مرشح مع Forge</Heading><Text fontSize="sm">يُرسل الهدف ومصدر الأساس وسياق التدريب المحدود إلى النموذج المُعدّ. قد يستهلك الطلب توكنات؛ التكلفة النقدية غير معروفة مسبقًا. يُحفظ الناتج في الحجر.</Text>
      {status.data && (!status.data.enabled || !status.data.modelConfigured) && <Text role="status" color="#8c3525">{!status.data.enabled ? 'محرك المهارات غير مفعّل على الخادم.' : 'لا يوجد نموذج مُعدّ لتوليد المهارات.'}</Text>}
      <Field label="هدف التحسين"><Textarea aria-label="هدف التحسين" required minLength={10} maxLength={4000} rows={4} value={goal} disabled={disabled} onChange={event => setGoal(event.target.value)} borderColor="#6d8176" placeholder="صف النتيجة المطلوبة والقيود التي يجب الحفاظ عليها." /></Field>
      <Field label="معرّف العائلة الجديدة"><Input aria-label="معرّف العائلة الجديدة" dir="ltr" value={targetSlug} required={builtin} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+){0,7}" disabled={disabled} onChange={event => setTargetSlug(event.target.value)} placeholder="my-reviewed-skill" borderColor="#6d8176" /></Field>
      <Text fontSize="sm" color="#526860">{builtin ? 'مطلوب للمهارة المدمجة: اختر معرّفًا لإنشاء فرع مستقل. الخادم يحدد رقم النسخة.' : 'اختياري: إدخال معرّف جديد ينشئ فرعًا مستقلًا. تركه فارغًا يقترح نسخة داخل عائلة الأساس؛ الخادم يحدد رقم النسخة.'}</Text>
      <Check checked={generationApproved} onChange={setGenerationApproved} disabled={disabled || !baseline.data || baseline.loading || !status.data?.enabled || !status.data.modelConfigured}>أوافق على إرسال هذا الهدف ومصدر نسخة الأساس المحددة إلى النموذج واستهلاك التوكنات.</Check>
      <Button type="submit" bg="#196b56" color="white" alignSelf="start" disabled={disabled || !generationApproved || !baseline.data || baseline.loading || !status.data?.enabled || !status.data.modelConfigured || goal.trim().length < 10 || Boolean(builtin && !targetSlug.trim())}>{busy === 'generate' ? 'جارٍ حفظ الطلب…' : 'توليد مرشح محفوظ في الحجر'}</Button>
    </Stack></Box>

    <Stack {...panel} gap="4"><Heading as="h3" size="md">سجل التوليد</Heading>{generations.loading && <Text role="status">جارٍ تحميل السجل…</Text>}{!generations.loading && generations.data?.items.length === 0 && <Text>لم تُحفظ طلبات توليد بعد.</Text>}
      {generations.data?.items.map(item => <Button key={item.id} variant="outline" h="auto" minH="44px" py="3" justifyContent="start" whiteSpace="normal" textAlign="start" overflowWrap="anywhere" aria-pressed={generationId === item.id} disabled={Boolean(busy)} onClick={() => chooseGeneration(item)}>{item.targetSlug} · {item.targetVersion} · {statusLabels[item.status]} · {skillDate(item.startedAt)}</Button>)}
      <Pager offset={generationOffset} total={generations.data?.total ?? 0} step={20} disabled={offline || Boolean(busy) || generations.loading} onChange={setGenerationOffset} />
      {generation.data && <Stack gap="3" borderTop="1px solid #e0e8e2" pt="4"><Text fontWeight="600">الطلب المحدد: {statusLabels[generation.data.status]}</Text><Text fontSize="sm">النموذج: {generation.data.model ?? 'لم يصل إيصال النموذج'} · التوكنات: {generation.data.usage ? `${generation.data.usage.inputTokens} إدخال / ${generation.data.usage.outputTokens} إخراج` : 'غير معلومة'}</Text>{generation.data.errorCode && <Text color="#8c3525" overflowWrap="anywhere">{generation.data.errorCode}</Text>}{generation.data.status === 'unknown' && <Text>قد يكون طلب النموذج قد نُفّذ. لا توجد إعادة تلقائية ولا تفعيل تلقائي.</Text>}
        {generation.data.candidateId && <Flex gap="2" wrap="wrap"><Button variant="outline" disabled={disabled} onClick={() => { setCandidateId(generation.data!.candidateId!); setBaselineId(generation.data!.baseline.versionId); }}>استخدام المرشح والأساس في المقارنة</Button><Button variant="plain" color="#196b56" onClick={() => onOpenSkill(generation.data!.candidateId!)}>فتح المرشح لفحص المصدر</Button></Flex>}
        {analysis.data && <Box><Text fontWeight="600">الخطوات المستندة إلى السجل</Text><Text fontSize="sm">تحليل تدريب فقط؛ لا يكشف مدخلات التحقق المستقلة.</Text><Box as="ul" ps="5">{analysis.data.actions.map(item => <li key={item}>{actionLabels[item]}</li>)}</Box>{analysis.data.inspection && <Text>الفحص: {analysis.data.inspection.verdict} · {analysis.data.inspection.current ? 'يطابق المحتوى الحالي' : 'تاريخي'}</Text>}{analysis.data.trainingFailures.map(item => <Text key={`${item.evaluationId}:${item.caseId}`} fontSize="sm" overflowWrap="anywhere">{item.caseId}: {statusLabels[item.status]} · {item.reasonCode ?? 'سبب غير محدد'}</Text>)}{analysis.data.truncated && <Text>التحليل محدود؛ توجد تفاصيل أخرى خارج نافذة العرض.</Text>}</Box>}
      </Stack>}{generation.stopped && <Text role="status">انتهت نافذة التحديث التلقائي. استخدم «تحديث السجلات» لقراءة الحالة الحالية.</Text>}
    </Stack>

    <Box as="form" onSubmit={benchmark} {...panel}><Stack gap="4"><Heading as="h3" size="md">3. مقارنة بقياس فعلي معزول</Heading><Field label="مجموعة القياس"><select aria-label="مجموعة القياس" style={fieldStyle} value={suiteId} disabled={disabled || catalog.loading} onChange={event => setSuiteId(event.target.value)}>{catalog.data?.suites.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>
      {selectedSuite && <Stack gap="2" fontSize="sm"><Text>{selectedSuite.measuredScope}</Text><Text>{selectedSuite.trainingCases} حالات تدريب · {selectedSuite.holdoutCases} حالات تحقق مستقلة · تُشغّل لكلتا النسختين.</Text><Box as="ul" ps="5" color="#526860">{selectedSuite.limitations.map(item => <li key={item}>{item}</li>)}</Box></Stack>}
      <Text fontSize="sm">تُختبر نسخ ثابتة في قاعدة ومجلدات مؤقتة مستقلة. الأدوات أو المستويات غير المدعومة تُعرض محجوبة؛ النتيجة لا تمنح صلاحيات ولا تفعل المهارة.</Text>
      <Check checked={benchmarkApproved} onChange={setBenchmarkApproved} disabled={disabled || !baseline.data || !candidate.data || !selectedSuite || baseline.loading || candidate.loading || !catalog.data?.enabled}>أوافق على تشغيل المجموعة المحددة على نسختي الأساس والمرشح في البيئة المعزولة.</Check>
      <Button type="submit" bg="#196b56" color="white" alignSelf="start" disabled={disabled || !benchmarkApproved || !catalog.data?.enabled || !selectedSuite || !baseline.data || !candidate.data || baselineId === candidateId || baseline.loading || candidate.loading}>{busy === 'benchmark' ? 'جارٍ حفظ التجربة…' : 'بدء المقارنة المعزولة'}</Button>
    </Stack></Box>

    <Stack {...panel} gap="4"><Heading as="h3" size="md">القياسات المحفوظة</Heading><Text fontSize="sm" color="#526860">{candidateId ? 'نتائج تشمل النسخة المرشحة المحددة.' : 'آخر النتائج المحفوظة في حسابك.'}</Text>{evaluations.loading && <Text role="status">جارٍ تحميل القياسات…</Text>}{evaluations.data?.items.map(item => <Button key={item.id} variant="outline" h="auto" minH="44px" py="3" justifyContent="start" textAlign="start" whiteSpace="normal" overflowWrap="anywhere" aria-pressed={evaluationId === item.id} disabled={Boolean(busy)} onClick={() => chooseEvaluation(item)}>{item.suite.id} · {statusLabels[item.status]} · {skillDate(item.startedAt)}</Button>)}{evaluations.data?.items.length === 0 && <Text>لا توجد تجارب محفوظة لهذه النسخة.</Text>}<Pager offset={evaluationOffset} total={evaluations.data?.total ?? 0} step={20} disabled={offline || Boolean(busy) || evaluations.loading} onChange={setEvaluationOffset} />
      {evaluation.data && <Stack gap="5" borderTop="1px solid #e0e8e2" pt="4"><Text fontWeight="600">حالة التجربة المحددة: {statusLabels[evaluation.data.status]}</Text>{evaluation.data.errorCode && <Text color="#8c3525">{evaluation.data.errorCode}</Text>}<Quality quality={selectedQuality} /><Evidence evaluation={evaluation.data} /></Stack>}
      {evaluation.stopped && <Text role="status">توقّف التحديث التلقائي بعد 100 قراءة. لم تُلغَ التجربة؛ حدّث السجلات لمعرفة حالتها.</Text>}
    </Stack>

    <Box as="form" onSubmit={promote} {...panel}><Stack gap="4"><Heading as="h3" size="md">4. قرار الترقية</Heading><Text fontSize="sm">الترقية مرتبطة بالمرشح ونتيجة المقارنة المحددين أعلاه. يعيد الخادم فحص الأصل والبصمات والصلاحيات والمراجعة الحالية عند الطلب.</Text>
      {!canPromote && <Text color="#8c3525">اختر توليدًا ناجحًا ومرشحه المفحوص وقياسًا مكتملًا جاهزًا للمراجعة يطابق أساسه. ترقية المهارات التنفيذية مغلقة.</Text>}
      <Check checked={promotionApproved} onChange={setPromotionApproved} disabled={disabled || !canPromote}>راجعت مصدر المرشح والفحص ونطاق القياس، وأوافق صراحة على تفعيل هذه النسخة.</Check>
      {candidate.data?.inspection?.verdict === 'review' && <Check checked={acknowledgeFindings} onChange={setAcknowledgeFindings} disabled={disabled || !canPromote}>قرأت ملاحظات الفحص وأقبلها لهذه النسخة.</Check>}
      <Button type="submit" bg="#196b56" color="white" alignSelf="start" disabled={disabled || !canPromote || !promotionApproved || candidate.data?.inspection?.verdict === 'review' && !acknowledgeFindings}>{busy === 'promote' ? 'جارٍ التحقق من الترقية…' : 'تفعيل المرشح بعد المراجعة'}</Button>
    </Stack></Box>
  </Stack>;
}
