import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ModelCouncil, ModelCouncilMember } from "@mohassan/contracts";
import { shortLink } from "./markdown";
import councilStyles from "./model-council.module.css";
import styles from "./model-council-discussion.module.css";

type Discussion = NonNullable<ModelCouncil["discussion"]>;
type DiscussionProps = { discussion: Discussion; members: ModelCouncilMember[] };

const verdictLabels: Record<Discussion["checks"][number]["verdict"], string> = {
  supports: "يؤيّد",
  contradicts: "يعارض",
  unsure: "غير متأكد",
};
const roundLabels: Record<ModelCouncilMember["round"], string> = {
  understanding: "فهم الطلب",
  search: "البحث في الويب",
  answer: "الإجابة",
};
const absenceLabels: Record<Exclude<ModelCouncilMember["outcome"], "ok">, string> = {
  abstained: "امتنع عن المشاركة",
  failed: "تعذّرت مشاركته",
  timeout: "انتهت المهلة",
};

function memberLabels(members: ModelCouncilMember[]) {
  return new Map(members.map(member => [member.model, member.label]));
}

function MemberName({ id, labels }: { id: string; labels: ReadonlyMap<string, string> }) {
  return <bdi dir="auto" title={id}>{labels.get(id) ?? (id === "pipeline" ? "المحرك" : id)}</bdi>;
}

function participationText(discussion: Discussion, labels: ReadonlyMap<string, string>): string {
  const speakers = new Set([
    ...discussion.proposals.map(proposal => proposal.member),
    ...discussion.checks.filter(check => labels.has(check.checker)).map(check => check.checker),
    ...discussion.votes.map(vote => vote.member),
  ]);
  speakers.delete("pipeline");
  speakers.delete("web-search");
  if (speakers.size === 0) return "لم يشارك أي نموذج في النقاش";
  if (speakers.size === 1) return "ناقش نموذج واحد";
  if (speakers.size === 2) return "ناقش نموذجان";
  return `ناقشت ${speakers.size} ${speakers.size <= 10 ? "نماذج" : "نموذجًا"}`;
}

function evidenceLink(value?: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function CouncilDiscussionPanel({
  discussion, members, id, hidden,
}: DiscussionProps & { id?: string; hidden?: boolean }) {
  const { proposals, checks, votes, decision } = discussion;
  const labels = memberLabels(members);
  const absent = members.flatMap(({ model, round, outcome, note }) =>
    outcome === "ok" ? [] : [{ model, round, status: absenceLabels[outcome], note }]);

  return <div id={id} className={styles.panel} dir="rtl" hidden={hidden} data-testid="council-panel">
    {!hidden && <>
      <section>
        <h3>المقترحات</h3>
        {proposals.length ? <ul role="list">
          {proposals.map(({ member, answer, evidenceUrl, evidenceQuote }, index) => {
            const url = evidenceLink(evidenceUrl);
            return <li key={index} className={styles.entry}>
              <div className={styles.entryHeading}>
                <strong><MemberName id={member} labels={labels} /></strong>
                {member === decision.chosen && <span className={styles.selected}>الجواب المختار</span>}
              </div>
              <p className={styles.answer} dir="auto">{answer.trim() ? answer : "لم يُسجّل نصّ المقترح."}</p>
              {url && <p>المصدر <a href={url.href} title={url.href} target="_blank" rel="noopener noreferrer"><bdi>{shortLink(url.href)}</bdi></a></p>}
              {evidenceQuote?.trim() && <blockquote dir="auto">{evidenceQuote}</blockquote>}
              {!url && !evidenceQuote?.trim() && <p>لم يُسجّل دليل لهذا المقترح.</p>}
            </li>;
          })}
        </ul> : <p>لم تُسجّل مقترحات.</p>}
      </section>
      <section>
        <h3>التحقّق</h3>
        {checks.length ? <ul role="list">
          {checks.map(({ checker, member, verdict, note }, index) => <li key={index} className={styles.entry}>
            <p><strong><MemberName id={checker} labels={labels} /></strong> · جواب <MemberName id={member} labels={labels} /> · <strong>{verdictLabels[verdict]}</strong></p>
            {note?.trim() && <p dir="auto">{note}</p>}
          </li>)}
        </ul> : <p>لم تُسجّل نتائج تحقّق.</p>}
      </section>
      <section>
        <h3>التصويت</h3>
        {votes.length ? <ul role="list">
          {votes.map(({ member, weight, weightSource }, index) => <li key={index} className={styles.entry}>
            <p><strong><MemberName id={member} labels={labels} /></strong> · الوزن <bdi>{weight}</bdi></p>
            <p>مصدر الوزن · <bdi dir="auto">{weightSource.trim() || "لا يوجد قياس مسجّل"}</bdi></p>
          </li>)}
        </ul> : <p>لم تُسجّل أوزان للتصويت.</p>}
      </section>
      <section className={styles.decision}>
        <h3>القرار</h3>
        <p className={styles.answer}>{decision.chosen === "pipeline" ? "بقي جواب " : "أُرسل جواب "}<strong><MemberName id={decision.chosen} labels={labels} /></strong></p>
        <p>{decision.reasonAr}</p>
      </section>
      {absent.length > 0 && <section>
        <h3>من تعذّرت مشاركتهم</h3>
        <ul role="list">
          {absent.map(({ model, round, status, note }, index) => <li key={index} className={styles.entry}>
            <p><strong><MemberName id={model} labels={labels} /></strong> · {roundLabels[round]} · {status}</p>
            {note?.trim() && <p dir="auto">{note}</p>}
          </li>)}
        </ul>
      </section>}
    </>}
  </div>;
}

export function CouncilDiscussionDetails({ discussion, members }: DiscussionProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const labels = memberLabels(members);
  const { chosen, reasonAr } = discussion.decision;
  return <div className={councilStyles.details} dir="rtl" lang="ar">
    <button
      type="button"
      className={`${councilStyles.toggle} ${styles.toggle}`}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen(value => !value)}
      data-testid="council-toggle"
    >
      <span className={styles.summary} title={reasonAr}>
        {participationText(discussion, labels)}؛ {chosen === "pipeline" ? "بقي جواب " : "اختير جواب "}
        <strong><MemberName id={chosen} labels={labels} /></strong> — {reasonAr}
      </span>
      <ChevronDown size={14} className={open ? councilStyles.flipped : ""} aria-hidden="true" />
    </button>
    <CouncilDiscussionPanel id={panelId} hidden={!open} discussion={discussion} members={members} />
  </div>;
}
