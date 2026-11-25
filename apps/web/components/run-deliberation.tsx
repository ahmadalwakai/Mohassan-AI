import type { DecisionOutcome, DecisionReason, EvidenceCode, ReviewFindingCode, ThoughtRecord } from "@mohassan/contracts";
import styles from "./run-status.module.css";

const actions = { act: "تنفيذ", ask: "طلب توضيح", abstain: "امتناع" } as const;
const scopes = { public: "عام", private: "خاص", unknown: "غير محدد" } as const;
const revisions = { none: "بلا تعديل", format: "عُدّل التنسيق", read: "أُعيدت القراءة" } as const;
const reasons: Record<DecisionReason, string> = {
  lowest_expected_cost: "أقل تكلفة متوقعة", missing_context: "السياق ناقص", restricted: "الصلاحيات لا تسمح",
  missing_capability: "الأداة المطلوبة غير متاحة", no_supported_candidate: "لا يوجد مسار مناسب",
  pending_card: "توجد خطوة تنتظر ردًا", clarified_choice: "اختار المستخدم المسار", scope_conflict: "تعارض في نطاق الطلب",
};
const evidence: Record<EvidenceCode, string> = {
  cascade_match: "طابق شرط المسار", cascade_weak_match: "طابق شرط المسار جزئيًا", route_decision: "قرار التوجيه",
  router_top: "من أعلى اقتراحات الموجّه", follow_up: "متابعة لطلب سابق", memory_hit: "نتيجة من الذاكرة",
  pending_card: "خطوة معلّقة", missing_context: "سياق إضافي", restricted: "صلاحية لهذا المسار", missing_capability: "أداة متاحة",
  unresolved: "تحديد المطلوب", explicit_destination: "وجهة صريحة", request_scope: "تحديد النطاق",
  clarified_choice: "اختيار من المستخدم", no_supported_candidate: "مسار مدعوم", unsupported_operation: "العملية المطلوبة غير مدعومة",
};
const findings: Record<ReviewFindingCode, string> = {
  decision_mismatch: "اختلاف عن المسار المختار", missing_part: "جزء لم يُجب عنه", unverified_part: "جزء تعذّر التحقق منه",
  wrong_entity: "كيان مختلف", unsupported_answer: "جواب بلا سند", format_language: "لغة غير مطابقة",
  format_sentences: "عدد جمل غير مطابق", format_brief: "الجواب أطول من المطلوب", format_fields: "حقول غير مطابقة",
  format_json: "تنسيق JSON غير مطابق",
};

function Decision({ outcome }: { outcome: DecisionOutcome }) {
  return <>{actions[outcome.action]}{outcome.action === "act" ? <> · <bdi dir="ltr">
    {outcome.route}{outcome.handler && outcome.handler !== outcome.route ? ` · ${outcome.handler}` : ""}
  </bdi></> : null}</>;
}

function DecisionRecord({ record }: { record: ThoughtRecord }) {
  return <>
    <p className={styles.line}><strong><Decision outcome={record.chosen} /></strong> · ثقة {Math.round(record.confidence * 100)}٪</p>
    {record.enforced === false ? <p className={styles.line}>في وضع المراقبة، اتّبع التنفيذ المسار المعتاد.</p> : null}
    {record.reasons.length ? <p className={styles.line}>{record.reasons.map(reason => reasons[reason]).join("، ")}</p> : null}
    {record.legacy ? <p className={styles.line}>
      {record.legacyObserved === false ? "المسار المعتاد المقدّر" : "المسار المعتاد"} <Decision outcome={record.legacy} />{record.disagrees ? " · مختلف عن القرار" : ""}
    </p> : null}
    {record.candidates.length ? <details>
      <summary>المسارات المرشّحة</summary>
      <ul className={styles.list}>
        {record.candidates.map(candidate => <li key={`${candidate.route}:${candidate.handler}`} className={styles.item}>
          <bdi dir="ltr" className={styles.outcome}>{candidate.route} · {candidate.handler}</bdi>
          <bdi dir="ltr" className={styles.kind}>{candidate.score.toFixed(2)}</bdi>
          <span className={styles.note}>{candidate.evidence.map(code => evidence[code]).join("، ")}</span>
        </li>)}
      </ul>
    </details> : null}
    {record.readings.length ? <details>
      <summary>تفسيرات الطلب</summary>
      <ul className={styles.list}>
        {record.readings.map(({ route, scope, spans }, index) => <li key={`${route}-${index}`} className={styles.item}>
          <bdi dir="ltr" className={styles.outcome}>{route}</bdi>
          <span className={styles.kind}>{scopes[scope]}</span>
          {spans.map(({ turn, start, end }, spanIndex) => <span key={`${turn}-${start}-${end}-${spanIndex}`} className={styles.note}>
            {turn === "current" ? "الطلب الحالي" : "الطلب السابق"} <bdi dir="ltr">{start}–{end}</bdi>
          </span>)}
        </li>)}
      </ul>
    </details> : null}
    {record.changeEvidence.length ? <p className={styles.line}>
      <strong>ما قد يغيّر القرار</strong> · {record.changeEvidence.map(code => evidence[code]).join("، ")}
    </p> : null}
    {record.review ? <>
      <p className={styles.line}><strong>مراجعة الجواب</strong> · أُجيب عن {record.review.answeredParts} من {record.review.checkedParts} · {revisions[record.review.revision]}</p>
      {record.review.findings.length ? <p className={styles.line}>{record.review.findings.map(code => findings[code]).join("، ")}</p> : null}
    </> : null}
  </>;
}

export function RunDeliberation({ record, earlier }: { record?: ThoughtRecord; earlier?: ThoughtRecord[] }) {
  if (!record && !earlier?.length) return null;
  return <section aria-label="اتخاذ القرار" data-testid="run-deliberation">
    <h3 className={styles.heading}>اتخاذ القرار</h3>
    {record ? <DecisionRecord record={record} /> : null}
    {earlier?.length ? <details>
      <summary>القرارات السابقة في المهمة</summary>
      <ol className={styles.list}>
        {earlier.map((item, index) => <li key={index}><DecisionRecord record={item} /></li>)}
      </ol>
    </details> : null}
  </section>;
}
