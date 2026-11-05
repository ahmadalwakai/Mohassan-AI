"use client";

import { CheckCheck, CircleHelp, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import { PlanningResultSchema } from "@mohassan/contracts";

const availabilityLabels = { available: "القدرة متاحة", unavailable: "القدرة غير متاحة", manual: "خطوة يدوية" };
const impactLabels = { low: "منخفض", medium: "متوسط", high: "مرتفع" };
const scopeLabels: Record<string, string> = {
  "diagnostic:read": "تشخيص للقراءة", "model:generate": "طلب نموذج", "code:read": "قراءة الكود",
  "code:write": "تعديل الكود", "code:run": "تشغيل الكود", "code:publish": "نشر مشروع",
  "browser:read": "قراءة المتصفح", "browser:submit": "إرسال نموذج", "ads:read": "قراءة الإعلانات",
  "ads:draft": "مسودة إعلانية", "ads:activate": "تفعيل حملة", "ads:budget": "تعديل ميزانية",
  "ads:pause": "إيقاف حملة", "device:view": "مشاهدة الجهاز", "device:control": "التحكم بالجهاز",
};

function timestamp(value: string) {
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function TextList({ title, values, empty }: { title: string; values: string[]; empty: string }) {
  return <section className="plan-subsection"><h4>{title}</h4>{values.length ? <ul className="plan-list">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="plan-muted">{empty}</p>}</section>;
}

export function PlanningResultView({ result }: { result: Record<string, unknown> }) {
  const parsed = PlanningResultSchema.safeParse(result);
  if (!parsed.success) return <section className="result-box"><p className="inline-error" role="alert">تعذر عرض الخطة لأن بياناتها لا تطابق العقد المعتمد. لا تعتبر هذه النتيجة إذنًا للتنفيذ.</p></section>;
  const output = parsed.data;
  const plan = output.plan;
  const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
  return <section className="planning-result" aria-label="الخطة المقترحة">
    <div className="plan-result-heading"><span className="tool-icon tool-active"><Sparkles size={22} /></span><div><h3>اكتمل إعداد الخطة</h3><p>إعداد خطة فقط؛ لم يُنفّذ الهدف أو أدوات الخطوات.</p></div></div>
    <div className="plan-policy-notice"><ShieldCheck size={19} /><p>اقتصر التحقق المستقل على بنية الخطة والتبعيات والسياسة. لا يثبت ذلك إنجاز الهدف أو نجاح الخطوات المقترحة، ولا يمنح إذن تنفيذها.</p></div>
    <p className="plan-summary">{output.summary}</p>
    <section className="plan-subsection"><h4>الهدف المطلوب</h4><p className="plan-objective">{plan.goal.objective}</p></section>
    <section className="plan-subsection"><h4><CheckCheck size={17} />معايير النجاح المقترحة</h4><ol className="plan-criteria">{plan.goal.successCriteria.map((criterion) => <li key={criterion.id}><strong>{criterion.description}</strong><span>الدليل المتوقع: {criterion.evidence}</span></li>)}</ol></section>
    <div className="plan-paired-sections"><TextList title="القيود" values={plan.goal.constraints} empty="لم تسجل الخطة قيودًا إضافية." /><TextList title="الافتراضات غير المثبتة" values={plan.goal.assumptions} empty="لم تسجل الخطة افتراضات إضافية." /></div>
    {output.needsClarification || plan.goal.clarifyingQuestions.length ? <section className="plan-questions"><h4><CircleHelp size={18} />أسئلة تحتاج توضيحًا</h4>{plan.goal.clarifyingQuestions.length ? <ol>{plan.goal.clarifyingQuestions.map((question, index) => <li key={index}>{question}</li>)}</ol> : <p>تحتاج الخطة توضيحًا قبل أي تنفيذ لاحق. راجع القيود والافتراضات ونقاط عدم اليقين.</p>}</section> : null}
    <section className="plan-subsection"><h4><GitBranch size={17} />ترتيب الخطوات المقترح</h4><p className="plan-muted">هذه مجموعات اعتماد مقترحة. لم يبدأ تشغيل أي خطوة منها.</p><ol className="plan-batches">{output.executionBatches.map((batch, index) => <li key={index}><span>المجموعة {(index + 1).toLocaleString("ar")}</span><div>{batch.map((id) => <span key={id}>{stepsById.get(id)?.title ?? id}</span>)}</div></li>)}</ol></section>
    <section className="plan-subsection"><h4>الخطوات والصلاحيات المطلوبة</h4><ol className="plan-steps">{plan.steps.map((step, index) => <li className="plan-step" key={step.id}>
      <div className="plan-step-heading"><span className="plan-step-number">{(index + 1).toLocaleString("ar")}</span><h5>{step.title}</h5><span className={`subtle-badge ${step.availability === "available" ? "badge-green" : step.availability === "unavailable" ? "badge-unavailable" : ""}`}>{availabilityLabels[step.availability]}</span></div>
      <p>{step.description}</p>
      <dl className="plan-step-properties"><div><dt>تنتظر</dt><dd>{step.dependsOn.length ? step.dependsOn.map((id) => stepsById.get(id)?.title ?? id).join("، ") : "لا توجد خطوات سابقة"}</dd></div><div><dt>الموافقة</dt><dd>{step.requiresApproval ? "تحتاج موافقة قبل تنفيذها لاحقًا" : "تخضع لفحص الصلاحية قبل أي تنفيذ لاحق"}</dd></div><div><dt>القدرة</dt><dd>{step.capabilityId ? <code dir="ltr">{step.capabilityId}</code> : "عمل يدوي أو قدرة لم تحدد بعد"}</dd></div></dl>
      {step.requiredScopes.length ? <div className="plan-scope-list" aria-label="نطاقات الصلاحية المقترحة">{step.requiredScopes.map((scope) => <span key={scope}>{scopeLabels[scope] ?? scope}</span>)}</div> : null}
      <details className="plan-acceptance"><summary>كيف نتحقق من هذه الخطوة؟</summary><ul>{step.acceptanceCriteria.map((criterion, criterionIndex) => <li key={criterionIndex}>{criterion}</li>)}</ul></details>
    </li>)}</ol></section>
    {plan.uncertainties.length ? <section className="plan-subsection"><h4>نقاط عدم اليقين</h4><div className="plan-uncertainties">{plan.uncertainties.map((uncertainty, index) => <article key={index}><div><strong>{uncertainty.description}</strong><span className="subtle-badge">أثر {impactLabels[uncertainty.impact]}</span></div><p>طريقة الحسم: {uncertainty.resolution}</p></article>)}</div></section> : null}
    <section className="plan-model-info"><h4>مصدر الخطة وحدودها</h4><dl><div><dt>المزوّد والنموذج</dt><dd dir="ltr">Groq · {output.model}</dd></div><div><dt>سبب الاختيار</dt><dd>{output.routeReason}</dd></div><div><dt>التوكنات</dt><dd>إدخال {output.usage.inputTokens.toLocaleString("ar")} · إخراج {output.usage.outputTokens.toLocaleString("ar")}</dd></div><div><dt>وقت الإعداد</dt><dd><time dateTime={output.generatedAt}>{timestamp(output.generatedAt)}</time></dd></div><div><dt>تقدير النموذج لثقته</dt><dd>{Math.round(plan.confidence * 100).toLocaleString("ar")}% — تقدير للخطة، لا دليل على نجاح التنفيذ.</dd></div></dl><details className="plan-acceptance"><summary>ما الذي تحقق منه النظام؟</summary><ul>{output.verification.checks.map((check, index) => <li key={index}>{check}</li>)}</ul><p className="plan-muted">وقت التحقق: {timestamp(output.verifiedAt)}</p></details></section>
  </section>;
}
