"""Arabic scorecards and append-only JSONL history."""
from __future__ import annotations

import fcntl
from html import escape
import json
import os
from pathlib import Path
from shlex import join
from tempfile import NamedTemporaryFile


METRIC_LABELS = {
    "first_progress_ms": "أول تقدّم مرئي (ms)",
    "final_answer_ms": "الجواب النهائي (ms)",
    "cpu_ms_per_turn": "متوسط CPU لكل دور (ms)",
    "peak_rss_bytes": "ذروة RSS (bytes)",
    "model_files_bytes": "ملفات النماذج على القرص (bytes)",
    "resident_worker_bytes": "ذاكرة العامل المقيم (bytes)",
    "training_gpu_hours": "وقت GPU المخصّص للتدريب (hours)",
}


def code(value) -> str:
    return "<code>" + escape(str(value)).replace("|", "&#124;") + "</code>"


def number(value) -> str:
    return f"{value:.6g}" if isinstance(value, float) else str(value)


def metric(item: dict) -> str:
    if item["value"] is None:
        return f"not measured ({code(item['reason'])})"
    if isinstance(item["value"], dict):
        return f"p50 {number(item['value']['p50'])} / p95 {number(item['value']['p95'])}"
    return number(item["value"])


def quality_table(arms: dict, key: str) -> list[str]:
    qualities = {arm: result["quality"][key] for arm, result in arms.items()}
    columns = ["العائلة", "اللغة", *(code(arm) for arm in qualities)]
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    rows = {arm: {(row.get("family"), row.get("language")): row for row in [data["overall"], *data["groups"]]}
            for arm, data in qualities.items()}
    for family, language in next(iter(rows.values())):
        cells = []
        for arm, groups in rows.items():
            row = groups[family, language]
            interval = " – ".join(f"{v:.2%}" for v in row["interval95"])
            verdict = f"{row['correct']}/{row['total']} [{interval}]"
            if arm != "baseline":
                verdict += f" · Δ {row['gain']:+.2%} · p {number(row['mcnemar_p'])}"
            cells.append(verdict)
        lines.append("| " + " | ".join([code(family or "all"), code(language or "all"), *cells]) + " |")
    return lines


def metric_table(arms, metrics_of, phase):
    lines = ["| المقياس | " + " | ".join(code(arm) for arm in arms) + " |",
             "| --- | " + " | ".join("---" for _ in arms) + " |"]
    for field, label in METRIC_LABELS.items():
        cells = []
        for arm in arms.values():
            item = metrics_of(arm)[field]
            cell = metric(item)
            if item.get("total"):
                per_language = item.get("samples_by_language", {})
                languages = arm["turns_by_language"].get(phase, {})
                coverage = "، ".join(f"{code(language)} {per_language.get(language, 0)}/{total}"
                                     for language, total in sorted(languages.items())) if per_language else ""
                cell += f" · {item['samples']}/{item['total']}"
                cell += f" ({coverage})" if coverage else " (not measured: التغطية حسب اللغة غير مسجّلة)"
            cells.append(cell)
        lines.append("| " + " | ".join([label, *cells]) + " |")
    return lines


def source_lines(source):
    return [
        f"- المخرج الخام {code(source['raw_output'])} ({code(source['raw_output_sha256'])})",
        f"  عند {code(source['recorded_at'])} بالأمر {code(join(source['command']))}",
    ]


def checks_lines(checks):
    for check in checks:
        observed = check["value"]
        if observed is None:
            observed = "not measured"
        elif "total" in check:
            observed = f"{observed}/{check['total']}"
        limit = check["limit"] if check["limit"] is not None else "threshold_missing"
        reason = f" · {code(check['reason'])}" if check.get("reason") else ""
        yield f"  - {code(check['name'])} {code(check['status'])} · {code(observed)} · الحد {code(limit)}{reason}"


