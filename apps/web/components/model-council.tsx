"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ModelCouncil, ModelCouncilMember } from "@mohassan/contracts";
import styles from "./model-council.module.css";

const OUTCOME: Record<ModelCouncilMember["outcome"], string> = { ok: "اكتمل التشغيل", abstained: "امتنع عن الإجابة", failed: "تعذّر التشغيل", timeout: "انتهى وقت التشغيل" };
const JUDGE: Record<NonNullable<ModelCouncilMember["judge"]>, string> = {
  send: "فحص الرد بلا حجب", fix: "فحص الرد يقترح تعديلًا", withhold: "فحص الرد يوصي بالحجب", failed: "تعذّر فحص الرد",
};
const PUBLICATION: Record<NonNullable<ModelCouncilMember["publication"]>, string> = {
  pipeline: "أولوية النشر للمحرك", corroborated: "بديل مشروط بتعذّر جواب المحرك",
  "owner-fallback": "خيار تجريبي أخير للمالك", ineligible: "غير مؤهل للنشر في هذا الدور",
};

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} م.ث` : `${(ms / 1000).toFixed(1)} ث`;
}

function chosenLabel(council: ModelCouncil): string {
  return council.members.find(member => member.round === "answer" && member.model === council.chosen)?.label ?? council.chosen;
}

function Understanding({ member }: { member: ModelCouncilMember }) {
  return <li className={styles.item}>
    <span className={styles.name}>{member.label}</span>
    {member.output ? <bdi className={styles.value} dir="ltr">{member.output}</bdi> : <span className={styles.chip}>{OUTCOME[member.outcome]}</span>}
    {member.agreesWithRules === undefined ? null
      : <span className={`${styles.chip} ${member.agreesWithRules ? styles.agree : styles.differ}`}>{member.agreesWithRules ? "يوافق القواعد" : "يخالف القواعد"}</span>}
    {member.note ? <span className={styles.note}>{member.note}</span> : null}
  </li>;
}

function sourceMatchLabel({ inEvidence, publication }: ModelCouncilMember): string {
  if (inEvidence === undefined) return "مطابقة المصدر غير مقيسة";
  if (publication === undefined) return inEvidence
    ? "ظهر تشابه تقريبي في الأدلة في الفحص السابق"
    : "لم يظهر تشابه تقريبي في الأدلة في الفحص السابق";
  return inEvidence ? "ظهرت مطابقة نصية في الأدلة" : "لم تظهر مطابقة نصية في الأدلة";
}

function Answer({ member }: { member: ModelCouncilMember }) {
  return <li className={`${styles.answer} ${member.chosen ? styles.chosen : ""}`} data-chosen={member.chosen ? "true" : undefined}>
    <div className={styles.answerHead}>
      <span className={styles.name}>{member.label}</span>
      {member.chosen ? <span className={`${styles.chip} ${styles.agree}`}>اختيار المجلس</span> : null}
      <span className={styles.chip}>{OUTCOME[member.outcome]}</span>
      {member.outcome === "ok" ? <>
        <span className={`${styles.chip} ${member.judge === "withhold" || member.judge === "failed" ? styles.differ : ""}`}>
          {member.judge ? JUDGE[member.judge] : "نتيجة فحص الرد غير مسجّلة"}
        </span>
        <span className={styles.chip}>{sourceMatchLabel(member)}</span>
      </> : null}
      {member.agreements ? <span className={styles.chip}>{member.publication === undefined
        ? `تشابه تقريبي مع ${member.agreements} من الأعضاء في الفحص السابق`
        : `مطابقة نصية مع ${member.agreements} من الأعضاء`}</span> : null}
      {member.publication ? <span className={styles.chip}>{PUBLICATION[member.publication]}</span> : null}
      <span className={styles.note}>{seconds(member.elapsedMs)}</span>
    </div>
    {member.output ? <p dir="auto" className={styles.text}>{member.output}</p> : null}
    {member.note ? <p className={styles.note}>{member.note}</p> : null}
  </li>;
}

/** The council's record as the owner reads it: the decision, how each model read the request, the search and the answers. */
export function CouncilPanel({ council, id }: { council: ModelCouncil; id?: string }) {
  const understanding = council.members.filter(member => member.round === "understanding");
  const search = council.members.filter(member => member.round === "search");
  const answers = council.members.filter(member => member.round === "answer");
  return <div id={id} className={styles.panel} data-testid="council-panel">
    <p className={styles.line}><strong>القرار:</strong> {council.reason}</p>
    <p className={styles.line}><strong>المدة:</strong> {seconds(council.elapsedMs)}</p>
    {understanding.length ? <section aria-label="كيف فهمت النماذج الطلب">
      <h3 className={styles.heading}>كيف فهمت النماذج الطلب</h3>
      <ul className={styles.list}>{understanding.map((member, index) => <Understanding key={`${member.model}-${index}`} member={member} />)}</ul>
    </section> : null}
    {search.length ? <section aria-label="البحث في الويب">
      <h3 className={styles.heading}>البحث في الويب</h3>
      <ul className={styles.list}>{search.map((member, index) => <li key={index} className={styles.item}>
        <span className={styles.chip}>{OUTCOME[member.outcome]}</span>
        {member.output ? <span dir="auto" className={styles.value}>{member.output}</span> : null}
        {member.note ? <span className={styles.note}>{member.note}</span> : null}
        <span className={styles.note}>{seconds(member.elapsedMs)}</span>
      </li>)}</ul>
    </section> : null}
    {answers.length ? <section aria-label="أجوبة الأعضاء">
      <h3 className={styles.heading}>أجوبة الأعضاء</h3>
      <p className={styles.note}>يفحص الحَكَم صياغة الرد وبعض شروط السند عند توفره. صحة الأجوبة غير مقيسة في هذا الفحص.</p>
      <ol className={styles.list}>{answers.map((member, index) => <Answer key={`${member.model}-${index}`} member={member} />)}</ol>
    </section> : null}
  </div>;
}

/** Under an owner's reply: the model council that picked it, closed until asked for. */
export function ModelCouncilDetails({ council }: { council: ModelCouncil }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const answering = council.members.filter(member => member.round === "answer").length;
  return <div className={styles.details}>
    <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)} data-testid="council-toggle">
      <span>نقاش النماذج ({answering})</span>
      <span className={styles.summary}>{council.changed ? `أُرسل جواب ${chosenLabel(council)}` : "بقي جواب المحرك"}</span>
      <ChevronDown size={14} className={open ? styles.flipped : ""} aria-hidden="true" />
    </button>
    {open ? <CouncilPanel council={council} id={panel} /> : null}
  </div>;
}
