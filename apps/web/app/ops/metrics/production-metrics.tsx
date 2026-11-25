"use client";

import { useState } from "react";
import {
  answerPaths, resourceMetrics, trafficRoles,
  type AnswerPath, type Latency, type MetricWindow, type ProductionMetricsResponse, type ResourceMetric,
  type TrafficRole, type WorkingRunPhase,
} from "@mohassan/contracts";
import { Download, RefreshCw } from "lucide-react";
import { MetricsFrame } from "./metrics-frame";
import {
  hasChatSamples, metricsCsvPath, metricsPath, requestMetrics, requestTotals, routeHistory, slowestRoutes, type MetricsState,
} from "./metrics-data";
import styles from "./metrics.module.css";

const windowOptions = { hour: "آخر ساعة", day: "آخر ٢٤ ساعة", week: "آخر ٧ أيام" } as const;
type WindowKey = keyof typeof windowOptions;
const roleLabel: Record<TrafficRole, string> = { owner: "المالك", member: "الأعضاء" };
const phaseLabels: Record<WorkingRunPhase, string> = {
  received: "استلام الطلب",
  understanding: "فهم الطلب",
  selecting: "اختيار المسار",
  planning: "التخطيط",
  answering: "إعداد الرد",
  awaiting_input: "انتظار معلومات",
  awaiting_approval: "انتظار الموافقة",
  executing: "التنفيذ",
  verifying: "التحقق",
  repairing: "الإصلاح",
};
const pathLabels: Record<AnswerPath, string> = {
  web: "الويب", local_computation: "الحساب المحلي", skill_reader: "قارئ المهارات",
  memory: "الذاكرة", browser: "المتصفح", refusal: "الرفض",
};
const resourceLabels: Record<ResourceMetric, string> = {
  eventLoopDelayMs: "تأخر حلقة الأحداث (مللي ثانية)",
  heapUsedBytes: "الذاكرة المخصصة للكائنات (بايت)",
  rssBytes: "الذاكرة المقيمة للعملية (بايت)",
  openHandles: "مقابض العملية المفتوحة",
};
const numbers = new Intl.NumberFormat("ar", { maximumFractionDigits: 2 });
const rates = new Intl.NumberFormat("ar", { style: "percent", maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat("ar", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23",
});
const times = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" });

function valueText(value: number | null) {
  return value === null ? "—" : numbers.format(value);
}

function errorRate(errors: number, requests: number) {
  return requests ? rates.format(errors / requests) : "—";
}

function Time({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{dates.format(value)}</time>;
}

function TimeWindow({ window }: { window: Pick<MetricWindow, "startMs" | "endMs"> }) {
  return (
    <p className={styles.window}>
      من <Time value={window.startMs} /> إلى <Time value={window.endMs} /> بالتوقيت العالمي
    </p>
  );
}

function RequestCards({ window }: { window: MetricWindow }) {
  return (
    <section className={styles.section} aria-labelledby="metrics-requests">
      <h2 id="metrics-requests">طلبات الخادم</h2>
      <TimeWindow window={window} />
      <div className={styles.cards}>
        {trafficRoles.map(role => {
          const totals = requestTotals(window.roles[role].routes);
          return (
            <article className={styles.card} key={role}>
              <h3>{roleLabel[role]}</h3>
              <dl className={styles.values}>
                <div><dt>الطلبات</dt><dd>{valueText(totals.count)}</dd></div>
                <div><dt>أخطاء الطلبات <bdi>4xx</bdi></dt><dd>{errorRate(totals.clientErrors, totals.count)}</dd></div>
                <div><dt>أخطاء الخادم <bdi>5xx</bdi></dt><dd>{errorRate(totals.serverErrors, totals.count)}</dd></div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LatencyColumns({ latency }: { latency: Latency }) {
  return <><td>{valueText(latency.samples)}</td><td>{valueText(latency.p50)}</td><td>{valueText(latency.p90)}</td><td>{valueText(latency.p99)}</td></>;
}

function LatencyHeadings() {
  return <><th scope="col">العينات</th><th scope="col"><bdi>p50</bdi></th><th scope="col"><bdi>p90</bdi></th><th scope="col"><bdi>p99</bdi></th></>;
}

function SlowRoutes({ window, role }: { window: MetricWindow; role: TrafficRole }) {
  const routes = slowestRoutes(window.roles[role].routes);
  return (
    <section className={styles.section} aria-labelledby="metrics-slowest">
      <h2 id="metrics-slowest">أبطأ المسارات · {roleLabel[role]}</h2>
      <TimeWindow window={window} />
      {routes.length === 0 ? <p>لا توجد عينات زمنية قابلة للترتيب.</p> : (
        <div className={styles.tableScroll}>
          <table>
            <caption>مرتبة حسب <bdi>p90</bdi> · أزمنة الاستجابة بالمللي ثانية</caption>
            <thead>
              <tr>
                <th scope="col">المسار</th><th scope="col">الطلبات</th><LatencyHeadings />
                <th scope="col"><bdi>4xx</bdi></th><th scope="col"><bdi>5xx</bdi></th>
              </tr>
            </thead>
            <tbody>
              {routes.map(route => (
                <tr key={route.route}>
                  <th scope="row"><bdi dir="ltr">{route.route}</bdi></th><td>{valueText(route.count)}</td>
                  <LatencyColumns latency={route.latency} />
                  <td>{errorRate(route.statusClasses["4xx"], route.count)}</td>
                  <td>{errorRate(route.statusClasses["5xx"], route.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RouteChart({ series }: { series: ReturnType<typeof routeHistory>[number] }) {
  const values = series.hours.flatMap(hour => hour.p90 === null ? [] : [hour.p90]);
  const max = values.length ? Math.max(...values) : null;
  const first = series.hours[0];
  const last = series.hours.at(-1);
  return (
    <figure className={styles.chart}>
      <figcaption><bdi dir="ltr">{series.route}</bdi></figcaption>
      {max === null ? <p>لا توجد عينات زمنية قابلة للعرض لهذا المسار.</p> : (
        <>
          <div className={styles.plot} aria-hidden="true">
            <div className={styles.axisValues}><span>{valueText(max)}</span><span>{valueText(0)}</span></div>
            <div className={styles.bars}>
              {series.hours.map(hour => (
                <div className={styles.barTrack} key={hour.startMs} title={`${times.format(hour.startMs)}–${times.format(hour.endMs)} · ${valueText(hour.p90)}`}>
                  {hour.p90 !== null && <span className={styles.bar} style={{ height: `${max ? hour.p90 / max * 100 : 0}%` }} />}
                </div>
              ))}
            </div>
            {first && last && <div className={styles.axisTimes}><span>{times.format(first.startMs)}</span><span>{times.format(last.endMs)}</span></div>}
          </div>
          <details className={styles.chartData}>
            <summary>القياسات بالساعة</summary>
            <div className={styles.tableScroll}>
              <table>
                <thead><tr><th scope="col">الفترة بالتوقيت العالمي</th><th scope="col"><bdi>p90</bdi> (مللي ثانية)</th></tr></thead>
                <tbody>
                  {series.hours.map(hour => (
                    <tr key={hour.startMs}>
                      <th scope="row"><Time value={hour.startMs} /> – <Time value={hour.endMs} /></th>
                      <td>{valueText(hour.p90)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </figure>
  );
}

function RouteCharts({ report, role }: { report: ProductionMetricsResponse; role: TrafficRole }) {
  const series = routeHistory(report, role);
  return (
    <section className={styles.section} aria-labelledby="metrics-history">
      <h2 id="metrics-history">زمن الاستجابة لأكثر المسارات طلبًا · {roleLabel[role]}</h2>
      <TimeWindow window={report.windows.day} />
      <p className={styles.note}>آخر ٢٤ ساعة · <bdi>p90</bdi> لكل ساعة بالمللي ثانية. الفراغ يعني غياب قيمة قابلة للعرض.</p>
      {series.length === 0
        ? <p>لا توجد طلبات خلال هذه الفترة.</p>
        : <div className={styles.cards}>{series.map(route => <RouteChart key={route.route} series={route} />)}</div>}
    </section>
  );
}

function ChatMetrics({ window, role }: { window: MetricWindow; role: TrafficRole }) {
  const { chat } = window.roles[role];
  const timings = [
    { label: "حتى أول تقدّم ظاهر", latency: chat.firstProgress },
    { label: "حتى الرد النهائي", latency: chat.finalAnswer },
  ];
  const phases = Object.entries(chat.phases).map(([phase, latency]) => ({
    label: phaseLabels[phase as WorkingRunPhase] ?? phase, latency,
  }));
  return (
    <section className={styles.section} aria-labelledby="metrics-chat">
      <h2 id="metrics-chat">زمن المحادثات · {roleLabel[role]}</h2>
      <TimeWindow window={window} />
      {!hasChatSamples(chat) ? <p>لا توجد قياسات للمحادثات خلال هذه الفترة.</p> : (
        <>
          <p>جولات المحادثة المسجلة <strong>{valueText(chat.runs)}</strong></p>
          <div className={styles.tableScroll}>
            <table>
              <caption>زمن الوصول ومدّة المراحل بالمللي ثانية</caption>
              <thead><tr><th scope="col">القياس</th><LatencyHeadings /></tr></thead>
              <tbody>
                {timings.map(({ label, latency }) => (
                  <tr key={label}><th scope="row">{label}</th><LatencyColumns latency={latency} /></tr>
                ))}
              </tbody>
              {phases.length > 0 && (
                <tbody>
                  <tr><th scope="rowgroup" colSpan={5}>مراحل الجولة</th></tr>
                  {phases.map(({ label, latency }) => (
                    <tr key={label}><th scope="row">{label}</th><LatencyColumns latency={latency} /></tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
          <h3>مسارات الإجابة</h3>
          <dl className={styles.values}>
            {answerPaths.map(path => <div key={path}><dt>{pathLabels[path]}</dt><dd>{valueText(chat.paths[path])}</dd></div>)}
          </dl>
        </>
      )}
    </section>
  );
}

function ProcessMetrics({ window }: { window: MetricWindow }) {
  return (
    <section className={styles.section} aria-labelledby="metrics-process">
      <h2 id="metrics-process">موارد عملية الخادم</h2>
      <TimeWindow window={window} />
      {resourceMetrics.every(metric => window.resources[metric].samples === 0) ? <p>لا توجد عينات للموارد خلال هذه الفترة.</p> : (
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th scope="col">المورد</th><th scope="col">العينات</th><th scope="col">المتوسط</th><th scope="col">الأعلى</th></tr></thead>
            <tbody>
              {resourceMetrics.map(metric => {
                const { samples, average, max } = window.resources[metric];
                return (
                  <tr key={metric}>
                    <th scope="row">{resourceLabels[metric]}</th>
                    <td>{valueText(samples)}</td><td>{valueText(average)}</td><td>{valueText(max)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ProductionMetrics({ initialState }: { initialState: MetricsState }) {
  const [state, setState] = useState(initialState);
  const [windowKey, setWindowKey] = useState<WindowKey>("day");
  const [role, setRole] = useState<TrafficRole>("owner");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const report = state.kind === "ready" ? state.report : null;

  async function refresh() {
    setState({ kind: "loading" });
    setExportError(false);
    setState(await requestMetrics(metricsPath, { credentials: "same-origin" }));
  }

  async function exportCsv() {
    setExporting(true);
    setExportError(false);
    try {
      const response = await fetch(metricsCsvPath, { credentials: "same-origin", cache: "no-store", redirect: "error" });
      if (response.status === 401 || response.status === 403) {
        setState({ kind: response.status === 401 ? "signin" : "forbidden" });
        return;
      }
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/csv")) throw new Error("CSV unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "production-metrics.csv";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  }

  const selectedWindow = report?.windows[windowKey];
  const empty = selectedWindow && Object.values(selectedWindow.roles).every(({ routes, chat }) =>
    !routes.some(route => route.count > 0) && !hasChatSamples(chat))
    && resourceMetrics.every(metric => selectedWindow.resources[metric].samples === 0);

  return (
    <MetricsFrame>
      {state.kind === "loading" && <p role="status">جارٍ تحميل مقاييس الإنتاج…</p>}
      {state.kind === "signin" && <p role="alert">سجّل الدخول بحساب المالك لعرض مقاييس الإنتاج.</p>}
      {state.kind === "forbidden" && <p role="alert">مقاييس الإنتاج متاحة لحساب المالك فقط.</p>}
      {state.kind === "error" && (
        <div className={styles.state}>
          <p role="alert">تعذّر تحميل مقاييس الإنتاج.</p>
          <button type="button" onClick={() => void refresh()}>إعادة المحاولة</button>
        </div>
      )}
      {report && selectedWindow && (
        <>
          <div className={styles.toolbar}>
            <p className={styles.window}>آخر تحديث <Time value={report.generatedAtMs} /> بالتوقيت العالمي</p>
            <div className={styles.actions}>
              <button type="button" onClick={() => void refresh()} disabled={exporting}><RefreshCw size={16} aria-hidden="true" />تحديث</button>
              {report.enabled && (
                <button type="button" onClick={() => void exportCsv()} disabled={exporting}>
                  <Download size={16} aria-hidden="true" />{exporting ? "جارٍ تنزيل الملف…" : "تنزيل CSV لكل الفترات"}
                </button>
              )}
            </div>
          </div>
          {exportError && <p className={styles.notice} role="alert">تعذّر تنزيل ملف المقاييس. حاول مجددًا.</p>}
          {!report.enabled ? <p className={styles.notice} role="status">جمع المقاييس متوقف.</p> : (
            <>
              {report.countingOnly && <p className={styles.notice} role="status">يجمع الخادم العدّادات فقط الآن. قد تكون عينات الزمن والموارد ناقصة.</p>}
              {!report.snapshotAvailable && <p className={styles.notice} role="status">حفظ المقاييس على القرص غير متاح حاليًا.</p>}
              <div className={styles.filters}>
                <label>الفترة
                  <select value={windowKey} onChange={event => setWindowKey(event.target.value as WindowKey)}>
                    {Object.entries(windowOptions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label>تفاصيل حركة
                  <select value={role} onChange={event => setRole(event.target.value as TrafficRole)}>
                    {trafficRoles.map(className => <option key={className} value={className}>{roleLabel[className]}</option>)}
                  </select>
                </label>
              </div>
              {empty ? <div className={styles.section} role="status"><p>لا توجد قياسات في الفترة المحددة.</p><TimeWindow window={selectedWindow} /></div> : (
                <>
                  <RequestCards window={selectedWindow} />
                  <SlowRoutes window={selectedWindow} role={role} />
                  <ChatMetrics window={selectedWindow} role={role} />
                  <ProcessMetrics window={selectedWindow} />
                </>
              )}
              <RouteCharts report={report} role={role} />
            </>
          )}
        </>
      )}
    </MetricsFrame>
  );
}