def render(result: dict) -> str:
    arms = result["arms"]
    stamp = result["start"]
    lines = [
        "# بطاقة قياس قيمة موحسن", "",
        f"- بدء التشغيل {code(stamp['started_at'])}",
        f"- نهاية التشغيل {code(result['finished_at'])}",
        f"- مرجع الأداة {code(stamp['commit'])}",
        f"- ملف تثبيت التشغيل {code(result['start_sha256'])}",
        "- المجموعات " + "، ".join(code(suite) for suite in stamp["suites"]),
    ]
    registration = stamp["preregistration"]
    if registration:
        lines.append(f"- تثبيت التسجيل المسبق {code(registration['sha256'])} عند {code(registration.get('stamped_at') or registration['registered_at'])}")
    if not stamp["decisive"]:
        lines.append("- تشغيل استكشافي. تبقى النتائج الجديدة في الظل حتى يحدّد المالك عتبات القرار مسبقًا.")
    lines += [
        "", "## الجودة", "",
        "كل خلية تعرض الصحيح من المجموع ومجال Wilson عند 95%. تعرض الأذرع المقارنة فرق النسبة "
        "واحتمال McNemar الدقيق ثنائي الطرف مقابل خط الأساس على الحالات نفسها.", "",
        *quality_table(arms, "combined"),
    ]
    for suite in stamp["suites"]:
        lines += ["", f"### {code(suite)}", "", *quality_table(arms, suite)]
    phase = result["measurement_phase"]
    lines += [
        "", "## السرعة والتكلفة", "",
        f"أُخذت مقاييس القرار من {code(phase)}. يعرض كل مقياس زمني تغطية الأدوار التي أمكن رصدها.",
        "", *metric_table(arms, lambda arm: arm["metrics"], phase),
    ]
    for additional in sorted(next(iter(arms.values()))["phase_metrics"].keys() - {phase}):
        lines.extend(["", f"### {code(additional)}", "",
                      *metric_table(arms, lambda arm: arm["phase_metrics"][additional], additional)])
    for arm, data in arms.items():
        lines.extend(["", f"### {code(arm)}", "", f"- الإصدار {code(data['commit'])}"])
        if data.get("model_version"):
            lines.append(f"- إصدار النموذج {code(data['model_version'])}")
        if data.get("settings"):
            lines.append("- الإعدادات " + "، ".join(code(f"{key}={value}") for key, value in data["settings"].items()))
        for name, machine in data.get("phase_machines", {phase: data["machine"]}).items():
            lines.append(f"- جهاز القياس ({code(name)}) " + "، ".join(
                f"{code(label)} {code(value)}" for label, value in machine.items()))
        for name, digest in data["receipt_hashes"].items():
            lines.append(f"- بصمة الإيصال {code(name)} {code(digest)}")
        for source in data["evidence"]:
            lines.extend(source_lines(source))
        if dates := data.get("training_dates"):
            lines.append(f"- التدريب من {code(dates['started_at'])} إلى {code(dates['completed_at'])}")
            lines.append(f"  - إيصال البداية {code(dates['started_receipt'])} ({code(dates['started_receipt_sha256'])})")
        for key, value in data["decision"].get("monetary", {}).items():
            displayed = code(value) if value is not None else "not measured (القياس الذي يعتمد عليه السعر غير متاح)"
            lines.append(f"- {code(key)} {displayed}")
        if ids := data["quality"]["combined"]["regression_ids"]:
            lines += ["", "معرّفات الحالات العامة التي تراجعت", "", *[f"- {code(case_id)}" for case_id in ids]]
    if private := result.get("private_evidence"):
        lines.extend(["", "### قياس المجموعات الخاصة", "", *source_lines(private)])
    lines += ["", "## القرار", ""]
    for arm, data in arms.items():
        decision = data["decision"]
        lines.append(f"- {code(arm)} — {code(decision['outcome'])}")
        lines.extend(checks_lines(decision.get("checks", [])))
        if data.get("model_version"):
            status = data["own_model_justified"]
            conclusion = {
                True: "اجتاز النموذج عتبات القيمة والتكلفة أمام الضابط المطابق.",
                False: "لم يجتز النموذج عتبات القيمة والتكلفة أمام الضابط المطابق.",
                None: "not measured (الأدلة غير كافية للحكم على قيمة النموذج مقابل تكلفته).",
            }[status]
            lines.append(f"  - {conclusion}")
            if data.get("model_control"):
                lines.append(f"  - الضابط {code(data['model_control'])}")
                lines.extend("  " + line for line in checks_lines(data["model_decision"]["checks"]))
    if not any(arm.get("model_version") for arm in arms.values()):
        lines.append("- قيمة نموذج موحسن الخاص — not measured (هذا التشغيل لم يتضمّن ذراعًا بإصدار نموذج محدّد).")
    if result.get("model_runtime"):
        lines += ["", "## قياسات تشغيل النماذج المرفقة", ""]
        for arm, item in result["model_runtime"].items():
            lines.append(f"- {code(arm)} · {code(item['model_version'])} · {code(item['receipt_sha256'])}")
            for field in sorted(set(item["metrics"]) | set(item.get("unmeasured", {}))):
                value = item["metrics"].get(field)
                if field == "model_latency_ms" and value:
                    value = f"{min(value):.6g} – {max(value):.6g} ms"
                if value is None or value == []:
                    value = f"not measured ({item['unmeasured'][field]})"
                lines.append(f"  - {code(field)} {code(value)}")
    if result.get("ablation"):
        lines += ["", "## قياسات مفاتيح التطوير المرفقة", ""]
        for supplement in result["ablation"]:
            evidence = supplement["evidence"]
            lines += [
                f"- {code(supplement['arm'])} مقابل {code(supplement['baseline_arm'])} "
                f"للمفتاح {code(supplement['switch'])}",
                f"  - {code(evidence['raw_output'])} ({code(supplement['raw_output_sha256'])}) "
                f"عند {code(evidence['recorded_at'])} بالأمر {code(join(evidence['command']))}",
            ]
            for group in supplement["groups"]:
                interval = " – ".join(f"{v:.2%}" for v in group["interval95"])
                lines.append(f"  - {code(group['suite_id'])} {code(group['family'])} {code(group['language'])} "
                             f"{group['baseline_correct']}/{group['total']} → {group['correct']}/{group['total']} · "
                             f"[{interval}] · p {number(group['mcnemar_p'])}")
    lines.append("")
    return "\n".join(lines)


def write_report(path: Path, text: str) -> None:
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
            os.link(temporary, path)
        finally:
            temporary.unlink()


def append_history(path: Path, row: dict) -> None:
    """Keep each run's row intact when independent scorecards finish concurrently."""
    data = json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode() + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+b") as history:
        fcntl.flock(history, fcntl.LOCK_EX)
        offset = history.seek(0, os.SEEK_END)
        if offset:
            history.seek(-1, os.SEEK_END)
            if history.read(1) != b"\n":
                raise ValueError("Scorecard history ends in an incomplete row.")
        try:
            history.write(data)
            history.flush()
            os.fsync(history.fileno())
        except OSError:
            history.truncate(offset)
            raise
