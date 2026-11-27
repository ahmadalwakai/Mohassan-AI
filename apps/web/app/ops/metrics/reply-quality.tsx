import {
  councilMemberOutcomes,
  replyFeedbackSources,
  type CouncilMemberOutcome,
  type CouncilMetrics,
  type ReplyFeedbackMetrics,
  type ReplyFeedbackSource,
} from "@mohassan/contracts";
import styles from "./metrics.module.css";

const numbers = new Intl.NumberFormat("ar", { maximumFractionDigits: 2 });
const valueText = (value: number | null) => value === null ? "—" : numbers.format(value);

const outcomeLabels: Record<CouncilMemberOutcome, string> = {
  ok: "اكتمل", abstained: "امتنع", timeout: "انتهت المهلة", failed: "فشل",
};
const sourceLabels: Record<ReplyFeedbackSource, string> = {
  pipeline: "مسار الإجابة المعتاد", v5: "v5", councilChanged: "ردود غيّرها المجلس",
};

export function CouncilStats({ metrics }: { metrics: CouncilMetrics }) {
  const { turns, changedReplies, chosenByModel, memberOutcomes, elapsedMs, v5 } = metrics;
  const choices = new Map(Object.entries(chosenByModel));
  const outcomesByModel = new Map(Object.entries(memberOutcomes));
  const models = [...new Set([...choices.keys(), ...outcomesByModel.keys()])].sort();

  return (
    <section className={styles.section} aria-labelledby="metrics-council">
      <h2 id="metrics-council">مجلس النماذج</h2>
      <dl className={styles.values}>
        <div><dt>جولات المجلس</dt><dd>{valueText(turns)}</dd></div>
        <div><dt>الردود التي غيّرها المجلس</dt><dd>{valueText(changedReplies)}</dd></div>
        <div><dt>مشاركات <bdi>v5</bdi></dt><dd>{valueText(v5.attempted)}</dd></div>
        <div>
          <dt>إجابات <bdi>v5</bdi> التي لم يخترها المجلس</dt>
          <dd>{valueText(v5.unusedAnswers)} من {valueText(v5.answered)}</dd>
        </div>
      </dl>
      <h3>مدة المجلس بالمللي ثانية</h3>
      <dl className={styles.values}>
        <div><dt>العينات</dt><dd>{valueText(elapsedMs.samples)}</dd></div>
        <div><dt><bdi>p50</bdi></dt><dd>{valueText(elapsedMs.p50)}</dd></div>
        <div><dt><bdi>p90</bdi></dt><dd>{valueText(elapsedMs.p90)}</dd></div>
        <div><dt><bdi>p99</bdi></dt><dd>{valueText(elapsedMs.p99)}</dd></div>
      </dl>
      {models.length === 0 ? <p>لا توجد مشاركات للمجلس خلال هذه الفترة.</p> : (
        <div className={styles.tableScroll}>
          <table>
            <caption>الردود المختارة ونتائج المشاركات حسب النموذج</caption>
            <thead>
              <tr>
                <th scope="col">النموذج</th>
                <th scope="col">اختير ردّه</th>
                {councilMemberOutcomes.map(outcome => <th key={outcome} scope="col">{outcomeLabels[outcome]}</th>)}
              </tr>
            </thead>
            <tbody>
              {models.map(model => (
                <tr key={model}>
                  <th scope="row"><bdi>{model}</bdi></th>
                  <td>{valueText(choices.get(model) ?? 0)}</td>
                  {councilMemberOutcomes.map(outcome => (
                    <td key={outcome}>{valueText(outcomesByModel.get(model)?.[outcome] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ReplyFeedbackStats({ metrics, roleLabel }: { metrics: ReplyFeedbackMetrics; roleLabel: string }) {
  return (
    <section className={styles.section} aria-labelledby="metrics-reply-feedback">
      <h2 id="metrics-reply-feedback">تقييم الردود · {roleLabel}</h2>
      <div className={styles.tableScroll}>
        <table>
          <caption>حسب وقت نشر الرد وآخر تقييم له</caption>
          <thead>
            <tr>
              <th scope="col">مصدر الرد</th><th scope="col">الردود</th><th scope="col">مفيد</th>
              <th scope="col">خطأ</th><th scope="col">ناقص</th><th scope="col">بلا تقييم</th>
            </tr>
          </thead>
          <tbody>
            {replyFeedbackSources.map(source => {
              const { replies, useful, wrong, incomplete, unrated } = metrics[source];
              return (
                <tr key={source}>
                  <th scope="row"><bdi>{sourceLabels[source]}</bdi></th>
                  <td>{valueText(replies)}</td><td>{valueText(useful)}</td><td>{valueText(wrong)}</td>
                  <td>{valueText(incomplete)}</td><td>{valueText(unrated)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
